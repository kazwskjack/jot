import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import TaskReplyPolicyPanel from './TaskReplyPolicyPanel';
import TaskReplyHistoryPanel from './TaskReplyHistoryPanel';
import ReplyPolicyFields from './ReplyPolicyFields';
import WorkPublicationPanel from './WorkPublicationPanel';
import {publicationOccurrence} from './publication-ui.mjs';
import {findOwnedOccurrence,findOwnedTask} from './desktop-open-task.mjs';
import {MutationPending} from './useMutationReceipt';
import {replyModes} from './reply-policy-ui.mjs';
import {createNotificationRefreshFocusTracker,advanceNotificationRefreshFocus} from './notification-ui.mjs';
import {dialogTabBoundaryTarget} from './dialog-focus.mjs';
import React,{useContext,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {Agent,Caps,Task,TaskSchedulePreview,TaskSourceSelection} from './types';
import {workbenchApi,pathId,taskActionCommand} from './client';
import {ApiError,request,taskDraftScope} from '../jot/client';
import {TaskSaveReceipt,TaskDraftStore,TaskActionStore} from './task-save.mjs';
import {useResource} from './useResource';
import {validateTaskWizardStep,taskInput,taskTriggerInput,blankTaskForm,taskFormFromTask,taskTriggerSummary,taskFormFromMessage,scheduleTime,executionReason,canResumeTask,taskRunCountLabel,taskCreationNotificationDefaults} from './form-state.mjs';
import {beginSchedulePreview} from './calendar-ui.mjs';
import {ResourceStatus,Empty} from './PanelStatus';
import LucideIcon from '../icons/LucideIcon';
import TaskLedgerPanel from './TaskLedgerPanel';
import TaskPrdPanel from './TaskPrdPanel';
import TaskBudgetPanel from './TaskBudgetPanel';
import {budgetError,nanoToDollars} from './budget-ui.mjs';
import TaskRunControls from './TaskRunControls';
import type {Run} from '../jot/types';
import TaskMembersPanel from './TaskMembersPanel';
import TaskCollaborationPanel from './TaskCollaborationPanel';
import TaskNotificationsPanel from './TaskNotificationsPanel';
import TaskArtifactDeliveryOptions,{type TaskArtifactDeliverySelection} from './TaskArtifactDeliveryOptions';
const states:Record<string,string>={active:'已启用',paused:'已暂停',archived:'已归档',budget_exhausted:'预算用尽',queued:'已排队',running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已取消',pending:'等待中',waiting_approval:'等待确认',waiting_user:'等待补充',interrupted:'已中断',completed:'已验收完成',acceptance_confirmed:'已验收，等待收尾',acceptance_rejected:'验收未通过',evidence_recorded:'已记录执行证据',waiting_evidence:'等待验收证据'};

type Form={reply_settings?:Record<string,any>;notification_settings?:{channel_binding_ids:string[];artifact_delivery_binding_ids?:string[];artifact_delivery_binding_versions?:Partial<Record<string,number>>;events:string[]};source?:{conversation_id:string;message_id:string};title:string;agent_id:string;objective:string;kind:string;conversation_id:string;interval_seconds:string;url:string;expression:string;delay_seconds:string;missed_triggers?:string;max_runs:string;run_at:string;time:string;timezone:string;weekdays:number[];model_budget_enabled:boolean;model_tokens:string;model_dollars:string;model_calls:string};
type Preview={status:string;message?:string;result?:TaskSchedulePreview;unchanged?:boolean};
type DesktopOpenTaskIdentity=Readonly<{task_id:string;occurrence_id:string}>;
const triggers=[['once','单次执行'],['interval','按间隔执行'],['daily','每日执行'],['weekly','每周执行'],['cron','Cron 表达式'],['delay','延迟执行'],['page_change','网页发生变化'],['conversation_message','对话收到新消息'],['conversation_result','对话完成新结果']];
const weekdays=[[1,'周一'],[2,'周二'],[3,'周三'],[4,'周四'],[5,'周五'],[6,'周六'],[0,'周日']] as const;
export default function TasksPanel({caps,agents,onConversation,taskSource,onTaskSourceConsumed,desktopOpenTask,onDesktopOpenTaskConsumed}:{caps:Caps;agents:Agent[];onConversation:(id:string)=>void;taskSource?:TaskSourceSelection|null;onTaskSourceConsumed?:()=>void;desktopOpenTask?:DesktopOpenTaskIdentity|null;onDesktopOpenTaskConsumed?:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const supported=caps.workbench?.task_triggers??[],enabled=caps.workbench?.enabled===true&&supported.length>0;
 const unlimitedRunsEnabled=caps.workbench?.task_unlimited_runs===true&&caps.workbench?.task_run_limit_protocol===1;
 const limits=caps.workbench?.task_schedule_limits,minInterval=limits?.min_interval_seconds??60,maxInterval=limits?.max_interval_seconds??31536000;
 const message=(value:string)=>value===`检查间隔（秒）必须为 ${minInterval}–${maxInterval} 的整数`?t(value,`Check Interval Must Be an Integer from ${minInterval} to ${maxInterval} Seconds`):taskUiMessage(value,language);
 const execution=executionReason(caps.workbench);
 const modelLimits=caps.workbench?.task_model_budget_limits,modelBudgetEnabled=caps.workbench?.model_budget===true&&!!modelLimits;
 const scope=taskDraftScope();
 const resource=useResource(signal=>workbenchApi.tasks(signal),`tasks:${scope??''}`,enabled);
 const recovery=useMemo(()=>{if(!scope)return {store:null,data:null,error:''};try{const store=new TaskDraftStore(sessionStorage,scope);return {store,data:store.read(),error:''};}catch{return {store:null,data:null,error:'本机任务草稿无法读取；不会自动重新提交。请保留原保存回执并核对服务端任务。'};}},[scope]);
 const [step,setStep]=useState(recovery.data?4:0),[desktopOccurrenceRoute,setDesktopOccurrenceRoute]=useState<DesktopOpenTaskIdentity|null>(null);
 const [form,setForm]=useState<Form|null>(recovery.data?.form??null),[editing,setEditing]=useState<Task|null>(recovery.data?.editing??null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[detail,setDetail]=useState<Task|null>(null),[notice,setNotice]=useState('');
  const detailOpener=useRef<HTMLButtonElement|null>(null),restoreDetailFocus=useRef(false),taskRouteRefresh=useRef<{identity:DesktopOpenTaskIdentity;baseline:unknown;finished:boolean}|null>(null);
 const finishDesktopOccurrenceRoute=useCallback(()=>setDesktopOccurrenceRoute(null),[]);
 const closeDetail=()=>{setDesktopOccurrenceRoute(null);restoreDetailFocus.current=true;setDetail(null);};
 useLayoutEffect(()=>{if(detail||!restoreDetailFocus.current)return;restoreDetailFocus.current=false;const opener=detailOpener.current;if(opener?.isConnected&&!opener.disabled)opener.focus();},[detail]);
 const [preview,setPreview]=useState<Preview|null>(null);
 const deliveryEnabled=caps.workbench?.task_create_delivery===true;
 const deliveryBindings=useResource(signal=>workbenchApi.channelBindings(signal),`task-create-bindings:${scope??''}`,!!form&&!editing&&deliveryEnabled&&caps.workbench?.channel_bindings===true);
 const deliveryEvents=[['completed','任务完成'],['changed','页面有变化'],['failed','执行失败'],['needs_confirmation','需要你确认']] as const;
 const delivery=taskCreationNotificationDefaults(form?.notification_settings);
 const artifactChoices:TaskArtifactDeliverySelection[]=delivery.artifact_delivery_binding_ids.flatMap(id=>{const version=delivery.artifact_delivery_binding_versions?.[id];return typeof version==='number'&&Number.isSafeInteger(version)&&version>0?[{channel_binding_id:id,binding_version:version}]:[];});
 const setArtifactChoices=(choices:TaskArtifactDeliverySelection[])=>setForm(current=>current?{...current,notification_settings:{...(current.notification_settings??delivery),artifact_delivery_binding_ids:choices.map(choice=>choice.channel_binding_id),artifact_delivery_binding_versions:Object.fromEntries(choices.map(choice=>[choice.channel_binding_id,choice.binding_version]))}}:current);
 const assertDelivery=()=>{const artifacts=delivery.artifact_delivery_binding_ids??[],versions=delivery.artifact_delivery_binding_versions??{};if(delivery.channel_binding_ids.length&&(deliveryBindings.loading||deliveryBindings.error||delivery.channel_binding_ids.some(id=>!deliveryBindings.data?.items.some(binding=>binding.channel_binding_id===id&&binding.status==='verified'))))throw new Error('通知渠道尚未确认或已失效，请刷新并重新选择');if(artifacts.length!==artifactChoices.length||artifacts.some(id=>{const binding=deliveryBindings.data?.items.find(item=>item.channel_binding_id===id);return !delivery.channel_binding_ids.includes(id)||!delivery.events.includes('completed')||!Number.isSafeInteger(versions[id])||binding?.status!=='verified'||binding.channel!=='wecom'||binding.version!==versions[id];}))throw new Error('文件交付目标或 binding 版本已变化，请重新选择');};
 const dialogue=!!form&&['conversation_message','conversation_result'].includes(form.kind);
 const conversations=useResource(signal=>request<{items:{conversation_id:string;title?:string;archived_at?:string|null}[]}>('/conversations?limit=50','GET',undefined,undefined,signal),'task-source-conversations',enabled&&dialogue);
 const previewKey=form?JSON.stringify({kind:form.kind,conversation_id:form.conversation_id,interval_seconds:form.interval_seconds,url:form.url,expression:form.expression,delay_seconds:form.delay_seconds,run_at:form.run_at,time:form.time,timezone:form.timezone,weekdays:form.weekdays}):'';
 const previewAvailable=!!form&&enabled&&supported.includes(form.kind);
 const unchangedDelayEdit=!!editing&&form?.kind==='delay'&&editing.trigger.kind==='delay'&&form.delay_seconds===String(editing.trigger.delay_seconds);
 const formKey=useRef(''),saveReceipt=useRef(new TaskSaveReceipt(undefined,recovery.store)),receiptOwnerScope=useRef(scope??''),ownerScopeRef=useRef(scope??'');
 const controls=useMemo(()=>{
  const value:{key:string;receipt:TaskSaveReceipt|null;error:string}={key:crypto.randomUUID(),receipt:null,error:''};
  try{value.receipt=new TaskSaveReceipt(()=>value.key,new TaskActionStore(sessionStorage,scope));}
  catch{value.error='任务操作回执无法读取；请保留浏览器存储并核对原操作。';}
  return value;
 },[scope]);
 const taskOperationPending=controls.receipt?.pending===true;
 const actionsBlocked=busy||taskOperationPending||!!controls.error;
 const pendingAction=controls.receipt?.command;
 const pendingTask=resource.data?.items.find(task=>pendingAction?.path.startsWith('/persistent-tasks/'+pathId(task.task_id)+'/'));
 const actionLabels:Record<string,string>={pause:'暂停',resume:'恢复',archive:'归档','run-now':'立即运行'};
 const [receiptScopeMismatch,setReceiptScopeMismatch]=useState(false);
 useEffect(()=>{const currentScope=scope??'',changed=ownerScopeRef.current!==currentScope;ownerScopeRef.current=currentScope;if(changed){setDetail(null);setError('');setNotice('');setPreview(null);}if(saveReceipt.current.pending){setReceiptScopeMismatch(receiptOwnerScope.current!==currentScope);return;}if(!changed&&receiptOwnerScope.current===currentScope)return;saveReceipt.current=new TaskSaveReceipt(undefined,recovery.store);receiptOwnerScope.current=currentScope;setReceiptScopeMismatch(false);setForm(null);setEditing(null);setStep(0);},[scope,recovery.store,busy]);
 useEffect(()=>{if(form&&!saveReceipt.current.pending&&recovery.store)try{recovery.store.saveDraft(form,editing,step);}catch{setError('本机草稿无法保存；请释放站点存储后重试。');}},[form,editing,step,recovery.store]);
 useEffect(()=>{
  if(!previewKey){setPreview(null);return;}
  if(!previewAvailable){setPreview({status:'unavailable',message:'此触发方式尚未接入服务'});return;}
  if(unchangedDelayEdit){setPreview({status:'ready',result:{next_due_at:editing!.next_due_at,timezone:null},unchanged:true});return;}
  let trigger;
  try{trigger=taskTriggerInput(JSON.parse(previewKey),{min_interval_seconds:minInterval,max_interval_seconds:maxInterval});}
  catch(e){setPreview({status:'invalid',message:e instanceof Error?e.message:'请填写完整的触发规则'});return;}
  return beginSchedulePreview(trigger,request,setPreview);
 },[previewKey,previewAvailable,minInterval,maxInterval,unchangedDelayEdit,editing?.next_due_at]);
 useEffect(()=>{if(!enabled)return;const timer=setInterval(()=>{if(!document.hidden&&!busy&&!form)resource.reload();},15000);return()=>clearInterval(timer);},[enabled,busy,form]);
 useEffect(()=>{
  if(!desktopOpenTask){taskRouteRefresh.current=null;return;}
   if(!enabled){taskRouteRefresh.current={identity:desktopOpenTask,baseline:resource.data,finished:true};setNotice('该通知关联的任务或执行记录当前不可用。');onDesktopOpenTaskConsumed?.();return;}
  let attempt=taskRouteRefresh.current;
  if(attempt?.identity!==desktopOpenTask){
    attempt={identity:desktopOpenTask,baseline:resource.data,finished:false};taskRouteRefresh.current=attempt;resource.reload();return;
  }
  if(!attempt||attempt.finished)return;
  if(resource.loading||resource.error)return;
   if(resource.data===attempt.baseline)return;
  if(!resource.data)return;
  const task=findOwnedTask(resource.data.items,desktopOpenTask);attempt.finished=true;
  if(!task){setNotice('该通知关联的任务或执行记录当前不可用。');onDesktopOpenTaskConsumed?.();return;}
  setNotice('');setDesktopOccurrenceRoute(desktopOpenTask);setDetail(task);onDesktopOpenTaskConsumed?.();
 },[desktopOpenTask,enabled,resource.loading,resource.error,resource.data,resource.reload,onDesktopOpenTaskConsumed]);
 const run=async(action:()=>Promise<void>)=>{if(busy)return;const actionScope=scope??'';setBusy(true);setError('');setNotice('');try{await action();if(ownerScopeRef.current===actionScope)resource.reload();}catch(e){if(ownerScopeRef.current===actionScope){const message=e instanceof Error?e.message:'操作未完成';setError(/^(BUDGET_|MODEL_BUDGET_)/.test(message)?budgetError(message):message);}}finally{setBusy(false);}};
 const start=(task?:Task)=>{if(saveReceipt.current.pending||recovery.error||taskOperationPending)return;setStep(0);setEditing(task??null);formKey.current=crypto.randomUUID();setError('');setPreview(null);setForm(task?taskFormFromTask(task,limits):{...blankTaskForm(agents[0]?.agent_id??'',limits,modelLimits),kind:supported.includes('once')?'once':supported[0]??'once'});};
 useEffect(()=>{if(!taskSource||!enabled||!agents.length||saveReceipt.current.pending||recovery.error)return;try{setStep(0);setEditing(null);formKey.current=crypto.randomUUID();setForm(taskFormFromMessage(taskSource,agents,limits,modelLimits));setError('');onTaskSourceConsumed?.();}catch(e){setError(e instanceof Error?e.message:'来源不可用');onTaskSourceConsumed?.();}},[taskSource,enabled,agents]);
 const change=(key:Exclude<keyof Form,'weekdays'|'model_budget_enabled'>,value:string)=>{if(['kind','conversation_id','interval_seconds','url','expression','delay_seconds','run_at','time','timezone'].includes(key))setPreview(null);setForm(current=>current?{...current,[key]:value}:current);};
 const toggleDay=(day:number)=>{setPreview(null);setForm(current=>current?{...current,weekdays:current.weekdays.includes(day)?current.weekdays.filter(value=>value!==day):[...current.weekdays,day].sort((a,b)=>a-b)}:current);};
 const next=()=>{try{validateTaskWizardStep(form,step,limits,!editing&&modelBudgetEnabled,unlimitedRunsEnabled);if(step===1&&preview?.status!=='ready')throw new Error('请等待服务器确认触发规则');setError('');if(step===3&&!editing&&deliveryEnabled)assertDelivery();setStep(current=>Math.min(4,current+1));}catch(e){setError(e instanceof Error?e.message:'请补全当前步骤');}};
 const save=(e:React.FormEvent)=>{e.preventDefault();if(step!==4||recovery.error||receiptScopeMismatch||taskOperationPending)return;const saveScope=scope??'';void run(async()=>{if(saveReceipt.current.pending){if(receiptOwnerScope.current!==(scope??''))throw new Error('账户范围已变化；请切回原范围核对待确认任务。');await saveReceipt.current.submit(request,'/persistent-tasks','POST',{});}else{const input=taskInput(form,limits,!editing&&modelBudgetEnabled,unlimitedRunsEnabled);if(!editing&&deliveryEnabled)assertDelivery();if(!deliveryEnabled||editing)delete input.notification_settings;if(!editing&&form?.reply_settings!==undefined&&caps.workbench?.task_reply_policy!==true)throw new Error('当前服务不支持保存回复规则，请关闭向导后重新创建仅报告任务。');if(editing)delete input.reply_policy;if(!supported.includes(input.trigger.kind))throw new Error('此触发方式尚未接入服务');if(!agents.some(agent=>agent.agent_id===input.agent_id&&agent.status==='active'))throw new Error('执行角色已失效，请重新选择');recovery.store?.saveDraft(form,editing,4);receiptOwnerScope.current=scope??'';await saveReceipt.current.submit(request,editing?`/persistent-tasks/${pathId(editing.task_id)}`:'/persistent-tasks',editing?'PATCH':'POST',{...input,...(editing?{expected_version:editing.version}:{})});}if(ownerScopeRef.current!==saveScope)return;try{recovery.store?.clear();}catch{}setForm(null);setEditing(null);setNotice('任务配置已保存。运行状态以执行记录为准。');});};
 const action=(task?:Task,kind?:string)=>void run(async()=>{
  if(taskDraftScope()!==scope)throw new Error('任务账户范围已变化；请切回原账户后重试。');
  const receipt=controls.receipt;if(!receipt)throw new Error(controls.error);
  let command=receipt.command;
  if(!command){
   if(!task||!kind)throw new Error('原任务操作回执不可用');
   if(kind==='run-now'&&execution)throw new Error(execution);
   command={...taskActionCommand(task,kind,controls.key),key:controls.key};
  }
  const send=async(path:string,method:string,body:unknown,key:string)=>{
   try{
    await request('/capabilities');
    if(taskDraftScope()!==scope)throw new Error('任务账户范围已变化；请切回原账户后重试。');
    return await request(path,method,body,key);
   }catch(error){
    if(error instanceof ApiError&&(error.status===401||error.status===403))throw new Error('任务操作身份尚未确认；请恢复原账户后重试原请求。');
    throw error;
   }
  };
  try{
   await receipt.submit(send,command.path,command.method,command.body);
   if(ownerScopeRef.current===(scope??''))setNotice(command.path.endsWith('/run-now')?'执行请求已接收。请在执行记录中查看进展。':'任务状态已更新。');
  }finally{if(!receipt.pending)controls.key=crypto.randomUUID();}
 });
 return <div lang={language}><div className="wb-toolbar"><div><h2>{message('持续任务')}</h2><p>{message(execution?'保存角色与规则，等待执行宿主就绪。':'关闭页面后，任务仍由服务器按保存的规则唤醒。')}</p></div><button className="wb-primary" disabled={!enabled||!agents.length||busy||taskOperationPending||saveReceipt.current.pending||!!recovery.error} title={message(!agents.length?'请先创建执行角色':!enabled?'服务器尚未启用持续任务':'')} onClick={()=>start()}><LucideIcon name="plus"/>{message('创建任务')}</button></div>
  {recovery.error&&<p className="wb-error" role="alert">{message(recovery.error)}</p>}
  {controls.error&&<p className="wb-error" role="alert">{message(controls.error)}</p>}
  {taskOperationPending&&<div className="wb-status" role="status"><p>{pendingTask?.title??message('原任务')}{t('的',' ')}{message(actionLabels[pendingAction?.path.split('/').at(-1)??'']??'任务操作')}{t('请求结果尚未确认。重试会复用原请求体和请求键。',' Request Outcome Is Unconfirmed. Retrying Reuses the Original Body and Request Key.')}</p><button type="button" disabled={busy} onClick={()=>action()}>{message('重试原任务操作')}</button></div>}
  {!enabled&&<Empty>{message('服务器尚未启用持续任务。')}</Empty>}<ResourceStatus {...resource} error={message(resource.error)} onRetry={resource.reload}/>{error&&<p className="wb-error" role="alert">{message(error)}</p>}{notice&&<p className="wb-status" role="status">{message(notice)}</p>}
  {enabled&&execution&&<p className="wb-status wb-execution-notice" role="status">{message(execution)}</p>}
  {receiptScopeMismatch&&<p className="wb-status" role="status">{message('账户范围已变化。原保存回执仍保留；请切回创建时的账户范围后重试。')}</p>}
  {form&&!receiptScopeMismatch&&<form className="wb-form" aria-label={message(editing?'编辑持续任务':'创建持续任务')} onSubmit={save}><div className="wb-form-head"><h3>{message(editing?'编辑任务':'新的持续任务')}</h3><button type="button" disabled={busy||saveReceipt.current.pending} aria-label={message('关闭任务编辑')} onClick={()=>{recovery.store?.clear();setForm(null);setEditing(null);}}><LucideIcon name="x"/></button></div>
<ol className="wb-actions" aria-label={message('创建任务步骤')}>{['目标与角色','触发规则','运行预算','通知与交付','总确认'].map((label,index)=><li key={label} aria-current={step===index?'step':undefined}>{index+1}. {message(label)}</li>)}</ol>
   <fieldset hidden={step!==0} disabled={busy||saveReceipt.current.pending||step!==0}>   {form.source&&<p className="wb-status">{message('来自已完成的对话消息。请确认目标、触发方式和预算；保存后由服务器核验来源。来源不会自动授权通知或回复。')}</p>}
   <div className="wb-form-grid"><label>{message('任务名称')}<input autoFocus required maxLength={200} value={form.title} onChange={e=>change('title',e.target.value)}/></label><label>{message('执行角色')}<select aria-label={message('执行角色')} required value={form.agent_id} onChange={e=>change('agent_id',e.target.value)}><option value="">{message('选择执行角色')}</option>{agents.filter(agent=>agent.status!=='archived').map(agent=><option key={agent.agent_id} value={agent.agent_id}>{agent.name}</option>)}</select></label></div>
   <label>{message('目标与结果要求')}<textarea rows={4} required value={form.objective} maxLength={12000} onChange={e=>change('objective',e.target.value)}/></label>
</fieldset>
   <fieldset hidden={step!==1} disabled={busy||saveReceipt.current.pending||step!==1}>   <div className="wb-form-grid"><label>{message('触发方式')}<select value={form.kind} onChange={e=>change('kind',e.target.value)}>{triggers.map(([value,label])=><option key={value} value={value} disabled={!supported.includes(value)}>{message(label)}{!supported.includes(value)?message('（尚未接入）'):''}</option>)}</select></label></div>
   {form.kind==='once'&&<label>{message('执行时间（留空立即执行）')}<input value={form.run_at} onChange={e=>change('run_at',e.target.value)} placeholder="2026-10-01T20:00:00+08:00"/></label>}
   {['interval','page_change'].includes(form.kind)&&<label>{t(`检查间隔（秒，${minInterval}–${maxInterval}）`,`Check Interval (Seconds, ${minInterval}–${maxInterval})`)}<input type="number" required min={minInterval} max={maxInterval} step={1} value={form.interval_seconds} onChange={e=>change('interval_seconds',e.target.value)}/></label>}
   {['daily','weekly'].includes(form.kind)&&<><div className="wb-form-grid"><label>{message('执行时间')}<input type="time" required step={60} value={form.time} onChange={e=>change('time',e.target.value)}/></label><label>{message('IANA 时区')}<input required value={form.timezone} onChange={e=>change('timezone',e.target.value)} placeholder="Asia/Hong_Kong"/><small>{message('默认使用当前设备时区；按此时区的当地时间执行。')}</small></label></div>{form.kind==='weekly'&&<fieldset><legend>{message('每周执行日')}</legend><div className="wb-actions">{weekdays.map(([day,label])=><label className="wb-checkbox" key={day}><input type="checkbox" checked={form.weekdays.includes(day)} onChange={()=>toggleDay(day)}/>{message(label)}</label>)}</div><small>{message('请至少选择一天。')}</small></fieldset>}{limits?.dst_gap==='next_valid_time'&&limits?.dst_fold==='first_only'&&<small>{message('夏令时跳过的时间顺延到下一有效时间；重复的时间仅执行第一次。')}</small>}</>}
    {form.kind==='cron'&&<><div className="wb-form-grid"><label>{message('Cron 表达式')}<input required maxLength={120} spellCheck={false} value={form.expression} onChange={e=>change('expression',e.target.value)} placeholder="0 9 * * 1-5"/></label><label>{message('IANA 时区')}<input required maxLength={100} value={form.timezone} onChange={e=>change('timezone',e.target.value)} placeholder="Asia/Hong_Kong"/></label></div><small>{message('填写五段 Cron 规则；首次执行时间由服务器按此 IANA 时区计算。')}</small></>}
    {form.kind==='delay'&&<><label>{message('延迟时间（秒）')}<input type="number" required min={1} max={31536000} step={1} value={form.delay_seconds} onChange={e=>change('delay_seconds',e.target.value)}/></label><small>{message('服务器首次受理时设置一次截止时间；编辑任务其他字段会保留原时间。')}</small></>}
   {form.kind==='page_change'&&<label>{message('网页地址')}<input type="url" required value={form.url} onChange={e=>change('url',e.target.value)} placeholder="https://example.com/news"/><small>{message('首次检查建立基线，后续正文变化才派发任务。服务端校验公开网页访问范围。')}</small></label>}
   {dialogue&&<><ResourceStatus {...conversations} error={message(conversations.error)} onRetry={conversations.reload}/><label>{message('来源对话')}<select required value={form.conversation_id} onChange={e=>change('conversation_id',e.target.value)}><option value="">{message('选择自己的对话')}</option>{form.conversation_id&&!conversations.data?.items.some(item=>item.conversation_id===form.conversation_id)&&<option value={form.conversation_id}>{message('当前来源对话')}</option>}{conversations.data?.items.filter(item=>!item.archived_at).map(item=><option key={item.conversation_id} value={item.conversation_id}>{item.title||message('未命名对话')}</option>)}</select><small>{message('保存后只跟踪新事件；暂停和恢复后从当前消息继续。任务自己的回复不会再次唤醒自己。')}</small></label></>}
    <p className="wb-status" role="status" aria-live="polite">{preview?.status==='ready'?(dialogue?t('来源对话已确认；等待保存之后的新事件。','Source Conversation Confirmed; Waiting for New Events After Saving.'):preview.unchanged?t(`当前截止时间：${scheduleTime(preview.result?.next_due_at,preview.result?.timezone)}（未修改延迟规则时保存会保留原时间）`,`Current Deadline: ${scheduleTime(preview.result?.next_due_at,preview.result?.timezone)} (Saving Retains It When the Delay Rule Is Unchanged)`):t(`${form.kind==='page_change'?'首次检查预览':'首次执行预览'}：${scheduleTime(preview.result?.next_due_at,preview.result?.timezone)}（服务器计算，保存时重新确认）`,`${form.kind==='page_change'?'First Check Preview':'First Run Preview'}: ${scheduleTime(preview.result?.next_due_at,preview.result?.timezone)} (Calculated by Server; Reconfirmed When Saving)`)):preview?.status==='loading'?t(dialogue?'正在确认来源对话…':'正在计算首次检查 / 执行时间…',dialogue?'Confirming Source Conversation…':'Calculating First Check / Run Time…'):message(preview?.message??'填写触发规则后显示首次执行预览。')}</p>
</fieldset>
   <fieldset hidden={step!==2} disabled={busy||saveReceipt.current.pending||step!==2}><>{(unlimitedRunsEnabled||form.max_runs==='unlimited')&&<label className="wb-checkbox"><input type="checkbox" disabled={!unlimitedRunsEnabled} checked={form.max_runs==='unlimited'} onChange={e=>change('max_runs',e.target.checked?'unlimited':'100')}/>{message('不限运行次数')}</label>}{form.max_runs==='unlimited'?<p className="wb-hint">{message('不限运行次数，仍会遵守模型额度和任务权限。')}</p>:<label>{message('最多运行次数')}<input type="number" required min={1} max={10000} step={1} value={form.max_runs} onChange={e=>change('max_runs',e.target.value)}/></label>}</>   {!editing&&modelBudgetEnabled&&<fieldset disabled={busy}><legend>{message('模型额度')}</legend><label className="wb-checkbox"><input type="checkbox" checked={form.model_budget_enabled} onChange={e=>setForm(current=>current?{...current,model_budget_enabled:e.target.checked}:current)}/>{message('设置本任务的模型额度')}</label>{form.model_budget_enabled?<><div className="wb-form-grid"><label>{message('任务 Token 上限')}<input inputMode="numeric" required value={form.model_tokens} onChange={e=>change('model_tokens',e.target.value)}/></label><label>{message('任务费用上限（USD，或填“不限额”）')}<input inputMode="decimal" required value={form.model_dollars} onChange={e=>change('model_dollars',e.target.value)}/></label><label>{message('任务模型调用次数上限')}<input inputMode="numeric" required value={form.model_calls} onChange={e=>change('model_calls',e.target.value)}/></label></div><small>{t(`服务器允许上限：${modelLimits!.tokens} Token、${nanoToDollars(modelLimits!.nano_usd)} USD、${modelLimits!.model_calls} 次模型调用。额度与任务一起保存；0 会限制新增模型调用。`,`Server Ceilings: ${modelLimits!.tokens} Tokens, ${message(nanoToDollars(modelLimits!.nano_usd))} USD, ${modelLimits!.model_calls} Model Calls. Limits Are Saved with the Task; Zero Restricts New Model Calls.`)}</small></>:<small>{t(`使用服务器默认额度：${modelLimits!.tokens} Token、${nanoToDollars(modelLimits!.nano_usd)} USD、${modelLimits!.model_calls} 次模型调用。`,`Server Default Budget: ${modelLimits!.tokens} Tokens, ${message(nanoToDollars(modelLimits!.nano_usd))} USD, ${modelLimits!.model_calls} Model Calls.`)}</small>}<p className="wb-hint">{message('这些是任务累计模型额度；一次执行可能调用模型多次。之后可在执行记录中调整，消耗不会清零。')}</p></fieldset>}
</fieldset>
   <fieldset hidden={step!==3} disabled={busy||saveReceipt.current.pending||step!==3}><legend>{message('通知与交付')}</legend>
   {editing?<p>{message('保留当前通知授权。请在执行记录的通知设置中单独调整，不随普通任务编辑改变。')}</p>:<><p>{message('结果始终保存在应用内。外部通知只发送到明确选中的已验证渠道。')}</p>
    {deliveryEnabled?<><ResourceStatus {...deliveryBindings} error={message(deliveryBindings.error)} onRetry={deliveryBindings.reload}/>{deliveryBindings.data?.items.filter(binding=>binding.status==='verified').map(binding=><label className="wb-checkbox" key={binding.channel_binding_id}><input type="checkbox" checked={delivery.channel_binding_ids.includes(binding.channel_binding_id)} onChange={event=>setForm(current=>{if(!current)return current;const value=current.notification_settings??delivery,ids=event.target.checked?[...value.channel_binding_ids,binding.channel_binding_id]:value.channel_binding_ids.filter(id=>id!==binding.channel_binding_id),artifacts=(value.artifact_delivery_binding_ids??[]).filter(id=>ids.includes(id));return {...current,notification_settings:{...value,channel_binding_ids:ids,artifact_delivery_binding_ids:artifacts,artifact_delivery_binding_versions:Object.fromEntries(artifacts.map(id=>[id,value.artifact_delivery_binding_versions?.[id]]))}};})}/>{message(binding.channel==='email'?'邮箱':binding.channel==='wecom'?'微信企业':'浏览器通知')}{t('渠道 ',' Channel ')}{binding.channel_binding_id.slice(-6)}</label>)}
    <button type="button" onClick={()=>setForm(current=>current?{...current,notification_settings:{...delivery,channel_binding_ids:[],artifact_delivery_binding_ids:[],artifact_delivery_binding_versions:{}}}:current)}>{message('仅保留应用内结果')}</button>
    {deliveryEvents.map(([event,label])=><label className="wb-checkbox" key={event}><input type="checkbox" checked={delivery.events.includes(event)} onChange={change=>setForm(current=>{if(!current)return current;const value=current.notification_settings??delivery,events=change.target.checked?[...value.events,event]:value.events.filter(item=>item!==event),clear=event==='completed'&&!change.target.checked,artifacts=clear?[]:value.artifact_delivery_binding_ids??[];return {...current,notification_settings:{...value,events,artifact_delivery_binding_ids:artifacts,artifact_delivery_binding_versions:Object.fromEntries(artifacts.map(id=>[id,value.artifact_delivery_binding_versions?.[id]]))}};})}/>{message(label)}</label>)}
    <TaskArtifactDeliveryOptions targets={deliveryBindings.data?.items??[]} notificationDraft={{channel_binding_ids:delivery.channel_binding_ids,events:delivery.events}} selected={artifactChoices} scopeEpoch={`${scope??''}:create:${formKey.current}`} disabled={deliveryBindings.loading||!!deliveryBindings.error||!deliveryBindings.data} selectionFrozen={busy||saveReceipt.current.pending} onChange={setArtifactChoices}/>
   <small>{message('最多5个渠道。默认同一收件人最短间隔60秒，24小时最多20次；保存后可在通知设置中调整。没有已验证渠道时先创建应用内任务，再从执行记录绑定邮箱或微信。')}</small></>:<p>{message('此服务尚未启用创建时的外部交付授权，仅保存应用内结果。')}</p>}
   <p>{message('回复规则独立于通知；当前先保存配置，实际回复尚未启用。')}</p></>}
   {!editing&&caps.workbench?.task_reply_policy===true&&<ReplyPolicyFields value={form.reply_settings} onChange={value=>setForm(current=>current?{...current,reply_settings:value}:current)} workspaceId={agents.find(agent=>agent.agent_id===form.agent_id)?.workspace_id} projectId={agents.find(agent=>agent.agent_id===form.agent_id)?.project_id} bindingsEnabled={caps.workbench?.channel_bindings===true} executionEnabled={Boolean(caps.workbench?.task_reply_execution)}/> }
</fieldset>
    {step===4&&<section aria-label={message('任务配置总确认')}><h4>{message('确认任务配置')}</h4><dl><dt>{message('任务')}</dt><dd>{form.title}</dd><dt>{message('执行角色')}</dt><dd>{agents.find(agent=>agent.agent_id===form.agent_id)?.name??message('角色不可用')}</dd><dt>{message('目标')}</dt><dd style={{whiteSpace:'pre-wrap'}}>{form.objective}</dd><dt>{message('触发')}</dt><dd>{(()=>{try{return taskTriggerSummary(taskTriggerInput(form,limits),language);}catch{return message('触发规则尚未完整，请返回修改');}})()}</dd><dt>{message('最多运行')}</dt><dd>{form.max_runs==='unlimited'?message('不限次数'):t(`${form.max_runs} 次`,`${form.max_runs} Runs`)}</dd><dt>{message('模型预算')}</dt><dd>{form.model_budget_enabled?t(`${form.model_tokens} Token / ${form.model_dollars} USD / ${form.model_calls} 次`,`${form.model_tokens} Tokens / ${form.model_dollars==='不限额'?'Unlimited':form.model_dollars} USD / ${form.model_calls} Calls`):message('使用服务器默认额度')}</dd><dt>{message('结果交付')}</dt><dd>{editing?message('保留已有通知设置；不随本次编辑改变'):deliveryEnabled&&delivery.channel_binding_ids.length?t(`应用内结果，以及 ${delivery.channel_binding_ids.length} 个已验证通知渠道`,`In-App Results and ${delivery.channel_binding_ids.length} Verified Notification Channels`):message('仅应用内执行记录')}</dd>{!editing&&deliveryEnabled&&delivery.channel_binding_ids.length>0&&<><dt>{message('通知渠道')}</dt><dd>{delivery.channel_binding_ids.map(id=>{const binding=deliveryBindings.data?.items.find(item=>item.channel_binding_id===id);return `${message(binding?.channel==='email'?'邮箱':binding?.channel==='wecom'?'微信企业':'浏览器通知')} · ${id.slice(-6)}`;}).join(t('、',', '))}</dd><dt>{message('文件输出')}</dt><dd>{delivery.artifact_delivery_binding_ids.length?t(`已选择 WeCom：${delivery.artifact_delivery_binding_ids.map(id=>id.slice(-6)).join('、')}（仅任务完成通知）`,`Selected WeCom: ${delivery.artifact_delivery_binding_ids.map(id=>id.slice(-6)).join(', ')} (Task Completion Notifications Only)`):message('关闭')}</dd><dt>{message('提醒条件')}</dt><dd>{deliveryEvents.filter(([event])=>delivery.events.includes(event)).map(([,label])=>message(label)).join(t('、',', '))||message('不发送提醒')}</dd><dt>{message('发送限制')}</dt><dd>{message('最短60秒；同一收件人24小时最多20次；无安静时段。之后可单独调整。')}</dd></>}<dt>{message('回复方式')}</dt><dd>{editing?message('保留已有独立回复规则'):message(replyModes.find(([mode])=>mode===(form.reply_settings?.mode??'report'))?.[1]??'')}</dd>{!editing&&form.reply_settings&&form.reply_settings.mode!=='report'&&<><dt>{message('回复目标与方向')}</dt><dd>{form.reply_settings.target_id} · {form.reply_settings.topic} · {form.reply_settings.tone}</dd><dt>{message('回复限制')}</dt><dd>{t(`每日${form.reply_settings.max_per_24_hours}次，冷却${form.reply_settings.min_interval_seconds}秒，有效至${form.reply_settings.expires_at}；`,`Daily Limit ${form.reply_settings.max_per_24_hours}; Cooldown ${form.reply_settings.min_interval_seconds} Seconds; Expires ${form.reply_settings.expires_at}; `)}{form.reply_settings.quiet_enabled?`${form.reply_settings.quiet_start}–${form.reply_settings.quiet_end} · ${form.reply_settings.quiet_timezone}`:message('无静默时段')}{t('。','.')}</dd><dt>{message('禁止事项')}</dt><dd>{form.reply_settings.forbidden}</dd>{!caps.workbench?.task_reply_execution&&<dd>{message('保存本身不会生成或发送回复；实际发送尚未启用。')}</dd>}</>}{form.source&&<><dt>{message('来源')}</dt><dd>{t('已完成消息 ','Completed Message ')}{form.source.message_id}</dd></>}</dl><p className="wb-hint">{message('保存会启用服务器触发规则。恢复草稿不会自动保存；仍需在这里确认。角色工具权限沿用现有配置。')}</p></section>}
    {saveReceipt.current.pending&&<p role="status">{message('保存结果尚未确认。重试保留原任务内容；确认前请不要重复创建。')}</p>}
    <div className="wb-actions">{step>0&&<button type="button" disabled={busy||saveReceipt.current.pending} onClick={()=>setStep(value=>value-1)}>{message('上一步')}</button>}{step<4?<button key="next-step" className="wb-primary" type="button" disabled={busy||!!recovery.error||saveReceipt.current.pending} onClick={next}>{message('下一步')}</button>:<button key="confirm-save" type="submit" className="wb-primary" disabled={busy||!!recovery.error||receiptScopeMismatch}>{message(saveReceipt.current.pending?'重试原任务':busy?'正在保存…':'确认并保存任务')}</button>}</div>
  </form>}
  {!resource.loading&&!resource.error&&enabled&&!resource.data?.items.length&&!form&&<Empty>{message('尚无持续任务。选择角色、触发方式和运行预算后开始。')}</Empty>}
  <div className="wb-task-list">{resource.data?.items.map(task=><article className="wb-task-card" key={task.task_id}><div className="wb-card-top"><div><h3>{task.title}</h3><small>{agents.find(agent=>agent.agent_id===task.agent_id)?.name??message('角色已移除')} · {taskTriggerSummary(task.trigger,language)}</small></div><span className="wb-badge">{states[task.status]?message(states[task.status]):task.status}</span></div><p>{task.objective}</p><div className="wb-task-meta"><span>{taskRunCountLabel(task,language)}</span><span>{t('下次：','Next: ')}{scheduleTime(task.next_due_at,task.trigger.timezone)}</span></div>{task.last_error&&<p className="wb-error">{t('最近错误：','Latest Error: ')}{task.last_error}</p>}<div className="wb-actions"><button disabled={busy} onClick={event=>{detailOpener.current=event.currentTarget;setDetail(task);}}>{message('执行记录')}</button>{task.trigger.kind==='project_discovery'?<span>{message('通过项目发现策略管理')}</span>:<><button disabled={actionsBlocked||task.status==='archived'} onClick={()=>start(task)}>{message('编辑')}</button><button disabled={actionsBlocked||!(task.status==='active'||canResumeTask(task))} onClick={()=>action(task,task.status==='active'?'pause':'resume')}>{message(task.status==='active'?'暂停':'恢复')}</button><button disabled={!!execution||actionsBlocked||task.status==='archived'||task.status==='budget_exhausted'} title={message(execution)} onClick={()=>action(task,'run-now')}>{message('立即运行')}</button><button disabled={actionsBlocked||task.status==='archived'} onClick={()=>action(task,'archive')}>{message('归档')}</button></>}</div></article>)}</div>
  {detail&&<OccurrencePanel key={detail.task_id} task={resource.data?.items.find(item=>item.task_id===detail.task_id)??detail} agents={agents} replyEnabled={caps.workbench?.task_reply_policy===true} replyExecution={Boolean(caps.workbench?.task_reply_execution)} notificationsEnabled={caps.workbench?.task_notifications===true} bindingsEnabled={caps.workbench?.channel_bindings===true} emailBindingsEnabled={caps.workbench?.email_bindings===true} wecomBindingsEnabled={caps.workbench?.wecom_bindings??caps.workbench?.channel_bindings===true} webPushBindingsEnabled={caps.workbench?.webpush_bindings===true} onTaskUpdated={resource.reload} membersEnabled={caps.workbench?.agent_messages===true&&!execution} readinessEnabled={caps.workbench?.task_readiness===true} budgetEnabled={caps.workbench?.model_budget===true} resumeEnabled={caps.capabilities.resume_checkpoint===true} prdEnabled={caps.workbench?.task_prd===true} executionReady={!execution} desktopOpenTask={desktopOccurrenceRoute} onDesktopOpenTaskResolved={finishDesktopOccurrenceRoute} onClose={closeDetail} onConversation={onConversation}/>}
 </div>;
}
function OccurrencePanel({task,agents,replyEnabled,replyExecution,notificationsEnabled,bindingsEnabled,emailBindingsEnabled,wecomBindingsEnabled,webPushBindingsEnabled,onTaskUpdated,membersEnabled,readinessEnabled,budgetEnabled,resumeEnabled,prdEnabled,executionReady,desktopOpenTask,onDesktopOpenTaskResolved,onClose,onConversation}:{task:Task;agents:Agent[];replyEnabled:boolean;replyExecution:boolean;notificationsEnabled:boolean;bindingsEnabled:boolean;emailBindingsEnabled:boolean;wecomBindingsEnabled:boolean;webPushBindingsEnabled:boolean;onTaskUpdated:()=>void;membersEnabled:boolean;readinessEnabled:boolean;budgetEnabled:boolean;resumeEnabled:boolean;prdEnabled:boolean;executionReady:boolean;desktopOpenTask?:DesktopOpenTaskIdentity|null;onDesktopOpenTaskResolved?:()=>void;onClose:()=>void;onConversation:(id:string)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const [publicationBusy,setPublicationBusy]=useState(false),reportPending=useContext(MutationPending);
 const publicationPending=useCallback((value:boolean)=>{setPublicationBusy(value);reportPending(value)},[reportPending]);
 const completionLabels={awaiting_completion:'已验收，等待收尾',finalizing:'正在确认完成',reconciliation_pending:'完成状态待核对',completed:'已验收完成'};
 const resource=useResource(signal=>workbenchApi.occurrences(task.task_id,signal),task.task_id),[selectedId,setSelectedId]=useState<string|null>(null),[notice,setNotice]=useState('');
  const notificationFocusReturn=useRef<(()=>void)|null>(null),notificationRefresh=useRef<{started:boolean}|null>(null),occurrenceStatus=useRef<HTMLDivElement>(null),desktopOccurrenceRefresh=useRef<{identity:DesktopOpenTaskIdentity;baseline:unknown;finished:boolean}|null>(null);
 const notificationRefreshTracker=useRef<ReturnType<typeof createNotificationRefreshFocusTracker>|null>(null);if(!notificationRefreshTracker.current)notificationRefreshTracker.current=createNotificationRefreshFocusTracker();
 const selected=resource.data?.items.find(item=>item.occurrence_id===selectedId)??null;
 const publication=publicationOccurrence(task.task_id,selected);
 const run=useResource(signal=>request<Run>(`/runs/${pathId(selected!.run_id!)}`,'GET',undefined,undefined,signal),selected?.run_id??'',!!selected?.run_id);
 const notificationsSaved=(restoreFocus:()=>void)=>{notificationFocusReturn.current=restoreFocus;notificationRefresh.current=notificationRefreshTracker.current!.begin();resource.reload();onTaskUpdated();};
 useLayoutEffect(()=>{notificationRefreshTracker.current!.update(resource.loading);},[resource.loading]);
 useLayoutEffect(()=>{const step=advanceNotificationRefreshFocus(notificationRefresh.current,{loading:resource.loading,error:resource.error,hasData:!!resource.data});notificationRefresh.current=step.pending;if(step.action==='retry'){occurrenceStatus.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();return;}if(step.action==='restore'){notificationFocusReturn.current?.();notificationFocusReturn.current=null;}},[resource.data,resource.error,resource.loading]);
  useEffect(()=>{
   if(!desktopOpenTask){desktopOccurrenceRefresh.current=null;return;}
   if(desktopOpenTask.task_id!==task.task_id)return;
   let attempt=desktopOccurrenceRefresh.current;
   if(attempt?.identity!==desktopOpenTask){
     attempt={identity:desktopOpenTask,baseline:resource.data,finished:false};desktopOccurrenceRefresh.current=attempt;resource.reload();return;
   }
   if(!attempt||attempt.finished)return;
   if(resource.loading||resource.error)return;
    if(resource.data===attempt.baseline)return;
   if(!resource.data)return;
   const occurrence=findOwnedOccurrence(resource.data.items,desktopOpenTask);
   attempt.finished=true;
   if(occurrence){setSelectedId(occurrence.occurrence_id);setNotice('');}
   else setNotice('该通知关联的任务或执行记录当前不可用。');
   onDesktopOpenTaskResolved?.();
  },[desktopOpenTask,task.task_id,resource.loading,resource.error,resource.data,resource.reload,onDesktopOpenTaskResolved]);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden){resource.reload();if(selected?.run_id)run.reload();}},10000);return()=>clearInterval(timer);},[selected?.run_id]);
  return <div lang={language} className="wb-detail-overlay"><section className="wb-detail" role="dialog" aria-modal="true" aria-label={t(`${task.title}执行记录`,`${task.title} Execution Records`)} tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape'&&!publicationBusy){onClose();return;}if(e.key!=='Tab')return;const focusable=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')).filter(element=>!element.closest('[hidden],[aria-hidden="true"],[inert]')&&element.getClientRects().length>0);if(!focusable.length){e.preventDefault();e.currentTarget.focus();return;}const target=dialogTabBoundaryTarget(document.activeElement,focusable,e.shiftKey);if(target){e.preventDefault();target.focus();}}}>
  <div className="wb-form-head"><div><small>{message('执行记录')}</small><h3>{task.title}</h3></div><button autoFocus disabled={publicationBusy} onClick={onClose} aria-label={message('关闭执行记录')}><LucideIcon name="x"/></button></div>
   {budgetEnabled&&<TaskBudgetPanel taskId={task.task_id}/>} {readinessEnabled?<TaskLedgerPanel taskId={task.task_id} taskStatus={task.status}/>:<Empty>{message('服务器尚未接入准备度详情。')}</Empty>}
  {prdEnabled&&<div lang="zh-CN"><TaskPrdPanel key={`prd:${task.task_id}`} task={task} executionReady={executionReady} onBound={()=>{resource.reload();onTaskUpdated();}}/></div>}
  {membersEnabled&&<TaskCollaborationPanel key={task.task_id} task={task} agents={agents}/>}
  <div ref={occurrenceStatus}><ResourceStatus {...resource} error={message(resource.error)} onRetry={resource.reload}/></div>{notice&&<p className="wb-status" role="status">{message(notice)}</p>}
  {!resource.loading&&!resource.error&&!resource.data?.items.length&&<Empty>{message('尚未产生执行记录。')}</Empty>}
  {replyEnabled&&<TaskReplyHistoryPanel key={`reply-history:${task.task_id}`} taskId={task.task_id} onConversation={onConversation}/>}
  <div className="wb-occurrences">{resource.data?.items.map(item=><button key={item.occurrence_id} disabled={publicationBusy} aria-pressed={selectedId===item.occurrence_id} onClick={()=>{setSelectedId(item.occurrence_id);setNotice('');}}><span>{scheduleTime(item.scheduled_for,task.trigger.timezone)}</span><span>{item.completion_state?message(completionLabels[item.completion_state]):states[item.status]?message(states[item.status]):item.status}</span></button>)}</div>
  {replyEnabled&&<TaskReplyPolicyPanel key={task.task_id} taskId={task.task_id} workspaceId={agents.find(agent=>agent.agent_id===task.agent_id)?.workspace_id} projectId={agents.find(agent=>agent.agent_id===task.agent_id)?.project_id} bindingsEnabled={bindingsEnabled} executionEnabled={replyExecution} canEdit={task.status!=='archived'&&!!resource.data&&!resource.loading&&!resource.error&&resource.data.items.every(item=>['succeeded','partial','failed','cancelled','interrupted'].includes(item.status))} onSaved={()=>{resource.reload();onTaskUpdated();}}/>}
  {notificationsEnabled&&<TaskNotificationsPanel taskId={task.task_id} occurrenceId={selected?.occurrence_id} bindingsEnabled={bindingsEnabled} emailBindingsEnabled={emailBindingsEnabled} wecomBindingsEnabled={wecomBindingsEnabled} webPushBindingsEnabled={webPushBindingsEnabled} canEdit={task.status!=='archived'&&!!resource.data&&!resource.loading&&!resource.error&&resource.data.items.every(item=>['succeeded','partial','failed','cancelled','interrupted'].includes(item.status))} onSaved={notificationsSaved}/>}
  {selected&&<div className="wb-run-detail"><p>{t('业务状态：','Business State: ')}{states[selected.business_state]?message(states[selected.business_state]):selected.business_state??'—'}</p>{selected.conversation_id&&<button disabled={publicationBusy} onClick={()=>onConversation(selected.conversation_id!)}>{message('查看本次对话 ↗')}</button>}
   {selected.completion_state&&<p role="status">{message(completionLabels[selected.completion_state])}</p>}
   <ResourceStatus {...run} error={message(run.error)} onRetry={run.reload}/>
   {run.data?.run_id===selected.run_id&&<><dl><dt>{message('运行状态')}</dt><dd>{states[run.data!.status]?message(states[run.data!.status]):run.data!.status}</dd><dt>{message('创建时间')}</dt><dd>{run.data!.created_at}</dd><dt>{message('更新时间')}</dt><dd>{run.data!.updated_at}</dd></dl>
    <TaskRunControls key={selected.run_id} run={run.data!} expectedRunId={selected.run_id!} enabled={resumeEnabled&&!run.error&&!resource.error} loading={run.loading||resource.loading} onRefresh={()=>{run.reload();resource.reload();}} onResumed={()=>{setNotice('恢复请求已接收；继续沿用本次执行的进度和额度。');resource.reload();run.reload();}}/>
   </>}
   {publication&&<div lang="zh-CN"><WorkPublicationPanel key={`${publication.taskId}:${publication.runId}`} {...publication} onBusy={publicationPending}/></div>}
   <TaskMembersPanel key={selected.occurrence_id} task={task} agents={agents} occurrence={selected} run={run.data?.run_id===selected.run_id?run.data:null} enabled={membersEnabled&&!resource.error&&!run.error}/>
   {Boolean(selected.evidence)&&<><h4>{message('检查证据')}</h4><pre>{JSON.stringify(selected.evidence,null,2)}</pre></>}
  </div>}
 </section></div>;
}
