import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import React,{useEffect,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import type {TaskPrdWorkGrant,TaskPrdWorkAdmissionRequest,TaskPrdWorkAdmissionReceipt,TaskPrdWorkAdmissionState} from '../../packages/gateway/contracts/types';

function checked(value:TaskPrdWorkAdmissionReceipt,taskId:string,body:TaskPrdWorkAdmissionRequest){
 if(value?.protocol!==1||value.task_id!==taskId||value.plan_id!==body.plan_id||value.cycle_id!==body.cycle_id||value.grant_id!==body.grant_id
  ||value.grant_sha256!==body.preview_sha256||value.accepted!==true||value.execution_authorized!==false||typeof value.created_at!=='string')throw Error('PRD_WORK_ADMISSION_RECEIPT_INVALID');
 return value;
}
export default function TaskPrdWorkAdmission({taskId,planId,grant,ready,locked,save,onStateChange}:{
 taskId:string;planId:string|null;grant:TaskPrdWorkGrant|null;ready:boolean;locked:boolean;save:TaskSaveReceipt;onStateChange:()=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const [confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<TaskPrdWorkAdmissionReceipt|null>(null);
 const identity=`${taskId}:${planId??''}:${grant?.grant_id??''}`;
 const resource=useResource(async signal=>{
  const value=await request<TaskPrdWorkAdmissionState>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(planId!)}/admission`,'GET',undefined,undefined,signal);
  if(value.task_id!==taskId||value.plan_id!==planId||typeof value.available!=='boolean'||value.execution_authorized!==false
   ||(value.reason!==null&&(typeof value.reason!=='string'||!/^[A-Z][A-Z0-9_]{0,95}$/.test(value.reason))))throw Error('PRD_WORK_ADMISSION_RECEIPT_INVALID');
  if(value.request!==null){
   checked(value.request,taskId,{plan_id:planId!,cycle_id:grant!.cycle_id,grant_id:grant!.grant_id,preview_sha256:grant!.grant_sha256});
  }
  if(value.admission!==null&&(!value.request||value.admission.grant_id!==value.request.grant_id||(['occurrence_id','run_id','conversation_id','created_at'] as const).some(key=>typeof value.admission![key]!=='string'||!value.admission![key])))throw Error('PRD_WORK_ADMISSION_RECEIPT_INVALID');
  return value;
 },identity,!!planId&&!!grant);
 useEffect(()=>{setConfirmed(false);setError('');setReceipt(null);},[identity]);
 const state=resource.data?.plan_id===planId?resource.data:null;
 async function submit(){
  if(save.busy||(!save.pending&&(locked||!ready||!confirmed||!grant||!planId||!state?.available||!!state.request||resource.loading||!!resource.error)))return;
  setError('');
  const checkedRequest=async(path:string,method:string,body:TaskPrdWorkAdmissionRequest,key:string)=>checked(await request<TaskPrdWorkAdmissionReceipt>(path,method,body,key),taskId,body);
  try{
   const body=grant&&planId?{plan_id:planId,cycle_id:grant.cycle_id,grant_id:grant.grant_id,preview_sha256:grant.grant_sha256}:{};
   const work=save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plan-admit`,'POST',body);
   onStateChange();setReceipt(await work);setConfirmed(false);resource.reload();
  }catch(e){if(!save.pending)setConfirmed(false);setError(prdMessage(e instanceof Error?e.message:'PRD_WORK_ADMISSION_RECEIPT_INVALID'));}
  finally{onStateChange();}
 }
 if(!grant&&!save.pending&&!receipt)return null;
 return <section lang={language} aria-label={message('原 Worker 工作准入')}>
  <h5>{message('原 Worker 工作准入')}</h5>
  <p className="wb-hint">{message('确认后由现有 Worker 持续核对快照字节、原生空闲、容量、原任务次数及累计预算。条件满足后创建原任务工作批次，页面请求回执只记录已受理。')}</p>
  <button type="button" disabled={locked||resource.loading||!grant} onClick={()=>resource.reload()}>{message('读取原准入状态')}</button>
  {resource.loading&&<p role="status">{message('正在读取准入记录…')}</p>}
  {resource.error&&<p role="alert">{message(prdMessage(resource.error))}</p>}
  {state&&!state.available&&<p role="status">{message('原生工作配置尚未就绪。')}</p>}
  {state?.request&&<p role="status">{t('已受理 grant ','Admission Request Accepted for Grant ')}{state.request.grant_id}{t(' 的准入请求。','.')}</p>}
  {state?.reason&&<p role="status">{message(prdMessage(state.reason))}</p>}
  {state?.admission&&<p role="status">{t('原工作批次 ','Original Work Occurrence ')}{state.admission.occurrence_id}{t(' · 运行 ',' · Run ')}{state.admission.run_id}{t('。执行结果沿原任务记录更新。','. Execution Results Update Through Original Task Records.')}</p>}
  {ready&&state?.available&&!state.request&&<label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event=>setConfirmed(event.target.checked)}/>{message('确认由原 Worker 在上述条件满足后启动此 grant 对应的原任务工作批次。')}</label>}
  {(ready&&state?.available&&!state.request||save.pending)&&<button type="button" disabled={save.busy||(!save.pending&&(locked||!confirmed||resource.loading||!!resource.error))} onClick={()=>void submit()}>{message(save.busy?'正在保存准入请求…':save.pending?'重试原准入回执':'请求原 Worker 准入')}</button>}
  {save.pending&&<p role="status">{message('请求及 key 已保留，请重试原回执。')}</p>}
  {receipt&&<p role="status">{t('已保存准入请求 ','Admission Request Saved ')}{receipt.grant_id}{t('。','.')}</p>}
  {error&&<p role="alert">{message(error)}</p>}
 </section>;
}
