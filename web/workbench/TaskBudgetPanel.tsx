import React,{useEffect,useRef,useState} from 'react';
import type {TaskModelBudget,ModelBudgetSummary} from './types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './AgentsPanel';
import {nanoToDollars,budgetLimitInput,budgetReason,budgetError} from './budget-ui.mjs';

function BudgetTable({scope}:{scope:ModelBudgetSummary}){
 return <div className="wb-budget-table"><table><thead><tr><th>项目</th><th>上限</th><th>已消耗</th><th>预留中</th><th>可用</th></tr></thead><tbody>{(['tokens','nano_usd','model_calls'] as const).map(key=><tr key={key}><th>{key==='tokens'?'已计量 Token':key==='nano_usd'?'费用（USD）':'模型次数'}</th>{(['limits','used','held','remaining'] as const).map(field=><td key={field}>{key==='nano_usd'?nanoToDollars(scope[field][key]):scope[field][key]}</td>)}</tr>)}</tbody></table></div>;
}
export function BudgetDetails({budget,onEdit,busy}:{budget:TaskModelBudget;onEdit:()=>void;busy:boolean}){
 if(!budget.configured)return <p className="wb-status">服务器尚未启用模型预算；这里暂不显示消耗估算。</p>;
 const names={owner_daily:'用户每日',project_daily:'项目每日',agent_daily:'角色每日'} as Record<string,string>;
 return <><BudgetTable scope={budget.root}/><p className="wb-hint">费用按配置费率核算，不等同供应商账单。预留中包含排队或尚未结算的调用；调整上限不会清零消耗。</p>
  <p className="wb-hint">Token 仅统计按 Token 计量的模型；按次数计量不代表 Token 用量为零。</p>
  {budget.unmetered_token_calls>0&&<p className="wb-hint">按次数计量的辅助调用：{budget.unmetered_token_calls} 次，已计入模型次数及配置费用，未测量其 Token。</p>}
  {budget.blocking_reasons.length>0?<ul className="wb-ledger-reasons" aria-label="预算限制">{budget.blocking_reasons.map(reason=><li key={reason}>{budgetReason(reason)}</li>)}</ul>:<p className="wb-status">当前额度足以预留下一次模型调用；执行仍需满足任务授权与状态条件。</p>}
  <button disabled={busy} onClick={onEdit}>调整额度</button>
  <details className="wb-budget-shared"><summary>每日共享额度（UTC）</summary>{budget.shared.map(scope=><section key={scope.kind}><h5>{names[scope.kind]??'共享额度'}</h5><BudgetTable scope={scope}/>{scope.ends_at&&<p className="wb-hint">周期结束：{new Date(scope.ends_at).toLocaleString()}（本地时间）</p>}</section>)}</details>
 </>;
}
type Form={tokens:string;dollars:string;model_calls:string;version:number};
export default function TaskBudgetPanel({taskId}:{taskId:string}){
 const resource=useResource(signal=>workbenchApi.taskModelBudget(taskId,signal),taskId);
 const [form,setForm]=useState<Form|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestKey=useRef<{material:string;key:string}|null>(null);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!form&&!busy)resource.reload();},15000);return()=>clearInterval(timer);},[taskId,form,busy]);
 useEffect(()=>{setForm(null);setError('');setNotice('');requestKey.current=null;},[taskId]);
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
 return <section className="wb-task-budget" aria-label="模型预算与消耗"><div className="wb-form-head"><h4>模型预算与消耗</h4><button disabled={busy} onClick={resource.reload}>刷新预算</button></div><ResourceStatus {...resource} onRetry={resource.reload}/>
  {error&&<p className="wb-error" role="alert">{error}</p>}{notice&&<p className="wb-status" role="status">{notice}</p>}
  {resource.data&&<BudgetDetails budget={resource.data} busy={busy||!!form} onEdit={edit}/>}
  {form&&<form className="wb-form" aria-label="调整模型额度" onSubmit={event=>void save(event)}><h4>任务累计上限</h4><label>Token 上限<input inputMode="numeric" required value={form.tokens} disabled={busy} onChange={e=>setForm({...form,tokens:e.target.value})}/></label><label>费用上限（USD，或填“不限额”）<input inputMode="decimal" required value={form.dollars} disabled={busy} onChange={e=>setForm({...form,dollars:e.target.value})}/></label><label>模型调用次数上限<input inputMode="numeric" required value={form.model_calls} disabled={busy} onChange={e=>setForm({...form,model_calls:e.target.value})}/></label>
   {resource.data?.configured&&<p className="wb-hint">服务器允许上限：{resource.data.ceiling.tokens} Token、{nanoToDollars(resource.data.ceiling.nano_usd)} USD、{resource.data.ceiling.model_calls} 次调用。任务版本与预算版本独立。</p>}
   <div className="wb-actions"><button className="wb-primary" disabled={busy}>{busy?'正在保存…':'保存额度'}</button><button type="button" disabled={busy} onClick={()=>{setForm(null);setError('');requestKey.current=null;}}>取消</button></div>
  </form>}
 </section>;
}
