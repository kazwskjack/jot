import React,{useEffect,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import type {TaskPrdWorkPlan,TaskPrdWorkPlanAcceptance,TaskPrdWorkCycle as Cycle,TaskPrdWorkCycleCommand,TaskPrdWorkCycleState} from '../../packages/gateway/contracts/types';

function checked(value:Cycle,taskId:string,planId:string,acceptanceHash:string){
 if(value?.task_id!==taskId||value.origin?.kind!=='task_prd'||value.origin.plan_id!==planId||value.origin.acceptance_sha256!==acceptanceHash
  ||value.admission_id!==null||value.report_sha256!==null||value.policy_version!==null||value.execution_authorized!==false
  ||typeof value.cycle_id!=='string'||!value.cycle_id||value.cycle_id.length>256
  ||!Number.isSafeInteger(value.version)||value.version<1||!['open','closed'].includes(value.state))throw Error('PRD_WORK_CYCLE_RECEIPT_INVALID');
 return value;
}
export default function TaskPrdWorkCycle({taskId,plan,acceptance,locked,ready,save,onStateChange}:{
 taskId:string;plan:TaskPrdWorkPlan|null;acceptance:TaskPrdWorkPlanAcceptance|null;locked:boolean;ready:boolean;save:TaskSaveReceipt;onStateChange:()=>void;
}){
 const [confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<Cycle|null>(null);
 const identity=`${taskId}:${plan?.plan_id??''}:${acceptance?.sha256??''}`;
 const resource=useResource(async signal=>{
  const value=await request<TaskPrdWorkCycleState>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(plan!.plan_id)}/cycle`,'GET',undefined,undefined,signal);
  if(value.task_id!==taskId||value.plan_id!==plan!.plan_id||value.execution_authorized!==false)throw Error('PRD_WORK_CYCLE_RECEIPT_INVALID');
  if(value.cycle!==null){
   const cycle=checked(value.cycle,taskId,plan!.plan_id,acceptance!.sha256);
   if(cycle.origin.plan_sha256!==plan!.sha256||cycle.origin.acceptance_id!==acceptance!.acceptance_id)throw Error('PRD_WORK_CYCLE_RECEIPT_INVALID');
  }
  return value;
 },identity,!!plan&&!!acceptance);
 useEffect(()=>{setConfirmed(false);setError('');setReceipt(null);},[identity]);
 const current=resource.data?.plan_id===plan?.plan_id?resource.data:null,cycle=current?.cycle;
 async function submit(){
  if(save.busy||(!save.pending&&(locked||(!cycle&&!ready)||!confirmed||!acceptance||!plan||resource.loading||resource.error||!current||cycle?.state==='closed')))return;
  setError('');
  const checkedRequest=async(path:string,method:string,body:TaskPrdWorkCycleCommand,key:string)=>{
   const value=checked(await request<Cycle>(path,method,body,key),taskId,body.plan_id,body.preview_sha256);
   if(body.action==='close'&&(value.state!=='closed'||value.cycle_id!==body.cycle_id||value.version!==body.expected_version+1))throw Error('PRD_WORK_CYCLE_RECEIPT_INVALID');
   return value;
  };
  try{
   const body=plan&&acceptance?{action:cycle?'close':'create',plan_id:plan.plan_id,preview_sha256:acceptance.sha256,
    ...(cycle?{cycle_id:cycle.cycle_id,expected_version:cycle.version}:{})}:{};
   const work=save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plan-cycle`,'POST',body);
   onStateChange();setReceipt(await work);setConfirmed(false);resource.reload();
  }catch(e){if(!save.pending)setConfirmed(false);setError(prdMessage(e instanceof Error?e.message:'原工作循环回执待核对'));}
  finally{onStateChange();}
 }
 if(!acceptance&&!save.pending&&!receipt)return null;
 return <section aria-label="PRD 原工作循环" style={{overflowWrap:'anywhere'}}>
  <h5>原工作循环资源</h5>
  <p className="wb-hint">循环保留原任务、规划批次和累计预算。当前提供资源创建及关闭，执行准入接线继续开发。</p>
  {resource.loading&&<p role="status">正在读取原循环…</p>}
  {resource.error&&<p role="alert" className="wb-error">{prdMessage(resource.error)}</p>}
  <button type="button" disabled={locked||resource.loading} onClick={()=>{setConfirmed(false);resource.reload();}}>刷新原循环</button>
  {cycle&&<p role="status">{cycle.cycle_id} · v{cycle.version} · {cycle.state==='open'?'开放':'已关闭'}</p>}
  {current&&cycle?.state!=='closed'&&<label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked||(!cycle&&!ready)} onChange={event=>setConfirmed(event.target.checked)}/>{cycle?'确认关闭此原循环，保存原关闭回执。':'确认以这份提案确认记录创建原工作循环资源。'}</label>}
  {(current&&cycle?.state!=='closed'||save.pending)&&<button type="button" disabled={save.busy||(!save.pending&&(locked||(!cycle&&!ready)||!confirmed||resource.loading||!!resource.error))} onClick={()=>void submit()}>{save.busy?'正在保存循环回执…':save.pending?'重试原循环回执':cycle?'关闭原循环':'创建原工作循环'}</button>}
  {save.pending&&<p role="status">原请求及 key 已保留，请重试原循环回执。</p>}
  {receipt&&<p role="status">原命令回执 {receipt.cycle_id} · v{receipt.version} · {receipt.state==='open'?'开放':'已关闭'}。</p>}
  {error&&<p role="alert" className="wb-error">{error}</p>}
 </section>;
}
