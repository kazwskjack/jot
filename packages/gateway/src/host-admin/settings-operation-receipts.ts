import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {validateHostSettingsProductCommand,validateHostSettingsProductResult} from './settings-product-contract.ts';
import {assertHostSettingsOperationReceiptSchema} from './settings-operation-receipt-schema.ts';

const HASH=/^[a-f0-9]{64}$/;
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY=/^[A-Za-z0-9_-]{8,128}$/;
const NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const RESERVATION_TOKEN=/^[A-Za-z0-9_-]{43}$/;
const OPERATION_ID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RECEIPT_COLUMNS='actor_id,base_settings_sha256,created_at,expected_dsh_revision,expected_version,host_instance_id,host_proof_json,idempotency_key,namespace,operation,operation_id,owner_id,patch_sha256,policy_epoch,profile_id,request_sha256,reservation_expires_at,reservation_token_sha256,result_json,schema_fingerprint,state,updated_at';
const RECEIPT_IDENTITY_FIELDS:readonly (keyof Row)[]=['operation_id','owner_id','actor_id','profile_id','host_instance_id','policy_epoch','namespace','operation',
 'idempotency_key','request_sha256','expected_version','expected_dsh_revision','base_settings_sha256','schema_fingerprint','patch_sha256','created_at'];
type Row={operation_id:string;owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number;namespace:string;operation:string;
 idempotency_key:string;request_sha256:string;expected_version:number;expected_dsh_revision:number;base_settings_sha256:string;schema_fingerprint:string;patch_sha256:string;state:string;
 reservation_token_sha256:string|null;reservation_expires_at:string|null;host_proof_json:string|null;result_json:string|null;created_at:string;updated_at:string};
type VersionRow={owner_id:string;profile_id:string;namespace:string;settings_version:number;dsh_revision:number;schema_fingerprint:string;settings_sha256:string;reconciliation_sha256:string;updated_at:string};
type Scope=Readonly<{owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number;namespace:string;operation:'settings.update';
 idempotency_key:string;expected_version:number;expected_dsh_revision:number;base_settings_sha256:string;schema_fingerprint:string;patch:Readonly<Record<string,unknown>>}>;
type Proof=Readonly<{protocol:1;source:'dsh-settings-controller';outcome:'applied'|'conflict'|'rejected';operation_id:string;request_sha256:string;
 owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number;namespace:string;expected_version:number;
 settings_revision:number|null;schema_fingerprint:string;patch_sha256:string;observed_settings_sha256:string|null}>;

export type HostSettingsOperationReceiptV1=Readonly<{
 protocol:1;operation_id:string;state:'reserved'|'dispatched'|'completed'|'unknown'|'no_side_effect';
 owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number;namespace:string;operation:'settings.update';
 idempotency_key:string;request_sha256:string;expected_version:number;schema_fingerprint:string;patch_sha256:string;
 result?:Readonly<Record<string,unknown>>;
}>;

export type HostSettingsOperationReserveV1=
 |Readonly<{kind:'reserved';operation_id:string;reservation_token:string;request_sha256:string}>
 |Readonly<{kind:'pending';operation_id:string;state:'reserved'|'dispatched'|'unknown'}>
 |Readonly<{kind:'completed'|'no_side_effect';operation_id:string;result:Readonly<Record<string,unknown>>}>
 |Readonly<{kind:'conflict'|'unavailable'|'reconcile_required'}>;

export type HostSettingsOriginalReceiptPortV1=
 |Readonly<{kind:'absent'|'pending'|'conflict'|'unavailable'}>
 |Readonly<{kind:'completed';receipt:Readonly<Record<string,unknown>>}>;

type VersionIdentity=Readonly<{owner_id:string;profile_id:string;namespace:string}>;
type ObservedVersion=Readonly<VersionIdentity&{dsh_revision:number;schema_fingerprint:string;settings_sha256:string}>;
type ReconcileVersionInput=Readonly<ObservedVersion&{expected_version:number|null;approval_sha256:string}>;

type OriginalLookupInput=Readonly<{owner_id:string;actor_id?:string;profile_id?:string;host_instance_id?:string;policy_epoch?:number;operation:'settings.update';idempotency_key:string;request_sha256?:string;
 namespace?:string;expected_version?:number;schema_fingerprint?:string;patch?:Readonly<Record<string,unknown>>}>;

function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;
 if(record(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
 throw new TypeError('host_settings_receipt_input_invalid');
}
function digest(value:unknown):string{return createHash('sha256').update(canonical(value),'utf8').digest('hex');}
function tokenDigest(value:string):string{return createHash('sha256').update(value,'utf8').digest('hex');}
function boundedJson(value:unknown,maxBytes:number):string{
 const json=JSON.stringify(value);
 if(typeof json!=='string'||Buffer.byteLength(json,'utf8')>maxBytes)throw new TypeError('host_settings_receipt_payload_invalid');
 return json;
}
function timestamp(value:number):string{if(!Number.isSafeInteger(value)||value<0)throw new TypeError('host_settings_receipt_clock_invalid');return new Date(value).toISOString();}
function parseObject(value:string|null):Record<string,unknown>|undefined{
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>65536)return undefined;
 try{const parsed:unknown=JSON.parse(value);return record(parsed)?parsed:undefined;}catch{return undefined;}
}
function canonicalTimestamp(value:unknown):value is string{
 if(typeof value!=='string')return false;
 const parsed=Date.parse(value);return Number.isFinite(parsed)&&new Date(parsed).toISOString()===value;
}
function resultFor(row:Row):Record<string,unknown>|undefined{
 const value=parseObject(row.result_json);if(!value)return undefined;
 try{return validateHostSettingsProductResult(value,row.namespace);}catch{return undefined;}
}
function scopeFor(input:Scope){
 if(!record(input)||Object.keys(input).sort().join(',')!=='actor_id,base_settings_sha256,expected_dsh_revision,expected_version,host_instance_id,idempotency_key,namespace,operation,owner_id,patch,policy_epoch,profile_id,schema_fingerprint'
  ||!OWNER_ID.test(input.owner_id??'')||!OWNER_ID.test(input.actor_id??'')||!OWNER_ID.test(input.profile_id??'')
  ||!OWNER_ID.test(input.host_instance_id??'')||!Number.isSafeInteger(input.policy_epoch)||input.policy_epoch<1
  ||!NAMESPACE.test(input.namespace??'')||input.namespace==='jot-host-policy'||input.operation!=='settings.update'
  ||!KEY.test(input.idempotency_key??'')||!Number.isSafeInteger(input.expected_version)||input.expected_version<1||!HASH.test(input.schema_fingerprint??''))
  throw new TypeError('host_settings_receipt_scope_invalid');
 const command=validateHostSettingsProductCommand({expected_version:input.expected_version,expected_schema_fingerprint:input.schema_fingerprint,settings:input.patch});
 const patch=command.settings,patchSha=digest(patch);
 if(!Number.isSafeInteger(input.expected_dsh_revision)||input.expected_dsh_revision<0||!HASH.test(input.base_settings_sha256??''))
  throw new TypeError('host_settings_receipt_version_scope_invalid');
 const requestSha=digest({owner_id:input.owner_id,actor_id:input.actor_id,profile_id:input.profile_id,host_instance_id:input.host_instance_id,
  policy_epoch:input.policy_epoch,namespace:input.namespace,operation:input.operation,expected_version:input.expected_version,
  expected_dsh_revision:input.expected_dsh_revision,base_settings_sha256:input.base_settings_sha256,
  schema_fingerprint:input.schema_fingerprint,patch_sha256:patchSha,patch});
 return{owner_id:input.owner_id,actor_id:input.actor_id,profile_id:input.profile_id,host_instance_id:input.host_instance_id,
  policy_epoch:input.policy_epoch,namespace:input.namespace,operation:input.operation,idempotency_key:input.idempotency_key,
  request_sha256:requestSha,expected_version:input.expected_version,expected_dsh_revision:input.expected_dsh_revision,
  base_settings_sha256:input.base_settings_sha256,schema_fingerprint:input.schema_fingerprint,patch_sha256:patchSha,patch};
}
function proofMatches(row:Row,value:unknown,outcome:Proof['outcome']):value is Proof{
 if(!record(value)||Object.keys(value).sort().join(',')!=='actor_id,expected_version,host_instance_id,namespace,observed_settings_sha256,operation_id,outcome,owner_id,patch_sha256,policy_epoch,profile_id,protocol,request_sha256,schema_fingerprint,settings_revision,source')return false;
 const proof=value as unknown as Proof;
 if(proof.protocol!==1||proof.source!=='dsh-settings-controller'||proof.outcome!==outcome||proof.operation_id!==row.operation_id
  ||proof.request_sha256!==row.request_sha256||proof.owner_id!==row.owner_id||proof.actor_id!==row.actor_id||proof.profile_id!==row.profile_id
  ||proof.host_instance_id!==row.host_instance_id||proof.policy_epoch!==row.policy_epoch||proof.namespace!==row.namespace
  ||proof.expected_version!==row.expected_version||proof.schema_fingerprint!==row.schema_fingerprint||proof.patch_sha256!==row.patch_sha256)return false;
 if(outcome==='applied')return Number.isSafeInteger(row.expected_dsh_revision)&&proof.settings_revision===row.expected_dsh_revision+1&&HASH.test(proof.observed_settings_sha256??'');
 if(outcome==='conflict')return (proof.settings_revision===null||Number.isSafeInteger(proof.settings_revision)&&proof.settings_revision>=0)&&proof.observed_settings_sha256===null;
 return proof.settings_revision===null&&proof.observed_settings_sha256===null;
}
function exactOutcomeProof(row:Row,value:unknown):value is Proof{
 if(!record(value))return false;
 return value.outcome==='conflict'?proofMatches(row,value,'conflict'):proofMatches(row,value,'rejected');
}
function storedReceipt(value:unknown):Row|undefined{
 if(!record(value)||Object.keys(value).sort().join(',')!==RECEIPT_COLUMNS)return;
 const row=value as unknown as Row;
 if(!OPERATION_ID.test(row.operation_id??'')||!OWNER_ID.test(row.owner_id??'')||!OWNER_ID.test(row.actor_id??'')
  ||!OWNER_ID.test(row.profile_id??'')||!OWNER_ID.test(row.host_instance_id??'')
  ||!Number.isSafeInteger(row.policy_epoch)||row.policy_epoch<1||!NAMESPACE.test(row.namespace??'')||row.namespace==='jot-host-policy'
  ||row.operation!=='settings.update'||!KEY.test(row.idempotency_key??'')||!HASH.test(row.request_sha256??'')
  ||!Number.isSafeInteger(row.expected_version)||row.expected_version<1||!Number.isSafeInteger(row.expected_dsh_revision)||row.expected_dsh_revision<0
  ||!HASH.test(row.base_settings_sha256??'')||!HASH.test(row.schema_fingerprint??'')||!HASH.test(row.patch_sha256??'')
  ||!['reserved','dispatched','completed','unknown','no_side_effect'].includes(row.state)
  ||!canonicalTimestamp(row.created_at)||!canonicalTimestamp(row.updated_at)
  ||row.host_proof_json!==null&&(typeof row.host_proof_json!=='string'||Buffer.byteLength(row.host_proof_json,'utf8')>8192)
  ||row.result_json!==null&&(typeof row.result_json!=='string'||Buffer.byteLength(row.result_json,'utf8')>65536))return;
 if(row.state==='reserved'){
  if(!HASH.test(row.reservation_token_sha256??'')||!Number.isFinite(Date.parse(row.reservation_expires_at??''))
   ||!canonicalTimestamp(row.reservation_expires_at)||Date.parse(row.reservation_expires_at??'')<=Date.parse(row.created_at)
   ||row.host_proof_json!==null||row.result_json!==null)return;
  return row;
 }
 if(row.reservation_token_sha256!==null||row.reservation_expires_at!==null)return;
 const proof=parseObject(row.host_proof_json);
 if(row.state==='dispatched')return row.host_proof_json===null&&row.result_json===null?row:undefined;
 if(row.state==='unknown'){
  const result=parseObject(row.result_json);
  if(row.host_proof_json!==null||!result||Object.keys(result).sort().join(',')!=='reason_code,status'
   ||result.status!=='unknown_pending'||result.reason_code!=='host_settings_outcome_unknown')return;
  return row;
 }
 const result=resultFor(row);
 if(!result)return;
 if(row.state==='completed'){
  if(!proof||!proofMatches(row,proof,'applied')||result.status!=='saved'||result.settings_version!==row.expected_version+1
   ||digest(result.settings)!==proof.observed_settings_sha256)return;
  return row;
 }
 if(!['held','rejected','conflict','stale_scope'].includes(String(result.status))||!proof)return;
 if(proof.source==='gateway-receipt-cas'){
  if(Object.keys(proof).sort().join(',')!=='observed_at,operation_id,outcome,prior_state,protocol,request_sha256,source'
   ||proof.protocol!==1||proof.outcome!=='not_dispatched'||proof.prior_state!=='reserved'||proof.operation_id!==row.operation_id
   ||proof.request_sha256!==row.request_sha256||!Number.isFinite(Date.parse(String(proof.observed_at))))return;
  return row;
 }
 if(!exactOutcomeProof(row,proof)||result.status!==(proof.outcome==='conflict'?'conflict':'rejected'))return;
 return row;
}
function sameReceiptIdentity(before:Row,after:Row|undefined):after is Row{
 return Boolean(after&&RECEIPT_IDENTITY_FIELDS.every(field=>after[field]===before[field]));
}
function transaction<T>(db:DatabaseSync,operation:()=>T):T{
 db.exec('BEGIN IMMEDIATE');try{const value=operation();db.exec('COMMIT');return value;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

export function createHostSettingsOperationReceiptStore({db,now=()=>Date.now(),claimLeaseMs=30_000}: {
 db:DatabaseSync;now?:()=>number;claimLeaseMs?:number
}){
 if(!db||typeof db.prepare!=='function'||!Number.isSafeInteger(claimLeaseMs)||claimLeaseMs<1000||claimLeaseMs>300_000)throw new TypeError('host_settings_receipt_store_config_invalid');
 assertHostSettingsOperationReceiptSchema(db);
 const getByKey=db.prepare('SELECT * FROM ga_host_settings_operations WHERE owner_id=? AND operation=? AND idempotency_key=?');
 const getById=db.prepare('SELECT * FROM ga_host_settings_operations WHERE operation_id=?');
 const hasVersionSchema=()=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_host_settings_versions'").get());
 const getVersion=(ownerId:string,profileId:string,namespace:string)=>db.prepare('SELECT * FROM ga_host_settings_versions WHERE owner_id=? AND profile_id=? AND namespace=?').get(ownerId,profileId,namespace);
 // R's approved M23 slice validates one permanent receipt row; it adds no migration or Host write authority.
 function stored(row:unknown):Row|undefined{return storedReceipt(row);}
 function storedVersion(row:unknown):VersionRow|undefined{return record(row)?row as VersionRow:undefined;}
 function safeNow(){const value=now();if(!Number.isSafeInteger(value)||value<0)throw new TypeError('host_settings_receipt_clock_invalid');return value;}
 function makeTerminal(row:Row,state:'completed'|'no_side_effect',result:Record<string,unknown>,proof?:Proof,reservationToken?:string){
  const safe=validateHostSettingsProductResult(result,row.namespace),now=safeNow(),at=timestamp(now);
  const update=db.prepare(`UPDATE ga_host_settings_operations SET state=?,result_json=?,host_proof_json=?,updated_at=?,reservation_token_sha256=NULL,reservation_expires_at=NULL
   WHERE operation_id=? AND state=? AND request_sha256=?`);
  const prior=row.state;
  const allowed=state==='completed'?(prior==='dispatched'||prior==='unknown'):(prior==='reserved'||prior==='dispatched'||prior==='unknown');
  if(!allowed)return{ok:false as const};
  if(state==='no_side_effect'&&prior==='reserved'){
   if(typeof reservationToken!=='string'||!RESERVATION_TOKEN.test(reservationToken)||row.reservation_token_sha256!==tokenDigest(reservationToken)
    ||!Number.isFinite(Date.parse(row.reservation_expires_at??''))||Date.parse(row.reservation_expires_at??'')<=now)return{ok:false as const};
  }
  if(state==='completed'&&(safe.status!=='saved'||!proof||!proofMatches(row,proof,'applied')
   ||safe.settings_version!==row.expected_version+1||digest(safe.settings)!==proof.observed_settings_sha256))return{ok:false as const};
  if(state==='no_side_effect'){
   if(!['held','rejected','conflict','stale_scope'].includes(String(safe.status)))return{ok:false as const};
   if(prior!=='reserved'){
    if(!proof||!exactOutcomeProof(row,proof)||safe.status!==(proof.outcome==='conflict'?'conflict':'rejected'))return{ok:false as const};
   }
  }
  if(state==='completed'){
   if(!Number.isSafeInteger(row.expected_dsh_revision)||!HASH.test(row.base_settings_sha256??''))return{ok:false as const};
    if(!hasVersionSchema())return{ok:false as const};
    const version=storedVersion(getVersion(row.owner_id,row.profile_id,row.namespace));
   if(!version||version.settings_version!==row.expected_version||version.dsh_revision!==row.expected_dsh_revision
    ||version.schema_fingerprint!==row.schema_fingerprint||version.settings_sha256!==row.base_settings_sha256)return{ok:false as const};
   const nextVersion=row.expected_version+1;
   if(!Number.isSafeInteger(nextVersion)||db.prepare(`UPDATE ga_host_settings_versions SET settings_version=?,dsh_revision=?,schema_fingerprint=?,settings_sha256=?,updated_at=?
      WHERE owner_id=? AND profile_id=? AND namespace=? AND settings_version=? AND dsh_revision=? AND schema_fingerprint=? AND settings_sha256=?`)
     .run(nextVersion,proof!.settings_revision,proof!.schema_fingerprint,proof!.observed_settings_sha256,at,row.owner_id,row.profile_id,row.namespace,
      row.expected_version,row.expected_dsh_revision,row.schema_fingerprint,row.base_settings_sha256).changes!==1)throw new Error('host_settings_version_cas_failed');
  }
  const evidence=state==='no_side_effect'&&prior==='reserved'?{protocol:1,source:'gateway-receipt-cas',outcome:'not_dispatched',operation_id:row.operation_id,request_sha256:row.request_sha256,prior_state:'reserved',observed_at:at}:proof;
  if(update.run(state,boundedJson(safe,65536),evidence?boundedJson(evidence,8192):null,at,row.operation_id,prior,row.request_sha256).changes!==1)throw new Error('host_settings_receipt_finalize_failed');
  if(stored(getById.get(row.operation_id))?.state!==state)throw new Error('host_settings_receipt_write_invalid');
  return{ok:true as const};
 }
 return Object.freeze({
  readVersion(input:VersionIdentity,observed:ObservedVersion){
   if(!record(input)||!OWNER_ID.test(input.owner_id??'')||!OWNER_ID.test(input.profile_id??'')||!NAMESPACE.test(input.namespace??'')||input.namespace==='jot-host-policy'
    ||!record(observed)||observed.owner_id!==input.owner_id||observed.profile_id!==input.profile_id||observed.namespace!==input.namespace
    ||!Number.isSafeInteger(observed.dsh_revision)||observed.dsh_revision<0||!HASH.test(observed.schema_fingerprint??'')||!HASH.test(observed.settings_sha256??''))return{kind:'unavailable' as const};
    if(!hasVersionSchema())return{kind:'reconcile_required' as const,reason:'settings_version_missing' as const};
    const row=storedVersion(getVersion(input.owner_id,input.profile_id,input.namespace));
   if(!row)return{kind:'reconcile_required' as const,reason:'settings_version_missing' as const};
   if(row.dsh_revision!==observed.dsh_revision||row.schema_fingerprint!==observed.schema_fingerprint||row.settings_sha256!==observed.settings_sha256)
    return{kind:'reconcile_required' as const,reason:'settings_source_drift' as const};
   return{kind:'ready' as const,settings_version:Number(row.settings_version)};
  },
  reconcileVersion(input:ReconcileVersionInput){
    if(!record(input)||!OWNER_ID.test(input.owner_id??'')||!OWNER_ID.test(input.profile_id??'')||!NAMESPACE.test(input.namespace??'')||input.namespace==='jot-host-policy'
    ||!Number.isSafeInteger(input.dsh_revision)||input.dsh_revision<0||!HASH.test(input.schema_fingerprint??'')||!HASH.test(input.settings_sha256??'')
    ||!HASH.test(input.approval_sha256??'')||input.expected_version!==null&&(!Number.isSafeInteger(input.expected_version)||input.expected_version<1))return{kind:'unavailable' as const};
    if(!hasVersionSchema())return{kind:'unavailable' as const};
   return transaction(db,()=>{
     const prior=storedVersion(getVersion(input.owner_id,input.profile_id,input.namespace));
    if(prior&&prior.reconciliation_sha256===input.approval_sha256&&prior.dsh_revision===input.dsh_revision
      &&prior.schema_fingerprint===input.schema_fingerprint&&prior.settings_sha256===input.settings_sha256)
      return{kind:'reconciled' as const,settings_version:Number(prior.settings_version)};
    if(!prior&&input.expected_version!==null||prior&&input.expected_version!==prior.settings_version)return{kind:'conflict' as const};
    const nextVersion=prior?Number(prior.settings_version)+1:1;
    if(!Number.isSafeInteger(nextVersion))return{kind:'unavailable' as const};
    const at=timestamp(safeNow());
    if(prior){
     if(db.prepare(`UPDATE ga_host_settings_versions SET settings_version=?,dsh_revision=?,schema_fingerprint=?,settings_sha256=?,reconciliation_sha256=?,updated_at=?
       WHERE owner_id=? AND profile_id=? AND namespace=? AND settings_version=? AND reconciliation_sha256=?`)
      .run(nextVersion,input.dsh_revision,input.schema_fingerprint,input.settings_sha256,input.approval_sha256,at,input.owner_id,input.profile_id,input.namespace,
       prior.settings_version,prior.reconciliation_sha256).changes!==1)return{kind:'conflict' as const};
    }else db.prepare(`INSERT INTO ga_host_settings_versions(owner_id,profile_id,namespace,settings_version,dsh_revision,schema_fingerprint,settings_sha256,reconciliation_sha256,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.owner_id,input.profile_id,input.namespace,nextVersion,input.dsh_revision,input.schema_fingerprint,input.settings_sha256,input.approval_sha256,at);
    return{kind:'reconciled' as const,settings_version:nextVersion};
   });
  },
  reserve(input:Scope):HostSettingsOperationReserveV1{
   let scope;try{scope=scopeFor(input);}catch{return{kind:'unavailable'};}
   return transaction(db,()=>{
    const at=safeNow(),iso=timestamp(at);
    const rawExisting=getByKey.get(scope.owner_id,scope.operation,scope.idempotency_key);
    const existing=stored(rawExisting);
    if(rawExisting!==undefined&&!existing)return{kind:'unavailable'};
    if(existing){
     if(existing.request_sha256!==scope.request_sha256)return{kind:'conflict'};
     if(existing.state==='completed'||existing.state==='no_side_effect'){
      const result=resultFor(existing);return result?{kind:existing.state,operation_id:existing.operation_id,result}:{kind:'unavailable'};
     }
     if(existing.state==='dispatched'||existing.state==='unknown')return{kind:'pending',operation_id:existing.operation_id,state:existing.state};
     if(existing.state!=='reserved')return{kind:'unavailable'};
     // reservation_expires_at is only the claim lease; the permanent receipt/key is held, never reissued.
     return{kind:'pending',operation_id:existing.operation_id,state:'reserved'};
    }
     if(!hasVersionSchema())return{kind:'reconcile_required' as const};
     const version=storedVersion(getVersion(scope.owner_id,scope.profile_id,scope.namespace));
    if(!version||version.settings_version!==scope.expected_version||version.dsh_revision!==scope.expected_dsh_revision
      ||version.schema_fingerprint!==scope.schema_fingerprint||version.settings_sha256!==scope.base_settings_sha256)return{kind:'reconcile_required'};
    const operationId=randomUUID(),token=randomBytes(32).toString('base64url'),until=timestamp(at+claimLeaseMs);
    db.prepare(`INSERT INTO ga_host_settings_operations(operation_id,owner_id,actor_id,profile_id,host_instance_id,policy_epoch,namespace,operation,idempotency_key,
     request_sha256,expected_version,expected_dsh_revision,base_settings_sha256,schema_fingerprint,patch_sha256,state,reservation_token_sha256,reservation_expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?)`)
     .run(operationId,scope.owner_id,scope.actor_id,scope.profile_id,scope.host_instance_id,scope.policy_epoch,scope.namespace,scope.operation,scope.idempotency_key,
      scope.request_sha256,scope.expected_version,scope.expected_dsh_revision,scope.base_settings_sha256,scope.schema_fingerprint,scope.patch_sha256,tokenDigest(token),until,iso,iso);
    if(!stored(getById.get(operationId)))throw new Error('host_settings_receipt_write_invalid');
    return{kind:'reserved',operation_id:operationId,reservation_token:token,request_sha256:scope.request_sha256};
   });
  },
  lookupOriginal(input:OriginalLookupInput){
   if(!OWNER_ID.test(input?.owner_id??'')||input.operation!=='settings.update'||!KEY.test(input.idempotency_key??''))return{kind:'unavailable'};
   if(input.actor_id!==undefined&&!OWNER_ID.test(input.actor_id)||input.profile_id!==undefined&&!OWNER_ID.test(input.profile_id)
    ||input.host_instance_id!==undefined&&!OWNER_ID.test(input.host_instance_id)||input.policy_epoch!==undefined&&(!Number.isSafeInteger(input.policy_epoch)||input.policy_epoch<1))return{kind:'unavailable'};
   const commandFields=['namespace','expected_version','schema_fingerprint','patch'];
   const hasCommand=commandFields.some(key=>Object.hasOwn(input,key));
   if(hasCommand&&(!NAMESPACE.test(input.namespace??'')||input.namespace==='jot-host-policy'||!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1
    ||!HASH.test(input.schema_fingerprint??'')||!record(input.patch)))return{kind:'unavailable'};
   try{return transaction(db,()=>{
    const raw=getByKey.get(input.owner_id,input.operation,input.idempotency_key);if(raw===undefined)return{kind:'absent'};
    const row=stored(raw);if(!row)return{kind:'unavailable'};
    for(const key of ['actor_id','profile_id','host_instance_id','policy_epoch'] as const)if(input[key]!==undefined&&row[key]!==input[key])return{kind:'conflict'};
    if(input.request_sha256!==undefined&&input.request_sha256!==row.request_sha256)return{kind:'conflict'};
    if(hasCommand){
     let patchSha:string;
     try{patchSha=digest(validateHostSettingsProductCommand({expected_version:input.expected_version,expected_schema_fingerprint:input.schema_fingerprint,settings:input.patch}).settings);}catch{return{kind:'unavailable'};}
     if(input.namespace!==row.namespace||input.expected_version!==row.expected_version||input.schema_fingerprint!==row.schema_fingerprint||patchSha!==row.patch_sha256)return{kind:'conflict'};
    }
    if(row.state==='reserved')return{kind:'reserved',operation_id:row.operation_id,state:'reserved',request_sha256:row.request_sha256};
    if(row.state==='dispatched')return{kind:'pending',operation_id:row.operation_id,state:'dispatched',request_sha256:row.request_sha256};
    if(row.state==='unknown')return{kind:'unknown',operation_id:row.operation_id,request_sha256:row.request_sha256,result:{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'}};
    if(row.state==='completed'||row.state==='no_side_effect'){
     const result=resultFor(row);return result?{kind:row.state,operation_id:row.operation_id,request_sha256:row.request_sha256,result}:{kind:'unavailable'};
    }
    return{kind:'unavailable'};
   });}catch{return{kind:'unavailable'};}
  },
  markDispatched(input:{operation_id:string;reservation_token:string;request_sha256:string}){
   if(!OPERATION_ID.test(input?.operation_id??'')||!RESERVATION_TOKEN.test(input.reservation_token??'')||!HASH.test(input.request_sha256??''))return{ok:false as const};
   const at=safeNow();return transaction(db,()=>{
    const row=stored(getById.get(input.operation_id));
    if(!row||row.state!=='reserved'||row.request_sha256!==input.request_sha256||row.reservation_token_sha256!==tokenDigest(input.reservation_token)
     ||Date.parse(row.reservation_expires_at??'')<=at)return{ok:false as const};
    const changes=db.prepare(`UPDATE ga_host_settings_operations SET state='dispatched',reservation_token_sha256=NULL,reservation_expires_at=NULL,updated_at=?
     WHERE operation_id=? AND state='reserved' AND reservation_token_sha256=? AND request_sha256=? AND reservation_expires_at>?`)
     .run(timestamp(at),input.operation_id,tokenDigest(input.reservation_token),input.request_sha256,timestamp(at)).changes;
    if(changes!==1)return{ok:false as const};
    // Dispatch may change state/lease only; the original scope and identity remain immutable.
    const written=stored(getById.get(input.operation_id));
    if(!written||written.state!=='dispatched'||!sameReceiptIdentity(row,written))throw new Error('host_settings_receipt_write_invalid');
    return{ok:true as const};
   });
  },
  complete(input:{operation_id:string;request_sha256:string;result:unknown;proof?:unknown}){
   if(typeof input?.operation_id!=='string'||!HASH.test(input.request_sha256??''))return{ok:false as const};
   try{return transaction(db,()=>{const row=stored(getById.get(input.operation_id));if(!row||row.request_sha256!==input.request_sha256)return{ok:false as const};
     const result=record(input.result)?input.result:undefined;if(!result)return{ok:false as const};
     return makeTerminal(row,'completed',result,input.proof as Proof|undefined);
    });}catch{return{ok:false as const};}
  },
  markUnknown(input:{operation_id:string;request_sha256:string;reason:'host_settings_outcome_unknown'}){
   if(typeof input?.operation_id!=='string'||!HASH.test(input.request_sha256??'')||input.reason!=='host_settings_outcome_unknown')return{ok:false as const};
   const at=safeNow();return transaction(db,()=>{
    const row=stored(getById.get(input.operation_id));if(!row||row.request_sha256!==input.request_sha256)return{ok:false as const};
    if(row.state==='unknown')return{ok:true as const};
    const changes=db.prepare(`UPDATE ga_host_settings_operations SET state='unknown',result_json=?,updated_at=?
     WHERE operation_id=? AND state='dispatched' AND request_sha256=?`).run(JSON.stringify({status:'unknown_pending',reason_code:'host_settings_outcome_unknown'}),timestamp(at),input.operation_id,input.request_sha256).changes;
    if(changes!==1)return{ok:false as const};
    if(stored(getById.get(input.operation_id))?.state!=='unknown')throw new Error('host_settings_receipt_write_invalid');
    return{ok:true as const};
   });
  },
  rejectNoSideEffect(input:{operation_id:string;request_sha256:string;reservation_token?:string;result:unknown;proof?:unknown}){
   if(typeof input?.operation_id!=='string'||!HASH.test(input.request_sha256??'')||!record(input.result))return{ok:false as const};
   return transaction(db,()=>{const row=stored(getById.get(input.operation_id));if(!row||row.request_sha256!==input.request_sha256)return{ok:false as const};
    return makeTerminal(row,'no_side_effect',input.result as Record<string,unknown>,input.proof as Proof|undefined,input.reservation_token);
   });
  },
 });
}

/** Convert the durable DAO states to the Host product service's receipt port. */
export function mapHostSettingsOriginalReceiptPort(value:unknown):HostSettingsOriginalReceiptPortV1{
 if(!record(value)||typeof value.kind!=='string')return{kind:'unavailable'};
 if(value.kind==='absent')return{kind:'absent'};
 if(value.kind==='conflict')return{kind:'conflict'};
 if(value.kind==='unavailable')return{kind:'unavailable'};
 if(value.kind==='reserved'||value.kind==='pending'||value.kind==='unknown')return{kind:'pending'};
 if(value.kind==='completed'||value.kind==='no_side_effect'){
  const receipt=record(value.result)?value.result:undefined;
  if(!receipt)return{kind:'unavailable'};
  return{kind:'completed',receipt};
 }
 return{kind:'unavailable'};
}

/**
 * Build the authenticated lookup adapter used by the Host product service.
 * `resolveHostOwner` must validate the Host context ticket and return the
 * profile-bound owner; caller-supplied owner ids are never accepted.
 */
export function createHostSettingsOriginalReceiptAdapter({store,expectedGatewayId,authenticateComponent,resolveHostOwner}: {
 store:Pick<ReturnType<typeof createHostSettingsOperationReceiptStore>,'lookupOriginal'>;
 expectedGatewayId:string;
 authenticateComponent:(authorization:unknown)=>string|undefined|Promise<string|undefined>;
 resolveHostOwner:(input:Readonly<{ticket:string;namespace:string;gateway_id:string}>)=>Readonly<{owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number}>|undefined|Promise<Readonly<{owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number}>|undefined>;
}){
 if(!store||typeof store.lookupOriginal!=='function'||typeof expectedGatewayId!=='string'||!expectedGatewayId
  ||typeof authenticateComponent!=='function'||typeof resolveHostOwner!=='function')throw new TypeError('host_settings_original_adapter_invalid');
 return Object.freeze({async lookupOriginal(input:Record<string,unknown>):Promise<HostSettingsOriginalReceiptPortV1>{
  const allowed=['authorization','ticket','namespace','idempotency_key','expected_version','expected_schema_fingerprint','patch'];
  if(!record(input)||Object.keys(input).some(key=>!allowed.includes(key)))return{kind:'unavailable'};
  const authorization=typeof input.authorization==='string'?input.authorization:'';
  const ticket=typeof input.ticket==='string'?input.ticket:'';
  const namespace=typeof input.namespace==='string'?input.namespace:'';
  const idempotencyKey=typeof input.idempotency_key==='string'?input.idempotency_key:'';
  if(!authorization||ticket.length<32||ticket.length>128||!NAMESPACE.test(namespace)||namespace==='jot-host-policy'||!KEY.test(idempotencyKey))return{kind:'unavailable'};
  const hasCommand=['expected_version','expected_schema_fingerprint','patch'].some(key=>Object.hasOwn(input,key));
  const expectedVersion=input.expected_version;
  const schemaFingerprint=typeof input.expected_schema_fingerprint==='string'?input.expected_schema_fingerprint:'';
  const patch=record(input.patch)?input.patch:undefined;
  if(hasCommand&&(!Number.isSafeInteger(expectedVersion)||!HASH.test(schemaFingerprint)||!patch))return{kind:'unavailable'};
  let gatewayId:string|undefined,hostOwner:Readonly<{owner_id:string;actor_id:string;profile_id:string;host_instance_id:string;policy_epoch:number}>|undefined;
  try{gatewayId=await authenticateComponent(authorization);if(gatewayId!==expectedGatewayId)return{kind:'unavailable'};
   hostOwner=await resolveHostOwner({ticket,namespace,gateway_id:gatewayId});}catch{return{kind:'unavailable'};}
  if(!hostOwner||!OWNER_ID.test(hostOwner.owner_id??'')||!OWNER_ID.test(hostOwner.actor_id??'')||!OWNER_ID.test(hostOwner.profile_id??'')
   ||!OWNER_ID.test(hostOwner.host_instance_id??'')||!Number.isSafeInteger(hostOwner.policy_epoch)||hostOwner.policy_epoch<1)return{kind:'unavailable'};
  let row:unknown;
  try{row=store.lookupOriginal({owner_id:hostOwner.owner_id,actor_id:hostOwner.actor_id,profile_id:hostOwner.profile_id,
   host_instance_id:hostOwner.host_instance_id,policy_epoch:hostOwner.policy_epoch,operation:'settings.update',idempotency_key:idempotencyKey,
   ...(hasCommand?{namespace,expected_version:expectedVersion as number,schema_fingerprint:schemaFingerprint,patch:patch as Record<string,unknown>}: {})});}
  catch{return{kind:'unavailable'};}
  return mapHostSettingsOriginalReceiptPort(row);
 }});
}
