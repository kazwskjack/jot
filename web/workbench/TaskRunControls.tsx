import React,{useEffect,useRef,useState} from 'react';
import type {Run,ResumeReceipt} from '../jot/types';
import {workbenchApi} from './client';
import {taskRunCanResume,taskRunMessage,taskResumeError} from './task-run-ui.mjs';

export default function TaskRunControls({run,expectedRunId,enabled,loading,onRefresh,onResumed}:{run:Run;expectedRunId:string;enabled:boolean;loading:boolean;onRefresh:()=>void;onResumed:(receipt:ResumeReceipt)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[accepted,setAccepted]=useState(false);
 const inFlight=useRef(false),keys=useRef(new Map<string,string>()),current=useRef<AbortController|null>(null);
 useEffect(()=>{setError('');setAccepted(false);setBusy(false);inFlight.current=false;return()=>{current.current?.abort();};},[expectedRunId]);
 const resume=async()=>{
  if(inFlight.current||accepted||loading||!taskRunCanResume(run,expectedRunId,enabled))return;
  inFlight.current=true;setBusy(true);setError('');const controller=new AbortController();current.current=controller;
  const identity=JSON.stringify([run.run_id,run.version,run.checkpoint_id]),key=keys.current.get(identity)??crypto.randomUUID();keys.current.set(identity,key);
  try{
   const receipt=await workbenchApi.resumeTaskRun(run,key,controller.signal);
   if(controller.signal.aborted)return;
   if(receipt.accepted!==true||receipt.continuation_of!==run.run_id||typeof receipt.run_id!=='string'||!receipt.run_id||receipt.run_id===run.run_id)throw new Error('resume_receipt_unconfirmed');
   setAccepted(true);onResumed(receipt);
  }catch(error){
   if(controller.signal.aborted)return;
   setError(taskResumeError(error));
   if([403,404,409].includes((error as {status?:number}).status??0))onRefresh();
  }finally{if(!controller.signal.aborted){inFlight.current=false;setBusy(false);}}
 };
 if(run.run_id!==expectedRunId)return null;
 const message=taskRunMessage(run);
 return <div className="wb-task-resume">{message&&<p className="wb-status">{message}</p>}{error&&<p className="wb-error" role="alert">{error}</p>}{!accepted&&taskRunCanResume(run,expectedRunId,enabled)&&<><button disabled={busy||loading} onClick={()=>void resume()}>{busy?'正在恢复…':'从保存进度继续'}</button><p className="wb-hint">沿用本次执行的进度和累计额度；恢复不会新建一次触发或自动批准待确认事项。</p></>}</div>;
}
