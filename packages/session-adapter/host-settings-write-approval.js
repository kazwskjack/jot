import {createHash,randomBytes} from 'node:crypto';
import {hostSettingsProductCommand} from './host-settings-product-service.js';

const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const HASH=/^[a-f0-9]{64}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const owner=peer=>peer?.principal?.kind==='owner';
const fail=code=>{throw Error(code);};
function canonical(v,depth=0){
 if(depth>12)return fail('host_settings_approval_review_invalid');
 if(Array.isArray(v))return`[${v.map(x=>canonical(x,depth+1)).join(',')}]`;
 if(record(v))return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k],depth+1)}`).join(',')}}`;
 if(v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
 return fail('host_settings_approval_review_invalid');
}
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const random=()=>randomBytes(32).toString('base64url');
function validateReview(value){
 if(!exact(value,['purpose','identity','observation','command'])||!['settings.update','settings.reconcile'].includes(value.purpose))return fail('host_settings_approval_review_invalid');
 const id=value.identity,observed=value.observation;
 if(!exact(id,['owner_id','actor_id','profile_id','host_instance_id','policy_epoch','namespace'])
  ||!['owner_id','actor_id','profile_id','host_instance_id'].every(k=>typeof id[k]==='string'&&ID.test(id[k]))
  ||!Number.isSafeInteger(id.policy_epoch)||id.policy_epoch<1||typeof id.namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(id.namespace)||id.namespace==='jot-host-policy'
  ||!exact(observed,['settings_version','dsh_revision','schema_version','schema_fingerprint','settings_sha256','configuration_sha256','document_sha256','migration','active_run_impact'])
  ||observed.settings_version!==null&&(!Number.isSafeInteger(observed.settings_version)||observed.settings_version<1)
  ||!Number.isSafeInteger(observed.dsh_revision)||observed.dsh_revision<0||!Number.isSafeInteger(observed.schema_version)||observed.schema_version<1
  ||!['schema_fingerprint','settings_sha256','configuration_sha256','document_sha256'].every(k=>typeof observed[k]==='string'&&HASH.test(observed[k]))
  ||!exact(observed.migration,['state','legacy_document_sha256','legacy_imported_sha256'])||!['unknown','migrated','not_required'].includes(observed.migration.state)
  ||!['legacy_document_sha256','legacy_imported_sha256'].every(k=>observed.migration[k]===null||typeof observed.migration[k]==='string'&&HASH.test(observed.migration[k]))
  ||observed.migration.state==='not_required'&&(observed.migration.legacy_document_sha256!==null||observed.migration.legacy_imported_sha256!==null)
  ||observed.migration.state==='migrated'&&(observed.migration.legacy_document_sha256!==null||!HASH.test(observed.migration.legacy_imported_sha256??''))
  ||value.purpose==='settings.update'&&(!exact(observed.active_run_impact,['active_runs','active_sessions'])
    ||!['active_runs','active_sessions'].every(k=>observed.active_run_impact[k]===null||Number.isSafeInteger(observed.active_run_impact[k])&&observed.active_run_impact[k]>=0)
    ||(observed.active_run_impact.active_runs===null)!==(observed.active_run_impact.active_sessions===null))
  ||value.purpose==='settings.reconcile'&&observed.active_run_impact!==null)return fail('host_settings_approval_review_invalid');
 if(value.purpose==='settings.reconcile'){
  if(value.command!==null)return fail('host_settings_approval_review_invalid');
 }else{
  if(!exact(value.command,['idempotency_key','expected_version','expected_schema_fingerprint','settings'])
   ||typeof value.command.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value.command.idempotency_key))return fail('host_settings_approval_review_invalid');
  const {idempotency_key,...command}=value.command;hostSettingsProductCommand(command);
  if(command.expected_version!==observed.settings_version||command.expected_schema_fingerprint!==observed.schema_fingerprint)return fail('host_settings_approval_review_invalid');
 }
 const text=canonical(value);if(Buffer.byteLength(text,'utf8')>65536)return fail('host_settings_approval_review_invalid');
 return{review:structuredClone(value),sha256:hash(text)};
}
export function hostSettingsOwnerReviewDigest(review){return validateReview(review).sha256;}

/** Producer is invoked only behind the existing Connection owner admission.
 * The injected review reader must derive facts from authenticated A1/native
 * sources. No browser Boolean, read ticket or arbitrary peer constructs a grant. */
export function createHostSettingsOwnerApproval({readCurrentReview,now=()=>Date.now(),lifetimeMs=90000,maxPending=32}={}){
 if(typeof readCurrentReview!=='function'||!Number.isSafeInteger(lifetimeMs)||lifetimeMs<1000||lifetimeMs>90000
  ||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>128)throw TypeError('host_settings_approval_configuration_invalid');
 const challenges=new Map(),grants=new Map();
 function time(){const at=now();if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(at+lifetimeMs))return fail('host_settings_approval_clock_invalid');return at;}
 function purge(at){for(const map of [challenges,grants])for(const[k,v]of map)if(v.expiresAt<=at)map.delete(k);}
 return Object.freeze({
  async prepare(request){
   const input=structuredClone(request),value=validateReview(await readCurrentReview(input)),at=time();purge(at);
   if(challenges.size+grants.size>=maxPending)return fail('host_settings_approval_capacity');
   const challenge=random(),key=hash(challenge);if(challenges.has(key))return fail('host_settings_approval_unavailable');
   challenges.set(key,{input,...value,expiresAt:at+lifetimeMs,nonceHash:null});
   return{challenge_id:challenge,purpose:value.review.purpose,review_sha256:value.sha256,expires_at:at+lifetimeMs};
  },
  open({peer,challenge_id}={}){
   if(!owner(peer))return fail('host_settings_owner_required');
   const at=time();purge(at);if(!TOKEN.test(challenge_id??''))return fail('host_settings_approval_invalid');
   const entry=challenges.get(hash(challenge_id));if(!entry)return fail('host_settings_approval_invalid');
   const nonce=random();entry.nonceHash=hash(nonce);
   return{challenge_id,owner_page_nonce:nonce,review_sha256:entry.sha256,review:structuredClone(entry.review),expires_at:entry.expiresAt};
  },
  async approve({peer,challenge_id,owner_page_nonce,review_sha256}={}){
   if(!owner(peer))return fail('host_settings_owner_required');
   const at=time();purge(at);
   if(!TOKEN.test(challenge_id??'')||!TOKEN.test(owner_page_nonce??'')||!HASH.test(review_sha256??''))return fail('host_settings_approval_invalid');
   const key=hash(challenge_id),entry=challenges.get(key);
   if(!entry||entry.nonceHash!==hash(owner_page_nonce)||entry.sha256!==review_sha256)return fail('host_settings_approval_invalid');
   challenges.delete(key); // Consume before awaiting any fresh source read.
   const fresh=validateReview(await readCurrentReview(entry.input));
   if(fresh.sha256!==entry.sha256||time()>=entry.expiresAt)return fail('host_settings_approval_stale');
   const token=random(),grantKey=hash(token);if(grants.has(grantKey))return fail('host_settings_approval_unavailable');
   grants.set(grantKey,{...entry,peer});
   return{kind:entry.review.purpose==='settings.update'?'owner_settings_write':'owner_settings_reconcile',token};
  },
  async consume({approval,purpose,expected_review_sha256}={}){
   const at=time();purge(at);
   if(!exact(approval,['kind','token'])||!TOKEN.test(approval.token??'')||!HASH.test(expected_review_sha256??''))return{ok:false};
   const key=hash(approval.token),entry=grants.get(key);
   if(!entry||entry.review.purpose!==purpose||entry.sha256!==expected_review_sha256
    ||approval.kind!==(purpose==='settings.update'?'owner_settings_write':'owner_settings_reconcile')||!owner(entry.peer))return{ok:false};
   grants.delete(key);
   try{
    const fresh=validateReview(await readCurrentReview(entry.input));
    if(fresh.sha256!==entry.sha256||time()>=entry.expiresAt)return{ok:false};
   }catch{return{ok:false};}
   return{ok:true,peer:entry.peer,review:structuredClone(entry.review),approval_sha256:entry.sha256};
  }
 });
}
