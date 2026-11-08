import {validateReplyForm,validateFrozenReplyPolicy} from './reply-policy-ui.mjs';
import {taskCreationNotificationInput,taskCreationNotificationDraft} from './form-state.mjs';
export {TaskSaveReceipt} from './task-save-receipt.mjs';

const formFields=['source','title','agent_id','objective','kind','conversation_id','interval_seconds','url','expression','delay_seconds','missed_triggers','max_runs','run_at','time','timezone','weekdays','model_budget_enabled','model_tokens','model_dollars','model_calls','notification_settings','reply_settings'];
const taskFields=['source','task_id','title','agent_id','objective','trigger','budget','status','version','runs_used','next_due_at','last_error','created_at'];
const inputFields=['source','title','agent_id','objective','trigger','budget','model_budget','expected_version','notification_settings','reply_policy'];
function object(value,fields){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!fields.includes(key)))throw new Error('任务草稿格式无效');}
function formValue(value){
 object(value,formFields);
 value={expression:'',delay_seconds:'',...value};
 if(formFields.some(key=>!['source','notification_settings','reply_settings','missed_triggers'].includes(key)&&!(key in value)))throw new Error('任务草稿字段缺失');
 for(const [key,item] of Object.entries(value)){
  if(key==='missed_triggers'){if(item!==undefined&&!['coalesce','skip','catch_up'].includes(item))throw new Error('任务草稿漏触发策略无效');}
  else if(key==='reply_settings'){validateReplyForm(item);}
  else if(key==='notification_settings'){taskCreationNotificationDraft(item);}
  else if(key==='weekdays'){if(!Array.isArray(item)||item.length>7||item.some(day=>!Number.isInteger(day)||day<0||day>6))throw new Error('任务草稿星期无效');}
  else if(key==='model_budget_enabled'){if(typeof item!=='boolean')throw new Error('任务草稿预算无效');}
  else if(key==='source'){object(item,['conversation_id','message_id']);if(Object.keys(item).length!==2||Object.values(item).some(id=>typeof id!=='string'||!id||id.length>200))throw new Error('任务草稿来源无效');}
  else if(typeof item!=='string'||item.length>12000)throw new Error('任务草稿字段无效');
 }
 return value;
}
function editingValue(value){object(value,taskFields);if(typeof value.task_id!=='string'||!value.task_id||value.task_id.length>200||!Number.isSafeInteger(value.version)||value.version<1)throw new Error('任务编辑版本无效');}
function command(value){
 if(value===null)return;
 object(value,['path','method','body','key']);
 if(!((value.path==='/persistent-tasks'&&value.method==='POST')||(/^\/persistent-tasks\/[A-Za-z0-9_%.-]{1,600}$/.test(value.path)&&value.method==='PATCH'))||typeof value.key!=='string'||!value.key||value.key.length>200)throw new Error('任务保存回执格式无效');
 object(value.body,inputFields);if(value.body.reply_policy!==undefined)validateFrozenReplyPolicy(value.body.reply_policy);if(value.body.notification_settings!==undefined)taskCreationNotificationInput(value.body.notification_settings);
}
// Same-tab recovery only. The server namespace separates signed-in owners;
// restored data never authorizes execution or widens a server-side grant.
export class TaskDraftStore {
 constructor(storage,scope){if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('任务草稿用户范围不可用');this.storage=storage;this.key=`jot-task-draft/v1/${scope}`;}
 read(){
  const text=this.storage.getItem(this.key);if(!text)return null;
  if(text.length>80000)throw new Error('任务草稿过大');
  const data=JSON.parse(text);object(data,['version','form','editing','step','command']);
  if(data.version!==1||!Number.isInteger(data.step)||data.step<0||data.step>4)throw new Error('任务草稿版本无效');
  if(data.form!==null)data.form=formValue(data.form);if(data.editing!==null)editingValue(data.editing);command(data.command);
  return data;
 }
 write(data){const text=JSON.stringify(data);if(text.length>80000)throw new Error('任务草稿过大');this.storage.setItem(this.key,text);}
 saveDraft(form,editing,step){
  if(form!==null)form=formValue(form);if(editing!==null){editing=Object.fromEntries(taskFields.filter(key=>key in editing).map(key=>[key,editing[key]]));editingValue(editing);}
  if(!Number.isInteger(step)||step<0||step>4)throw new Error('任务草稿步骤无效');
  const old=this.read();if(old?.command&&(JSON.stringify(form)!==JSON.stringify(old.form)||JSON.stringify(editing)!==JSON.stringify(old.editing)))throw new Error('请先确认原任务保存回执');
  this.write({version:1,form,editing,step,command:old?.command??null});
 }
 saveCommand(value){command(value);const old=this.read()??{version:1,form:null,editing:null,step:3};this.write({...old,command:value});}
 complete(){this.write({version:1,form:null,editing:null,step:3,command:null});}
 clear(){if(this.read()?.command)throw new Error('请先确认原任务保存回执');this.storage.removeItem(this.key);}
}

export class TaskActionStore {
 constructor(storage,scope){
  if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('task_action_scope_invalid');
  this.storage=storage;this.key='jot-task-action/v1/'+scope;
 }
 validate(value){
  object(value,['path','method','body','key']);
  if(Object.keys(value).length!==4||value.method!=='POST'||typeof value.path!=='string'||typeof value.key!=='string'||!/^[A-Za-z0-9_-]{8,200}$/.test(value.key))throw new Error('task_action_command_invalid');
  const match=/^\/persistent-tasks\/([^/]+)\/(pause|resume|archive|run-now)$/.exec(value.path);
  if(!match)throw new Error('task_action_command_invalid');
  const id=decodeURIComponent(match[1]);
  if(!id||id.length>200||id==='.'||id==='..'||/[/\\]/.test(id)||encodeURIComponent(id)!==match[1])throw new Error('task_action_command_invalid');
  object(value.body,match[2]==='run-now'?['client_message_id']:['expected_version']);
  if(Object.keys(value.body).length!==1||(match[2]==='run-now'?value.body.client_message_id!==value.key:!Number.isSafeInteger(value.body.expected_version)||value.body.expected_version<1))throw new Error('task_action_command_invalid');
 }
 read(){
  const raw=this.storage.getItem(this.key);if(raw===null)return null;
  if(raw.length>4096)throw new Error('task_action_command_invalid');
  const command=JSON.parse(raw);this.validate(command);return {command};
 }
 saveCommand(command,expected){
  if(command===null){this.complete(expected);return;}
  this.validate(command);const current=this.read()?.command;
  if(current&&JSON.stringify(current)!==JSON.stringify(command))throw new Error('task_action_pending');
  const raw=JSON.stringify(command);this.storage.setItem(this.key,raw);
  if(this.storage.getItem(this.key)!==raw)throw new Error('task_action_storage_unavailable');
 }
 complete(expected){
  const current=this.read()?.command;if(!current||expected&&current.key!==expected.key)return;
  this.storage.removeItem(this.key);
  if(this.storage.getItem(this.key)!==null)throw new Error('task_action_storage_unavailable');
 }
}
