import {randomUUID} from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {normalizeSupervisorScope,normalizeSupervisorDrain,normalizeDrainReceipt,supervisorUuid} from './host-supervisor-contract.mjs';

const phases=new Set(['available','downloading','downloaded','staged','awaiting-activation','activating','active','cancelled','failed','unknown']);
const terminalPhases=new Set(['active','cancelled','failed']);
const startupStatuses=new Set([null,'pending','attempted','healthy','rolled-back']);
const handoffStatuses=new Set(['requested','launched','healthy','rolled-back','unknown']);
const restoredStartupStatuses=new Set(['prepared','attempted','healthy','unknown']);
const phaseTransitions={
 available:new Set(['downloading','cancelled','failed']),
 downloading:new Set(['downloaded','cancelled','failed','unknown']),
 downloaded:new Set(['staged','cancelled','failed','unknown']),
 staged:new Set(['awaiting-activation','cancelled','failed','unknown']),
 'awaiting-activation':new Set(['activating','cancelled','failed','unknown']),
 activating:new Set(['active','failed','unknown'])
};
const digestPattern=/^[a-f0-9]{64}$/;
const sequencePattern=/^[1-9][0-9]{0,19}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const strongEtagPattern=/^"[\x21\x23-\x7e]*"$/;
const allowedDirectorySyncErrors=new Set(['EBADF','EISDIR','EINVAL','ENOTSUP','EPERM']);

function fail(code){throw new Error(code);}
function exactKeys(value,keys){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&
  Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
}
function plainRecord(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function validText(value,max=200){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
function freezeDeep(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const item of Object.values(value))freezeDeep(item);
  Object.freeze(value);
 }
 return value;
}
function sameAbsolutePath(left,right){
 const first=resolve(left),second=resolve(right);
 return process.platform==='win32'?first.toLocaleLowerCase('en-US')===second.toLocaleLowerCase('en-US'):first===second;
}
function stable(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
}
function normalizeTarget(target){
 const keys=['product','channel','platform','arch'];
 if(!exactKeys(target,keys)||keys.some(key=>!validText(target[key],100)))fail('desktop_update_target_invalid');
 return {product:target.product,channel:target.channel,platform:target.platform,arch:target.arch};
}
function targetKey(target,profile=target?.profile??'standalone'){
 const key=[target.product,target.channel,target.platform,target.arch];
 if(profile==='desktop-electron')key.push(profile);
 return JSON.stringify(key);
}
function normalizeSequence(value){if(typeof value!=='string'||!sequencePattern.test(value))fail('desktop_update_sequence_invalid');return value;}
function normalizeDigest(value,code='desktop_update_digest_invalid'){
 if(typeof value!=='string'||!digestPattern.test(value))fail(code);
 return value;
}
function normalizeReleaseId(value,profile='standalone'){
 const suffix=profile==='desktop-electron'?'desktop-electron':'standalone';
 const pattern=new RegExp('^[a-f0-9]{40,64}-[a-f0-9]{12}-'+suffix+'$','i');
 if(typeof value!=='string'||!pattern.test(value))fail('desktop_update_release_id_invalid');return value;
}
function normalizeRef(value,profile='standalone'){
 if(profile==='desktop-electron'){
  if(!exactKeys(value,['releaseId','manifestSha256','profile','runtimeSha256','target'])||value.profile!==profile||
   !plainRecord(value.target)||Object.keys(value.target).sort().join(',')!=='abi,arch,electronArchiveSha256,electronExecutableSha256,electronVersion,nodeVersion,platform,profile,runtimeKind'||
   value.target.profile!=='desktop-electron'||value.target.runtimeKind!=='electron'||
   typeof value.target.electronVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.target.electronVersion)||
   typeof value.target.nodeVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(value.target.nodeVersion)||
   !['win32','linux','darwin'].includes(value.target.platform)||typeof value.target.arch!=='string'||!validText(value.target.arch,100)||
   !plainRecord(value.target.abi)||Object.keys(value.target.abi).sort().join(',')!=='napi,node'||
   !/^\d+$/.test(value.target.abi.node??'')||!/^\d+$/.test(value.target.abi.napi??'')||
   !digestPattern.test(value.target.electronArchiveSha256??'')||!digestPattern.test(value.target.electronExecutableSha256??''))
   fail('desktop_update_deployment_invalid');
  return {releaseId:normalizeReleaseId(value.releaseId,profile),manifestSha256:normalizeDigest(value.manifestSha256),profile,
   runtimeSha256:normalizeDigest(value.runtimeSha256),target:{...value.target,abi:{...value.target.abi}}};
 }
 if(!exactKeys(value,['releaseId','manifestSha256','profile'])||value.profile!==profile)fail('desktop_update_deployment_invalid');
 return {releaseId:normalizeReleaseId(value.releaseId,profile),manifestSha256:normalizeDigest(value.manifestSha256),profile};
}
function normalizeDeployment(value,profile=value?.active?.profile??'standalone'){
 if(!exactKeys(value,['protocol','active','previous'])||value.protocol!==1)fail('desktop_update_deployment_invalid');
 return {protocol:1,active:normalizeRef(value.active,profile),previous:value.previous===null?null:normalizeRef(value.previous,profile)};
}
function normalizeReceipt(value,profile=value?.profile??'standalone'){
 const keys=['releaseId','envelopeDigest','manifestSha256','product','channel','platform','arch','sequence','profile'];
 if(!exactKeys(value,keys)||value.profile!==profile)fail('desktop_update_receipt_invalid');
 const target=normalizeTarget({product:value.product,channel:value.channel,platform:value.platform,arch:value.arch});
 return {
  releaseId:normalizeReleaseId(value.releaseId,profile),envelopeDigest:normalizeDigest(value.envelopeDigest),
  manifestSha256:normalizeDigest(value.manifestSha256),product:target.product,channel:target.channel,
  platform:target.platform,arch:target.arch,sequence:normalizeSequence(value.sequence),profile
 };
}
function normalizeDownloadMap(value){
 if(!plainRecord(value)||Object.keys(value).length>10000)fail('desktop_update_state_corrupt');
 const result={};
 for(const [filePath,entry] of Object.entries(value)){
  if(!validRelativePath(filePath)||!exactKeys(entry,['offset','etag'])||!Number.isSafeInteger(entry.offset)||entry.offset<0||
   !(entry.etag===null||typeof entry.etag==='string'&&strongEtagPattern.test(entry.etag))||(entry.offset>0&&!entry.etag))
   fail('desktop_update_state_corrupt');
  result[filePath]={offset:entry.offset,etag:entry.etag};
 }
 return result;
}
function validRelativePath(value){
 return typeof value==='string'&&value.length>0&&value.length<=1024&&!value.startsWith('/')&&!value.includes('\\')&&
  !/[\u0000-\u001f\u007f]/.test(value)&&!/%(?:2f|5c)/i.test(value)&&
  value.split('/').every(part=>part&&part!=='.'&&part!=='..');
}
function normalizeHandoff(value,operation){
 const keys=['protocol','operationId','profile','candidate','previous','recovery','state'];
 if(!exactKeys(value,keys)||value.protocol!==1||value.operationId!==operation.id||value.profile!=='desktop-electron'||
  operation.profile!=='desktop-electron'||!handoffStatuses.has(value.state)||!exactKeys(value.candidate,['releaseId','manifestSha256'])||
  !exactKeys(value.previous,['releaseId','manifestSha256'])||!exactKeys(value.recovery,['backupId','releaseId']))fail('desktop_update_handoff_invalid');
 const candidate={releaseId:normalizeReleaseId(value.candidate.releaseId,'desktop-electron'),manifestSha256:normalizeDigest(value.candidate.manifestSha256)};
 const previous={releaseId:normalizeReleaseId(value.previous.releaseId,'desktop-electron'),manifestSha256:normalizeDigest(value.previous.manifestSha256)};
 const recovery={backupId:normalizeDigest(value.recovery.backupId),releaseId:normalizeReleaseId(value.recovery.releaseId,'desktop-electron')};
 if(!operation.candidate||candidate.releaseId!==operation.candidate.releaseId||candidate.manifestSha256!==operation.candidate.manifestSha256||
  !operation.recoveryPoint||recovery.backupId!==operation.recoveryPoint.backupId||recovery.releaseId!==operation.recoveryPoint.releaseId||
  recovery.releaseId!==previous.releaseId)fail('desktop_update_handoff_identity_mismatch');
 return {protocol:1,operationId:operation.id,profile:'desktop-electron',candidate,previous,recovery,state:value.state};
}
function normalizeProcessContext(value){
 if(!exactKeys(value,['pid','execPath','releaseRoot'])||!Number.isSafeInteger(value.pid)||value.pid<1||
  typeof value.execPath!=='string'||!isAbsolute(value.execPath)||!sameAbsolutePath(resolve(value.execPath),value.execPath)||
  typeof value.releaseRoot!=='string'||!isAbsolute(value.releaseRoot)||!sameAbsolutePath(resolve(value.releaseRoot),value.releaseRoot)||
  !sameAbsolutePath(dirname(value.execPath),value.releaseRoot))fail('desktop_update_restored_startup_process_invalid');
 return {pid:value.pid,execPath:value.execPath,releaseRoot:value.releaseRoot};
}
function normalizeRestoredProbeReceipt(value,previous){
 if(!exactKeys(value,['instanceId','origin','readyAt','releaseId','status','target'])||!validText(value.instanceId,300)||
  value.releaseId!==previous.releaseId||value.status!=='ready'||!validText(value.readyAt,40))
  fail('desktop_update_restored_startup_probe_invalid');
 const readyAt=new Date(value.readyAt);
 if(!Number.isFinite(readyAt.getTime())||readyAt.toISOString()!==value.readyAt)fail('desktop_update_restored_startup_probe_invalid');
 let origin;try{origin=new URL(value.origin);}catch{fail('desktop_update_restored_startup_probe_invalid');}
 if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||
  stable(value.target)!==stable(previous.target))fail('desktop_update_restored_startup_probe_invalid');
 return {instanceId:value.instanceId,origin:value.origin,readyAt:value.readyAt,releaseId:value.releaseId,status:'ready',target:previous.target};
}
function normalizeRestoredStartup(value,operation){
 if(!exactKeys(value,['protocol','operationId','generation','nonce','previous','recovery','state','processContext','probeReceipt'])||
  value.protocol!==1||value.operationId!==operation.id||!Number.isSafeInteger(value.generation)||value.generation!==1||
  typeof value.nonce!=='string'||!uuidPattern.test(value.nonce)||!restoredStartupStatuses.has(value.state)||
  operation.profile!=='desktop-electron'||operation.phase!=='active'||operation.startupStatus!=='rolled-back'||
  !operation.rollback||!operation.rollbackTarget||!operation.handoff||operation.handoff.state!=='rolled-back')
  fail('desktop_update_state_corrupt');
 const previous=normalizeRef(value.previous,'desktop-electron');
 const recovery=value.recovery;
 if(!exactKeys(recovery,['backupId','releaseId']))fail('desktop_update_state_corrupt');
 const normalizedRecovery={backupId:normalizeDigest(recovery.backupId),releaseId:normalizeReleaseId(recovery.releaseId,'desktop-electron')};
 if(stable(previous)!==stable(operation.rollbackTarget)||previous.releaseId!==operation.rollback.activeReleaseId||
  operation.rollback.previousReleaseId!==operation.handoff.candidate.releaseId||
  previous.releaseId!==operation.handoff.previous.releaseId||previous.manifestSha256!==operation.handoff.previous.manifestSha256||
  normalizedRecovery.backupId!==operation.rollback.backupDigest||normalizedRecovery.backupId!==operation.handoff.recovery.backupId||
  normalizedRecovery.releaseId!==operation.handoff.recovery.releaseId||normalizedRecovery.releaseId!==operation.recoveryPoint?.releaseId||
  normalizedRecovery.backupId!==operation.recoveryPoint?.backupId||normalizedRecovery.releaseId!==previous.releaseId)
  fail('desktop_update_state_corrupt');
 let processContext=null,probeReceipt=null;
 if(value.processContext!==null)processContext=normalizeProcessContext(value.processContext);
 if(value.probeReceipt!==null)probeReceipt=normalizeRestoredProbeReceipt(value.probeReceipt,previous);
 if(value.state==='prepared'&&(processContext!==null||probeReceipt!==null)||
  value.state==='attempted'&&(!processContext||probeReceipt!==null)||
  value.state==='healthy'&&(!processContext||!probeReceipt)||value.state==='unknown'&&probeReceipt!==null)
  fail('desktop_update_state_corrupt');
 return {protocol:1,operationId:operation.id,generation:1,nonce:value.nonce.toLowerCase(),previous,recovery:normalizedRecovery,
  state:value.state,processContext,probeReceipt};
}
function normalizeOperation(value){
 const operationKeys=['id','targetKey','envelopeDigest','manifestSha256','phase','candidate','downloads','rollback','recoveryPoint','signedEnvelopeBase64'];
 const optionalKeys=['profile','startupStatus','handoff','rollbackTarget','restoredStartup','supervisorDrain'];
 const hasStartupStatus=plainRecord(value)&&Object.hasOwn(value,'startupStatus'),hasProfile=plainRecord(value)&&Object.hasOwn(value,'profile');
 const hasHandoff=plainRecord(value)&&Object.hasOwn(value,'handoff');
 if(!plainRecord(value)||operationKeys.some(key=>!Object.hasOwn(value,key))||
  Object.keys(value).some(key=>!operationKeys.includes(key)&&!optionalKeys.includes(key))||
  typeof value.id!=='string'||!uuidPattern.test(value.id)||typeof value.targetKey!=='string'||!validText(value.targetKey,500)||
  !digestPattern.test(value.envelopeDigest)||!digestPattern.test(value.manifestSha256)||!phases.has(value.phase))
  fail('desktop_update_state_corrupt');
 const operationProfile=hasProfile?value.profile:'standalone';
 if(!['standalone','desktop-electron'].includes(operationProfile))fail('desktop_update_state_corrupt');
 if(hasStartupStatus&&(!startupStatuses.has(value.startupStatus)||value.startupStatus!==null&&value.phase!=='active'))fail('desktop_update_state_corrupt');
 let parsedTarget;
 try{parsedTarget=JSON.parse(value.targetKey);}catch{fail('desktop_update_state_corrupt');}
 const targetProfile=parsedTarget?.length===5?parsedTarget[4]:'standalone';
 if(!Array.isArray(parsedTarget)||![4,5].includes(parsedTarget.length)||parsedTarget.slice(0,4).some(item=>!validText(item,100))||
  parsedTarget.length===5&&parsedTarget[4]!=='desktop-electron'||targetProfile!==operationProfile||
  targetKey(normalizeTarget({product:parsedTarget[0],channel:parsedTarget[1],platform:parsedTarget[2],arch:parsedTarget[3]}),operationProfile)!==value.targetKey)
  fail('desktop_update_state_corrupt');
 let candidate=null;
 if(value.candidate!==null){
  if(!exactKeys(value.candidate,['releaseId','manifestSha256']))fail('desktop_update_state_corrupt');
  candidate={releaseId:normalizeReleaseId(value.candidate.releaseId,operationProfile),manifestSha256:normalizeDigest(value.candidate.manifestSha256)};
 }
 let rollback=null;
 if(value.rollback!==null){
  if(!exactKeys(value.rollback,['activeReleaseId','previousReleaseId','backupDigest']))fail('desktop_update_state_corrupt');
  rollback={activeReleaseId:normalizeReleaseId(value.rollback.activeReleaseId,operationProfile),previousReleaseId:normalizeReleaseId(value.rollback.previousReleaseId,operationProfile),backupDigest:normalizeDigest(value.rollback.backupDigest)};
 }
 let recoveryPoint=null;
 if(value.recoveryPoint!==null){
  if(!exactKeys(value.recoveryPoint,['backupId','releaseId']))fail('desktop_update_state_corrupt');
  recoveryPoint={backupId:normalizeDigest(value.recoveryPoint.backupId),releaseId:normalizeReleaseId(value.recoveryPoint.releaseId,operationProfile)};
 }
 let signedEnvelopeBase64=null;
 if(value.signedEnvelopeBase64!==null){
  if(typeof value.signedEnvelopeBase64!=='string'||value.signedEnvelopeBase64.length>90000||
   !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.signedEnvelopeBase64))fail('desktop_update_state_corrupt');
  const bytes=Buffer.from(value.signedEnvelopeBase64,'base64');
  if(!bytes.length||bytes.length>64*1024||bytes.toString('base64')!==value.signedEnvelopeBase64)fail('desktop_update_state_corrupt');
  signedEnvelopeBase64=value.signedEnvelopeBase64;
 }
 const operation={
  id:value.id.toLowerCase(),targetKey:value.targetKey,envelopeDigest:normalizeDigest(value.envelopeDigest),
  manifestSha256:normalizeDigest(value.manifestSha256),phase:value.phase,candidate,
  downloads:normalizeDownloadMap(value.downloads),rollback,recoveryPoint,signedEnvelopeBase64
 };
 if(hasProfile)operation.profile=operationProfile;
 if(hasStartupStatus)operation.startupStatus=value.startupStatus;
 if(hasHandoff)operation.handoff=value.handoff===null?null:normalizeHandoff(value.handoff,{...operation,profile:operationProfile});
 if(Object.hasOwn(value,'rollbackTarget'))operation.rollbackTarget=value.rollbackTarget===null?null:normalizeRef(value.rollbackTarget,operationProfile);
 if(Object.hasOwn(value,'restoredStartup'))operation.restoredStartup=value.restoredStartup===null?null:normalizeRestoredStartup(value.restoredStartup,operation);
 if(Object.hasOwn(value,'supervisorDrain')){
  operation.supervisorDrain=normalizeSupervisorDrain(value.supervisorDrain);
  if(operationProfile!=='desktop-electron'||operation.supervisorDrain.scope.operationId!==operation.id)fail('desktop_update_state_corrupt');
 }
 return operation;
}
function normalizeState(value){
 if(!exactKeys(value,['protocol','highWaterByTarget','releaseReceipts','operation'])||value.protocol!==1||
  !plainRecord(value.highWaterByTarget)||Object.keys(value.highWaterByTarget).length>10000||
  !Array.isArray(value.releaseReceipts)||value.releaseReceipts.length>10000)
  fail('desktop_update_state_corrupt');
 const highWaterByTarget={};
 for(const [key,entry] of Object.entries(value.highWaterByTarget)){
  let parts;
  try{parts=JSON.parse(key);}catch{fail('desktop_update_state_corrupt');}
  if(!Array.isArray(parts)||![4,5].includes(parts.length)||parts.slice(0,4).some(item=>!validText(item,100))||
   parts.length===5&&parts[4]!=='desktop-electron'||
   key!==JSON.stringify(parts)||!exactKeys(entry,['sequence','envelopeDigest']))fail('desktop_update_state_corrupt');
  normalizeTarget({product:parts[0],channel:parts[1],platform:parts[2],arch:parts[3]});
  highWaterByTarget[key]={sequence:normalizeSequence(entry.sequence),envelopeDigest:normalizeDigest(entry.envelopeDigest)};
 }
 const releaseReceipts=value.releaseReceipts.map(receipt=>normalizeReceipt(receipt));
 if(new Set(releaseReceipts.map(item=>item.releaseId)).size!==releaseReceipts.length)fail('desktop_update_state_corrupt');
 const sequenceByTarget=new Map();
 for(const receipt of releaseReceipts){
  const key=targetKey(receipt),identity=key+'\0'+receipt.sequence,prior=sequenceByTarget.get(identity);
  if(prior&&prior!==receipt.envelopeDigest)fail('desktop_update_state_corrupt');
  sequenceByTarget.set(identity,receipt.envelopeDigest);
 }
 const operation=value.operation===null?null:normalizeOperation(value.operation);
 for(const [key,floor] of Object.entries(highWaterByTarget)){
  if(!releaseReceipts.some(receipt=>targetKey(receipt)===key&&receipt.sequence===floor.sequence&&receipt.envelopeDigest===floor.envelopeDigest))
   fail('desktop_update_state_corrupt');
 }
 if(operation?.candidate){
  const candidateReceipt=releaseReceipts.find(receipt=>receipt.releaseId===operation.candidate.releaseId&&
   receipt.manifestSha256===operation.candidate.manifestSha256&&receipt.envelopeDigest===operation.envelopeDigest&&targetKey(receipt,operation.profile??'standalone')===operation.targetKey);
  if(!candidateReceipt)fail('desktop_update_state_corrupt');
 }else if(operation&&['staged','awaiting-activation','activating','active'].includes(operation.phase))fail('desktop_update_state_corrupt');
 if(operation?.handoff&&(!releaseReceipts.some(receipt=>receipt.releaseId===operation.handoff.previous.releaseId&&
  receipt.manifestSha256===operation.handoff.previous.manifestSha256&&receipt.profile==='desktop-electron')))fail('desktop_update_state_corrupt');
 return {protocol:1,highWaterByTarget,releaseReceipts,operation};
}
function emptyState(){return {protocol:1,highWaterByTarget:{},releaseReceipts:[],operation:null};}
function encode(state){return JSON.stringify(state)+'\n';}
function sameReceipt(left,right){return encode(left)===encode(right);}
function receiptForRef(receipts,ref){return receipts.find(item=>item.releaseId===ref.releaseId&&item.manifestSha256===ref.manifestSha256)||null;}
function compareSequence(first,second){const a=BigInt(first),b=BigInt(second);return a<b?-1:a>b?1:0;}

export function createUpdateStateStore({statePath,fs=defaultFs}={}){
 if(typeof statePath!=='string'||!isAbsolute(statePath)||!fs||typeof fs.open!=='function'||typeof fs.readFile!=='function'||typeof fs.rename!=='function')
  fail('desktop_update_state_path_invalid');

 async function loadStrict(){
  let info;
  try{info=await fs.lstat(statePath);}catch(error){if(error?.code==='ENOENT')return emptyState();throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)fail('desktop_update_state_corrupt');
  let raw;
  try{raw=await fs.readFile(statePath,'utf8');}catch{fail('desktop_update_state_corrupt');}
  let parsed;
  try{parsed=JSON.parse(raw);}catch{fail('desktop_update_state_corrupt');}
  let normalized;
  try{normalized=normalizeState(parsed);}catch{fail('desktop_update_state_corrupt');}
  if(encode(normalized)!==raw)fail('desktop_update_state_corrupt');
  return normalized;
 }

 async function read(){
  try{
   const state=freezeDeep(await loadStrict());
   const unknown=state.operation?.phase==='unknown'||state.operation?.handoff?.state==='unknown';
   return {enabled:!unknown,reason:unknown?'desktop_update_state_unknown':null,state};
  }catch(error){return {enabled:false,reason:error?.message==='desktop_update_state_corrupt'?'desktop_update_state_corrupt':'desktop_update_state_unavailable',state:null};}
 }

 async function writeState(next){
  const normalized=normalizeState(next),directory=dirname(statePath),temporary=statePath+'.'+process.pid+'.'+randomUUID()+'.tmp';
  await fs.mkdir(directory,{recursive:true});
  let handle;
  try{
   handle=await fs.open(temporary,'wx',0o600);
   await handle.writeFile(encode(normalized),'utf8');
   await handle.sync();
   await handle.close();handle=undefined;
   await fs.rename(temporary,statePath);
   let directoryHandle;
   try{directoryHandle=await fs.open(directory,'r');await directoryHandle.sync();}
   catch(error){if(!allowedDirectorySyncErrors.has(error?.code))throw error;}
   finally{if(directoryHandle)await directoryHandle.close().catch(()=>{});}
   return freezeDeep(normalized);
  }catch(error){
   if(handle)await handle.close().catch(()=>{});
   await fs.rm(temporary,{force:true}).catch(()=>{});
   throw error;
  }
 }

 async function mutate(mutator){
  const current=await loadStrict();
  if(current.operation?.phase==='unknown'||current.operation?.handoff?.state==='unknown')fail('desktop_update_state_unknown');
  const next=await mutator(current);
  if(next===current)return freezeDeep(current);
  return writeState(next);
 }

 async function withRestoredStartupLock(action){
  const lockPath=statePath+'.restored-startup.lock',deadline=Date.now()+5000;
  await fs.mkdir(dirname(statePath),{recursive:true});
  let lock;
  while(!lock){
   try{lock=await fs.open(lockPath,'wx',0o600);}
   catch(error){
    if(error?.code!=='EEXIST')throw error;
    if(Date.now()>=deadline)fail('desktop_update_restored_startup_lock_busy');
    await new Promise(resolve=>setTimeout(resolve,25));
   }
  }
  try{return await action();}
  finally{
   await lock.close().catch(()=>{});
   await fs.rm(lockPath,{force:true}).catch(()=>{});
  }
 }

 function requireOperation(state,operationId){
  if(!state.operation||state.operation.id!==operationId)fail('desktop_update_operation_mismatch');
  return state.operation;
 }

 async function beginOperation(input){
  return withRestoredStartupLock(()=>mutate(state=>{
   const allowed=['id','target','envelopeDigest','manifestSha256','signedEnvelopeBase64','profile'];
   if(!plainRecord(input)||['id','target','envelopeDigest','manifestSha256'].some(key=>!Object.hasOwn(input,key))||
    Object.keys(input).some(key=>!allowed.includes(key)))fail('desktop_update_operation_invalid');
   const profile=input.profile??'standalone';if(!['standalone','desktop-electron'].includes(profile))fail('desktop_update_operation_invalid');
   const target=normalizeTarget(input.target),id=typeof input.id==='string'?input.id.toLowerCase():'';
   if(!uuidPattern.test(id))fail('desktop_update_operation_invalid');
   const envelopeDigest=normalizeDigest(input.envelopeDigest),manifestSha256=normalizeDigest(input.manifestSha256);
   let signedEnvelopeBase64=null;
   if(input.signedEnvelopeBase64!==undefined){
    if(typeof input.signedEnvelopeBase64!=='string'||input.signedEnvelopeBase64.length>90000||
     !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.signedEnvelopeBase64))fail('desktop_update_operation_invalid');
    const bytes=Buffer.from(input.signedEnvelopeBase64,'base64');
    if(!bytes.length||bytes.length>64*1024||bytes.toString('base64')!==input.signedEnvelopeBase64)fail('desktop_update_operation_invalid');
    signedEnvelopeBase64=input.signedEnvelopeBase64;
   }
   if(state.operation&&!terminalPhases.has(state.operation.phase))fail('desktop_update_operation_busy');
   if(state.operation?.supervisorDrain&&state.operation.supervisorDrain.state!=='stopped')fail('desktop_update_supervisor_held');
   const key=targetKey(target,profile);
   const candidateReceipt=state.releaseReceipts.find(item=>item.profile===profile&&item.envelopeDigest===envelopeDigest&&item.manifestSha256===manifestSha256&&targetKey(item)===key);
   const operation={id,targetKey:key,envelopeDigest,manifestSha256,phase:'available',candidate:candidateReceipt?{releaseId:candidateReceipt.releaseId,manifestSha256}:null,downloads:{},rollback:null,recoveryPoint:null,signedEnvelopeBase64,profile,startupStatus:null,handoff:null};
   return {...state,operation};
  }));
 }

 async function recordDownloadProgress(operationId,filePath,offset,etag){
  if(!validRelativePath(filePath)||!Number.isSafeInteger(offset)||offset<0||!(etag===null||typeof etag==='string'&&strongEtagPattern.test(etag))||(offset>0&&!etag))
   fail('desktop_update_progress_invalid');
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if(current.phase!=='downloading')fail('desktop_update_phase_invalid');
   const previous=current.downloads[filePath];
   if(previous&&offset<previous.offset)fail('desktop_update_progress_regressed');
   if(previous&&previous.etag&&etag!==previous.etag)fail('desktop_update_etag_changed');
   return {...state,operation:{...current,downloads:{...current.downloads,[filePath]:{offset,etag}}}};
  });
 }

 async function setPhase(operationId,phase){
  if(typeof phase!=='string'||!phases.has(phase))fail('desktop_update_phase_invalid');
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if(current.phase===phase)return state;
   if(!phaseTransitions[current.phase]?.has(phase))fail('desktop_update_phase_invalid');
   return {...state,operation:{...current,phase}};
  });
 }

 async function claimStartupAttempt(operationId){
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if(current.phase!=='active'||current.startupStatus!=='pending')fail('desktop_update_startup_attempt_invalid');
   if((current.profile??'standalone')==='desktop-electron'&&current.handoff?.state!=='launched')fail('desktop_update_startup_handoff_invalid');
   return {...state,operation:{...current,startupStatus:'attempted'}};
  });
 }

 async function confirmStartup(operationId){
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if(current.phase!=='active'||current.startupStatus!=='attempted')fail('desktop_update_startup_confirmation_invalid');
   if((current.profile??'standalone')==='desktop-electron'&&current.handoff?.state!=='launched')fail('desktop_update_startup_handoff_invalid');
   return {...state,operation:{...current,startupStatus:'healthy'}};
  });
 }

 async function recordLauncherHandoff(operationId,value){
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if((current.profile??'standalone')!=='desktop-electron'||current.phase!=='active'||current.startupStatus!=='pending'||current.handoff!==null)
    fail('desktop_update_handoff_phase_invalid');
   const handoff=normalizeHandoff(value,current);
   if(handoff.state!=='requested'||!state.releaseReceipts.some(receipt=>receipt.releaseId===handoff.previous.releaseId&&
    receipt.manifestSha256===handoff.previous.manifestSha256&&receipt.profile==='desktop-electron'))fail('desktop_update_handoff_previous_invalid');
   return {...state,operation:{...current,handoff}};
  });
 }

 async function transitionHandoff({operationId,from,to}={}){
  if(!exactKeys({operationId,from,to},['operationId','from','to'])||typeof operationId!=='string'||!uuidPattern.test(operationId)||
   !handoffStatuses.has(from)||!handoffStatuses.has(to))fail('desktop_update_handoff_transition_invalid');
  const transitions={requested:new Set(['launched','unknown']),launched:new Set(['healthy','rolled-back','unknown']),
   healthy:new Set(),'rolled-back':new Set(),unknown:new Set()};
  let changed=false;
  await mutate(state=>{
   const current=requireOperation(state,operationId),handoff=current.handoff;
   if((current.profile??'standalone')!=='desktop-electron'||!handoff)fail('desktop_update_handoff_invalid');
   if(handoff.state===to)return state;
   if(handoff.state!==from||!transitions[from].has(to))fail('desktop_update_handoff_transition_invalid');
   const updated=normalizeHandoff({...handoff,state:to},current);
   changed=true;
   return {...state,operation:{...current,handoff:updated}};
  });
  return changed;
 }

 async function markUnknown(operationId){
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if((current.profile??'standalone')!=='desktop-electron'||!['activating','active'].includes(current.phase))
    fail('desktop_update_state_unknown_transition_invalid');
   const handoff=current.handoff?{...current.handoff,state:'unknown'}:null;
   return {...state,operation:{...current,phase:'unknown',...(current.handoff?{handoff}:{})}};
  });
 }

 async function readHandoff(){
  const state=await loadStrict();
  return state.operation?.handoff??null;
 }

 async function readStartup({operationId}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId))fail('desktop_update_startup_receipt_invalid');
  const state=await loadStrict(),operation=state.operation;
  if(!operation||operation.id!==operationId||(operation.profile??'standalone')!=='desktop-electron'||
   !operation.candidate||!operation.recoveryPoint||!['pending','attempted','healthy'].includes(operation.startupStatus))return null;
  return Object.freeze({protocol:1,operationId,candidate:Object.freeze({...operation.candidate}),
   recovery:Object.freeze({backupId:operation.recoveryPoint.backupId,releaseId:operation.recoveryPoint.releaseId}),state:operation.startupStatus});
 }

 async function waitForStartup({operationId,candidate,recovery,timeoutMs=30000,signal}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId)||!exactKeys(candidate,['releaseId','manifestSha256'])||
   !exactKeys(recovery,['backupId','releaseId'])||!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>15*60*1000)
   fail('desktop_update_startup_wait_invalid');
  const expectedCandidate={releaseId:normalizeReleaseId(candidate.releaseId,'desktop-electron'),manifestSha256:normalizeDigest(candidate.manifestSha256)};
  const expectedRecovery={backupId:normalizeDigest(recovery.backupId),releaseId:normalizeReleaseId(recovery.releaseId,'desktop-electron')};
  const deadline=Date.now()+timeoutMs;
  for(;;){
   if(signal?.aborted)throw signal.reason??new Error('desktop_update_cancelled');
   const receipt=await readStartup({operationId});
   if(receipt&&receipt.operationId===operationId&&receipt.candidate.releaseId===expectedCandidate.releaseId&&
    receipt.candidate.manifestSha256===expectedCandidate.manifestSha256&&receipt.recovery.backupId===expectedRecovery.backupId&&
    receipt.recovery.releaseId===expectedRecovery.releaseId&&receipt.state==='healthy')return receipt;
   const remaining=deadline-Date.now();if(remaining<=0)return null;
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(done,Math.min(100,remaining));
    function done(){signal?.removeEventListener('abort',abort);resolve();}
    function abort(){clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??new Error('desktop_update_cancelled'));}
    signal?.addEventListener('abort',abort,{once:true});
   });
  }
 }

 function requireRestoredStartup(operation,operationId,previous,recovery,nonce){
  if(!operation||operation.id!==operationId||operation.profile!=='desktop-electron'||operation.phase!=='active'||
   operation.startupStatus!=='rolled-back'||!operation.restoredStartup)fail('desktop_update_restored_startup_invalid');
  const restored=operation.restoredStartup;
  if(stable(restored.previous)!==stable(previous)||encode(restored.recovery)!==encode(recovery)||restored.nonce!==nonce)
   fail('desktop_update_restored_startup_identity_mismatch');
  return restored;
 }

 async function prepareRestoredStartup(input={}){
  if(!plainRecord(input)||Object.keys(input).some(key=>!['operationId','before','after','previous','recovery'].includes(key))||
   typeof input.operationId!=='string'||!uuidPattern.test(input.operationId)||
   Object.hasOwn(input,'before')!==Object.hasOwn(input,'after')||
   !(Object.hasOwn(input,'previous')||Object.hasOwn(input,'after'))||!plainRecord(input.recovery))
   fail('desktop_update_restored_startup_invalid');
  const {operationId,recovery}=input;
  if(!exactKeys(recovery,['backupId','releaseId']))fail('desktop_update_restored_startup_invalid');
  const expectedRecovery={backupId:normalizeDigest(recovery.backupId),releaseId:normalizeReleaseId(recovery.releaseId,'desktop-electron')};
  const previous=input.previous??input.after?.active;
  const expectedPrevious=normalizeRef(previous,'desktop-electron');
  let launchAllowed=false,receipt=null;
  await withRestoredStartupLock(async()=>{
   if(Object.hasOwn(input,'before'))await markRollback({before:input.before,after:input.after,backupDigest:expectedRecovery.backupId});
   await mutate(state=>{
   const operation=requireOperation(state,operationId);
   if(operation.profile!=='desktop-electron'||operation.phase!=='active'||operation.startupStatus!=='rolled-back'||
    operation.handoff?.state!=='rolled-back'||!operation.rollback||!operation.rollbackTarget)
    fail('desktop_update_restored_startup_rollback_required');
   if(stable(operation.rollbackTarget)!==stable(expectedPrevious)||operation.rollback.activeReleaseId!==expectedPrevious.releaseId||
    operation.handoff.previous.releaseId!==expectedPrevious.releaseId||operation.handoff.previous.manifestSha256!==expectedPrevious.manifestSha256||
    operation.rollback.backupDigest!==expectedRecovery.backupId||operation.recoveryPoint?.releaseId!==expectedRecovery.releaseId||
    operation.recoveryPoint.backupId!==expectedRecovery.backupId||expectedRecovery.releaseId!==expectedPrevious.releaseId)
    fail('desktop_update_restored_startup_identity_mismatch');
   if(operation.restoredStartup){
    if(stable(operation.restoredStartup.previous)!==stable(expectedPrevious)||encode(operation.restoredStartup.recovery)!==encode(expectedRecovery))
     fail('desktop_update_restored_startup_identity_mismatch');
    receipt=operation.restoredStartup;
    return state;
   }
   const restoredStartup={protocol:1,operationId,generation:1,nonce:randomUUID(),previous:expectedPrevious,recovery:expectedRecovery,
    state:'prepared',processContext:null,probeReceipt:null};
   const next={...operation,restoredStartup};
   launchAllowed=true;receipt=restoredStartup;
   return {...state,operation:next};
   });
  });
  return Object.freeze({launchAllowed,receipt:freezeDeep(receipt)});
 }

 async function readRestoredStartup({operationId}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId))fail('desktop_update_restored_startup_invalid');
  const state=await loadStrict(),operation=state.operation;
  if(!operation||operation.id!==operationId||operation.profile!=='desktop-electron'||!operation.restoredStartup)return null;
  return freezeDeep(operation.restoredStartup);
 }

 async function claimRestoredStartup({operationId,previous,recovery,nonce,processContext}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId)||typeof nonce!=='string'||!uuidPattern.test(nonce)||
   !plainRecord(previous)||!plainRecord(recovery))fail('desktop_update_restored_startup_invalid');
  const expectedPrevious=normalizeRef(previous,'desktop-electron');
  if(!exactKeys(recovery,['backupId','releaseId']))fail('desktop_update_restored_startup_invalid');
  const expectedRecovery={backupId:normalizeDigest(recovery.backupId),releaseId:normalizeReleaseId(recovery.releaseId,'desktop-electron')};
  const expectedProcess=normalizeProcessContext(processContext);
  let claimed=false,receipt=null;
  await withRestoredStartupLock(()=>mutate(state=>{
   const operation=requireOperation(state,operationId),restored=requireRestoredStartup(operation,operationId,expectedPrevious,expectedRecovery,nonce);
   if(restored.state==='prepared'){
    claimed=true;
    const nextRestored={...restored,state:'attempted',processContext:expectedProcess};
    receipt=nextRestored;
    return {...state,operation:{...operation,restoredStartup:nextRestored}};
   }
   if(restored.state==='attempted'&&encode(restored.processContext)===encode(expectedProcess)){
    claimed=true;receipt=restored;return state;
   }
   fail('desktop_update_restored_startup_replay_forbidden');
  }));
  return Object.freeze({claimed,receipt:freezeDeep(receipt)});
 }

 async function confirmRestoredStartup({operationId,previous,recovery,nonce,processContext,probeReceipt}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId)||typeof nonce!=='string'||!uuidPattern.test(nonce)||
   !plainRecord(previous)||!plainRecord(recovery))fail('desktop_update_restored_startup_invalid');
  const expectedPrevious=normalizeRef(previous,'desktop-electron');
  if(!exactKeys(recovery,['backupId','releaseId']))fail('desktop_update_restored_startup_invalid');
  const expectedRecovery={backupId:normalizeDigest(recovery.backupId),releaseId:normalizeReleaseId(recovery.releaseId,'desktop-electron')};
  const expectedProcess=normalizeProcessContext(processContext),expectedProbe=normalizeRestoredProbeReceipt(probeReceipt,expectedPrevious);
  let confirmed=false,receipt=null;
  await withRestoredStartupLock(()=>mutate(state=>{
   const operation=requireOperation(state,operationId),restored=requireRestoredStartup(operation,operationId,expectedPrevious,expectedRecovery,nonce);
   if(restored.state==='healthy'){
    if(encode(restored.processContext)!==encode(expectedProcess)||encode(restored.probeReceipt)!==encode(expectedProbe))
     fail('desktop_update_restored_startup_receipt_conflict');
    confirmed=true;receipt=restored;return state;
   }
   if(restored.state!=='attempted'||encode(restored.processContext)!==encode(expectedProcess))
    fail('desktop_update_restored_startup_confirmation_invalid');
   const nextRestored={...restored,state:'healthy',probeReceipt:expectedProbe};
   confirmed=true;receipt=nextRestored;
   return {...state,operation:{...operation,restoredStartup:nextRestored}};
  }));
  return Object.freeze({confirmed,receipt:freezeDeep(receipt)});
 }

 async function markRestoredStartupUnknown({operationId,nonce,processContext}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId)||typeof nonce!=='string'||!uuidPattern.test(nonce))
   fail('desktop_update_restored_startup_invalid');
  let changed=false;
  await withRestoredStartupLock(()=>mutate(state=>{
   const operation=requireOperation(state,operationId),restored=operation.restoredStartup;
   if(!restored||restored.nonce!==nonce)fail('desktop_update_restored_startup_identity_mismatch');
   if(restored.state==='unknown')return state;
   if(restored.state==='attempted'){
    const expectedProcess=normalizeProcessContext(processContext);
    if(encode(restored.processContext)!==encode(expectedProcess))fail('desktop_update_restored_startup_process_mismatch');
   }else if(restored.state!=='prepared')fail('desktop_update_restored_startup_unknown_transition_invalid');
   changed=true;
   return {...state,operation:{...operation,restoredStartup:{...restored,state:'unknown'}}};
  }));
  return changed;
 }

 async function waitForRestoredStartup({operationId,previous,recovery,timeoutMs=30000,signal}={}){
  if(typeof operationId!=='string'||!uuidPattern.test(operationId)||!exactKeys(previous,['releaseId','manifestSha256'])||
   !exactKeys(recovery,['backupId','releaseId'])||!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>15*60*1000)
   fail('desktop_update_restored_startup_wait_invalid');
  const expectedPrevious={releaseId:normalizeReleaseId(previous.releaseId,'desktop-electron'),
   manifestSha256:normalizeDigest(previous.manifestSha256)};
  const expectedRecovery={backupId:normalizeDigest(recovery.backupId),releaseId:normalizeReleaseId(recovery.releaseId,'desktop-electron')};
  const deadline=Date.now()+timeoutMs;
  for(;;){
   if(signal?.aborted)throw signal.reason??new Error('desktop_update_cancelled');
   const receipt=await readRestoredStartup({operationId});
   if(receipt&&receipt.previous.releaseId===expectedPrevious.releaseId&&receipt.previous.manifestSha256===expectedPrevious.manifestSha256&&
    receipt.recovery.backupId===expectedRecovery.backupId&&receipt.recovery.releaseId===expectedRecovery.releaseId){
    if(receipt.state==='healthy')return receipt;
    if(receipt.state==='unknown')return null;
   }
   const remaining=deadline-Date.now();if(remaining<=0)return null;
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(done,Math.min(100,remaining));
    function done(){signal?.removeEventListener('abort',abort);resolve();}
    function abort(){clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??new Error('desktop_update_cancelled'));}
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
   });
  }
 }

 async function recordReleaseReceipt(value){
  const receipt=normalizeReceipt(value),key=targetKey(receipt);
  return mutate(state=>{
   const prior=state.releaseReceipts.find(item=>item.releaseId===receipt.releaseId);
   if(prior){if(!sameReceipt(prior,receipt))fail('desktop_update_receipt_conflict');return state;}
   const sameSequence=state.releaseReceipts.find(item=>targetKey(item)===key&&item.sequence===receipt.sequence);
   if(sameSequence&&sameSequence.envelopeDigest!==receipt.envelopeDigest)fail('desktop_update_sequence_conflict');
   const floor=state.highWaterByTarget[key];
   if(floor&&floor.sequence===receipt.sequence&&floor.envelopeDigest!==receipt.envelopeDigest)fail('desktop_update_sequence_conflict');
   const operation=state.operation;
   let nextOperation=operation;
   if(operation&&operation.targetKey===key&&(operation.profile??'standalone')===receipt.profile&&operation.envelopeDigest===receipt.envelopeDigest&&operation.manifestSha256===receipt.manifestSha256){
    nextOperation={...operation,candidate:{releaseId:receipt.releaseId,manifestSha256:receipt.manifestSha256}};
   }
   return {...state,releaseReceipts:[...state.releaseReceipts,receipt],operation:nextOperation};
  });
 }

 async function recordRecoveryPoint(operationId,backupId,releaseId){
  return mutate(state=>{
   const current=requireOperation(state,operationId);
   if(current.phase!=='downloaded')fail('desktop_update_phase_invalid');
   const recoveryPoint={backupId:normalizeDigest(backupId),releaseId:normalizeReleaseId(releaseId,current.profile??'standalone')};
   if(current.recoveryPoint){
    if(current.recoveryPoint.backupId!==recoveryPoint.backupId||current.recoveryPoint.releaseId!==recoveryPoint.releaseId)
     fail('desktop_update_recovery_point_conflict');
    return state;
   }
   return {...state,operation:{...current,recoveryPoint}};
  });
 }

 async function reconcileDeployment(value){
  let deployment;
  try{deployment=normalizeDeployment(value);}catch{return {enabled:false,reason:'desktop_update_deployment_unknown',state:(await read()).state};}
  try{
   const state=await loadStrict();
   if(state.operation?.phase==='unknown'||state.operation?.handoff?.state==='unknown')return {enabled:false,reason:'desktop_update_state_unknown',state:freezeDeep(state)};
   if(state.operation?.phase==='activating'){
    const candidate=state.operation.candidate;
    if(!candidate||candidate.releaseId!==deployment.active.releaseId||candidate.manifestSha256!==deployment.active.manifestSha256){
     const unknown={...state,operation:{...state.operation,phase:'unknown'}};
     await writeState(unknown);
     return {enabled:false,reason:'desktop_update_deployment_unknown',state:freezeDeep(unknown)};
    }
   }
   const activeReceipt=receiptForRef(state.releaseReceipts,deployment.active),previousReceipt=deployment.previous?receiptForRef(state.releaseReceipts,deployment.previous):null;
   if(!activeReceipt||(deployment.previous&&!previousReceipt)){
    if(state.operation?.phase==='activating'){
     const unknown={...state,operation:{...state.operation,phase:'unknown'}};await writeState(unknown);
     return {enabled:false,reason:'desktop_update_deployment_unknown',state:freezeDeep(unknown)};
    }
    return {enabled:false,reason:'desktop_update_deployment_unknown',state:freezeDeep(state)};
   }
   let next=state;
   const key=targetKey(activeReceipt),currentFloor=state.highWaterByTarget[key];
   if(currentFloor&&compareSequence(activeReceipt.sequence,currentFloor.sequence)===0&&activeReceipt.envelopeDigest!==currentFloor.envelopeDigest)
    return {enabled:false,reason:'desktop_update_sequence_conflict',state:freezeDeep(state)};
   let highWaterByTarget=state.highWaterByTarget;
   if(!currentFloor||compareSequence(activeReceipt.sequence,currentFloor.sequence)>0)
    highWaterByTarget={...state.highWaterByTarget,[key]:{sequence:activeReceipt.sequence,envelopeDigest:activeReceipt.envelopeDigest}};
   if(state.operation?.phase==='activating'){
    next={...state,highWaterByTarget,operation:{...state.operation,phase:'active'}};
    next.operation.startupStatus='pending';
   }else if(highWaterByTarget!==state.highWaterByTarget)next={...state,highWaterByTarget};
   const persisted=next===state?freezeDeep(state):await writeState(next);
   return {enabled:true,reason:null,state:persisted,activeReleaseId:deployment.active.releaseId};
  }catch(error){
   if(error?.message==='desktop_update_state_corrupt')return {enabled:false,reason:'desktop_update_state_corrupt',state:null};
   return {enabled:false,reason:'desktop_update_state_unavailable',state:null};
  }
 }

 async function markRollback(value){
  if(!exactKeys(value,['before','after','backupDigest'])&&!exactKeys(value,['operationId','before','after','backupDigest']))
   fail('desktop_update_rollback_invalid');
  if(Object.hasOwn(value,'operationId')&&(typeof value.operationId!=='string'||!uuidPattern.test(value.operationId)))
   fail('desktop_update_rollback_invalid');
  const before=normalizeDeployment(value.before),after=normalizeDeployment(value.after,before.active.profile),backupDigest=normalizeDigest(value.backupDigest);
  if(!before.previous||after.active.releaseId!==before.previous.releaseId||after.active.manifestSha256!==before.previous.manifestSha256||
   !after.previous||after.previous.releaseId!==before.active.releaseId||after.previous.manifestSha256!==before.active.manifestSha256)
   fail('desktop_update_rollback_target_invalid');
  const state=await mutate(state=>{
   if(!receiptForRef(state.releaseReceipts,before.active)||!receiptForRef(state.releaseReceipts,before.previous))fail('desktop_update_rollback_receipt_missing');
   const operation=state.operation;
   if(value.operationId&&operation?.id!==value.operationId)fail('desktop_update_operation_mismatch');
   if(!operation||operation.phase!=='active'||(operation.profile??'standalone')!==before.active.profile)fail('desktop_update_rollback_state_invalid');
   if(!operation.recoveryPoint||operation.recoveryPoint.backupId!==backupDigest||operation.recoveryPoint.releaseId!==before.previous.releaseId)
    fail('desktop_update_rollback_backup_invalid');
   const rollback={activeReleaseId:after.active.releaseId,previousReleaseId:after.previous.releaseId,backupDigest};
   const handoff=operation.handoff?{...operation.handoff,state:'rolled-back'}:null;
   const rollbackTarget=(operation.profile??'standalone')==='desktop-electron'?after.active:null;
   return {...state,operation:{...operation,rollback,startupStatus:'rolled-back',...(operation.handoff?{handoff}:{}),
    ...(rollbackTarget?{rollbackTarget}:{})}};
  });
  return {enabled:true,state};
 }

 function supervisorOperation(state,scope){
  const op=requireOperation(state,scope.operationId);
  const identity=[op.candidate,op.handoff?.previous].find(ref=>ref?.releaseId===scope.releaseId&&ref.manifestSha256===scope.manifestSha256);
  if(op.profile!=='desktop-electron'||op.phase!=='active'||!identity)fail('desktop_update_supervisor_scope_invalid');
  if(scope.restoredNonce!==null&&(op.restoredStartup?.nonce!==scope.restoredNonce||op.restoredStartup?.generation!==scope.generation))
   fail('desktop_update_supervisor_scope_invalid');
  return op;
 }
 function sameSupervisorRecord(op,scope,requestId){
  const record=op.supervisorDrain;
  if(!record||record.requestId!==requestId||stable(record.scope)!==stable(scope))fail('desktop_update_supervisor_scope_invalid');
  return record;
 }
 async function beginSupervisorDrain({scope:input,requestId}={}){
  const scope=normalizeSupervisorScope(input);if(!supervisorUuid.test(requestId??''))fail('desktop_update_supervisor_scope_invalid');
  let dispatchAllowed=false,record;
  await withRestoredStartupLock(()=>mutate(state=>{
   const op=supervisorOperation(state,scope);
   if(op.supervisorDrain){record=sameSupervisorRecord(op,scope,requestId);return state;}
   record={protocol:1,scope,requestId,state:'dispatched',receipt:null};dispatchAllowed=true;
   return {...state,operation:{...op,supervisorDrain:record}};
  }));
  return Object.freeze({dispatchAllowed,record:freezeDeep(record)});
 }
 async function readSupervisorDrain({scope:input,requestId}={}){
  const scope=normalizeSupervisorScope(input),state=await loadStrict(),op=requireOperation(state,scope.operationId);
  if(op.profile!=='desktop-electron')fail('desktop_update_supervisor_scope_invalid');
  if(!op.supervisorDrain)return null;
  return freezeDeep(sameSupervisorRecord(op,scope,requestId));
 }
 async function finishSupervisorDrain({scope:input,requestId,receipt}={},unknown=false){
  const scope=normalizeSupervisorScope(input),normalized=unknown?null:normalizeDrainReceipt(receipt,scope);
  let result;
  await withRestoredStartupLock(()=>mutate(state=>{
   const op=supervisorOperation(state,scope),prior=sameSupervisorRecord(op,scope,requestId);
   if(prior.state==='stopped'){
    if(!unknown&&stable(prior.receipt)!==stable(normalized))fail('desktop_update_supervisor_receipt_conflict');result=prior;return state;
   }
   result={...prior,state:unknown?'unknown':'stopped',receipt:normalized};
   return {...state,operation:{...op,supervisorDrain:result}};
  }));return freezeDeep(result);
 }
 const completeSupervisorDrain=input=>finishSupervisorDrain(input);
 const markSupervisorDrainUnknown=input=>finishSupervisorDrain(input,true);

 return Object.freeze({read,beginOperation,recordDownloadProgress,setPhase,claimStartupAttempt,confirmStartup,recordLauncherHandoff,markUnknown,
  beginSupervisorDrain,readSupervisorDrain,completeSupervisorDrain,markSupervisorDrainUnknown,
  transitionHandoff,readHandoff,readStartup,waitForStartup,prepareRestoredStartup,readRestoredStartup,claimRestoredStartup,
  confirmRestoredStartup,markRestoredStartupUnknown,waitForRestoredStartup,recordReleaseReceipt,recordRecoveryPoint,reconcileDeployment,markRollback});
}

export function createDesktopLauncherHandoffStore({installRoot,stateRoot}={}){
 if(typeof installRoot!=='string'||!isAbsolute(installRoot))fail('desktop_update_handoff_store_invalid');
 const root=resolve(installRoot),expectedStateRoot=resolve(root,'.jot-state'),configuredStateRoot=resolve(stateRoot??expectedStateRoot);
 const samePath=process.platform==='win32'?configuredStateRoot.toLocaleLowerCase('en-US')===expectedStateRoot.toLocaleLowerCase('en-US'):
  configuredStateRoot===expectedStateRoot;
 if(!samePath)fail('desktop_update_handoff_store_invalid');
 const store=createUpdateStateStore({statePath:join(expectedStateRoot,'update-state.json'),profile:'desktop-electron'});
 async function markRollback(input={}){
  if(!exactKeys(input,['operationId','before','after','backupDigest'])||typeof input.operationId!=='string'||!uuidPattern.test(input.operationId))
   fail('desktop_update_launcher_rollback_scope_invalid');
  const backupDigest=normalizeDigest(input.backupDigest),before=normalizeDeployment(input.before,'desktop-electron'),
   after=normalizeDeployment(input.after,'desktop-electron');
  const loaded=await store.read(),operation=loaded.state?.operation,handoff=operation?.handoff;
  if(!loaded.enabled||!operation||operation.id!==input.operationId||operation.profile!=='desktop-electron'||operation.phase!=='active'||
   !['attempted','rolled-back'].includes(operation.startupStatus)||handoff?.state!=='rolled-back'||
   !operation.candidate||!operation.recoveryPoint||
   before.active.releaseId!==handoff.candidate.releaseId||before.active.manifestSha256!==handoff.candidate.manifestSha256||
   !before.previous||before.previous.releaseId!==handoff.previous.releaseId||before.previous.manifestSha256!==handoff.previous.manifestSha256||
   after.active.releaseId!==handoff.previous.releaseId||after.active.manifestSha256!==handoff.previous.manifestSha256||
   !after.previous||after.previous.releaseId!==handoff.candidate.releaseId||after.previous.manifestSha256!==handoff.candidate.manifestSha256||
   stable(before.active)!==stable(after.previous)||stable(before.previous)!==stable(after.active)||
   operation.candidate.releaseId!==handoff.candidate.releaseId||operation.candidate.manifestSha256!==handoff.candidate.manifestSha256||
   operation.recoveryPoint.backupId!==backupDigest||handoff.recovery.backupId!==backupDigest||
   operation.recoveryPoint.releaseId!==handoff.recovery.releaseId||handoff.recovery.releaseId!==before.previous.releaseId)
   fail('desktop_update_launcher_rollback_scope_invalid');
  const result=await store.markRollback({operationId:input.operationId,before,after,backupDigest});
  if(!result.enabled||result.state?.operation?.id!==input.operationId||stable(result.state.operation.rollbackTarget)!==stable(after.active))
   fail('desktop_update_launcher_rollback_scope_invalid');
  return result;
 }
 async function prepareRestoredStartup(input={}){
  if(!plainRecord(input)||Object.keys(input).some(key=>!['operationId','before','after','previous','recovery'].includes(key))||
   typeof input.operationId!=='string'||!uuidPattern.test(input.operationId)||
   Object.hasOwn(input,'before')!==Object.hasOwn(input,'after')||
   !(Object.hasOwn(input,'previous')||Object.hasOwn(input,'after'))||!plainRecord(input.recovery))
   fail('desktop_update_restored_startup_invalid');
  if(Object.hasOwn(input,'before')){
   const marked=await markRollback({operationId:input.operationId,before:input.before,after:input.after,backupDigest:input.recovery.backupId});
   if(!marked.enabled)fail('desktop_update_launcher_rollback_scope_invalid');
  }
  return store.prepareRestoredStartup({operationId:input.operationId,previous:input.previous??input.after?.active,recovery:input.recovery});
 }
 return Object.freeze({readHandoff:store.readHandoff,transitionHandoff:store.transitionHandoff,
  readStartup:store.readStartup,waitForStartup:store.waitForStartup,prepareRestoredStartup,
  readRestoredStartup:store.readRestoredStartup,waitForRestoredStartup:store.waitForRestoredStartup,markRollback});
}
