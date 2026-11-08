import React,{useEffect,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import type {TaskPrdWorkCycle,TaskPrdWorkHandoffRequest,TaskPrdWorkHandoffReceipt,TaskPrdWorkHandoffState} from '../../packages/gateway/contracts/types';

export default function TaskPrdWorkHandoff({taskId,planId,cycle,acceptanceHash,locked,save,onStateChange}:{
 taskId:string;planId:string|null;cycle:TaskPrdWorkCycle|null;acceptanceHash:string|null;locked:boolean;save:TaskSaveReceipt;onStateChange:()=>void;
}){
 const [confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<TaskPrdWorkHandoffReceipt|null>(null);
 const identity=`${taskId}:${planId??''}:${cycle?.cycle_id??''}`;
 const resource=useResource(async signal=>{
  const value=await request<TaskPrdWorkHandoffState>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(planId!)}/handoff`,'GET',undefined,undefined,signal);
  if(value.task_id!==taskId||value.plan_id!==planId||value.cycle_id!==cycle!.cycle_id||value.execution_authorized!==false
   ||typeof value.available!=='boolean'||typeof value.requested!=='boolean'||typeof value.settled!=='boolean'||!Array.isArray(value.reasons))throw Error('PRD_WORK_HANDOFF_RECEIPT_INVALID');
  if(value.planning!==null&&(!value.planning||typeof value.planning.run_id!=='string'||!value.planning.run_id
   ||typeof value.planning.status!=='string'||!Number.isSafeInteger(value.planning.version)||value.planning.version<1)
   ||value.command_id!==null&&(typeof value.command_id!=='string'||!value.command_id)
   ||value.settled&&(!value.requested||value.command_id===null)||value.reasons.some(reason=>typeof reason!=='string'))throw Error('PRD_WORK_HANDOFF_RECEIPT_INVALID');
  return value;
 },identity,!!planId&&!!cycle);
 const state=resource.data?.cycle_id===cycle?.cycle_id?resource.data:null,run=state?.planning;
 useEffect(()=>{setConfirmed(false);setError('');setReceipt(null);},[identity]);
 const canRequest=!!state?.available&&!state.requested&&!!run&&['starting','running','waiting_user','waiting_approval'].includes(run.status)&&cycle?.state==='open';
 async function submit(){
  if(save.busy||(!save.pending&&(locked||!confirmed||!canRequest||!run||!cycle||!planId||!acceptanceHash||resource.loading||resource.error)))return;
  setError('');
  const checked=async(path:string,method:string,body:TaskPrdWorkHandoffRequest,key:string)=>{
   const value=await request<TaskPrdWorkHandoffReceipt>(path,method,body,key);
   if(value.protocol!==1||value.task_id!==taskId||value.plan_id!==body.plan_id||value.cycle_id!==body.cycle_id||value.run_id!==body.run_id
    ||typeof value.command_id!=='string'||!value.command_id||value.accepted!==true||value.execution_authorized!==false)throw Error('PRD_WORK_HANDOFF_RECEIPT_INVALID');
   return value;
  };
  try{
   const body=cycle&&run&&planId&&acceptanceHash?{plan_id:planId,cycle_id:cycle.cycle_id,preview_sha256:acceptanceHash,run_id:run.run_id,expected_run_version:run.version}:{};
   const work=save.submit(checked,`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plan-handoff`,'POST',body);
   onStateChange();setReceipt(await work);setConfirmed(false);resource.reload();
  }catch(e){if(!save.pending)setConfirmed(false);setError(prdMessage(e instanceof Error?e.message:'原交接请求回执待确认'));}
  finally{onStateChange();}
 }
 if(!cycle&&!save.pending&&!receipt)return null;
 return <section aria-label="原规划运行交接">
  <h5>原规划运行交接</h5>
  <p className="wb-hint">此操作取消原规划运行，保留原任务、规划账本和累计预算。后续工作仍须通过原生空闲、容量、费用和路径准入。</p>
  <button type="button" disabled={locked||resource.loading} onClick={()=>{setConfirmed(false);resource.reload();}}>读取原交接记录</button>
  {resource.loading&&<p role="status">正在读取原规划与取消命令…</p>}
  {resource.error&&<p className="wb-error" role="alert">{prdMessage(resource.error)}</p>}
  {run&&<p role="status" style={{overflowWrap:'anywhere'}}>原规划 {run.run_id} · {run.status} · v{run.version}</p>}
  {state&&!state.available&&<p role="status">原生工作运行配置尚未就绪。</p>}
  {state?.requested&&<p role="status">{state.settled?'原取消命令及当前执行、费用记录已确认。':'原取消命令或当前执行、费用记录待确认。'} {state.command_id}</p>}
  {state?.reasons.length? <ul>{state.reasons.map(reason=><li key={reason}>{prdMessage(reason)}</li>)}</ul>:null}
  {canRequest&&<label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event=>setConfirmed(event.target.checked)}/>确认以取消原规划运行的方式交接，并等待原生取消及费用回执。</label>}
  {(canRequest||save.pending)&&<button type="button" disabled={save.busy||(!save.pending&&(locked||!confirmed||resource.loading||!!resource.error))} onClick={()=>void submit()}>{save.busy?'正在保存原取消请求…':save.pending?'重试原交接请求回执':'收束原规划运行'}</button>}
  {save.pending&&<p role="status">原请求及 key 已保留，请重试原回执。</p>}
  {receipt&&<p role="status" style={{overflowWrap:'anywhere'}}>已记录原取消请求 {receipt.command_id}，原生结果以交接记录为准。</p>}
  {error&&<p className="wb-error" role="alert">{error}</p>}
 </section>;
}
