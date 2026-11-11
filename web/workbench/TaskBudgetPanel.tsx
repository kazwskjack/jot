import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {TaskModelBudget,TaskModelBudgetAttempt,TaskModelBudgetAttempts,TaskModelBudgetAttemptsView,ModelBudgetSummary} from './types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';
import {nanoToDollars,budgetLimitInput,budgetReason,budgetError} from './budget-ui.mjs';

function BudgetTable({scope}:{scope:ModelBudgetSummary}){
 const language=useApplicationLanguage();
 const message=(value:string)=>taskUiMessage(value,language);
 return <div lang={language} className="wb-budget-table"><table><thead><tr><th>{message('项目')}</th><th>{message('上限')}</th><th>{message('已消耗')}</th><th>{message('预留中')}</th><th>{message('可用')}</th></tr></thead><tbody>{(['tokens','nano_usd','model_calls'] as const).map(key=><tr key={key}><th>{message(key==='tokens'?'已计量 Token':key==='nano_usd'?'费用（USD）':'模型次数')}</th>{(['limits','used','held','remaining'] as const).map(field=><td key={field}>{key==='nano_usd'?message(nanoToDollars(scope[field][key])):scope[field][key]}</td>)}</tr>)}</tbody></table></div>;
}
export function BudgetDetails({budget,onEdit,busy}:{budget:TaskModelBudget;onEdit:()=>void;busy:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 if(!budget.configured)return <p className="wb-status">{message('服务器尚未启用模型预算；这里暂不显示消耗估算。')}</p>;
 const names={owner_daily:'用户每日',project_daily:'项目每日',agent_daily:'角色每日'} as Record<string,string>;
 return <><BudgetTable scope={budget.root}/><p className="wb-hint">{message('费用按配置费率核算，不等同供应商账单。预留中包含排队或尚未结算的调用；调整上限不会清零消耗。')}</p>
  <p className="wb-hint">{message('Token 仅统计按 Token 计量的模型；按次数计量不代表 Token 用量为零。')}</p>
  {budget.unmetered_token_calls>0&&<p className="wb-hint">{t(`按次数计量的辅助调用：${budget.unmetered_token_calls} 次，已计入模型次数及配置费用，未测量其 Token。`,`${budget.unmetered_token_calls} Auxiliary Per-Call Invocations Are Included in Model Calls and Configured Cost; Their Tokens Were Not Measured.`)}</p>}
  {budget.blocking_reasons.length>0?<ul className="wb-ledger-reasons" aria-label={message('预算限制')}>{budget.blocking_reasons.map(reason=><li key={reason}>{message(budgetReason(reason))}</li>)}</ul>:<p className="wb-status">{message('当前额度足以预留下一次模型调用；执行仍需满足任务授权与状态条件。')}</p>}
  <button disabled={busy} onClick={onEdit}>{message('调整额度')}</button>
  <details className="wb-budget-shared"><summary>{message('每日共享额度（UTC）')}</summary>{budget.shared.map(scope=><section key={scope.kind}><h5>{message(names[scope.kind]??'共享额度')}</h5><BudgetTable scope={scope}/>{scope.ends_at&&<p className="wb-hint">{t('周期结束：','Period Ends: ')}{new Date(scope.ends_at).toLocaleString()}{t('（本地时间）',' (Local Time)')}</p>}</section>)}</details>
 </>;
}
const attemptPurposes:Record<NonNullable<TaskModelBudgetAttempt['purpose']>,string>={compaction:'上下文压缩','session-title':'会话标题',emotion:'情绪分析','web-decision':'网页判断','reply-verification':'回复核验'};
const attemptStates:Record<TaskModelBudgetAttempt['state'],string>={reserved:'已预留',in_flight:'执行中',unknown:'结果未知',settled:'已结算',released:'已释放'};
const attemptMoney=(value:string|null)=>value===null?'未知':`${nanoToDollars(value)} USD`;
const attemptCount=(value:string|null)=>value===null?'未知':value;
function mergeAttemptItems(existing:TaskModelBudgetAttempt[],incoming:TaskModelBudgetAttempt[]){
 const items=[...existing],positions=new Map(items.map((item,index)=>[item.attempt_ref,index]));
 for(const item of incoming){
  const index=positions.get(item.attempt_ref);
  if(index===undefined){positions.set(item.attempt_ref,items.length);items.push(item);}
  else items[index]=item;
 }
 return items;
}
function AttemptUsage({usage}:Pick<TaskModelBudgetAttempt,'usage'>){
 const language=useApplicationLanguage();
 const message=(value:string)=>taskUiMessage(value,language);
 const rows:[string,string|null][]=[['输入 Token',usage.input_tokens],['输出 Token',usage.output_tokens],['缓存读取 Token',usage.cache_read_tokens],['缓存写入 Token',usage.cache_write_tokens],['推理 Token',usage.reasoning_tokens],['总 Token',usage.total_tokens]];
 const partial=usage.status==='settled'&&rows.some(([,value])=>value===null);
 const label=usage.status==='settled'?(partial?'已结算；部分用量分桶未知':'已确认用量'):usage.status==='unknown'?'用量未知；不会按 0 估算':usage.status==='not_metered'?'此类调用不按 Token 计量；不代表 Token 为 0':'用量不可用；不会按 0 估算';
 return <><p className="wb-hint">{message(label)}</p><dl className="wb-readiness-dimensions">{rows.map(([name,value])=><React.Fragment key={name}><dt>{message(name)}</dt><dd>{message(usage.status==='not_metered'?'未计量':attemptCount(value))}</dd></React.Fragment>)}</dl></>;
}
export function BudgetAttemptHistory({page,onNext,busy=false}:{page:TaskModelBudgetAttemptsView;onNext:(cursor:string)=>void;busy?:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 return <section lang={language} className="wb-task-ledger" aria-label={message('模型调用记录')}><h4>{message('调用记录')}</h4><p className="wb-hint">{message('费用按配置费率核算（非供应商账单）。用量未确认时保留未知，不按 0 估算。')}</p>
  {!page.items.length?<p className="wb-status">{message('暂无模型调用记录。')}</p>:page.items.map(item=>{
   const usageConfirmed=item.usage.status==='settled'||item.usage.status==='not_metered';
   const state=item.state==='settled'&&!usageConfirmed?'已结算（用量不完整）':attemptStates[item.state];
   return <article className="wb-ledger-item" key={item.attempt_ref}><div className="wb-card-top"><strong>{message(item.purpose?attemptPurposes[item.purpose]:'模型调用')}</strong><span className="wb-badge">{message(state)}</span></div>
    <p><time dateTime={item.created_at}>{item.created_at}</time></p>
    <p>{t('预留：','Reserved: ')}{message(attemptCount(item.reserved.tokens))} Token · {message(attemptMoney(item.reserved.nano_usd))}</p>
    <p>{t('结算：','Settled: ')}{usageConfirmed?`${message(attemptCount(item.settled.tokens))} Token · ${message(attemptMoney(item.settled.nano_usd))}`:message('未知（用量未确认）')}</p>
    <AttemptUsage usage={item.usage}/>
   </article>;
  })}
  {page.truncated&&<p className="wb-hint" role="status">{message('调用记录已到读取上限，仍有后续记录未显示。')}</p>}
  {page.next_cursor&&<button aria-label={message('加载更多调用')} disabled={busy} onClick={()=>onNext(page.next_cursor!)}>{message(busy?'正在加载…':'加载更多调用')}</button>}
 </section>;
}
type Form={tokens:string;dollars:string;model_calls:string;version:number};
export default function TaskBudgetPanel({taskId}:{taskId:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const resource=useResource(signal=>workbenchApi.taskModelBudget(taskId,signal),taskId);
 const [attemptPosition,setAttemptPosition]=useState<{taskId:string;cursor?:string}>({taskId});
 const attemptCursor=attemptPosition.taskId===taskId?attemptPosition.cursor:undefined;
 const attempts=useResource(signal=>workbenchApi.taskModelBudgetAttempts(taskId,attemptCursor,signal),JSON.stringify([taskId,attemptCursor??null]),resource.data?.configured===true);
 const attemptPage=attempts.data?.task_id===taskId?attempts.data:null;
 const [attemptHistory,setAttemptHistory]=useState<{taskId:string;page:TaskModelBudgetAttemptsView}|null>(null);
 const [loadedAttemptCursors,setLoadedAttemptCursors]=useState<{taskId:string;cursors:Array<string|undefined>}>({taskId,cursors:[undefined]});
 const [attemptRefreshError,setAttemptRefreshError]=useState(''),[attemptRefreshing,setAttemptRefreshing]=useState(false);
 const attemptRefreshController=useRef<AbortController|null>(null),attemptRefreshSequence=useRef(0);
 const attemptView=attemptHistory?.taskId===taskId?attemptHistory.page:null;
 const [form,setForm]=useState<Form|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestKey=useRef<{material:string;key:string}|null>(null);
 const refreshAttemptHistory=useCallback(async()=>{
  if(!resource.data?.configured)return;
  const cursors=loadedAttemptCursors.taskId===taskId?loadedAttemptCursors.cursors:[undefined];
  if(!cursors.length)return;
  const sequence=++attemptRefreshSequence.current;
  attemptRefreshController.current?.abort();
  const controller=new AbortController();attemptRefreshController.current=controller;
  if(attempts.loading)attempts.reload();
  setAttemptRefreshError('');setAttemptRefreshing(true);
  try{
   const pages:TaskModelBudgetAttempts[]=[];
   for(const cursor of cursors){
    if(controller.signal.aborted)return;
    pages.push(await workbenchApi.taskModelBudgetAttempts(taskId,cursor,controller.signal));
   }
   if(controller.signal.aborted||sequence!==attemptRefreshSequence.current)return;
   const validPages=pages.filter((page):page is TaskModelBudgetAttemptsView=>page.configured&&page.task_id===taskId);
   if(validPages.length!==pages.length)throw new Error('调用记录与当前任务不匹配');
   const latestPage=validPages[validPages.length-1]!;
   setAttemptHistory(current=>({taskId,page:{...latestPage,items:mergeAttemptItems(current?.taskId===taskId?current.page.items:[],validPages.flatMap(page=>page.items))}}));
   attempts.clearError();
  }catch(error){
   if(!controller.signal.aborted&&sequence===attemptRefreshSequence.current)setAttemptRefreshError(error instanceof Error?error.message:'调用记录刷新失败');
  }finally{
   if(!controller.signal.aborted&&sequence===attemptRefreshSequence.current){
    setAttemptRefreshing(false);
    if(attemptRefreshController.current===controller)attemptRefreshController.current=null;
   }
  }
 },[taskId,loadedAttemptCursors,resource.data?.configured,attempts.loading,attempts.reload,attempts.clearError]);
 const refreshAll=useCallback(()=>{resource.reload();void refreshAttemptHistory();},[resource.reload,refreshAttemptHistory]);
 useEffect(()=>{
  const timer=setInterval(()=>{if(!document.hidden&&!form&&!busy&&!attemptRefreshing)refreshAll();},15000);
  return()=>clearInterval(timer);
 },[taskId,form,busy,attemptRefreshing,refreshAll]);
 useEffect(()=>()=>{
  attemptRefreshSequence.current++;
  attemptRefreshController.current?.abort();
  attemptRefreshController.current=null;
 },[taskId]);
 useEffect(()=>{
  setForm(null);setError('');setNotice('');requestKey.current=null;setAttemptPosition({taskId});setAttemptHistory(null);
  setLoadedAttemptCursors({taskId,cursors:[undefined]});setAttemptRefreshError('');setAttemptRefreshing(false);
 },[taskId]);
 useEffect(()=>{
  if(!attemptPage?.configured)return;
  setAttemptHistory(current=>{
   const existing=current?.taskId===taskId?current.page.items:[];
   return{taskId,page:{...attemptPage,items:mergeAttemptItems(existing,attemptPage.items)}};
  });
 },[attemptPage,taskId,attemptCursor]);
 const edit=()=>{const budget=resource.data;if(!budget?.configured)return;setError('');setNotice('');setForm({tokens:budget.root.limits.tokens,dollars:nanoToDollars(budget.root.limits.nano_usd),model_calls:budget.root.limits.model_calls,version:budget.version});};
 const save=async(event:React.FormEvent)=>{
  event.preventDefault();if(!form||busy)return;
  let input;
  try{input={expected_version:form.version,limits:budgetLimitInput(form)};}catch(e){setError(e instanceof Error?e.message:'请填写有效额度');return;}
  const material=JSON.stringify(input);if(requestKey.current?.material!==material)requestKey.current={material,key:crypto.randomUUID()};
  setBusy(true);setError('');setNotice('');
  try{await workbenchApi.updateTaskModelBudget(taskId,input,requestKey.current.key);setForm(null);requestKey.current=null;setNotice('额度已更新，原有消耗与预留保持不变。');resource.reload();}
  catch(e){setError(budgetError(e instanceof Error?e.message:''));}
  finally{setBusy(false);}
 };
 return <section lang={language} className="wb-task-budget" aria-label={message('模型预算与消耗')}><div className="wb-form-head"><h4>{message('模型预算与消耗')}</h4><button disabled={busy} onClick={refreshAll}>{message('刷新预算')}</button></div><ResourceStatus {...resource} error={message(resource.error)} onRetry={resource.reload}/>
  {error&&<p className="wb-error" role="alert">{message(error)}</p>}{notice&&<p className="wb-status" role="status">{message(notice)}</p>}
  {resource.data&&<BudgetDetails budget={resource.data} busy={busy||!!form} onEdit={edit}/>}
  {resource.data?.configured&&attempts.loading&&<p className="wb-status" role="status">{message('正在加载调用记录…')}</p>}
  {resource.data?.configured&&attemptRefreshing&&<p className="wb-status" role="status">{message('正在刷新已加载调用记录…')}</p>}
  {resource.data?.configured&&attemptRefreshError&&<p className="wb-error" role="alert">{t('调用记录刷新失败：','Refreshing Call Records Failed: ')}{message(attemptRefreshError)}<button onClick={()=>void refreshAttemptHistory()}>{message('重试')}</button></p>}
  {resource.data?.configured&&attempts.error&&<p className="wb-error" role="alert">{t('调用记录读取失败：','Reading Call Records Failed: ')}{message(attempts.error)}<button onClick={()=>void refreshAttemptHistory()}>{message('重试')}</button></p>}
  {resource.data?.configured&&attemptView?.configured&&<BudgetAttemptHistory page={attemptView} busy={attempts.loading||attemptRefreshing} onNext={cursor=>{
   setLoadedAttemptCursors(current=>{const cursors=current.taskId===taskId?current.cursors:[undefined];return cursors.includes(cursor)?current:{taskId,cursors:[...cursors,cursor]};});
   setAttemptPosition({taskId,cursor});
  }}/>}
  {resource.data?.configured&&attemptPage&&!attemptPage.configured&&<p className="wb-status">{message('当前服务器未启用模型预算，调用记录不可用。')}</p>}
  {form&&<form className="wb-form" aria-label={message('调整模型额度')} onSubmit={event=>void save(event)}><h4>{message('任务累计上限')}</h4><label>{message('Token 上限')}<input inputMode="numeric" required value={form.tokens} disabled={busy} onChange={e=>setForm({...form,tokens:e.target.value})}/></label><label>{message('费用上限（USD，或填“不限额”）')}<input inputMode="decimal" required value={form.dollars} disabled={busy} onChange={e=>setForm({...form,dollars:e.target.value})}/></label><label>{message('模型调用次数上限')}<input inputMode="numeric" required value={form.model_calls} disabled={busy} onChange={e=>setForm({...form,model_calls:e.target.value})}/></label>
   {resource.data?.configured&&<p className="wb-hint">{t(`服务器允许上限：${resource.data.ceiling.tokens} Token、${nanoToDollars(resource.data.ceiling.nano_usd)} USD、${resource.data.ceiling.model_calls} 次调用。任务版本与预算版本独立。`,`Server Ceilings: ${resource.data.ceiling.tokens} Tokens, ${message(nanoToDollars(resource.data.ceiling.nano_usd))} USD, ${resource.data.ceiling.model_calls} Calls. Task and Budget Versions Are Independent.`)}</p>}
   <div className="wb-actions"><button className="wb-primary" disabled={busy}>{message(busy?'正在保存…':'保存额度')}</button><button type="button" disabled={busy} onClick={()=>{setForm(null);setError('');requestKey.current=null;}}>{message('取消')}</button></div>
  </form>}
 </section>;
}
