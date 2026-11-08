import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {resolveOwnerBoundDshProfileContext} from './dsh-profile-binding.js';
import {hostSettingsSchemaFingerprint,normalizeHostSettingsWritePatch} from './host-settings-write-candidate.js';
import {hostSettingsProductCommand} from './host-settings-product-service.js';
import {createHostSettingsMigrationProofReader} from './host-settings-migration-proof.js';

const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const fail=code=>{throw Error(code??'host_settings_reconciliation_source_unavailable');};
function canonical(v,depth=0){
 if(depth>16)return fail();
 if(Array.isArray(v))return`[${v.map(x=>canonical(x,depth+1)).join(',')}]`;
 if(record(v))return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k],depth+1)}`).join(',')}}`;
 if(v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
 return fail();
}
const hash=v=>createHash('sha256').update(v).digest('hex');
const digest=v=>{const value=canonical(v);if(Buffer.byteLength(value,'utf8')>262144)return fail();return hash(value);};
const fields=['mode','workspace_id','provider_id','model_id','plugin_selection'];
const held=reason=>({status:'held',reason_code:reason});

/** Original Host ConfigEditor/descriptor source plus existing Gateway ledger.
 * Only digests of persisted configuration leave this reader. Migration advances
 * only when the selected DSH package's private proof passes every binding check. */
export function createHostSettingsReconciliationSource({settingsController,configEditor,readProfileContext,readIdentity,readSessionRefs,workbenchBridge,productSchema}={}){
 if(typeof settingsController?.describe!=='function'||typeof configEditor?.configuration!=='function'||typeof readProfileContext!=='function'
  ||typeof readIdentity!=='function'||typeof readSessionRefs!=='function'||typeof workbenchBridge?.requestHostSettings!=='function')throw TypeError('host_settings_reconciliation_dependency_invalid');
 if(!exact(productSchema,['schema_version','schema_fingerprint'])||!Number.isSafeInteger(productSchema.schema_version)||productSchema.schema_version<1
  ||typeof productSchema.schema_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(productSchema.schema_fingerprint))throw TypeError('host_settings_product_schema_invalid');
 const provision=Object.freeze({...productSchema});
 async function readActivityImpact(identity){
  const binding={owner_id:identity.owner_id,profile_id:identity.profile_id,namespace:identity.namespace};
  let sessionRefs=null,value;
  try{const refs=readSessionRefs();if(Array.isArray(refs))sessionRefs=refs;}catch{}
  try{value=await workbenchBridge.requestHostSettings('activity/preview',{identity:binding,session_refs:sessionRefs});}
  catch{return{active_runs:null,active_sessions:null};}
  if(!record(value)||!exact(value.identity,['owner_id','profile_id','namespace'])||digest(value.identity)!==digest(binding))
   return{active_runs:null,active_sessions:null};
  if(value.kind==='unknown'&&exact(value,['kind','identity']))return{active_runs:null,active_sessions:null};
  if(!exact(value,['kind','identity','active_runs','active_sessions'])||value.kind!=='ready'||!Number.isSafeInteger(value.active_runs)||value.active_runs<0
   ||!Number.isSafeInteger(value.active_sessions)||value.active_sessions<0)return{active_runs:null,active_sessions:null};
  return{active_runs:value.active_runs,active_sessions:value.active_sessions};
 }
 function legacyDigest(home,name){
  if(typeof home!=='string'||!isAbsolute(home))return fail('host_settings_legacy_source_unavailable');
  let root;try{root=realpathSync(home);}catch{return fail('host_settings_legacy_source_unavailable');}
  const path=resolve(root,name);let info,actual;
  try{info=lstatSync(path);actual=realpathSync(path);}catch(error){if(error?.code==='ENOENT')return null;return fail('host_settings_legacy_source_unavailable');}
  if(!info.isFile()||info.isSymbolicLink()||dirname(actual)!==root||info.size>1048576)return fail('host_settings_legacy_source_invalid');
  let bytes,after;try{bytes=readFileSync(path);after=lstatSync(path);}catch{return fail('host_settings_legacy_source_unavailable');}
  if(bytes.length>1048576||info.ino!==after.ino||info.size!==after.size||info.mtimeMs!==after.mtimeMs)return fail('host_settings_legacy_source_changed');
  return hash(bytes);
 }
 function capture(identity){
  const context=readProfileContext(),profile=resolveOwnerBoundDshProfileContext(context);
  if(profile.ownerId!==identity.owner_id||profile.profileId!==identity.profile_id)return fail();
  const path=configEditor.documentPath;
  if(typeof path!=='string'||!isAbsolute(path)||typeof context.patchPath!=='string'||resolve(path)!==resolve(context.patchPath))return fail();
  const info=lstatSync(path),actual=realpathSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1048576||dirname(actual)!==profile.profileDirectory)return fail();
  const bytes=readFileSync(path),after=lstatSync(path);
  if(bytes.length>1048576||info.ino!==after.ino||info.size!==after.size||info.mtimeMs!==after.mtimeMs)return fail('host_settings_reconciliation_source_changed');
  const rows=configEditor.configuration().filter(row=>row?.entry?.options?.id===identity.namespace);
  if(rows.length!==1||!record(rows[0].inherited)||!record(rows[0].override))return fail();
  const described=settingsController.describe();
  if(described?.writable!==true||described?.hasDocument!==true||!Array.isArray(described.namespaces))return fail();
  const descriptors=described.namespaces.filter(row=>row?.ns===identity.namespace);
  if(descriptors.length!==1)return fail();
  const descriptor=descriptors[0];
  if(descriptor.applies!=='live'||!Number.isSafeInteger(descriptor.revision)||descriptor.revision<0||!record(descriptor.value)
   ||!Array.isArray(descriptor.secrets)||descriptor.secrets.length!==0)return fail();
  const schemaFingerprint=hostSettingsSchemaFingerprint(descriptor.schema);
  if(schemaFingerprint!==provision.schema_fingerprint)return fail();
  const settings=normalizeHostSettingsWritePatch(Object.fromEntries(fields.filter(k=>Object.hasOwn(descriptor.value,k)).map(k=>[k,descriptor.value[k]])));
  if(Object.keys(settings).length!==fields.length)return fail();
  const migrationReader=createHostSettingsMigrationProofReader({profileHome:context.home,profileDirectory:profile.profileDirectory,namespace:identity.namespace});
  const migration={state:migrationReader.read(descriptor).state,legacy_document_sha256:legacyDigest(context.home,'settings.yaml'),
   legacy_imported_sha256:legacyDigest(context.home,'settings.yaml.imported')};
  return{dsh_revision:descriptor.revision,schema_version:provision.schema_version,schema_fingerprint:schemaFingerprint,
   settings_sha256:digest(settings),configuration_sha256:digest({inherited:rows[0].inherited,override:rows[0].override}),document_sha256:hash(bytes),migration};
 }
 async function readReview(request){
  if(!exact(request,['purpose','authenticated_actor_id','ticket','namespace','command'])||!['settings.update','settings.reconcile'].includes(request.purpose)
   ||typeof request.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(request.ticket))return fail();
  const identity=await readIdentity(request);
  if(!record(identity)||request.namespace!==identity.namespace||request.authenticated_actor_id!==identity.actor_id
   ||request.authenticated_actor_id!==identity.owner_id)return fail();
  let command=null;
  if(request.purpose==='settings.update'){
   if(!exact(request.command,['idempotency_key','expected_version','expected_schema_fingerprint','settings'])
    ||typeof request.command.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(request.command.idempotency_key))return fail();
   const{idempotency_key,...input}=request.command;
   command={idempotency_key,...hostSettingsProductCommand(input)};
  }else if(request.command!==null)return fail();
  const before=capture(identity),ledgerIdentity={owner_id:identity.owner_id,profile_id:identity.profile_id,namespace:identity.namespace};
  const activityImpact=command?await readActivityImpact(identity):null;
  const baseline=await workbenchBridge.requestHostSettings('version/inspect',{identity:ledgerIdentity});
  let version=null;
  if(baseline?.kind==='present'&&Number.isSafeInteger(baseline.settings_version)&&baseline.settings_version>=1)version=baseline.settings_version;
  else if(baseline?.kind!=='missing')return fail();
  const freshIdentity=await readIdentity(request),fresh=capture(freshIdentity),freshActivityImpact=command?await readActivityImpact(freshIdentity):null;
  if(digest(identity)!==digest(freshIdentity)||digest(before)!==digest(fresh)||digest(activityImpact)!==digest(freshActivityImpact))return fail('host_settings_reconciliation_source_changed');
  if(command&&(version===null||command.expected_version!==version||command.expected_schema_fingerprint!==before.schema_fingerprint
   ||baseline.dsh_revision!==before.dsh_revision||baseline.schema_fingerprint!==before.schema_fingerprint||baseline.settings_sha256!==before.settings_sha256))return fail();
  return{purpose:request.purpose,identity:structuredClone(identity),observation:{settings_version:version,...before,active_run_impact:activityImpact},command};
 }
 return Object.freeze({readReview,async reconcile({request,authority,approval,expected_review_sha256}={}){
  let approved;try{approved=await authority.consume({approval,purpose:'settings.reconcile',expected_review_sha256});}catch{return held('host_settings_owner_approval_invalid');}
  if(approved?.ok!==true||approved.peer?.principal?.kind!=='owner'||approved.review?.purpose!=='settings.reconcile')return held('host_settings_owner_approval_invalid');
  const review=approved.review;
  try{if(digest(await readReview(request))!==expected_review_sha256)return held('host_settings_reconciliation_source_changed');}
  catch{return held('host_settings_reconciliation_source_changed');}
  const observation=review.observation,id=review.identity;
  let result;
  try{result=await workbenchBridge.requestHostSettings('version/reconcile',{
   identity:{owner_id:id.owner_id,profile_id:id.profile_id,namespace:id.namespace},
   observed:{dsh_revision:observation.dsh_revision,schema_fingerprint:observation.schema_fingerprint,settings_sha256:observation.settings_sha256},
   expected_version:observation.settings_version,approval_sha256:approved.approval_sha256
  });}catch{return{status:'unknown_pending',reason_code:'host_settings_reconciliation_unknown'};}
  if(result?.kind!=='reconciled'||!Number.isSafeInteger(result.settings_version)||result.settings_version<1)return held('host_settings_reconciliation_conflict');
  try{
   const currentIdentity=await readIdentity(request),current=capture(currentIdentity);
   const{settings_version,active_run_impact,...native}=observation;
   if(digest(currentIdentity)!==digest(id)||digest(current)!==digest(native))return{status:'held',reason_code:'host_settings_reconciliation_source_changed',committed_settings_version:result.settings_version};
  }catch{return{status:'held',reason_code:'host_settings_reconciliation_source_changed',committed_settings_version:result.settings_version};}
  return{status:'reconciled',settings_version:result.settings_version,migration:{state:'unknown'}};
 }});
}
