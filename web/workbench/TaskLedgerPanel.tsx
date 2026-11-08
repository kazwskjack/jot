import React,{useEffect,useState} from 'react';
import type {TaskSubtask} from './types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus,Empty} from './PanelStatus';
import {readinessPresentation,readinessReason} from './readiness-ui.mjs';
import {buildTaskSubtaskInput,taskSubtaskCounts,taskSubtaskFailure} from './task-ledger-ui.mjs';

const states:Record<string,string>={pending:'待执行',running:'执行中',blocked:'等待补充',completed:'已标记完成',failed:'失败',cancelled:'已取消'};
const parentStates:Record<string,string>={active:'已启用',paused:'已暂停',archived:'已归档',budget_exhausted:'预算用尽'};
const actions:Record<string,string>={execute:'按验收条件执行',gather_evidence:'先补充证据',resolve_uncertainty:'先确认不确定项'};
type Draft={title:string;acceptance:string;priority:string;status:TaskSubtask['status'];dependencies:string[]};
const newDraft=():Draft=>({title:'',acceptance:'',priority:'50',status:'pending',dependencies:[]});
const statusOptions:[TaskSubtask['status'],string][]=[['pending','待执行'],['running','执行中'],['blocked','等待补充'],['completed','已标记完成'],['failed','失败'],['cancelled','已取消']];

export default function TaskLedgerPanel({taskId,taskStatus}:{taskId:string;taskStatus:string}){
 const subtasks=useResource(signal=>workbenchApi.subtasks(taskId,signal),taskId);
 const readiness=useResource(signal=>workbenchApi.taskReadiness(taskId,signal),taskId);
 const [creating,setCreating]=useState(false),[editing,setEditing]=useState<TaskSubtask|null>(null),[draft,setDraft]=useState<Draft>(newDraft);
 const [saving,setSaving]=useState(false),[saveError,setSaveError]=useState(''),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false);
 const items=subtasks.data?.items??[],showForm=creating||editing!==null,archived=taskStatus==='archived';
 const canManage=!archived&&!saving&&!uncertain&&!subtasks.loading&&!subtasks.error&&!!subtasks.data;
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden){subtasks.reload();readiness.reload();}},10000);return()=>clearInterval(timer);},[taskId]);
 function openCreate(){setEditing(null);setCreating(true);setDraft(newDraft());setSaveError('');setNotice('');}
 function openEdit(item:TaskSubtask){setCreating(false);setEditing(item);setDraft({title:item.title,acceptance:item.acceptance,priority:String(item.priority),status:item.status,dependencies:[...item.dependencies]});setSaveError('');setNotice('');}
 function cancelForm(){if(saving||uncertain)return;setCreating(false);setEditing(null);setDraft(newDraft());setSaveError('');}
 async function save(e:React.FormEvent){e.preventDefault();if(!showForm||!canManage)return;setSaving(true);setSaveError('');setNotice('');let submitted=false;
  try{
   const input=buildTaskSubtaskInput(editing,draft);
   submitted=true;
   await workbenchApi.upsertSubtask(taskId,input);
   setCreating(false);setEditing(null);setDraft(newDraft());setUncertain(false);setNotice(editing?'子任务已保存':'子任务已新增');subtasks.reload();readiness.reload();
  }catch(error){
   const failure=taskSubtaskFailure(error,submitted);setSaveError(failure.message);setUncertain(failure.uncertain);
   if(failure.refresh){subtasks.reload();readiness.reload();}
  }finally{setSaving(false);}
 }
 const counts=taskSubtaskCounts(items);
 return <section className="wb-task-ledger" aria-label="子任务与准备度"><h4>子任务与准备度</h4>
  <p className="wb-status">原任务状态：{parentStates[taskStatus]??taskStatus}</p>
  <p className="wb-hint">执行准备度仅供参考。账本状态和计数来自当前子任务记录，不代表实际完成或验收；完成仍由原证据和服务端校验决定。</p>
  <ResourceStatus {...subtasks} onRetry={subtasks.reload}/><ResourceStatus {...readiness} onRetry={readiness.reload}/>
  {!subtasks.loading&&!subtasks.error&&!!subtasks.data&&<p className="wb-status" aria-label="子任务状态计数">账本计数：共 {counts.total} 项；待执行 {counts.pending}、执行中 {counts.running}、等待补充 {counts.blocked}、已标记完成 {counts.completed}、失败 {counts.failed}、已取消 {counts.cancelled}{counts.other?`、其他状态 ${counts.other}`:''}。</p>}
  {!subtasks.loading&&!subtasks.error&&!items.length&&<Empty>当前任务还没有子任务，可由执行角色或你在下方新增。</Empty>}
  {!archived&&<button type="button" className="wb-primary" disabled={!canManage||showForm} onClick={openCreate}>新增子任务</button>}
  {archived&&<p className="wb-hint">原任务已归档，子任务账本为只读。</p>}
  {items.map(item=>{const view=readiness.data?.subtasks.find(row=>row.subtask_id===item.subtask_id&&row.subtask_version===item.version),presentation=readinessPresentation(view);
   return <article className="wb-ledger-item" key={item.subtask_id}><div className="wb-card-top"><h4>{item.title}</h4><span className="wb-badge">{states[item.status]??item.status}</span>{!archived&&<button type="button" disabled={!canManage||showForm} onClick={()=>openEdit(item)}>编辑</button>}</div>
    <p>验收：{item.acceptance}</p><p className="wb-status">优先级 {item.priority} · 准备度 {presentation.score===null?'待评估':`${presentation.score} / 100`}</p>
    {presentation.completion&&<p className="wb-status">{presentation.completion}</p>}
    {item.dependencies.length>0&&<p className="wb-hint">前置任务：{item.dependencies.map(id=>items.find(row=>row.subtask_id===id)?.title??'未找到的前置任务').join('、')}</p>}
    {presentation.reasons.length>0&&<ul className="wb-ledger-reasons">{presentation.reasons.map((reason:string)=><li key={reason}>{reason}</li>)}</ul>}
    {view?.latest&&<details><summary>评估详情</summary><p className="wb-hint">模型原始分数：{view.latest.model_raw_score??'未提供'}；尚未校准为成功概率。</p><dl className="wb-readiness-dimensions">{[['理解程度',view.latest.understanding],['前置条件',view.latest.prerequisites],['证据覆盖',view.latest.evidence_coverage],['目标唯一性',view.latest.target_uniqueness],['能力健康',view.latest.capability_health]].map(([label,score])=><React.Fragment key={label}><dt>{label}</dt><dd>{score} / 100</dd></React.Fragment>)}</dl></details>}
    {item.evidence.length>0&&<details><summary>来源与证据（{item.evidence.length}）</summary><ul className="wb-ledger-evidence">{item.evidence.map((ref,index)=><li key={index}><span>{ref.kind}</span> {ref.reference}{ref.hash&&<small> · {ref.hash}</small>}</li>)}</ul></details>}
   </article>;
  })}
  {!!readiness.data?.next.items.length&&!readiness.loading&&!readiness.error&&<><h4>下一步建议</h4><ul>{readiness.data.next.items.map(item=><li key={item.subtask_id}>{item.title}：{actions[item.next_action]}</li>)}</ul></>}
  {!!readiness.data?.next.blocked.length&&!readiness.loading&&!readiness.error&&<details><summary>等待补充的任务（{readiness.data.next.blocked.length}）</summary><ul>{readiness.data.next.blocked.map(item=><li key={item.subtask_id}>{item.title}：{item.reasons.map(readinessReason).join('；')}</li>)}</ul></details>}
  {showForm&&<form className="wb-form" onSubmit={save}>
   <h4>{editing?'编辑子任务':'新增子任务'}</h4>
   <fieldset className="wb-input-fields" disabled={saving||uncertain||archived}>
    <label>子任务标题<input required maxLength={200} value={draft.title} onChange={e=>setDraft(value=>({...value,title:e.target.value}))}/></label>
    <label>验收条件<textarea required maxLength={2000} rows={3} value={draft.acceptance} onChange={e=>setDraft(value=>({...value,acceptance:e.target.value}))}/></label>
    <label>优先级（0–100）<input type="number" min={0} max={100} step={1} value={draft.priority} onChange={e=>setDraft(value=>({...value,priority:e.target.value}))}/></label>
    {editing?<label>账本状态<select value={draft.status} onChange={e=>setDraft(value=>({...value,status:e.target.value as TaskSubtask['status']}))}>{statusOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>:<p className="wb-hint">新建子任务从“待执行”开始。</p>}
    <fieldset><legend>前置任务（可多选）</legend>{items.filter(item=>item.subtask_id!==editing?.subtask_id).map(item=><label className="wb-checkbox" key={item.subtask_id}><input type="checkbox" checked={draft.dependencies.includes(item.subtask_id)} onChange={e=>setDraft(value=>({...value,dependencies:e.target.checked?[...value.dependencies,item.subtask_id]:value.dependencies.filter(id=>id!==item.subtask_id)}))}/>{item.title} · {states[item.status]??item.status}</label>)}{items.length<=Number(Boolean(editing))&&<p className="wb-hint">没有可选的其他子任务。</p>}</fieldset>
   </fieldset>
   {editing?.evidence.length===0&&draft.status==='completed'&&<p className="wb-hint">当前没有执行证据，服务端不会接受“已标记完成”。</p>}
   <p className="wb-hint">表单不会创建或修改执行证据。保存完成状态仍须通过原账本证据与前置任务校验。</p>
   {uncertain&&<><p role="status">保存结果未确认。请先检查上方账本是否已有本次更改。</p><button type="button" onClick={()=>{setUncertain(false);setSaveError('');}}>我已核对账本，允许再次提交</button></>}
   {saveError&&<p className="wb-error" role="alert">{saveError}</p>}{notice&&<p role="status">{notice}</p>}
   <div className="wb-actions"><button className="wb-primary" disabled={saving||uncertain||!canManage}>{saving?'正在保存…':'保存子任务'}</button><button type="button" disabled={saving||uncertain} onClick={cancelForm}>取消</button></div>
  </form>}
 </section>;
}
