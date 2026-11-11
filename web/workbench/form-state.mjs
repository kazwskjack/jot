import {replyPolicyInput} from './reply-policy-ui.mjs';
const required=(value,label)=>{const text=String(value??'').trim();if(!text)throw new Error(`请填写${label}`);return text;};
const integer=(value,label,min,max)=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw new Error(`${label}必须为 ${min}–${max} 的整数`);return number;};
/** @returns {import('../../packages/gateway/contracts/types').CreatePersistentTask} */
export function taskInput(form,limits,modelBudgetEnabled=false,unlimitedRunsEnabled=false) {
 const input={title:required(form.title,'任务名称'),agent_id:required(form.agent_id,'执行角色'),objective:required(form.objective,'任务目标'),trigger:taskTriggerInput(form,limits)};
 if(form.max_runs==='unlimited'){
  if(!unlimitedRunsEnabled)throw new Error('服务器尚未支持不限运行次数');
  input.budget={max_runs:null};
 }else if(String(form.max_runs??'').trim())input.budget={max_runs:integer(form.max_runs,'最多运行次数',1,10000)};
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
export function validateTaskWizardStep(form,step,limits,modelBudgetEnabled=false,unlimitedRunsEnabled=false){
 if(step===0){required(form.title,'任务名称');required(form.agent_id,'执行角色');required(form.objective,'任务目标');return;}
 if(step===1){taskTriggerInput(form,limits);return;}
 if(step===2){taskInput({...form,reply_settings:undefined},limits,modelBudgetEnabled,unlimitedRunsEnabled);return;}
 if(step===3||step===4){taskInput(form,limits,modelBudgetEnabled,unlimitedRunsEnabled);return;}
 throw new Error('任务向导步骤无效');
}
export function taskTriggerInput(form,limits) {
 const trigger={kind:form.kind};
 if(!['once','interval','page_change','daily','weekly','cron','delay','conversation_message','conversation_result'].includes(form.kind))throw new Error('当前不支持这个触发方式');
 if(['conversation_message','conversation_result'].includes(form.kind)){trigger.conversation_id=required(form.conversation_id,'来源对话');if(trigger.conversation_id.length>200)throw new Error('对话标识过长');}
 if(['interval','page_change'].includes(form.kind))trigger.interval_seconds=integer(form.interval_seconds,'检查间隔（秒）',limits?.min_interval_seconds??60,limits?.max_interval_seconds??31536000);
 if(form.kind==='delay')trigger.delay_seconds=integer(form.delay_seconds,'延迟时间（秒）',1,31536000);
 if(form.kind==='cron'){
  trigger.expression=required(form.expression,'Cron 表达式');if(trigger.expression.length>120)throw new Error('Cron 表达式不能超过 120 个字符');
  trigger.timezone=required(form.timezone,'IANA 时区');if(trigger.timezone.length>100)throw new Error('IANA 时区不能超过 100 个字符');
  if(form.missed_triggers!==undefined){if(!['coalesce','skip','catch_up'].includes(form.missed_triggers))throw new Error('漏触发策略无效');trigger.missed_triggers=form.missed_triggers;}
 }
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
 return {title:'',agent_id:agentId,objective:'',kind:'once',conversation_id:'',interval_seconds:String(limits?.default_interval_seconds??300),url:'',expression:'',delay_seconds:'',max_runs:'100',run_at:'',time:'09:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',weekdays:[new Date().getDay()],model_budget_enabled:false,model_tokens:String(modelLimits?.tokens??0),model_dollars:modelLimits?nanoToDollars(modelLimits.nano_usd):'0',model_calls:String(modelLimits?.model_calls??0),notification_settings:{channel_binding_ids:[],artifact_delivery_binding_ids:[],artifact_delivery_binding_versions:{},events:['completed']}};
}
export function taskCreationNotificationInput(value){
 if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['channel_binding_ids','artifact_delivery_binding_ids','artifact_delivery_binding_versions','events'].includes(key))||!Array.isArray(value.channel_binding_ids)||value.channel_binding_ids.length>5||new Set(value.channel_binding_ids).size!==value.channel_binding_ids.length||value.channel_binding_ids.some(id=>typeof id!=='string'||!id||id.length>128)||!Array.isArray(value.events)||value.events.length>4||new Set(value.events).size!==value.events.length||value.events.some(event=>!['changed','completed','failed','needs_confirmation'].includes(event)))throw new Error('请选择有效的通知渠道和条件');
 const artifacts=value.artifact_delivery_binding_ids??[];
 if(!Array.isArray(artifacts)||artifacts.length>5||new Set(artifacts).size!==artifacts.length||artifacts.some(id=>typeof id!=='string'||!value.channel_binding_ids.includes(id))||artifacts.length&&!value.events.includes('completed'))throw new Error('文件交付需选择通知渠道并启用任务完成通知');
 return {channel_binding_ids:[...value.channel_binding_ids],artifact_delivery_binding_ids:[...artifacts],events:[...value.events]};
}
/** @returns {{channel_binding_ids:string[],artifact_delivery_binding_ids:string[],artifact_delivery_binding_versions:Partial<Record<string,number>>,events:import('./types').TaskNotificationSettings['events']}} */
export function taskCreationNotificationDefaults(value){
 return {channel_binding_ids:value?.channel_binding_ids??[],artifact_delivery_binding_ids:value?.artifact_delivery_binding_ids??[],artifact_delivery_binding_versions:value?.artifact_delivery_binding_versions??{},events:value?.events??['completed']};
}
export function taskCreationNotificationDraft(value){
 const input=taskCreationNotificationInput(value);
 const artifacts=value.artifact_delivery_binding_ids??[],versions=value.artifact_delivery_binding_versions??{};
 if(!versions||typeof versions!=='object'||Array.isArray(versions)||Object.keys(versions).some(id=>!artifacts.includes(id)||!Number.isSafeInteger(versions[id])||versions[id]<1)||artifacts.some(id=>!Number.isSafeInteger(versions[id])||versions[id]<1))throw new Error('文件交付需保留 binding 版本以便恢复草稿');
 return {...input,artifact_delivery_binding_versions:{...versions}};
}
export function taskFormFromMessage(selection,agents,limits,modelLimits){
 const message=selection?.message;
 const agent=agents.find(value=>value.conversation_id===selection?.conversation_id&&value.status!=='archived');
 if(typeof selection?.conversation_id!=='string'||!selection.conversation_id||selection.conversation_id.length>200||message?.status!=='complete'||typeof message.message_id!=='string'||!message.message_id||message.message_id.length>200)throw new Error('来源消息不可用，请返回对话重新选择');
 const objective=(message.blocks??[]).filter(block=>block.kind==='text').map(block=>block.text??'').join('\n').slice(0,12000);
 return {...blankTaskForm(agent?.agent_id??'',limits,modelLimits),objective,source:{conversation_id:selection.conversation_id,message_id:message.message_id}};
}
/** @returns {Omit<ReturnType<typeof blankTaskForm>,'notification_settings'>&{missed_triggers?:string}} */
export function taskFormFromTask(task,limits) {
 return {...Object.fromEntries(Object.entries(blankTaskForm(task.agent_id,limits)).filter(([key])=>key!=='notification_settings')),title:task.title,objective:task.objective,kind:task.trigger.kind,conversation_id:task.trigger.conversation_id??'',interval_seconds:String(task.trigger.interval_seconds??limits?.default_interval_seconds??300),url:task.trigger.url??'',expression:task.trigger.expression??'',delay_seconds:task.trigger.delay_seconds===undefined?'':String(task.trigger.delay_seconds),missed_triggers:task.trigger.kind==='cron'?task.trigger.missed_triggers:undefined,max_runs:task.budget.max_runs===null?'unlimited':String(task.budget.max_runs),run_at:task.trigger.run_at??'',time:task.trigger.time??'09:00',timezone:task.trigger.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone??'UTC',weekdays:[...(task.trigger.weekdays??[new Date().getDay()])]};
}
export function taskTriggerSummary(trigger,language='zh-CN') {
 const en=language==='en';
 if(trigger.kind==='project_discovery')return en?'Project Discovery Policy':'项目发现策略';
 if(trigger.kind==='conversation_message')return en?'New Conversation Message':'对话收到新消息';
 if(trigger.kind==='conversation_result')return en?'New Conversation Result':'对话完成新结果';
 if(trigger.kind==='once')return en?'Once':'单次';
 if(trigger.kind==='page_change')return en?'Page Change':'网页变化';
 if(trigger.kind==='cron')return `Cron ${trigger.expression} · ${trigger.timezone}`;
 if(trigger.kind==='delay')return en?`After ${trigger.delay_seconds} Seconds`:`延迟 ${trigger.delay_seconds} 秒`;
 if(trigger.kind==='daily')return en?`Daily ${trigger.time} · ${trigger.timezone}`:`每日 ${trigger.time} · ${trigger.timezone}`;
 if(trigger.kind==='weekly')return en?`Weekly ${(trigger.weekdays??[]).map(day=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')} ${trigger.time} · ${trigger.timezone}`:`每周 ${(trigger.weekdays??[]).map(day=>['周日','周一','周二','周三','周四','周五','周六'][day]).join('、')} ${trigger.time} · ${trigger.timezone}`;
 return en?`Every ${trigger.interval_seconds} Seconds`:`每 ${trigger.interval_seconds} 秒`;
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
export function canResumeTask(task) { return ['paused','budget_exhausted'].includes(task.status)&&(task.budget.max_runs===null||task.runs_used<task.budget.max_runs); }
export function taskRunCountLabel(task,language='zh-CN'){return language==='en'?(task.budget.max_runs===null?`${task.runs_used} Runs · Unlimited`:`${task.runs_used} / ${task.budget.max_runs} Runs`):(task.budget.max_runs===null?`已运行 ${task.runs_used} 次 · 不限次数`:`已运行 ${task.runs_used} / ${task.budget.max_runs}`);}
export function selectInitialConversation(items,initial,saved) {
 const visible=items.filter(item=>!item.archived_at);
 if(initial){if(!visible.some(item=>item.conversation_id===initial))throw new Error('此角色对话不可用或已归档，请返回角色列表刷新。');return initial;}
 // Recency does not express user selection: a list item can belong to a role
 // or a separate workflow. Start empty rather than silently substituting it.
 return visible.find(item=>item.conversation_id===saved)?.conversation_id??'';
}
export function teamInput(form) {
 const input={name:required(form.name,'团队名称'),member_ids:[...(form.member_ids??[])]};
 if(!input.member_ids.length)throw new Error('请至少选择一个成员');
 if(form.team_id)input.expected_version=form.version;
 else {input.workspace_id=required(form.workspace_id,'工作区');if(form.project_id)input.project_id=form.project_id;}
 return input;
}
import {budgetLimitInput,nanoToDollars} from './budget-ui.mjs';
