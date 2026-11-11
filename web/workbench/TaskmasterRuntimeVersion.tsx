import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import React,{useEffect,useRef,useState} from 'react';
import {request} from '../jot/client';
import {prdMessage} from './task-prd.mjs';
import type {TaskmasterInstallation,TaskPrdRuntimeVersion} from '../../packages/gateway/contracts/types';

const reasons={cli_failed:'CLI 退出码未成功',version_output_unconfirmed:'版本输出无法确认',cancelled:'观察已取消',timeout:'观察超时',output_limit:'输出超过限制',spawn_failed:'CLI 进程未能启动',cleanup_unconfirmed:'进程清理结果待确认'};
export default function TaskmasterRuntimeVersion({taskId,taskVersion,installation,locked,onBusyChange}:{
 taskId:string;taskVersion:number;installation:TaskmasterInstallation|null;locked:boolean;onBusyChange:(busy:boolean)=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[result,setResult]=useState<TaskPrdRuntimeVersion|null>(null),[error,setError]=useState('');
 const pending=useRef<AbortController|null>(null);
 const identity=`${taskId}:${taskVersion}:${installation?.profile_id??''}:${installation?.manifest_sha256??''}:${installation?.cli_entry_sha256??''}`;
 useEffect(()=>{
  pending.current?.abort();pending.current=null;setConfirmed(false);setBusy(false);setResult(null);setError('');onBusyChange(false);
  return()=>{pending.current?.abort();pending.current=null;onBusyChange(false);};
 },[identity,onBusyChange]);
 async function observe(){
  if(busy||locked||!confirmed||installation?.status!=='available'||!installation.manifest_sha256||!installation.cli_entry_sha256)return;
  const controller=new AbortController();pending.current=controller;setBusy(true);onBusyChange(true);setError('');setResult(null);
  const body={profile_id:installation.profile_id,manifest_sha256:installation.manifest_sha256,cli_entry_sha256:installation.cli_entry_sha256};
  try{
   const value=await request<TaskPrdRuntimeVersion>(`/persistent-tasks/${encodeURIComponent(taskId)}/prd/taskmaster-runtime-version`,'POST',body,undefined,controller.signal);
   if(controller.signal.aborted||pending.current!==controller)return;
   const runtime=value.runtime;
   if(value.task_id!==taskId||value.task_version!==taskVersion||runtime?.owner_id!==installation.owner_id||runtime.profile_id!==body.profile_id
    ||runtime.manifest_sha256!==body.manifest_sha256||runtime.cli_entry_sha256!==body.cli_entry_sha256||runtime.execution_authorized!==false
    ||!['observed','failed'].includes(runtime.status)||runtime.status==='observed'&&(runtime.exit_code!==0||runtime.reason_code!==null||typeof runtime.runtime_version!=='string')
    ||runtime.status==='failed'&&(runtime.runtime_version!==null||!runtime.reason_code||!Object.hasOwn(reasons,runtime.reason_code)))throw Error('PRD_TASKMASTER_RUNTIME_UNAVAILABLE');
   setResult(value);
  }catch(e){if(!controller.signal.aborted&&pending.current===controller)setError(prdMessage(e instanceof Error?e.message:'PRD_TASKMASTER_RUNTIME_UNAVAILABLE'));}
  finally{if(pending.current===controller){pending.current=null;setBusy(false);onBusyChange(false);setConfirmed(false);}}
 }
 return <section lang={language} aria-label={message('Taskmaster 实际运行版本')}>
  <p className="wb-hint">{message('此操作会启动当前用户已安装且哈希匹配的 Node CLI 入口，固定传入 --version。观察限制为 15 秒、64 KiB 合并输出，离页会取消。')}</p>
  <label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={locked||busy||installation?.status!=='available'} onChange={event=>setConfirmed(event.target.checked)}/>{message('确认运行已观察入口的 --version。')}</label>
  <button type="button" disabled={locked||busy||!confirmed||installation?.status!=='available'} onClick={()=>void observe()}>{message(busy?'正在观察 CLI 版本…':'观察实际运行版本')}</button>
  {result&&<div role="status">
   <p>{t('包声明版本 ','Declared Package Version ')}{result.runtime.declared_version} · {t('实际运行版本 ','Runtime Version ')}{result.runtime.runtime_version??message('待确认')}</p>
   {result.runtime.reason_code&&<p>{message(reasons[result.runtime.reason_code])}</p>}
   <p>{t('退出码 ','Exit Code ')}{result.runtime.exit_code??message('未返回')} · {t('观察时间 ','Observed At ')}{result.runtime.observed_at}</p>
  </div>}
  {error&&<p role="alert">{message(error)}</p>}
 </section>;
}
