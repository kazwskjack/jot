import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import TaskPrdWorkAdmission from './TaskPrdWorkAdmission';
import React,{useEffect,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import type {TaskPrdWorkCycle,TaskPrdWorkResources as Resources,TaskPrdWorkPreparation,TaskPrdWorkGrant,TaskPrdWorkPreparationRequest,TaskPrdWorkGrantRequest} from '../../packages/gateway/contracts/types';

const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function checkedPreparation(value:TaskPrdWorkPreparation,taskId:string,planId:string,cycleId:string){
 if(value?.protocol!==1||value.task_id!==taskId||value.plan_id!==planId||value.cycle_id!==cycleId||value.execution_authorized!==false||value.source_bytes_verified!==false
  ||![value.review_sha256,value.source_sha256,value.manifest_sha256,value.source_record_sha256,value.snapshot_record_sha256,value.acceptance_sha256].every(sha)
  ||typeof value.snapshot_id!=='string'||!value.snapshot_id||!Number.isSafeInteger(value.cycle_version)||value.cycle_version<1
  ||!Number.isSafeInteger(value.file_count)||value.file_count<0||!Number.isSafeInteger(value.total_bytes)||value.total_bytes<0
  ||!Array.isArray(value.paths)||!value.paths.length||value.paths.length>32||value.paths.some(path=>typeof path!=='string'||!path))throw Error('PRD_WORK_RESOURCE_RECEIPT_INVALID');
 return value;
}
function checkedGrant(value:TaskPrdWorkGrant,taskId:string,planId:string,cycleId:string,review:string){
 if(value?.protocol!==1||value.task_id!==taskId||value.plan_id!==planId||value.cycle_id!==cycleId||value.review_sha256!==review
  ||value.execution_authorized!==false||value.source_bytes_verified!==false||!sha(value.grant_sha256)||!sha(value.source_sha256)
  ||typeof value.grant_id!=='string'||!value.grant_id||typeof value.snapshot_id!=='string'||!value.snapshot_id||!Array.isArray(value.paths))throw Error('PRD_WORK_RESOURCE_RECEIPT_INVALID');
 return value;
}
export default function TaskPrdWorkResources({taskId,planId,cycle,acceptanceHash,locked,prepareSave,grantSave,admitSave,onStateChange}:{
 taskId:string;planId:string|null;cycle:TaskPrdWorkCycle|null;acceptanceHash:string|null;locked:boolean;prepareSave:TaskSaveReceipt;grantSave:TaskSaveReceipt;admitSave:TaskSaveReceipt;onStateChange:()=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const [copyConfirmed,setCopyConfirmed]=useState(false),[grantConfirmed,setGrantConfirmed]=useState(false),[error,setError]=useState('');
 const [preparedReceipt,setPreparedReceipt]=useState<TaskPrdWorkPreparation|null>(null),[grantReceipt,setGrantReceipt]=useState<TaskPrdWorkGrant|null>(null);
 const identity=`${taskId}:${planId??''}:${cycle?.cycle_id??''}`;
 const resource=useResource(async signal=>{
  const value=await request<Resources>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plans/${encodeURIComponent(planId!)}/resources`,'GET',undefined,undefined,signal);
  if(value.task_id!==taskId||value.plan_id!==planId||value.cycle_id!==cycle!.cycle_id||value.execution_authorized!==false
   ||typeof value.available!=='boolean'||typeof value.preparation_uncertain!=='boolean'||!Array.isArray(value.reasons)||value.reasons.some(reason=>typeof reason!=='string'))throw Error('PRD_WORK_RESOURCE_RECEIPT_INVALID');
  if(value.preparation!==null){
   const review=checkedPreparation(value.preparation,taskId,planId!,cycle!.cycle_id);
   if(review.acceptance_sha256!==cycle!.origin.acceptance_sha256)throw Error('PRD_WORK_RESOURCE_RECEIPT_INVALID');
  }
  if(value.grant!==null){if(!value.preparation)throw Error('PRD_WORK_RESOURCE_RECEIPT_INVALID');checkedGrant(value.grant,taskId,planId!,cycle!.cycle_id,value.preparation.review_sha256);}
  return value;
 },identity,!!planId&&!!cycle);
 useEffect(()=>{setCopyConfirmed(false);setGrantConfirmed(false);setPreparedReceipt(null);setGrantReceipt(null);setError('');},[identity,cycle?.version]);
 const state=resource.data?.cycle_id===cycle?.cycle_id?resource.data:null,review=state?.preparation,grant=state?.grant;
 const editable=!!state?.available&&cycle?.state==='open'&&!resource.loading&&!resource.error;
 async function prepare(){
  if(prepareSave.busy||(!prepareSave.pending&&(locked||!editable||!copyConfirmed||!planId||!cycle||!acceptanceHash||!!review||!!state?.reasons.length)))return;
  setError('');
  const checked=async(path:string,method:string,body:TaskPrdWorkPreparationRequest,key:string)=>{
   const value=checkedPreparation(await request<TaskPrdWorkPreparation>(path,method,body,key),taskId,body.plan_id,body.cycle_id);
   if(value.acceptance_sha256!==body.preview_sha256||value.cycle_version!==body.expected_cycle_version)throw Error('PRD_WORK_RESOURCE_RECEIPT_INVALID');
   return value;
  };
  try{
   const body=planId&&cycle&&acceptanceHash?{plan_id:planId,cycle_id:cycle.cycle_id,preview_sha256:acceptanceHash,expected_cycle_version:cycle.version}:{};
   const work=prepareSave.submit(checked,`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plan-prepare`,'POST',body);
   onStateChange();setPreparedReceipt(await work);setCopyConfirmed(false);resource.reload();
  }catch(e){if(!prepareSave.pending)setCopyConfirmed(false);setError(prdMessage(e instanceof Error?e.message:'原快照准备回执待确认'));}
  finally{onStateChange();}
 }
 async function authorize(){
  if(grantSave.busy||(!grantSave.pending&&(locked||!editable||!grantConfirmed||!planId||!cycle||!review||!!grant)))return;
  setError('');
  const checked=async(path:string,method:string,body:TaskPrdWorkGrantRequest,key:string)=>checkedGrant(await request<TaskPrdWorkGrant>(path,method,body,key),taskId,body.plan_id,body.cycle_id,body.preview_sha256);
  try{
   const body=planId&&cycle&&review?{plan_id:planId,cycle_id:cycle.cycle_id,preview_sha256:review.review_sha256}:{};
   const work=grantSave.submit(checked,`/persistent-tasks/${encodeURIComponent(taskId)}/prd/work-plan-grant`,'POST',body);
   onStateChange();setGrantReceipt(await work);setGrantConfirmed(false);resource.reload();
  }catch(e){if(!grantSave.pending)setGrantConfirmed(false);setError(prdMessage(e instanceof Error?e.message:'原路径范围确认回执待确认'));}
  finally{onStateChange();}
 }
 if(!cycle&&!prepareSave.pending&&!grantSave.pending&&!admitSave.pending&&!preparedReceipt&&!grantReceipt)return null;
 return <section lang={language} aria-label={message('原工作快照与路径范围')} style={{overflowWrap:'anywhere'}}>
  <h5>{message('原工作快照与路径范围')}</h5>
  <p className="wb-hint">{message('先核对规划交接与费用记录，再准备原逻辑文件快照并确认路径范围。实际执行时仍会核对快照字节、原生空闲、容量和累计预算。')}</p>
  <button type="button" disabled={locked||resource.loading} onClick={()=>{setCopyConfirmed(false);setGrantConfirmed(false);resource.reload();}}>{message('读取原快照与 grant')}</button>
  {resource.loading&&<p role="status">{message('正在读取原资源记录…')}</p>}
  {resource.error&&<p className="wb-error" role="alert">{message(prdMessage(resource.error))}</p>}
  {state&&!state.available&&<p role="status">{message('原生工作快照配置尚未就绪。')}</p>}
  {state?.preparation_uncertain&&<p role="status">{message('原准备结果待核对。重试将沿原 journal 恢复，无法确认的状态继续保留。')}</p>}
  {state?.reasons.length? <ul>{state.reasons.map(reason=><li key={reason}>{message(prdMessage(reason))}</li>)}</ul>:null}
  {editable&&!review&&<label className="wb-checkbox"><input type="checkbox" checked={copyConfirmed} disabled={locked||!!state?.reasons.length} onChange={event=>setCopyConfirmed(event.target.checked)}/>{message('确认读取原项目逻辑文件，并准备隔离工作快照。')}</label>}
  {(editable&&!review||prepareSave.pending)&&<button type="button" disabled={prepareSave.busy||(!prepareSave.pending&&(locked||!copyConfirmed||!!state?.reasons.length))} onClick={()=>void prepare()}>{message(prepareSave.busy?'正在准备原快照…':prepareSave.pending?'重试原快照回执':'准备原工作快照')}</button>}
  {review&&<>
   <p role="status">{t('快照 ','Snapshot ')}{review.snapshot_id} · {review.file_count}{t(' 个文件 · ',' Files · ')}{review.total_bytes}{t(' 字节',' Bytes')}</p>
   <dl><dt>{message('来源 / manifest SHA-256')}</dt><dd>{review.source_sha256} / {review.manifest_sha256}</dd><dt>{message('核对 SHA-256')}</dt><dd>{review.review_sha256}</dd><dt>{message('原角色版本 / 权限修订')}</dt><dd>{review.role_version} / {review.role_epoch}</dd></dl>
   <ul>{review.paths.map(path=><li key={path}>{path}</li>)}</ul>
   {!grant&&editable&&<label className="wb-checkbox"><input type="checkbox" checked={grantConfirmed} disabled={locked} onChange={event=>setGrantConfirmed(event.target.checked)}/>{message('已核对原快照、校验哈希及以上全部路径，确认保存原 grant。')}</label>}
  </>}
  {(editable&&!!review&&!grant||grantSave.pending)&&<button type="button" disabled={grantSave.busy||(!grantSave.pending&&(locked||!grantConfirmed))} onClick={()=>void authorize()}>{message(grantSave.busy?'正在保存原 grant…':grantSave.pending?'重试原 grant 回执':'确认原路径范围')}</button>}
  {grant&&<p role="status">{t('原 grant ','Original Grant ')}{grant.grant_id} · SHA-256 {grant.grant_sha256}{t('。','.')}</p>}
  {(prepareSave.pending||grantSave.pending)&&<p role="status">{message('原请求及 key 已保留，请重试对应原回执。')}</p>}
  {preparedReceipt&&<p role="status">{t('原准备回执 ','Original Preparation Receipt ')}{preparedReceipt.snapshot_id} · {preparedReceipt.review_sha256}</p>}
  {grantReceipt&&<p role="status">{t('原 grant 回执 ','Original Grant Receipt ')}{grantReceipt.grant_id} · {grantReceipt.grant_sha256}</p>}
  <TaskPrdWorkAdmission taskId={taskId} planId={planId} grant={grant??null} ready={cycle?.state==='open'} locked={locked} save={admitSave} onStateChange={onStateChange}/>
  {error&&<p className="wb-error" role="alert">{message(error)}</p>}
 </section>;
}
