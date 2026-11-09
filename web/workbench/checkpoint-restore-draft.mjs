// Original restore hints clear only after a validated durable command outcome.
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const invalid=()=>{throw Error('CHECKPOINT_RESTORE_DRAFT_INVALID')};
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))invalid()};
const restorePath=path=>typeof path==='string'&&/\/checkpoints\/[^/]+\/restore$/.test(path);
function checked(command,workspace){
 object(command,['path','method','body','key']);
 const match=/^\/workspaces\/([^/]+)\/checkpoints\/([^/]+)\/restore$/.exec(command.path);
 if(!match||match[1]!==encodeURIComponent(workspace)||command.method!=='POST'||typeof command.key!=='string'||!ID.test(command.key))invalid();
 let checkpoint;try{checkpoint=decodeURIComponent(match[2])}catch{invalid()}
 if(!ID.test(checkpoint)||encodeURIComponent(checkpoint)!==match[2])invalid();
 const body=command.body;object(body,['project_id','path','review_id','review_sha256']);
 if(typeof body.project_id!=='string'||!ID.test(body.project_id)||typeof body.review_id!=='string'||!ID.test(body.review_id)||typeof body.review_sha256!=='string'||!SHA.test(body.review_sha256)
  ||typeof body.path!=='string'||!body.path||body.path.length>4096||body.path.startsWith('-')||/^[A-Za-z]:/.test(body.path)||/[\\\x00-\x1f\x7f]/.test(body.path)||body.path.split('/').some(part=>!part||part==='.'||part==='..'))invalid();
 return structuredClone(command);
}

/** One original restore request hint, scoped by the BFF account scope and
 * workspace. Metadata only; loading never sends or authorizes an operation. */
export class CheckpointRestoreDraftStore{
 constructor(storage,scope,workspace){this.storage=storage;this.scope=scope;this.workspace=workspace;this.original=null;this.issue=''}
 validate(command){return checked(command,this.workspace)}
 backend(){return typeof this.storage==='function'?this.storage():this.storage}
 name(){if(!SHA.test(this.scope)||typeof this.workspace!=='string'||!this.workspace||this.workspace.length>128)throw Error('CHECKPOINT_RESTORE_SCOPE_UNAVAILABLE');return 'jot-checkpoint-restore:v1:'+this.scope+':'+encodeURIComponent(this.workspace)}
 read(){
  if(this.issue)return null;
  if(!this.scope)return null;
  try{
   const raw=this.backend().getItem(this.name())??this.original;if(raw===null)return null;
   if(this.original!==null&&raw!==this.original)throw Error('CHECKPOINT_RESTORE_DRAFT_CONFLICT');
   if(typeof raw!=='string'||raw.length>32768)invalid();let value;try{value=JSON.parse(raw)}catch{invalid()}
   object(value,['version','scope','workspace','command']);if(value.version!==1||value.scope!==this.scope||value.workspace!==this.workspace)invalid();
   const command=checked(value.command,this.workspace);this.original=raw;return {command};
  }catch(error){this.issue=['CHECKPOINT_RESTORE_DRAFT_INVALID','CHECKPOINT_RESTORE_DRAFT_CONFLICT'].includes(error?.message)?error.message:'CHECKPOINT_RESTORE_STORAGE_UNAVAILABLE';return null}
 }
 saveCommand(value){
  if(this.issue)throw Error(this.issue);
  if(value===null){this.complete();return}
  if(!restorePath(value.path)){if(this.read())this.issue='CHECKPOINT_RESTORE_DRAFT_CONFLICT';if(this.issue)throw Error(this.issue);return}
  const command=checked(value,this.workspace),name=this.name(),storage=this.backend();
  const raw=JSON.stringify({version:1,scope:this.scope,workspace:this.workspace,command}),prior=storage.getItem(name);
  if(prior!==null&&prior!==raw){this.issue='CHECKPOINT_RESTORE_DRAFT_CONFLICT';throw Error(this.issue);}
  storage.setItem(name,raw);this.original=raw;
 }
 complete(){
  if(this.original===null)return;
  const storage=this.backend(),name=this.name(),prior=storage.getItem(name);
  if(prior!==null&&prior!==this.original)throw Error('CHECKPOINT_RESTORE_DRAFT_CONFLICT');
  if(prior!==null)storage.removeItem(name);this.original=null;
 }
}

/** Keep wire errors intact. A restore error cannot prove that its original
 * journal/effect is absent, so retain the command until an outcome is read.
 * Ordinary file commands keep the receipt engine's existing error behavior. */
export function checkpointRestoreTransport(send){return async(path,method,...args)=>{
 try{return await send(path,method,...args)}catch(error){
  if(restorePath(path)&&method==='POST'&&Number.isInteger(error?.status)&&error.status>=400&&error.status<500)throw Object.assign(new Error(error.message,{cause:error}),{status:503});
  throw error;
 }
};}


/** Query only the original command. Absence never permits clearing or replay. */
export async function readCheckpointRestoreCommand(command,workspace,send){
 const frozen=checked(command,workspace),match=/^\/workspaces\/[^/]+\/checkpoints\/([^/]+)\/restore$/.exec(frozen.path);
 const query=new URLSearchParams(frozen.body);
 const descriptor={workspace_id:workspace,checkpoint_id:decodeURIComponent(match[1]),command_key:frozen.key,...frozen.body};
 const canonical=JSON.stringify(Object.fromEntries(Object.entries(descriptor).sort(([a],[b])=>a<b?-1:a>b?1:0)));
 const expectedDigest=Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical))),byte=>byte.toString(16).padStart(2,'0')).join('');
 const result=await send(`${frozen.path.replace(/\/restore$/,'')}/restore-requests/${encodeURIComponent(frozen.key)}?${query}`);
 const common=['state','command_key','request_sha256','command_sha256','execution_authorized','restore_authorized'];
 const variants={unobserved:[],recorded_pending:['operation_id'],settled:['operation_id','receipt'],terminal_rejected:['no_effect','reason']};
 const exactStatus=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
 if(!result||typeof result.state!=='string'||!Object.hasOwn(variants,result.state)||!exactStatus(result,[...common,...variants[result.state]])||result.execution_authorized!==false||result.restore_authorized!==false||result.command_key!==frozen.key||!SHA.test(result.request_sha256)||result.command_sha256!==expectedDigest)throw Error('CHECKPOINT_RESTORE_STATUS_INVALID');
 if(result.state==='terminal_rejected'&&result.no_effect===true&&result.reason==='workspace_checkpoint_review_changed')return result;
 if(result.state==='settled'&&exactStatus(result.receipt,['protocol','operation_id','checkpoint_id','path','outcome','target_state_sha256','result_version','source_revision','execution_authorized','restore_authorized'])&&typeof result.operation_id==='string'&&ID.test(result.operation_id)&&result.receipt?.operation_id===result.operation_id&&SHA.test(result.receipt.target_state_sha256)&&Number.isSafeInteger(result.receipt.source_revision)&&result.receipt.source_revision>=0&&(result.receipt.result_version===null||Number.isSafeInteger(result.receipt.result_version)&&result.receipt.result_version>0)&&result.receipt.execution_authorized===false&&result.receipt.restore_authorized===false&&result.receipt?.protocol===1&&result.receipt.checkpoint_id===decodeURIComponent(match[1])&&result.receipt.path===frozen.body.path&&['applied','not_applied'].includes(result.receipt.outcome))return result;
 if(result.state==='unobserved')return result;
 if(result.state==='recorded_pending'&&typeof result.operation_id==='string'&&ID.test(result.operation_id))return result;
 throw Error('CHECKPOINT_RESTORE_STATUS_INVALID');
}
