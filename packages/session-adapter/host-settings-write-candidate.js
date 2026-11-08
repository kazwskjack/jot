import {createHash} from 'node:crypto';

const SAFE_FIELDS=new Set(['mode','workspace_id','provider_id','model_id','plugin_selection']);
const NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const KEY=/^[A-Za-z0-9_-]{8,200}$/;
const HASH=/^[a-f0-9]{64}$/;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const opaque=value=>typeof value==='string'&&value.length>=8&&value.length<=256;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const SAFE_REASONS=new Set([
  'host_settings_namespace_forbidden','host_settings_operation_forbidden','host_settings_expected_revision_required',
  'host_settings_schema_fingerprint_required','host_settings_idempotency_key_invalid','host_settings_owner_approval_required',
  'host_settings_field_forbidden','host_settings_patch_invalid','host_settings_scope_unavailable','host_settings_scope_changed',
  'host_settings_receipt_unavailable','host_settings_outcome_unknown','host_settings_receipt_invalid',
  'host_settings_migration_unconfirmed','host_settings_activity_fence_unavailable','host_settings_activity_fence_busy',
  'host_settings_owner_approval_invalid','host_settings_write_rejected'
]);

function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;
  if(record(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('host_settings_value_invalid');
}

function digest(value){return createHash('sha256').update(canonical(value),'utf8').digest('hex');}
export function hostSettingsValueSha256(value){return digest(value);}

function semanticSchema(schema){
  if(!record(schema))throw new TypeError('host_settings_schema_invalid');
  if(!record(schema.refs)||!Number.isSafeInteger(schema.uid))return schema;
  const ancestry=new Set();
  function visit(id){
    const key=String(id),node=schema.refs[key];
    if(!record(node)||ancestry.has(key))throw new TypeError('host_settings_schema_invalid');
    ancestry.add(key);
    const result={};
    for(const field of Object.keys(node).sort()){
      const value=node[field];
      if(field==='dict'){
        if(!record(value))throw new TypeError('host_settings_schema_invalid');
        result.dict=Object.fromEntries(Object.keys(value).sort().map(name=>[name,visit(value[name])]));
      }else if(field==='inner')result.inner=visit(value);
      else if(field==='list'){
        if(!Array.isArray(value))throw new TypeError('host_settings_schema_invalid');
        result.list=value.map(visit);
      }
      else result[field]=value;
    }
    ancestry.delete(key);
    return result;
  }
  return visit(schema.uid);
}

export function hostSettingsSchemaFingerprint(schema){
  if(!record(schema))throw new TypeError('host_settings_schema_invalid');
  return digest(semanticSchema(schema));
}

export function normalizeHostSettingsWritePatch(value){return safePatch(value);}
export function projectHostSettingsWriteReceipt(value){return safeReceipt(value);}

function safePatch(value){
  if(!record(value)||Object.keys(value).length===0)throw new TypeError('host_settings_patch_invalid');
  const keys=Object.keys(value);
  if(keys.some(key=>!SAFE_FIELDS.has(key)))throw new TypeError('host_settings_field_forbidden');
  const patch={};
  for(const key of keys.sort()){
    const item=value[key];
    if(key==='mode'){
      if(!['agent','demo'].includes(item))throw new TypeError('host_settings_patch_invalid');
      patch[key]=item;
    }else if(key==='plugin_selection'){
      if(!Array.isArray(item)||item.length>128||item.some(id=>typeof id!=='string'||id.length<1||id.length>256)||new Set(item).size!==item.length)throw new TypeError('host_settings_patch_invalid');
      patch[key]=[...item];
    }else{
      if(typeof item!=='string'||item.length<1||item.length>512||/[\u0000-\u001f\u007f]/.test(item))throw new TypeError('host_settings_patch_invalid');
      patch[key]=item;
    }
  }
  return patch;
}

function scopeFor(context,namespace,operation,expectedVersion,expectedDshRevision,schemaFingerprint,patch){
  if(!record(context)||!['owner_id','actor_id','host_instance_id','profile_id','policy_epoch','settings_version','settings_revision','settings_sha256'].every(key=>context[key]!==undefined)
    ||!['owner_id','actor_id','host_instance_id','profile_id'].every(key=>typeof context[key]==='string'&&context[key].length>0)
    ||!Number.isSafeInteger(context.policy_epoch)||context.policy_epoch<1||!Number.isSafeInteger(context.settings_version)||context.settings_version<0
    ||!Number.isSafeInteger(context.settings_revision)||context.settings_revision<0||!HASH.test(context.settings_sha256??''))throw new TypeError('host_settings_scope_unavailable');
  if(context.namespace!==namespace)throw new TypeError('host_settings_scope_changed');
  if(context.settings_version!==expectedVersion||context.settings_revision!==expectedDshRevision)throw new TypeError('host_settings_scope_changed');
  return Object.freeze({
    owner_id:context.owner_id,actor_id:context.actor_id,host_instance_id:context.host_instance_id,profile_id:context.profile_id,policy_epoch:context.policy_epoch,
    namespace,operation,expected_version:expectedVersion,expected_dsh_revision:expectedDshRevision,
    expected_schema_fingerprint:schemaFingerprint,base_settings_sha256:context.settings_sha256,patch_sha256:digest(patch)
  });
}

function sameScope(left,right){
  try{return canonical(left)===canonical(right);}catch{return false;}
}

function knownCode(value){
  if(typeof value==='string')return value;
  if(!record(value))return undefined;
  for(const candidate of [value.code,value.error?.code,value.data?.code,value.remoteError?.code])if(typeof candidate==='string')return candidate;
}

function conflictVersion(value){
  if(!record(value))return undefined;
  // The locked DSH RemoteError maps SettingsConflictError.actual to `details.actual`.
  // Never forward the RemoteError itself; only project its numeric revision.
  for(const candidate of [value.actual,value.details?.actual,value.data?.actual,value.error?.data?.actual,value.current_version,value.data?.current_version])
    if(Number.isSafeInteger(candidate)&&candidate>=0)return candidate;
}

function safeMigration(value){
  if(!record(value)||!['not_required','migrated'].includes(value.state)
    ||value.from_schema_version!==null&&(!Number.isSafeInteger(value.from_schema_version)||value.from_schema_version<0)
    ||!Number.isSafeInteger(value.to_schema_version)||value.to_schema_version<1)return undefined;
  return{state:value.state,from_schema_version:value.from_schema_version,to_schema_version:value.to_schema_version};
}

function safeImpact(fence){
  const activeRuns=fence?.active_runs,activeSessions=fence?.active_sessions;
  if(!Number.isSafeInteger(activeRuns)||activeRuns<0||!Number.isSafeInteger(activeSessions)||activeSessions<0)return undefined;
  return{state:'known',active_runs:activeRuns,active_sessions:activeSessions,current_sessions_restarted:null};
}

function safeActiveImpact(value){
  if(!record(value))return undefined;
  const activeRuns=Number.isSafeInteger(value.active_runs)&&value.active_runs>=0?value.active_runs:null;
  const activeSessions=Number.isSafeInteger(value.active_sessions)&&value.active_sessions>=0?value.active_sessions:null;
  if(value.state==='known'&&activeRuns!==null&&activeSessions!==null)
    return{state:'known',active_runs:activeRuns,active_sessions:activeSessions,current_sessions_restarted:null};
  return{state:'unknown',active_runs:null,active_sessions:null,current_sessions_restarted:null};
}

function safeReceipt(value){
  if(!record(value))return undefined;
  if(value.status==='unknown_pending')return{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};
  if(value.status==='held'){
    const impact=safeActiveImpact(value.active_run_impact);
    return{status:'held',reason_code:SAFE_REASONS.has(value.reason_code)?value.reason_code:'host_settings_receipt_invalid',
      ...(record(value.migration)?{migration:safeMigration(value.migration)??{state:'unknown'}}:{}),...(impact?{active_run_impact:impact}:{})};
  }
  if(value.status==='conflict')return{status:'conflict',...(Number.isSafeInteger(value.current_version)&&value.current_version>=0?{current_version:value.current_version}:{})};
  if(value.status==='rejected')return{status:'rejected',reason_code:SAFE_REASONS.has(value.reason_code)?value.reason_code:'host_settings_write_rejected'};
  if(value.status==='stale_scope')return{status:'stale_scope',reason_code:'host_settings_scope_changed'};
  if(value.status!=='saved'||typeof value.namespace!=='string'||!Number.isSafeInteger(value.settings_version)||value.settings_version<1||!record(value.settings))return undefined;
  const projected={};
  for(const key of SAFE_FIELDS)if(Object.hasOwn(value.settings,key))projected[key]=structuredClone(value.settings[key]);
  let settings;try{settings=safePatch(projected);}catch{return undefined;}
  const activation=value.activation?.state==='live'?'live':'unknown';
  return{
    status:'saved',namespace:value.namespace,settings_version:value.settings_version,settings,
     activation:{state:activation},
     active_run_impact:safeActiveImpact(value.active_run_impact)??{state:'unknown',active_runs:null,active_sessions:null,current_sessions_restarted:null},
     migration:safeMigration(value.migration)??{state:'unknown'},safe_boundary:{state:'unknown'}
  };
}

function resultFromView(view,{namespace,expectedVersion,expectedDshRevision,patch,migration,impact}){
  if(!record(view)||view.ns!==namespace||!Number.isSafeInteger(view.revision)||view.revision!==expectedDshRevision+1||!record(view.value))return undefined;
  const settings={};
  for(const key of SAFE_FIELDS)if(Object.hasOwn(view.value,key))settings[key]=structuredClone(view.value[key]);
  for(const [key,value] of Object.entries(patch))if(canonical(settings[key])!==canonical(value))return undefined;
  return safeReceipt({
    status:'saved',namespace,settings_version:expectedVersion+1,settings,
    activation:{state:'unknown'},active_run_impact:impact,migration,safe_boundary:{state:'unknown'}
  });
}

function validatePorts({ownerWriteGrants,operationReceipts,activityGuard,migrationGuard,typertGateway,readCurrentScope}){
  if(typeof readCurrentScope!=='function'||typeof ownerWriteGrants?.consume!=='function'
    ||!['reserve','markDispatched','complete','rejectNoSideEffect','markUnknown'].every(name=>typeof operationReceipts?.[name]==='function')
    ||typeof activityGuard?.withWriteFence!=='function'||typeof migrationGuard?.assess!=='function'
    ||typeof typertGateway?.invoke!=='function')throw new TypeError('host_settings_write_ports_invalid');
}

/**
 * Candidate Host settings writer over DSH's real owner Remote.
 *
 * Ports are intentionally injected: Task 13 must bind ownerWriteGrants to a
 * separate exact-body owner approval, operationReceipts to Jot's existing
 * durable idempotency receipts, activityGuard to an exclusive Host lifecycle
 * fence, and migrationGuard to the real legacy-schema migration source.
 * Missing or unknown guard facts hold the operation. An unknown Remote outcome
 * stays pending and the same key is never sent to DSH again.
 */
export function createHostSettingsWriteCandidate({
  hostInstanceId,allowedNamespaces=[],ownerWriteGrants,operationReceipts,activityGuard,migrationGuard,typertGateway,readCurrentScope,readCurrentHostState
}={}){
  if(typeof hostInstanceId!=='string'||hostInstanceId.length===0)throw new TypeError('host_settings_host_id_invalid');
  validatePorts({ownerWriteGrants,operationReceipts,activityGuard,migrationGuard,typertGateway,readCurrentScope});
  if(typeof readCurrentHostState!=='function')throw new TypeError('host_settings_host_state_reader_invalid');
  const allowed=new Set(Array.isArray(allowedNamespaces)?allowedNamespaces.filter(value=>typeof value==='string'&&NAMESPACE.test(value)&&value!=='jot-host-policy'):[]);

  async function save(input={}){
    if(!UUID.test(input?.activity_admission_id??''))return{status:'held',reason_code:'host_settings_activity_fence_unavailable'};
    if(!record(input)||!allowed.has(input.namespace)||!NAMESPACE.test(input.namespace))return{status:'held',reason_code:'host_settings_namespace_forbidden'};
    if(input.operation!=='settings.update')return{status:'held',reason_code:'host_settings_operation_forbidden'};
    if(!Number.isSafeInteger(input.expected_version)||input.expected_version<1)return{status:'held',reason_code:'host_settings_expected_revision_required'};
    if(!HASH.test(input.expected_schema_fingerprint??''))return{status:'held',reason_code:'host_settings_schema_fingerprint_required'};
    if(!KEY.test(input.idempotency_key??''))return{status:'held',reason_code:'host_settings_idempotency_key_invalid'};
    if(!record(input.approval)||Object.keys(input.approval).sort().join(',')!=='kind,token'||input.approval.kind!=='owner_settings_write'||!opaque(input.approval.token))return{status:'held',reason_code:'host_settings_owner_approval_required'};
    let patch;
    try{patch=safePatch(input.patch);}catch(error){return{status:'held',reason_code:error?.message==='host_settings_field_forbidden'?'host_settings_field_forbidden':'host_settings_patch_invalid'};}

    let context;
    try{context=await readCurrentScope(input);}catch{return{status:'held',reason_code:'host_settings_scope_unavailable'};}
    if(context?.host_instance_id!==hostInstanceId)return{status:'held',reason_code:'host_settings_scope_changed'};
    if(context?.settings_version!==input.expected_version)return{status:'conflict',...(Number.isSafeInteger(context?.settings_version)?{current_version:context.settings_version}:{})};
    let scope;
    try{scope=scopeFor(context,input.namespace,input.operation,input.expected_version,context.settings_revision,input.expected_schema_fingerprint,patch);}
    catch(error){return{status:'held',reason_code:error?.message==='host_settings_scope_changed'?'host_settings_scope_changed':'host_settings_scope_unavailable'};}
    let reservation;
    try{reservation=await operationReceipts.reserve({
      owner_id:scope.owner_id,actor_id:scope.actor_id,profile_id:scope.profile_id,host_instance_id:scope.host_instance_id,
      policy_epoch:scope.policy_epoch,namespace:scope.namespace,operation:'settings.update',idempotency_key:input.idempotency_key,
      expected_version:scope.expected_version,expected_dsh_revision:scope.expected_dsh_revision,base_settings_sha256:scope.base_settings_sha256,
      schema_fingerprint:input.expected_schema_fingerprint,patch:structuredClone(patch)
    });}catch{return{status:'held',reason_code:'host_settings_receipt_unavailable'};}
    if(reservation?.kind==='conflict')return{status:'conflict'};
    if(reservation?.kind==='completed'||reservation?.kind==='no_side_effect')return safeReceipt(reservation.result)??{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};
    if(reservation?.kind==='pending')return{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};
    if(reservation?.kind!=='reserved'||typeof reservation.operation_id!=='string'||!reservation.operation_id
      ||!TOKEN.test(reservation.reservation_token??'')||!HASH.test(reservation.request_sha256??''))return{status:'held',reason_code:'host_settings_receipt_unavailable'};
    const operationId=reservation.operation_id,requestSha=reservation.request_sha256;
    let remoteStarted=false;
    const proofFor=(outcome,{settingsRevision=null,observedSettingsSha256=null}={})=>({
      protocol:1,source:'dsh-settings-controller',outcome,operation_id:operationId,request_sha256:requestSha,
      owner_id:scope.owner_id,actor_id:scope.actor_id,profile_id:scope.profile_id,host_instance_id:scope.host_instance_id,
      policy_epoch:scope.policy_epoch,namespace:scope.namespace,expected_version:input.expected_version,
      settings_revision:settingsRevision,schema_fingerprint:input.expected_schema_fingerprint,patch_sha256:scope.patch_sha256,
      observed_settings_sha256:observedSettingsSha256
    });
    const finalizeNoSideEffect=async(result,proof)=>{
      const safe=safeReceipt(result);if(!safe)return{status:'held',reason_code:'host_settings_receipt_invalid'};
      try{const stored=await operationReceipts.rejectNoSideEffect({operation_id:operationId,request_sha256:requestSha,result:safe,
        ...(!remoteStarted?{reservation_token:reservation.reservation_token}:{}),...(proof?{proof}:{})});
        if(stored?.ok!==true)return{status:'held',reason_code:'host_settings_receipt_unavailable'};
      }catch{return{status:'held',reason_code:'host_settings_receipt_unavailable'};}
      return safe;
    };
    const markUnknown=async()=>{
      try{await operationReceipts.markUnknown({operation_id:operationId,request_sha256:requestSha,reason:'host_settings_outcome_unknown'});}catch{}
      return{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};
    };
    const finalizeApplied=async(result,proof)=>{
      const safe=safeReceipt(result);if(!safe)return markUnknown();
      try{const stored=await operationReceipts.complete({operation_id:operationId,request_sha256:requestSha,result:safe,proof});
        if(stored?.ok!==true)return markUnknown();
      }catch{return markUnknown();}
      return safe;
    };
    const explicitDshOutcome=async(result,outcome,settingsRevision=null)=>{
      return finalizeNoSideEffect(result,proofFor(outcome,{settingsRevision}));
    };

    let migration;
    try{migration=await migrationGuard.assess({namespace:input.namespace,expectedSchemaFingerprint:input.expected_schema_fingerprint,
      expectedRevision:scope.expected_dsh_revision,patch:structuredClone(patch)});}catch{migration={decision:'hold',state:'unknown'};}
    const migrationFact=safeMigration(migration);
    if(migration?.decision!=='allow'||!migrationFact||migration?.schema_fingerprint!==input.expected_schema_fingerprint)
      return finalizeNoSideEffect({status:'held',reason_code:'host_settings_migration_unconfirmed',migration:migrationFact??{state:'unknown'}});

    try{
      return await activityGuard.withWriteFence(scope,async fence=>{
        if(!fence||typeof fence.fence_id!=='string'||!fence.fence_id)return finalizeNoSideEffect({status:'held',reason_code:'host_settings_activity_fence_unavailable',migration:migrationFact});
        const impact=safeImpact(fence);
        if(!impact||impact.active_runs!==0||impact.active_sessions!==0)return finalizeNoSideEffect({status:'held',reason_code:'host_settings_activity_fence_busy',migration:migrationFact,...(impact?{active_run_impact:impact}:{})});
        let current;
        try{current=await readCurrentScope(input);}catch{return finalizeNoSideEffect({status:'held',reason_code:'host_settings_scope_unavailable',migration:migrationFact});}
        let currentExpected;
        try{currentExpected=current&&scopeFor(current,input.namespace,input.operation,input.expected_version,scope.expected_dsh_revision,input.expected_schema_fingerprint,patch);}catch{}
        if(!sameScope(currentExpected,scope))return finalizeNoSideEffect({status:'stale_scope',reason_code:'host_settings_scope_changed'});

        let grant;
        try{grant=await ownerWriteGrants.consume({approval:structuredClone(input.approval),expectedScope:scope,idempotency_key:input.idempotency_key});}catch{return finalizeNoSideEffect({status:'held',reason_code:'host_settings_owner_approval_invalid',migration:migrationFact});}
        if(grant?.ok!==true||grant.peer?.principal?.kind!=='owner'||!sameScope(grant.scope,scope))
          return finalizeNoSideEffect({status:'held',reason_code:'host_settings_owner_approval_invalid',migration:migrationFact});

        let beforeRemote;
        try{beforeRemote=await readCurrentScope(input);}catch{return finalizeNoSideEffect({status:'held',reason_code:'host_settings_scope_unavailable',migration:migrationFact});}
        let beforeRemoteScope;
        try{beforeRemoteScope=beforeRemote&&scopeFor(beforeRemote,input.namespace,input.operation,input.expected_version,scope.expected_dsh_revision,input.expected_schema_fingerprint,patch);}catch{}
        if(!sameScope(beforeRemoteScope,scope))return finalizeNoSideEffect({status:'stale_scope',reason_code:'host_settings_scope_changed'});

        let dispatched;
        try{dispatched=await operationReceipts.markDispatched({operation_id:operationId,reservation_token:reservation.reservation_token,request_sha256:requestSha});}
        catch{return finalizeNoSideEffect({status:'held',reason_code:'host_settings_receipt_unavailable',migration:migrationFact});}
        if(dispatched?.ok!==true)return finalizeNoSideEffect({status:'held',reason_code:'host_settings_receipt_unavailable',migration:migrationFact});
        remoteStarted=true;
        const args={ns:input.namespace,patch,expectedRevision:scope.expected_dsh_revision};
        let view;
        try{view=await typertGateway.invoke({namespace:'settings',method:'update',args,peer:grant.peer});}
        catch(error){
          const code=knownCode(error);
          if(code==='settings/conflict'||code==='SETTINGS_CONFLICT')return explicitDshOutcome({status:'conflict'},'conflict',conflictVersion(error)??null);
          if(code==='settings/rejected')return explicitDshOutcome({status:'rejected',reason_code:'host_settings_write_rejected'},'rejected');
          return markUnknown();
        }
        if(record(view)&&view.ok===false){
          const code=knownCode(view);
          if(code==='settings/conflict'||code==='SETTINGS_CONFLICT')return explicitDshOutcome({status:'conflict'},'conflict',conflictVersion(view)??null);
          if(code==='settings/rejected')return explicitDshOutcome({status:'rejected',reason_code:'host_settings_write_rejected'},'rejected');
          return markUnknown();
        }
        const confirmed=resultFromView(view,{namespace:input.namespace,expectedVersion:input.expected_version,expectedDshRevision:scope.expected_dsh_revision,patch,migration:migrationFact,impact});
        if(!confirmed)return markUnknown();
        let after;
        try{after=await readCurrentHostState(input);}catch{after=undefined;}
        const afterScope=after?.scope,afterSettings=after?.settings;
        if(!record(afterScope)||after.applies!=='live'||afterScope.owner_id!==scope.owner_id||afterScope.actor_id!==scope.actor_id||afterScope.profile_id!==scope.profile_id
          ||afterScope.host_instance_id!==scope.host_instance_id||afterScope.policy_epoch!==scope.policy_epoch||afterScope.namespace!==scope.namespace
          ||afterScope.settings_revision!==scope.expected_dsh_revision+1||afterScope.schema_fingerprint!==input.expected_schema_fingerprint
          ||!record(afterSettings)||digest(normalizeHostSettingsWritePatch(afterSettings))!==digest(confirmed.settings))return markUnknown();
        const applied={...confirmed,activation:{state:'live'}};
        return finalizeApplied(applied,proofFor('applied',{settingsRevision:scope.expected_dsh_revision+1,observedSettingsSha256:digest(confirmed.settings)}));
      },input.activity_admission_id);
    }catch{
      if(remoteStarted)return markUnknown();
      return finalizeNoSideEffect({status:'held',reason_code:'host_settings_activity_fence_unavailable',migration:migrationFact});
    }
  }

  return Object.freeze({save});
}
