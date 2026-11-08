import {createHash,randomBytes} from 'node:crypto';
import {createHostSettingsProductService,createHostSettingsProductRequestHandler} from './host-settings-product-service.js';
import {createHostSettingsWriteCandidate,hostSettingsSchemaFingerprint,hostSettingsValueSha256,normalizeHostSettingsWritePatch} from './host-settings-write-candidate.js';
import {createHostSettingsMigrationProofReader} from './host-settings-migration-proof.js';

const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const fields=['mode','workspace_id','provider_id','model_id','plugin_selection'];
function canonical(v){
 if(Array.isArray(v))return'['+v.map(canonical).join(',')+']';
 if(record(v))return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 return JSON.stringify(v);
}
const digest=v=>createHash('sha256').update(canonical(v),'utf8').digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const sameDescription=(a,b)=>a?.revision===b?.revision&&a?.schema_fingerprint===b?.schema_fingerprint
 &&a?.settings_sha256===b?.settings_sha256&&same(a?.settings,b?.settings);
const unavailable=()=>{throw Error('host_settings_runtime_source_unavailable');};
const approvedReviewMatches=(review,scope,key)=>{
 if(!record(review)||review.purpose!=='settings.update'||!record(review.identity)||!record(review.observation)||!record(review.command))return false;
 const id=review.identity,observation=review.observation,command=review.command;
 try{
  const patch=normalizeHostSettingsWritePatch(command.settings);
  return id.owner_id===scope.owner_id&&id.actor_id===scope.actor_id&&id.profile_id===scope.profile_id
   &&id.host_instance_id===scope.host_instance_id&&id.policy_epoch===scope.policy_epoch&&id.namespace===scope.namespace
   &&command.idempotency_key===key&&command.expected_version===scope.expected_version
   &&command.expected_schema_fingerprint===scope.expected_schema_fingerprint
   &&observation.settings_version===scope.expected_version&&observation.dsh_revision===scope.expected_dsh_revision
   &&observation.schema_fingerprint===scope.expected_schema_fingerprint&&observation.settings_sha256===scope.base_settings_sha256
   &&hostSettingsValueSha256(patch)===scope.patch_sha256;
 }catch{return false;}
};

/** Product reads and writes over the selected Host profile, owner approval and the existing Gateway controls. */
export function createHostSettingsRuntimeProvider({namespace,hostInstanceId,bootstrap,settingsController,readProfile,readProfileContext,
 workbenchBridge,authenticateComponent,componentAuthorization,productSchema,approvalProducer,typertGateway,readSessionRefs}={}){
 if(namespace!=='jot-session-adapter')throw TypeError('host_settings_runtime_namespace_invalid');
 if(typeof bootstrap?.resolveSettingsTicket!=='function'||typeof readProfile!=='function'
  ||typeof settingsController?.describe!=='function'||typeof authenticateComponent!=='function')throw TypeError('host_settings_runtime_dependency_invalid');
 let provision;
 if(productSchema!==undefined){
  if(!record(productSchema)||Object.keys(productSchema).sort().join(',')!=='schema_fingerprint,schema_version'
   ||!Number.isSafeInteger(productSchema.schema_version)||productSchema.schema_version<1||!HASH.test(productSchema.schema_fingerprint??''))
   throw TypeError('host_settings_product_schema_invalid');
  provision=Object.freeze({...productSchema});
 }
 async function resolveScope(input){
  const before=readProfile();
  if(!ID.test(before?.ownerId??'')||!ID.test(before?.profileId??''))return unavailable();
  const ticket=await bootstrap.resolveSettingsTicket({authorization:componentAuthorization??input?.authorization,ticket:input?.ticket,namespace});
  const after=readProfile();
  if(ticket?.ok!==true||ticket.host_instance_id!==hostInstanceId||!ID.test(ticket.actor_id??'')
   ||!Number.isSafeInteger(ticket.policy_epoch)||ticket.policy_epoch<1||before.ownerId!==after.ownerId||before.profileId!==after.profileId)
   return unavailable();
  return{identity:{owner_id:after.ownerId,actor_id:ticket.actor_id,profile_id:after.profileId,
   host_instance_id:hostInstanceId,policy_epoch:ticket.policy_epoch},policy_revision:ticket.policy_revision,expires_at:ticket.expires_at};
 }
 async function request(operation,payload){
  if(typeof workbenchBridge?.requestHostSettings!=='function')return unavailable();
  return workbenchBridge.requestHostSettings(operation,payload);
 }
 async function checkedRequest(input,operation,payloadFor){
  const before=await resolveScope(input),result=await request(operation,payloadFor(before));
  const after=await resolveScope(input);if(!same(before,after))return unavailable();
  return result;
 }
 async function description(){
  const described=await settingsController.describe();
  if(!record(described)||described.writable!==true||described.hasDocument!==true||!Array.isArray(described.namespaces))return unavailable();
  const rows=described.namespaces.filter(row=>row?.ns===namespace);
  if(rows.length!==1)return unavailable();
  const row=rows[0];
  if(!Number.isSafeInteger(row.revision)||row.revision<0||row.applies!=='live'||!record(row.value)||!record(row.schema)
   ||!Array.isArray(row.secrets)||row.secrets.length!==0||Buffer.byteLength(JSON.stringify(row.schema),'utf8')>262144)return unavailable();
  const settings=normalizeHostSettingsWritePatch(Object.fromEntries(fields.filter(k=>Object.hasOwn(row.value,k)).map(k=>[k,row.value[k]])));
  if(Object.keys(settings).sort().join(',')!==[...fields].sort().join(','))return unavailable();
  const schemaFingerprint=hostSettingsSchemaFingerprint(row.schema);
  return{revision:row.revision,schema_fingerprint:schemaFingerprint,settings:structuredClone(settings),settings_sha256:digest(settings),schema:structuredClone(row.schema)};
 }
 async function readVersionedObservation(input){
  if(!provision)return unavailable();
  const beforeScope=await resolveScope(input),before=await description();
  if(before.schema_fingerprint!==provision.schema_fingerprint)return unavailable();
  const identity={owner_id:beforeScope.identity.owner_id,profile_id:beforeScope.identity.profile_id,namespace};
  const version=await request('version/read',{identity,observed:{...identity,dsh_revision:before.revision,
   schema_fingerprint:before.schema_fingerprint,settings_sha256:before.settings_sha256}});
  const after=await description(),afterScope=await resolveScope(input);
  if(!same(beforeScope,afterScope)||!sameDescription(before,after)||version?.kind!=='ready'
   ||!Number.isSafeInteger(version.settings_version)||version.settings_version<1)return unavailable();
  return{scope:beforeScope,description:before,settings_version:version.settings_version};
 }
 const originalReceipts={async lookupOriginal(input){
  try{
   const row=await checkedRequest(input,'receipt/lookup',scope=>({identity:scope.identity,operation:'settings.update',idempotency_key:input.idempotency_key,
    namespace:input.patch===undefined?null:namespace,expected_version:input.expected_version??null,
    schema_fingerprint:input.expected_schema_fingerprint??null,patch:input.patch??null}));
   if(row?.kind==='absent'||row?.kind==='conflict')return{kind:row.kind};
   if(['reserved','pending','unknown'].includes(row?.kind))return{kind:'pending'};
   if(['completed','no_side_effect'].includes(row?.kind)&&record(row.result))return{kind:'completed',receipt:row.result};
  }catch{}
  return{kind:'unavailable'};
 }};
 const pendingOwnerApprovals=new Map();
 const purgeOwnerApprovals=()=>{const now=Date.now();for(const[key,value]of pendingOwnerApprovals)if(value.expires_at<=now)pendingOwnerApprovals.delete(key);};
 async function resolveOwnerWriteApproval(input){
  if(typeof approvalProducer?.consumeApprovedWrite!=='function')return undefined;
  purgeOwnerApprovals();if(pendingOwnerApprovals.size>=32)return undefined;
  const current=await resolveScope(input);
  const command=input?.command;
  if(!record(command)||!TOKEN.test(input?.ticket??'')||!ID.test(current.identity.actor_id??''))return undefined;
  const normalized=normalizeHostSettingsWritePatch(command.settings);
  const request={purpose:'settings.update',authenticated_actor_id:current.identity.actor_id,ticket:input.ticket,namespace,
   command:{idempotency_key:input.idempotency_key,expected_version:command.expected_version,
    expected_schema_fingerprint:command.expected_schema_fingerprint,settings:normalized}};
  const token=randomBytes(32).toString('base64url');
  pendingOwnerApprovals.set(token,{request,expires_at:Date.now()+90_000});
  return{kind:'owner_settings_write',token};
 }
 const ownerWriteGrants={async consume({approval,expectedScope,idempotency_key}={}){
  purgeOwnerApprovals();
  if(!record(approval)||Object.keys(approval).sort().join(',')!=='kind,token'||approval.kind!=='owner_settings_write'||!TOKEN.test(approval.token??''))
   return{ok:false};
  const pending=pendingOwnerApprovals.get(approval.token);pendingOwnerApprovals.delete(approval.token);
  if(!pending||pending.request.command.idempotency_key!==idempotency_key)return{ok:false};
  let approved;try{approved=await approvalProducer.consumeApprovedWrite(pending.request);}catch{return{ok:false};}
  if(approved?.ok!==true||approved.peer?.principal?.kind!=='owner'||!approvedReviewMatches(approved.review,expectedScope,idempotency_key))
   return{ok:false};
  return{ok:true,peer:approved.peer,scope:expectedScope};
 }};
 const operationReceipts={
  reserve:input=>request('receipt/reserve',{scope:input}),
  markDispatched:input=>request('receipt/dispatched',input),
  complete:input=>request('receipt/complete',input),
  rejectNoSideEffect:input=>request('receipt/reject',{operation_id:input.operation_id,request_sha256:input.request_sha256,
   reservation_token:input.reservation_token??null,result:input.result,proof:input.proof??null}),
  markUnknown:input=>request('receipt/unknown',input)
 };
 const activityGuard={async withWriteFence(scope,operation,admissionId){
  const fenceScope={owner_id:scope.owner_id,actor_id:scope.actor_id,profile_id:scope.profile_id,host_instance_id:scope.host_instance_id,
   policy_epoch:scope.policy_epoch,namespace:scope.namespace,operation:'settings.update',expected_version:scope.expected_version,
   expected_dsh_revision:scope.expected_dsh_revision,expected_schema_fingerprint:scope.expected_schema_fingerprint,
   base_settings_sha256:scope.base_settings_sha256,patch_sha256:scope.patch_sha256};
  let closed;try{closed=await request('fence/close',{scope:fenceScope,admission_id:admissionId});}catch{return operation(undefined);}
  if(closed?.kind!=='closed'||typeof closed.fence_id!=='string')return operation(undefined);
  const fenceId=closed.fence_id;
  try{
   let refs=null;try{const value=await readSessionRefs?.();if(Array.isArray(value))refs=value;}catch{}
   const identity={owner_id:scope.owner_id,profile_id:scope.profile_id,namespace:scope.namespace};
   const [impact,status]=await Promise.all([
    request('activity/preview',{identity,session_refs:refs}),
    request('fence/status',{fence_id:fenceId,admission_id:admissionId})
   ]);
   if(status?.kind!=='closed'||status.fence_id!==fenceId||status.active_admissions!==0||status.active_runs!==0
    ||impact?.kind!=='ready'||!same(impact.identity,identity)||!Number.isSafeInteger(impact.active_runs)||impact.active_runs<0
    ||!Number.isSafeInteger(impact.active_sessions)||impact.active_sessions<0||impact.active_runs!==status.active_runs)
    return await operation(undefined);
   return await operation({fence_id:fenceId,active_runs:impact.active_runs,active_sessions:impact.active_sessions});
  }finally{
   const released=await request('fence/release',{fence_id:fenceId,admission_id:admissionId});
   if(released!==true)throw Error('host_settings_activity_fence_release_failed');
  }
 }};
 const migrationGuard={async assess({namespace:requestedNamespace,expectedSchemaFingerprint,expectedRevision}={}){
  try{
   if(!provision||requestedNamespace!==namespace||expectedSchemaFingerprint!==provision.schema_fingerprint)return{decision:'hold',state:'unknown'};
   const profile=readProfile(),profileContext=readProfileContext?.(),current=await description();
   if(!profile?.profileDirectory||typeof profileContext?.home!=='string'||current.revision!==expectedRevision
    ||current.schema_fingerprint!==expectedSchemaFingerprint)return{decision:'hold',state:'unknown'};
   const proof=createHostSettingsMigrationProofReader({profileHome:profileContext.home,profileDirectory:profile.profileDirectory,namespace}).read({ns:namespace,schema:current.schema});
   if(!['migrated','not_required'].includes(proof?.state))return{decision:'hold',state:'unknown'};
   return{decision:'allow',state:proof.state,from_schema_version:null,to_schema_version:provision.schema_version,schema_fingerprint:current.schema_fingerprint};
  }catch{return{decision:'hold',state:'unknown'};}
 }};
 const writer=typeof typertGateway?.invoke==='function'&&typeof approvalProducer?.consumeApprovedWrite==='function'
  ?createHostSettingsWriteCandidate({hostInstanceId,allowedNamespaces:[namespace],ownerWriteGrants,operationReceipts,activityGuard,migrationGuard,
   typertGateway,readCurrentScope:input=>readVersionedObservation(input).then(row=>({
    ...row.scope.identity,namespace,settings_version:row.settings_version,settings_revision:row.description.revision,
    settings_sha256:row.description.settings_sha256,schema_fingerprint:row.description.schema_fingerprint
   })),
   async readCurrentHostState(input){
    const beforeScope=await resolveScope(input),before=await description();
    const after=await description(),afterScope=await resolveScope(input);
    if(!same(beforeScope,afterScope)||!sameDescription(before,after)||before.schema_fingerprint!==provision?.schema_fingerprint)return undefined;
    return{applies:'live',scope:{...beforeScope.identity,namespace,settings_revision:before.revision,
     settings_sha256:before.settings_sha256,schema_fingerprint:before.schema_fingerprint},settings:before.settings};
   }}):undefined;
 const service=createHostSettingsProductService({namespace,originalReceipts,resolveOwnerWriteApproval,writer,
  async readEditorSnapshot(input){
   const row=await readVersionedObservation(input);
   return{namespace,settings_version:row.settings_version,schema_version:provision.schema_version,
    schema_fingerprint:row.description.schema_fingerprint,write_scope:digest({...row.scope.identity,namespace,
     settings_version:row.settings_version,settings_revision:row.description.revision,
     schema_fingerprint:row.description.schema_fingerprint,settings_sha256:row.description.settings_sha256}),
    settings:row.description.settings};
  }
 });
 return createHostSettingsProductRequestHandler({service,authenticateComponent});
}
