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
  catch(error){if(Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408&&error.message!=='IDEMPOTENCY_IN_PROGRESS'){this.store?.saveCommand(null,command);this.command=null;}throw error;}
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
