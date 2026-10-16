import React,{useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {discoveryCyclePresentation,discoveryDetailMatches,discoveryCoverage} from './discovery-history.mjs';
import type {Agent,DiscoveryCycle,DiscoveryHistoryDetail} from './types';
const outcomes:Record<string,string>={proposals:'已记录方案',no_plan:'未发现支持的改进方案',blocked:'发现过程受阻'};
function CycleState({cycle}:{cycle:DiscoveryCycle}){const view=discoveryCyclePresentation(cycle);return <p>执行状态：{view.run} · 业务状态：{view.business} · <strong>{view.acceptance}</strong></p>;}
export function DiscoveryCycleReport({value}:{value:DiscoveryHistoryDetail}){
 const {cycle,report,plans}=value;
 return <><CycleState cycle={cycle}/><p className="wb-hint">记录报告或执行结束不等于通过验收。历史记录不会授予新的执行权限；下方是提案，尚未应用。</p>
  <small>原轮次：{cycle.occurrence_id} · 来源修订 {cycle.signal_revision}</small>
  {report?<><h4>{outcomes[report.outcome]??'报告状态待核对'}</h4><p style={{whiteSpace:'pre-wrap'}}>{report.summary}</p><p>{discoveryCoverage(report.coverage)}</p><small>报告：{report.report_id} · {report.sha256}</small>
   {report.limitations.length>0&&<><h4>读取范围与限制</h4><ul>{report.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></>}
  </>:<p>本轮尚无报告。</p>}
  <h4>方案预览</h4>{plans.length?<div className="wb-message-list">{plans.map(plan=><article key={plan.plan_id}><h4>{plan.summary}</h4><p style={{whiteSpace:'pre-wrap'}}>{plan.rationale}</p><small>方案：{plan.plan_id} · {plan.sha256}</small>
   {plan.changes.map((change,index)=><section key={index}><h5>{change.path}</h5><p>{change.description}</p><p>拟执行步骤</p><ol>{change.steps.map((step,i)=><li key={i}>{step}</li>)}</ol><p>拟验收方式</p><ul>{change.verification.map((step,i)=><li key={i}>{step}</li>)}</ul></section>)}
   <details><summary>原工具证据引用</summary>{plan.evidence.map((evidence,index)=><p key={index}>{evidence.kind}：{evidence.reference}{evidence.hash&&<> · {evidence.hash}</>}</p>)}</details>
  </article>)}</div>:<p>这一页没有方案。</p>}
 </>;
}
export default function DiscoveryHistory({agent,identity,ownerScope,disabled=false}:{agent:Agent;identity:string;ownerScope:string;disabled?:boolean}){
 const [before,setBefore]=useState<string|undefined>(),[selected,setSelected]=useState<string|null>(null),[afterPlan,setAfterPlan]=useState<string|undefined>();
 const current=taskDraftScope()===ownerScope;
 const list=useResource(signal=>workbenchApi.discoveryHistory(agent.agent_id,before,signal),identity+':history:'+before,current),detail=useResource(signal=>workbenchApi.discoveryHistoryDetail(agent.agent_id,selected!,afterPlan,signal),identity+':detail:'+selected+':'+afterPlan,current&&!!selected);
 const page=current&&!list.loading&&!list.error&&list.data?.execution_authorized===false&&Array.isArray(list.data.items)?list.data:null,value=current&&!detail.loading&&!detail.error&&selected&&discoveryDetailMatches(detail.data,selected)?detail.data:null;
 const close=()=>{setSelected(null);setAfterPlan(undefined);};
 if(!current)return <p role="alert">用户范围已变化，请重新打开项目发现。</p>;
 return <section aria-label="发现周期记录"><h4>发现周期记录</h4><p className="wb-hint">仅查看原任务的来源修订、方案和报告。不显示来源正文，不应用项目修改。</p>
  {!selected?<><button disabled={disabled||list.loading} onClick={list.reload}>刷新发现记录</button>{list.loading&&<p role="status">正在读取发现记录…</p>}{list.error&&<p className="wb-error" role="alert">{list.error}</p>}
   <div className="wb-message-list">{page?.items.map(cycle=><article key={cycle.admission_id}><h5>来源修订 {cycle.signal_revision}</h5><CycleState cycle={cycle}/><small>{new Date(cycle.created_at).toLocaleString()} · {cycle.admission_id}</small>{cycle.report&&<p>{cycle.report.summary}</p>}<button disabled={disabled||list.loading} onClick={()=>{setAfterPlan(undefined);setSelected(cycle.admission_id);}}>查看本轮方案与报告</button></article>)}</div>
   {!list.loading&&!list.error&&page&&!page.items.length&&<p>尚无真实发现轮次。保存策略不等于已执行。</p>}
   <div className="wb-actions">{before&&<button disabled={disabled||list.loading} onClick={()=>setBefore(undefined)}>最新发现记录</button>}{page?.next_before_id&&<button disabled={disabled||list.loading} onClick={()=>setBefore(page.next_before_id!)}>更早发现记录</button>}</div>
  </>:<><div className="wb-actions"><button disabled={disabled} onClick={close}>返回发现记录</button><button disabled={disabled||detail.loading} onClick={detail.reload}>重新读取本轮报告</button></div>{detail.loading&&<p role="status">正在读取本轮报告…</p>}{detail.error&&<p className="wb-error" role="alert">{detail.error}</p>}{detail.data&&!value&&!detail.loading&&<p role="alert">报告与当前轮次不匹配，请重新读取。</p>}
   {value&&<><DiscoveryCycleReport value={value}/><div className="wb-actions">{afterPlan&&<button disabled={disabled||detail.loading} onClick={()=>setAfterPlan(undefined)}>第一页方案</button>}{value.next_after_plan_id&&<button disabled={disabled||detail.loading} onClick={()=>setAfterPlan(value.next_after_plan_id!)}>下一页方案</button>}</div></>}
  </>}
 </section>;
}
