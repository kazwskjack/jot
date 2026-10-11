import {replyPolicyInput} from './reply-policy-ui.mjs';
const required=(value,label)=>{const text=String(value??'').trim();if(!text)throw new Error(`请填写${label}`);return text;};
const integer=(value,label,min,max)=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw new Error(`${label}必须为 ${min}–${max} 的整数`);return number;};
export function taskInput(form,limits,modelBudgetEnabled=false) {
 const input={title:required(form.title,'任务名称'),agent_id:required(form.agent_id,'执行角色'),objective:required(form.objective,'任务目标'),trigger:taskTriggerInput(form,limits)};
 if(String(form.max_runs??'').trim())input.budget={max_runs:integer(form.max_runs,'最多运行次数',1,10000)};
 if(form.source!==undefined){
  if(!form.source||Object.keys(form.source).sort().join(',')!=='conversation_id,message_id')throw new Error('任务来源无效');
  const source={conversation_id:required(form.source.conversation_id,'来源对话'),message_id:required(form.source.message_id,'来源消息')};
  if(Object.values(source).some(value=>value.length>200))throw new Error('任务来源标识过长');
  input.source=source;
 }
 if(form.model_budget_enabled){
  if(!modelBudgetEnabled)throw new Error('服务器尚未启用模型预算设置');
  input.model_budget=budgetLimitInput({tokens:form.model_tokens,dollars:form.model_dollars,model_calls:form.model_calls});
 }
 if(form.reply_settings!==undefined)input.reply_policy=replyPolicyInput(form.reply_settings);
 if(form.notification_settings!==undefined)input.notification_settings=taskCreationNotificationInput(form.notification_settings);
 return input;
}
export function validateTaskWizardStep(form,step,limits,modelBudgetEnabled=false){
 if(step===0){required(form.title,'任务名称');required(form.agent_id,'执行角色');required(form.objective,'任务目标');return;}
 if(step===1){taskTriggerInput(form,limits);return;}
 if(step===2){taskInput({...form,reply_settings:undefined},limits,modelBudgetEnabled);return;}
 if(step===3||step===4){taskInput(form,limits,modelBudgetEnabled);return;}
 throw new Error('任务向导步骤无效');
}
export function taskTriggerInput(form,limits) {
 const trigger={kind:form.kind};
 if(!['once','interval','page_change','daily','weekly','conversation_message','conversation_result'].includes(form.kind))throw new Error('当前不支持这个触发方式');
 if(['conversation_message','conversation_result'].includes(form.kind)){trigger.conversation_id=required(form.conversation_id,'来源对话');if(trigger.conversation_id.length>200)throw new Error('对话标识过长');}
 if(['interval','page_change'].includes(form.kind))trigger.interval_seconds=integer(form.interval_seconds,'检查间隔（秒）',limits?.min_interval_seconds??60,limits?.max_interval_seconds??31536000);
 if(form.kind==='once'&&form.run_at){const date=new Date(form.run_at);if(!/(Z|[+-]\d\d:\d\d)$/.test(form.run_at)||!Number.isFinite(date.valueOf()))throw new Error('执行时间需包含时区，例如 +08:00');trigger.run_at=date.toISOString();}
 if(form.kind==='page_change'){let url;try{url=new URL(required(form.url,'网页地址'));}catch{throw new Error('请填写完整的网页地址');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port)))throw new Error('网页地址仅支持不含凭据的 HTTP / HTTPS 标准端口');trigger.url=url.href;}
 if(['daily','weekly'].includes(form.kind)){
  trigger.time=required(form.time,'执行时间');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time))throw new Error('执行时间需为 HH:mm，例如 09:30');
  trigger.timezone=required(form.timezone,'时区');
  try{if(/^[+-]/.test(trigger.timezone))throw new Error();new Intl.DateTimeFormat('zh-CN',{timeZone:trigger.timezone});}catch{throw new Error('请填写有效的 IANA 时区，例如 Asia/Hong_Kong');}
  if(form.kind==='weekly'){
   if(!Array.isArray(form.weekdays)||!form.weekdays.length||form.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6))throw new Error('请至少选择一个有效的星期');
   trigger.weekdays=[...new Set(form.weekdays)].sort((a,b)=>a-b);
  }
 }
 return trigger;
}
export function blankTaskForm(agentId,limits,modelLimits) {
 return {title:'',agent_id:agentId,objective:'',kind:'once',conversation_id:'',interval_seconds:String(limits?.default_interval_seconds??300),url:'',max_runs:'100',run_at:'',time:'09:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',weekdays:[new Date().getDay()],model_budget_enabled:false,model_tokens:String(modelLimits?.tokens??0),model_dollars:nanoToDollars(String(modelLimits?.nano_usd??0)),model_calls:String(modelLimits?.model_calls??0),notification_settings:{channel_binding_ids:[],events:['completed']}};
}
export function taskCreationNotificationInput(value){
 if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['channel_binding_ids','events'].includes(key))||!Array.isArray(value.channel_binding_ids)||value.channel_binding_ids.length>5||new Set(value.channel_binding_ids).size!==value.channel_binding_ids.length||value.channel_binding_ids.some(id=>typeof id!=='string'||!id||id.length>128)||!Array.isArray(value.events)||value.events.length>4||new Set(value.events).size!==value.events.length||value.events.some(event=>!['changed','completed','failed','needs_confirmation'].includes(event)))throw new Error('请选择有效的通知渠道和条件');
 return {channel_binding_ids:[...value.channel_binding_ids],events:[...value.events]};
}
export function taskFormFromMessage(selection,agents,limits,modelLimits){
 const message=selection?.message;
 const agent=agents.find(value=>value.conversation_id===selection?.conversation_id&&value.status!=='archived');
 if(typeof selection?.conversation_id!=='string'||!selection.conversation_id||selection.conversation_id.length>200||message?.status!=='complete'||typeof message.message_id!=='string'||!message.message_id||message.message_id.length>200)throw new Error('来源消息不可用，请返回对话重新选择');
 const objective=(message.blocks??[]).filter(block=>block.kind==='text').map(block=>block.text??'').join('\n').slice(0,12000);
 return {...blankTaskForm(agent?.agent_id??'',limits,modelLimits),objective,source:{conversation_id:selection.conversation_id,message_id:message.message_id}};
}
export function taskFormFromTask(task,limits) {
 return {...Object.fromEntries(Object.entries(blankTaskForm(task.agent_id,limits)).filter(([key])=>key!=='notification_settings')),title:task.title,objective:task.objective,kind:task.trigger.kind,conversation_id:task.trigger.conversation_id??'',interval_seconds:String(task.trigger.interval_seconds??limits?.default_interval_seconds??300),url:task.trigger.url??'',max_runs:String(task.budget.max_runs),run_at:task.trigger.run_at??'',time:task.trigger.time??'09:00',timezone:task.trigger.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone??'UTC',weekdays:[...(task.trigger.weekdays??[new Date().getDay()])]};
}
export function taskTriggerSummary(trigger) {
 if(trigger.kind==='conversation_message')return '对话收到新消息';
 if(trigger.kind==='conversation_result')return '对话完成新结果';
 if(trigger.kind==='once')return '单次';
 if(trigger.kind==='page_change')return '网页变化';
 if(trigger.kind==='daily')return `每日 ${trigger.time} · ${trigger.timezone}`;
 if(trigger.kind==='weekly')return `每周 ${(trigger.weekdays??[]).map(day=>['周日','周一','周二','周三','周四','周五','周六'][day]).join('、')} ${trigger.time} · ${trigger.timezone}`;
 return `每 ${trigger.interval_seconds} 秒`;
}
export function scheduleTime(date,timezone) {
 if(!date)return '—';
 if(!timezone)return new Date(date).toLocaleString();
 try{return `${new Date(date).toLocaleString('zh-CN',{timeZone:timezone,hour12:false})} (${timezone})`;}catch{return `${new Date(date).toLocaleString()} (${timezone})`;}
}
export function agentInput(form) {
 const input={name:required(form.name,'角色名称'),instructions:required(form.instructions,'角色职责'),workspace_id:required(form.workspace_id,'工作区')};
 if(form.project_id)input.project_id=form.project_id;
 if(form.allowed_tools)input.allowed_tools=[...form.allowed_tools];
 if(form.version!==undefined)input.expected_version=form.version;
 return input;
}
export function featureReason(capabilities,feature) {
 return capabilities?.enabled===true&&capabilities?.[feature]===true?'':'当前服务尚未启用此能力，请在服务接入完成后重试。';
}
export function executionReason(capabilities) { return capabilities?.enabled===true&&capabilities?.execution_ready===true?'':'角色与任务可保存；执行宿主尚未就绪'; }
export function canResumeTask(task) { return ['paused','budget_exhausted'].includes(task.status)&&task.runs_used<task.budget.max_runs; }
export function selectInitialConversation(items,initial,saved) {
 const visible=items.filter(item=>!item.archived_at);
 if(initial){if(!visible.some(item=>item.conversation_id===initial))throw new Error('此角色对话不可用或已归档，请返回角色列表刷新。');return initial;}
 return visible.find(item=>item.conversation_id===saved)?.conversation_id??visible[0]?.conversation_id??'';
}
export function teamInput(form) {
 const input={name:required(form.name,'团队名称'),member_ids:[...(form.member_ids??[])]};
 if(!input.member_ids.length)throw new Error('请至少选择一个成员');
 if(form.team_id)input.expected_version=form.version;
 else {input.workspace_id=required(form.workspace_id,'工作区');if(form.project_id)input.project_id=form.project_id;}
 return input;
}
import {budgetLimitInput,nanoToDollars} from './budget-ui.mjs';
