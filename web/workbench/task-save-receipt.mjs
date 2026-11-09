export const mutationRejected=error=>Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408&&error.message!=='IDEMPOTENCY_IN_PROGRESS';

// Current-page idempotency receipt. Network failure is not proof of rejection.
export class TaskSaveReceipt {
 /**
  * @param {() => string} [key]
  * @param {{read:()=>{command?:{path:string,method:string,body:unknown,key:string}|null}|null,saveCommand:(command:{path:string,method:string,body:unknown,key:string}|null,expected?:{key:string})=>void,complete:(expected?:{key:string})=>void}|null} [store]
  */
 constructor(key=()=>crypto.randomUUID(),store=null){this.key=key;this.store=store;this.command=store?.read()?.command??null;this.busy=false;}
 get pending(){return this.command!==null;}
 async submit(request,path,method,body){
  if(this.busy)throw new Error('任务正在保存');
  if(!this.command){const command={path,method,body:structuredClone(body),key:this.key()};this.store?.saveCommand(command);this.command=command;}
  const command=this.command;this.busy=true;
  try{const result=await request(command.path,command.method,structuredClone(command.body),command.key);this.store?.complete(command);this.command=null;return result;}
  catch(error){if(mutationRejected(error)){this.store?.saveCommand(null,command);this.command=null;}throw error;}
  finally{this.busy=false;}
 }
}


// Same-tab, owner-scoped recovery reuses the original atomic server receipt.
export class ProjectLifecycleStore {
 constructor(storage,scope){
  if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('project_lifecycle_scope_invalid');
  this.storage=storage;this.key=`jot-project-lifecycle/v1/${scope}`;
 }
 validate(command){
  if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).sort().join(',')!=='body,key,method,path'
   ||typeof command.path!=='string'||!/^\/projects\/[A-Za-z0-9_%.-]{1,600}\/lifecycle$/.test(command.path)||command.method!=='POST'
   ||typeof command.key!=='string'||command.key.length<8||command.key.length>200)throw new Error('project_lifecycle_command_invalid');
  const body=command.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,expected_version'
   ||!['archive','restore','delete'].includes(body.action)||!Number.isSafeInteger(body.expected_version)||body.expected_version<1)throw new Error('project_lifecycle_command_invalid');
 }
 read(){
  const raw=this.storage.getItem(this.key);if(!raw)return null;
  if(raw.length>4096)throw new Error('project_lifecycle_command_invalid');
  const command=JSON.parse(raw);this.validate(command);return {command};
 }
 saveCommand(command){if(command===null){this.complete();return;}this.validate(command);this.storage.setItem(this.key,JSON.stringify(command));}
 complete(){this.storage.removeItem(this.key);}
}


export class WorkspaceSelectionStore {
 constructor(storage,scope){
  if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('workspace_selection_scope_invalid');
  this.storage=storage;this.key=`jot-workspace-selection/v1/${scope}`;
 }
 validate(command){
  if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).sort().join(',')!=='body,key,method,path'
   ||command.path!=='/workspaces/selection'||command.method!=='POST'||typeof command.key!=='string'||command.key.length<8||command.key.length>200)throw new Error('workspace_selection_command_invalid');
  const body=command.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='expected_version,workspace_id'
   ||typeof body.workspace_id!=='string'||!body.workspace_id||body.workspace_id.length>128||!Number.isSafeInteger(body.expected_version)||body.expected_version<0)throw new Error('workspace_selection_command_invalid');
 }
 read(){
  const raw=this.storage.getItem(this.key);if(!raw)return null;
  if(raw.length>4096)throw new Error('workspace_selection_command_invalid');
  const command=JSON.parse(raw);this.validate(command);return {command};
 }
 saveCommand(command){if(command===null){this.complete();return;}this.validate(command);this.storage.setItem(this.key,JSON.stringify(command));}
 complete(){this.storage.removeItem(this.key);}
}


export class ArtifactRecoveryStore {
 constructor(storage,scope,artifactId){
  if(!/^[a-f0-9]{64}$/.test(scope)||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(artifactId))throw new Error('文件恢复范围尚未确认');
  this.closing=false;this.storage=storage;this.key=`jot-artifact-recovery/v1/${scope}/${artifactId}`;this.path=`/artifacts/${encodeURIComponent(artifactId)}/restore`;this.archivePath=`/artifacts/${encodeURIComponent(artifactId)}/archive`;
 }
 validate(command){
  if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).sort().join(',')!=='body,key,method,path'
   ||command.path!==this.path&&command.path!==this.archivePath||command.method!=='POST'||typeof command.key!=='string'||!/^[!-~]{8,128}$/.test(command.key)
   ||!command.body||typeof command.body!=='object'||Array.isArray(command.body)
   ||!Number.isSafeInteger(command.body.expected_version)||command.body.expected_version<1)throw new Error('文件恢复回执无法读取');
  const body=command.body,keys=Object.keys(body).sort().join(',');
  if(command.path===this.archivePath){
   if(keys!=='expected_sha256,expected_version'||typeof body.expected_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.expected_sha256))throw new Error('文件归档回执无法读取');
   return;
  }
  if(keys==='expected_version')return;
  if(!['expected_version,restore_sha256,restore_version','expected_version,part_index,restore_sha256,restore_version'].includes(keys)
   ||!Number.isSafeInteger(body.restore_version)||body.restore_version<1||body.restore_version>body.expected_version
   ||typeof body.restore_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.restore_sha256)
   ||body.part_index!==undefined&&(!Number.isSafeInteger(body.part_index)||body.part_index<1||body.part_index>50||body.restore_version!==1))throw new Error('文件恢复回执无法读取');
 }
 read(){const record=this.readRecord();return record?{command:record.command}:null;}
 readRecord(){
  const raw=this.storage.getItem(this.key);if(raw===null)return null;
  if(raw.length>4096)throw new Error('文件恢复回执无法读取');
  const value=JSON.parse(raw),wrapped=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='closing,command,version';
  if(wrapped&&(value.version!==1||typeof value.closing!=='boolean'))throw new Error('文件恢复回执无法读取');
  const command=wrapped?value.command:value;this.validate(command);this.closing=wrapped&&value.closing;
  return {command,closing:this.closing};
 }
 requestClose(){
  const record=this.readRecord();if(!record)throw new Error('原文件请求尚未读取');
  this.storage.setItem(this.key,JSON.stringify({version:1,command:record.command,closing:true}));this.closing=true;
 }
 saveCommand(command,expected){
  if(command===null){this.complete(expected);return;}
  this.validate(command);const current=this.read()?.command;
  if(current&&JSON.stringify(current)!==JSON.stringify(command))throw new Error('请先确认原文件恢复请求');
  if(current)return;
  this.storage.setItem(this.key,JSON.stringify(command));this.closing=false;
 }
 complete(expected){
  const current=this.read()?.command;
  if(current&&current.key!==expected?.key)throw new Error('文件恢复回执已变化');
  this.storage.removeItem(this.key);this.closing=false;
 }
}
