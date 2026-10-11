import React,{useEffect} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus,Empty} from './AgentsPanel';
import {readinessPresentation,readinessReason} from './readiness-ui.mjs';

const states:Record<string,string>={pending:'待执行',running:'执行中',blocked:'等待补充',completed:'已标记完成',failed:'失败',cancelled:'已取消'};
const actions:Record<string,string>={execute:'按验收条件执行',gather_evidence:'先补充证据',resolve_uncertainty:'先确认不确定项'};
export default function TaskLedgerPanel({taskId}:{taskId:string}){
 const subtasks=useResource(signal=>workbenchApi.subtasks(taskId,signal),taskId);
 const readiness=useResource(signal=>workbenchApi.taskReadiness(taskId,signal),taskId);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden){subtasks.reload();readiness.reload();}},10000);return()=>clearInterval(timer);},[taskId]);
 return <section className="wb-task-ledger" aria-label="子任务与准备度"><h4>子任务与准备度</h4><p className="wb-hint">执行准备度，供参考。评分、完成状态和执行回执分别记录；有回执仍需核对验收条件。</p>
  <ResourceStatus {...subtasks} onRetry={subtasks.reload}/><ResourceStatus {...readiness} onRetry={readiness.reload}/>
  {!subtasks.loading&&!subtasks.error&&!subtasks.data?.items.length&&<Empty>尚无子任务。执行角色可在工作时建立持久任务账本。</Empty>}
  {subtasks.data?.items.map(item=>{const view=readiness.data?.subtasks.find(row=>row.subtask_id===item.subtask_id&&row.subtask_version===item.version),presentation=readinessPresentation(view);
   return <article className="wb-ledger-item" key={item.subtask_id}><div className="wb-card-top"><h4>{item.title}</h4><span className="wb-badge">{states[item.status]??item.status}</span></div>
    <p>验收：{item.acceptance}</p><p className="wb-status">优先级 {item.priority} · 准备度 {presentation.score===null?'待评估':`${presentation.score} / 100`}</p>
    {presentation.completion&&<p className="wb-status">{presentation.completion}</p>}
    {item.dependencies.length>0&&<p className="wb-hint">前置任务：{item.dependencies.map(id=>subtasks.data?.items.find(row=>row.subtask_id===id)?.title??'未找到的前置任务').join('、')}</p>}
    {presentation.reasons.length>0&&<ul className="wb-ledger-reasons">{presentation.reasons.map((reason:string)=><li key={reason}>{reason}</li>)}</ul>}
    {view?.latest&&<details><summary>评估详情</summary><p className="wb-hint">模型原始分数：{view.latest.model_raw_score??'未提供'}；尚未校准为成功概率。</p><dl className="wb-readiness-dimensions">{[['理解程度',view.latest.understanding],['前置条件',view.latest.prerequisites],['证据覆盖',view.latest.evidence_coverage],['目标唯一性',view.latest.target_uniqueness],['能力健康',view.latest.capability_health]].map(([label,score])=><React.Fragment key={label}><dt>{label}</dt><dd>{score} / 100</dd></React.Fragment>)}</dl></details>}
    {item.evidence.length>0&&<details><summary>来源与证据（{item.evidence.length}）</summary><ul className="wb-ledger-evidence">{item.evidence.map((ref,index)=><li key={index}><span>{ref.kind}</span> {ref.reference}{ref.hash&&<small> · {ref.hash}</small>}</li>)}</ul></details>}
   </article>;
  })}
  {!!readiness.data?.next.items.length&&<><h4>下一步建议</h4><ul>{readiness.data.next.items.map(item=><li key={item.subtask_id}>{item.title}：{actions[item.next_action]}</li>)}</ul></>}
  {!!readiness.data?.next.blocked.length&&<details><summary>等待补充的任务（{readiness.data.next.blocked.length}）</summary><ul>{readiness.data.next.blocked.map(item=><li key={item.subtask_id}>{item.title}：{item.reasons.map(readinessReason).join('；')}</li>)}</ul></details>}
 </section>;
}
