import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import TaskPrdWorkCycle from './TaskPrdWorkCycle';
import PrdTextPreview from './PrdTextPreview';
import type {Task} from './types';
import type {TaskPrdWorkPlan,TaskPrdWorkPlanPage,TaskPrdWorkPlanSummary,TaskPrdWorkPlanAcceptance,TaskPrdWorkPlanAcceptanceRequest,TaskPrdWorkPlanAcceptanceState} from '../../packages/gateway/contracts/types';

const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere',wordBreak:'break-word',maxWidth:'100%'};
function checkAcceptance(value:TaskPrdWorkPlanAcceptance,taskId:string,planId:string,hash:string){
 if(value?.task_id!==taskId||value.plan_id!==planId||value.plan_sha256!==hash||value.accepted!==true||value.execution_authorized!==false
  ||!/^prd-acceptance-[a-f0-9]{64}$/.test(value.acceptance_id)||!/^[a-f0-9]{64}$/.test(value.sha256))throw Error('PRD_WORK_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
 return value;
}
export default function TaskPrdWorkPlans({task,locked,ready,save,cycleSave,handoffSave,onStateChange}:{
 task:Task;locked:boolean;ready:boolean;save:TaskSaveReceipt;cycleSave:TaskSaveReceipt;handoffSave:TaskSaveReceipt;onStateChange:()=>void;
}){
 const taskId=task.task_id,identity=`${taskId}:${task.version}:${task.status}:${ready}`;
 const currentIdentity=useRef(identity);currentIdentity.current=identity;
 const [open,setOpen]=useState(false),[before,setBefore]=useState(''),[previous,setPrevious]=useState<string[]>([]);
 const [detail,setDetail]=useState<TaskPrdWorkPlan|null>(null),[ledgerOpen,setLedgerOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [confirmed,setConfirmed]=useState(false),[receipt,setReceipt]=useState<TaskPrdWorkPlanAcceptance|null>(null);
 const active=useRef<AbortController|null>(null);
 const plans=useResource(signal=>request<TaskPrdWorkPlanPage>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans${before?`?before_id=${encodeURIComponent(before)}`:''}`,'GET',undefined,undefined,signal),`${taskId}:${before}`,open);
 const acceptance=useResource(async signal=>{
  const plan=detail!;
  const value=await request<TaskPrdWorkPlanAcceptanceState>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(plan.plan_id)}/acceptance`,'GET',undefined,undefined,signal);
  if(value.task_id!==taskId||value.plan_id!==plan.plan_id||value.execution_authorized!==false)throw Error('PRD_WORK_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  if(value.acceptance!==null)checkAcceptance(value.acceptance,taskId,plan.plan_id,plan.sha256);
  return value;
 },`${taskId}:${detail?.plan_id??''}:${detail?.sha256??''}`,open&&!!detail);
 useEffect(()=>{
  active.current?.abort();active.current=null;setBusy(false);setDetail(null);setLedgerOpen(false);setConfirmed(false);setReceipt(null);setError('');
  return()=>active.current?.abort();
 },[identity]);
 const page=plans.data?.task_id===taskId?plans.data:null;
 const changes=useMemo(()=>detail?JSON.stringify(detail.changes,null,2):'',[detail]);
 const ledger=useMemo(()=>ledgerOpen&&detail?JSON.stringify(detail.subtasks,null,2):'',[ledgerOpen,detail]);
 const accepted=detail&&(receipt?.plan_id===detail.plan_id?receipt:acceptance.data?.plan_id===detail.plan_id?acceptance.data.acceptance:null);
 const canAccept=ready&&!!detail&&task.version===detail.task_version&&['active','budget_exhausted'].includes(task.status)
  &&!acceptance.loading&&!acceptance.error&&acceptance.data?.plan_id===detail.plan_id&&!accepted;
 async function readPlan(plan:TaskPrdWorkPlanSummary){
  if(locked||busy)return;
  const controller=new AbortController(),context=identity;
  active.current?.abort();active.current=controller;setBusy(true);setError('');setDetail(null);setLedgerOpen(false);setConfirmed(false);setReceipt(null);
  try{
   const value=await request<TaskPrdWorkPlan>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(plan.plan_id)}`,'GET',undefined,undefined,controller.signal);
   if(controller.signal.aborted||context!==currentIdentity.current)return;
   if(value.task_id!==taskId||value.plan_id!==plan.plan_id||value.sha256!==plan.sha256||value.accepted!==false||value.execution_authorized!==false)throw Error('PRD_WORK_PLAN_INTEGRITY_FAILED');
   setDetail(value);
  }catch(e){if(!controller.signal.aborted&&context===currentIdentity.current)setError(prdMessage(e instanceof Error?e.message:'计划提案不可读取'));}
  finally{if(active.current===controller){active.current=null;setBusy(false);}}
 }
 async function accept(){
  if(save.busy||(!save.pending&&(locked||busy||!canAccept||!confirmed||!detail)))return;
  setError('');
  const checkedRequest=async(path:string,method:string,body:TaskPrdWorkPlanAcceptanceRequest,key:string)=>{
   const value=checkAcceptance(await request<TaskPrdWorkPlanAcceptance>(path,method,body,key),taskId,body.plan_id,body.preview_sha256);
   if(value.task_version!==body.expected_task_version||value.role.version!==body.expected_role_version||value.role.capability_epoch!==body.expected_role_epoch)throw Error('PRD_WORK_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
   return value;
  };
  try{
   const body=detail?{plan_id:detail.plan_id,preview_sha256:detail.sha256,expected_task_version:task.version,
    expected_role_version:detail.role.version,expected_role_epoch:detail.role.capability_epoch}:{};
   const work=save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plan-accept`,'POST',body);
   onStateChange();const value=await work;setReceipt(value);setConfirmed(false);acceptance.reload();
  }catch(e){
   if(!save.pending)setConfirmed(false);
   setError(prdMessage(e instanceof Error?e.message:'提案确认结果待核对'));
  }
  finally{onStateChange();}
 }
 function move(cursor:string,history:string[]){
  if(locked||busy)return;
  setBefore(cursor);setPrevious(history);setDetail(null);setLedgerOpen(false);setConfirmed(false);setReceipt(null);setError('');
 }
 return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>原 DSH 文件计划提案</summary>
  <p className="wb-hint">提案关联本批固定 PRD、全文读取回执和当时的子任务账本。确认会保存核对记录，执行继续通过原工作准入及路径授权。</p>
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
   <dl><dt>原任务 / 角色版本</dt><dd>v{detail.task_version} / v{detail.role.version} · 权限修订 {detail.role.capability_epoch}</dd><dt>原执行批次 / 运行</dt><dd>{detail.occurrence_id} / {detail.run_id}</dd><dt>PRD 绑定 / 原文 SHA-256</dt><dd>{detail.source.binding_id} / {detail.source.content_sha256}</dd><dt>提案 SHA-256</dt><dd>{detail.sha256}</dd><dt>原账本 SHA-256</dt><dd>{detail.ledger_sha256}</dd></dl>
   <PrdTextPreview content={changes} label="文件计划提案步骤" style={textStyle}/>
   <details open={ledgerOpen} onToggle={event=>setLedgerOpen(event.currentTarget.open)}><summary>本次冻结的子任务账本</summary>{ledgerOpen&&<PrdTextPreview content={ledger} label="文件计划原账本" style={textStyle}/>}</details>
   {!accepted&&(task.version!==detail.task_version||!['active','budget_exhausted'].includes(task.status))&&<p role="status">当前任务状态或版本与提案不匹配，请由原任务在有效执行批次重新提交计划。</p>}
   {acceptance.loading&&<p role="status">正在核对原确认记录…</p>}
   {acceptance.error&&<p className="wb-error" role="alert">{prdMessage(acceptance.error)} <button type="button" disabled={locked||busy} onClick={acceptance.reload}>重新读取确认记录</button></p>}
   {accepted?<p role="status">已有提案确认记录 {accepted.acceptance_id} · SHA-256 {accepted.sha256}。工作准入接线继续开发。</p>:<label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked||busy||!canAccept} onChange={event=>setConfirmed(event.target.checked)}/>我已核对固定原文、文件路径、步骤和原账本，确认保存本提案的核对记录。</label>}
  </div>}
  {(detail||save.pending)&&<button type="button" disabled={save.busy||(!save.pending&&(locked||busy||!canAccept||!confirmed))} onClick={()=>void accept()}>{save.busy?'正在保存确认记录…':save.pending?'重试原提案确认回执':'确认文件计划提案'}</button>}
  {save.pending&&<p role="status">提案确认结果待核对，已保留原请求及 key。请重试原回执。</p>}
  {receipt&&!detail&&<p role="status" style={textStyle}>原提案确认回执已恢复 {receipt.acceptance_id} · {receipt.sha256}。</p>}
  <TaskPrdWorkCycle taskId={taskId} plan={detail} acceptance={accepted||null} locked={locked||busy} ready={ready} save={cycleSave} handoffSave={handoffSave} onStateChange={onStateChange}/>
  {error&&<p className="wb-error" role="alert">{error}</p>}
 </details>;
}
