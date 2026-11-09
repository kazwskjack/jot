import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {ApiError,abortableDelay,follow,request} from './client';
import {parseNativeMemberExecution} from './native-member-execution';
import ActivityHistory from './ActivityHistory';
import ActivityTimeline from './ActivityTimeline';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {Activity,NativeMemberExecution,Run} from './types';

type View={source:NativeMemberExecution};
function MemberTimeline({view}:{view:View}){
 const [history,setHistory]=useState<Activity[]|null>(null);
 const retainHistory=useCallback((values:Activity[])=>setHistory(values),[]);
 const [live,setLive]=useState<Record<string,Activity>>({}),[following,setFollowing]=useState(true),[streamIssue,setStreamIssue]=useState('');
 const [observedRun,setObservedRun]=useState<{status:Run['status'];version:number}>({status:view.source.child_status,version:view.source.child_version});
 const cursor=useRef(view.source.child_as_of_seq);
 useEffect(()=>{
  if(!following)return;
  const controller=new AbortController();let fatal=false;
  const connect=async()=>{
   while(!controller.signal.aborted){
    try{
     await follow(view.source.child_conversation_id,cursor.current,event=>{
      if(controller.signal.aborted)return;
      if(event.conversation_id!==view.source.child_conversation_id||typeof event.seq!=='string'||!/^(0|[1-9]\d{0,18})$/.test(event.seq)||BigInt(event.seq)>9223372036854775807n){
       fatal=true;throw Error('成员更新来源尚未确认，请刷新原成员记录。');
      }
      const seq=BigInt(event.seq),previous=BigInt(cursor.current);
      if(seq<=previous)return;
      if(seq!==previous+1n){fatal=true;throw Error('成员更新出现记录间隙，请刷新原成员记录。');}
      if(event.run_id===view.source.child_run_id){
       if(event.type==='activity.upsert'){
        const activity=event.payload;
        if(activity.run_id!==view.source.child_run_id||typeof activity.activity_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(activity.activity_id)){
         fatal=true;throw Error('成员步骤身份尚未确认，请刷新原成员记录。');
        }
        setLive(prior=>({...prior,[activity.activity_id]:activity}));
       }
       if(event.type==='run.state'){
        const run=event.payload;
        if(run.run_id!==view.source.child_run_id||run.conversation_id!==view.source.child_conversation_id||!Number.isSafeInteger(run.version)||run.version<1){
         fatal=true;throw Error('成员运行身份尚未确认，请刷新原成员记录。');
        }
        setObservedRun(prior=>run.version>=prior.version?{status:run.status,version:run.version}:prior);
       }
      }
      cursor.current=event.seq;setStreamIssue('');
     },controller.signal);
    }catch(error){
     if(controller.signal.aborted)return;
     if(error instanceof SyntaxError||error instanceof Error&&['事件格式不兼容','事件过大'].includes(error.message)){
      setStreamIssue('成员更新格式尚未确认，请刷新原成员记录。');return;
     }
     if(fatal||error instanceof ApiError&&[401,403,404,410].includes(error.status)){
      setStreamIssue(fatal&&error instanceof Error?error.message:'成员更新权限或历史范围已变化，请刷新原成员记录。');return;
     }
     setStreamIssue('成员更新连接中断，正在从原序号重连。');
     try{await abortableDelay(1500,controller.signal);}catch{return;}
    }
   }
  };
  void connect();return()=>controller.abort();
 },[following,view.source.child_conversation_id,view.source.child_run_id]);
 const activities=useMemo(()=>{
  const merged=new Map((history??[]).map(activity=>[activity.activity_id,activity]));
  for(const activity of Object.values(live))merged.set(activity.activity_id,activity);
  return [...merged.values()].filter(activity=>activity.run_id===view.source.child_run_id);
 },[history,live,view.source.child_run_id]);
 return <section aria-label="所选原成员公开步骤">
  <p>子运行 <code>{view.source.child_run_id}</code> · {observedRun.status} · 版本 {observedRun.version}</p>
  <p>原父运行 <code>{view.source.root_run_id}</code> · 角色 <code>{view.source.role_ref}</code></p>
  <small>历史读取边界 {view.source.child_as_of_seq}，更新固定到所选子运行。</small>
  <button type="button" aria-pressed={following} onClick={()=>setFollowing(value=>!value)}>{following?'暂停实时更新':'继续实时更新'}</button>
  {streamIssue&&<p role="status">{streamIssue}</p>}
  <ConversationDisplayBoundary label="成员步骤历史"><ActivityHistory conversationId={view.source.child_conversation_id}
   runId={view.source.child_run_id} snapshotSeq={view.source.child_as_of_seq} requestVersion={1} onLoaded={retainHistory}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="成员时间线"><ActivityTimeline activities={activities} runs={{[view.source.child_run_id]:{status:observedRun.status}}}/></ConversationDisplayBoundary>
  {history!==null&&!activities.length&&<p role="status">此子运行暂未记录公开工具步骤。</p>}
 </section>;
}

export default function NativeMemberDetails({rootRunId,childSessionRef,childRunId,initialOpen=false}:{rootRunId:string;childSessionRef:string;childRunId?:string;initialOpen?:boolean}){
 const [open,setOpen]=useState(initialOpen);
 const resource=useResource<View>(async signal=>{
  const source=await request<NativeMemberExecution>(`/runs/${encodeURIComponent(rootRunId)}/native-members/${encodeURIComponent(childSessionRef)}/execution${childRunId?`?child_run_id=${encodeURIComponent(childRunId)}`:''}`,'GET',undefined,undefined,signal);
  parseNativeMemberExecution(source);
  if(source.root_run_id!==rootRunId||source.child_session_ref!==childSessionRef||(childRunId!==undefined&&source.child_run_id!==childRunId))throw Error('原成员执行身份尚未确认');
  return {source};
 },JSON.stringify([rootRunId,childSessionRef,childRunId??null]),open);
 return <section className="jot-native-member-details" aria-label="原成员执行记录">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'收起原成员步骤':'查看原成员步骤'}</button>
  {open&&<>
   <button type="button" disabled={resource.loading} onClick={resource.reload}>刷新原成员记录</button>
   {resource.loading&&<p role="status">正在读取原成员绑定和步骤…</p>}
   {resource.error&&<p role="alert">成员记录暂不可用或权限已更新，可刷新重试。</p>}
   {!resource.loading&&!resource.error&&resource.data&&<MemberTimeline key={`${resource.data.source.child_run_id}:${resource.data.source.child_as_of_seq}`} view={resource.data}/>}
  </>}
 </section>;
}
