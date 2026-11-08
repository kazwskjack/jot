import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import PrdTextPreview from './PrdTextPreview';
import type {TaskPrdWorkPlan,TaskPrdWorkPlanPage,TaskPrdWorkPlanSummary} from '../../packages/gateway/contracts/types';

const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere',wordBreak:'break-word',maxWidth:'100%'};
export default function TaskPrdWorkPlans({taskId,locked}:{taskId:string;locked:boolean}){
 const [open,setOpen]=useState(false),[before,setBefore]=useState(''),[previous,setPrevious]=useState<string[]>([]);
 const [detail,setDetail]=useState<TaskPrdWorkPlan|null>(null),[ledgerOpen,setLedgerOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef<AbortController|null>(null);
 const plans=useResource(signal=>request<TaskPrdWorkPlanPage>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans${before?`?before_id=${encodeURIComponent(before)}`:''}`,'GET',undefined,undefined,signal),`${taskId}:${before}`,open);
 useEffect(()=>()=>active.current?.abort(),[taskId]);
 const page=plans.data?.task_id===taskId?plans.data:null;
 const changes=useMemo(()=>detail?JSON.stringify(detail.changes,null,2):'',[detail]);
 const ledger=useMemo(()=>ledgerOpen&&detail?JSON.stringify(detail.subtasks,null,2):'',[ledgerOpen,detail]);
 async function readPlan(plan:TaskPrdWorkPlanSummary){
  if(locked||busy)return;
  const controller=new AbortController();active.current?.abort();active.current=controller;setBusy(true);setError('');setDetail(null);setLedgerOpen(false);
  try{
   const value=await request<TaskPrdWorkPlan>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(plan.plan_id)}`,'GET',undefined,undefined,controller.signal);
   if(controller.signal.aborted)return;
   if(value.task_id!==taskId||value.plan_id!==plan.plan_id||value.sha256!==plan.sha256||value.accepted!==false||value.execution_authorized!==false)throw Error('PRD_WORK_PLAN_INTEGRITY_FAILED');
   setDetail(value);
  }catch(e){if(!controller.signal.aborted)setError(prdMessage(e instanceof Error?e.message:'计划提案不可读取'));}
  finally{if(active.current===controller){active.current=null;setBusy(false);}}
 }
 function move(cursor:string,history:string[]){if(locked||busy)return;setBefore(cursor);setPrevious(history);setDetail(null);setLedgerOpen(false);setError('');}
 return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>原 DSH 文件计划提案</summary>
  <p className="wb-hint">提案关联本批固定 PRD、全文读取回执和当时的原子任务账本，供核对文件路径与步骤。工作准入及路径授权接线继续补齐。</p>
  <button type="button" disabled={locked||busy||plans.loading} onClick={()=>{move('',[]);plans.reload();}}>刷新提案</button>
  {plans.loading&&<p role="status">正在读取文件计划提案…</p>}
  {plans.error&&<p className="wb-error" role="alert">{prdMessage(plans.error)}</p>}
  {!plans.loading&&page&&<>
   {page.items.length===0&&<p role="status">此任务尚无文件计划提案。</p>}
   <ul>{page.items.map(plan=><li key={plan.plan_id} style={textStyle}>{plan.summary} · 原任务 v{plan.task_version} · {plan.path_count} 个路径 · {plan.subtask_count} 个子任务 <button type="button" disabled={locked||busy} onClick={()=>void readPlan(plan)}>核对提案</button></li>)}</ul>
   <div className="wb-actions"><button type="button" disabled={locked||busy||previous.length===0} onClick={()=>move(previous[previous.length-1]!,previous.slice(0,-1))}>上一页</button><button type="button" disabled={locked||busy||page.next_before_id===null} onClick={()=>move(page.next_before_id!,[...previous,before])}>下一页</button></div>
  </>}
  {busy&&<p role="status">正在读取提案来源…</p>}
  {detail&&<div style={textStyle}>
   <h5>{detail.summary}</h5><p>{detail.rationale}</p>
   <dl><dt>原执行批次 / 运行</dt><dd>{detail.occurrence_id} / {detail.run_id}</dd><dt>PRD 绑定 / 原文 SHA-256</dt><dd>{detail.source.binding_id} / {detail.source.content_sha256}</dd><dt>提案 SHA-256</dt><dd>{detail.sha256}</dd><dt>原账本 SHA-256</dt><dd>{detail.ledger_sha256}</dd></dl>
   <PrdTextPreview content={changes} label="文件计划提案步骤" style={textStyle}/>
   <details open={ledgerOpen} onToggle={event=>setLedgerOpen(event.currentTarget.open)}><summary>本次冻结的子任务账本</summary>{ledgerOpen&&<PrdTextPreview content={ledger} label="文件计划原账本" style={textStyle}/>}</details>
  </div>}
  {error&&<p className="wb-error" role="alert">{error}</p>}
 </details>;
}
