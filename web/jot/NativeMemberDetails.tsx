import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {ApiError,abortableDelay,follow,request,taskDraftScope} from './client';
import {parseNativeMemberExecution,type NativeMemberTarget} from './native-member-execution';
import ActivityHistory from './ActivityHistory';
import InteractionHistory from './InteractionHistory';
import ActivityTimeline from './ActivityTimeline';
import ConversationHistorySearch from './ConversationHistorySearch';
import type {ActivityReveal} from './activity-presentation';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {Activity,NativeMemberExecution,Run} from './types';

type View={source:NativeMemberExecution};
function MemberTimeline({view,onOpenMember}:{view:View;onOpenMember:(target:NativeMemberTarget)=>void}){
 const [history,setHistory]=useState<Activity[]|null>(null);
 const retainHistory=useCallback((values:Activity[])=>setHistory(values),[]);
 const region=useRef<HTMLElement>(null),[historyRequest,setHistoryRequest]=useState(1),[activityReveal,setActivityReveal]=useState<ActivityReveal>();
 const loadHistory=useCallback(()=>setHistoryRequest(value=>value+1),[]);
 const revealActivity=useCallback((value:ActivityReveal)=>setActivityReveal(prior=>prior?.key===value.key&&prior.activityId===value.activityId?prior:value),[]);
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
 const runs=useMemo(()=>({[view.source.child_run_id]:{status:observedRun.status}}),[view.source.child_run_id,observedRun.status]);
 return <section ref={region} data-chat-search-scope aria-label="所选原成员公开步骤">
  <p>子运行 <code>{view.source.child_run_id}</code> · {observedRun.status} · 版本 {observedRun.version}</p>
  <p>原父运行 <code>{view.source.root_run_id}</code> · 角色 <code>{view.source.role_ref}</code></p>
  <small>历史读取边界 {view.source.child_as_of_seq}，更新固定到所选子运行。</small>
  <button type="button" aria-pressed={following} onClick={()=>setFollowing(value=>!value)}>{following?'暂停实时更新':'继续实时更新'}</button>
  {streamIssue&&<p role="status">{streamIssue}</p>}
  <ConversationDisplayBoundary label="成员步骤搜索"><ConversationHistorySearch scope="activities" conversationId={view.source.child_conversation_id} runId={view.source.child_run_id} root={region} activities={activities}
   runs={runs} onRevealActivity={revealActivity} onLoadActivityHistory={loadHistory} activityHistorySeq={view.source.child_as_of_seq} resultSearchSeq={cursor.current}
   renderedRevision={activities} ready/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="成员步骤历史"><ActivityHistory conversationId={view.source.child_conversation_id}
   runId={view.source.child_run_id} snapshotSeq={view.source.child_as_of_seq} requestVersion={historyRequest} onLoaded={retainHistory}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="成员交互历史"><InteractionHistory key={view.source.child_run_id} conversationId={view.source.child_conversation_id} runId={view.source.child_run_id}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="成员时间线"><ActivityTimeline conversationId={view.source.child_conversation_id} activities={activities} runs={runs} onOpenMember={onOpenMember} {...(activityReveal?{reveal:activityReveal}:{})}/></ConversationDisplayBoundary>
  {history!==null&&!activities.length&&<p role="status">此子运行暂未记录公开工具步骤。</p>}
 </section>;
}

type MemberTarget={root_run_id:string;child_session_ref:string;child_run_id?:string};
function MemberExecutionView({target,onOpenMember}:{target:MemberTarget;onOpenMember:(target:NativeMemberTarget,from:NativeMemberExecution)=>void}){
 const owner=taskDraftScope();
 const resource=useResource<View>(async signal=>{
  const source=await request<NativeMemberExecution>(`/runs/${encodeURIComponent(target.root_run_id)}/native-members/${encodeURIComponent(target.child_session_ref)}/execution${target.child_run_id?`?child_run_id=${encodeURIComponent(target.child_run_id)}`:''}`,'GET',undefined,undefined,signal);
  parseNativeMemberExecution(source);
  if(taskDraftScope()!==owner||source.root_run_id!==target.root_run_id||source.child_session_ref!==target.child_session_ref
    ||target.child_run_id!==undefined&&source.child_run_id!==target.child_run_id)throw Error('原成员执行身份尚未确认');
  return {source};
 },JSON.stringify([owner,target]),true);
 return <>
  <button type="button" disabled={resource.loading} onClick={resource.reload}>刷新原成员记录</button>
  {resource.loading&&<p role="status">正在读取原成员绑定和步骤…</p>}
  {resource.error&&<p role="alert">成员记录暂不可用或权限已更新，可刷新重试。</p>}
  {!resource.loading&&!resource.error&&resource.data&&<MemberTimeline key={`${resource.data.source.child_run_id}:${resource.data.source.child_as_of_seq}`} view={resource.data}
   onOpenMember={target=>onOpenMember(target,resource.data!.source)}/>}
 </>;
}

export default function NativeMemberDetails({rootRunId,childSessionRef,childRunId,initialOpen=false}:{rootRunId:string;childSessionRef:string;childRunId?:string;initialOpen?:boolean}){
 const owner=taskDraftScope(),base:MemberTarget={root_run_id:rootRunId,child_session_ref:childSessionRef,...(childRunId?{child_run_id:childRunId}:{})};
 const identity=JSON.stringify([owner,base]),[open,setOpen]=useState(initialOpen);
 const [navigation,setNavigation]=useState<{identity:string;current:NativeMemberTarget;first:NativeMemberTarget;back:NativeMemberTarget[];trimmed:boolean}>();
 const [error,setError]=useState<{identity:string;text:string}>();
 const current=navigation?.identity===identity?navigation:undefined,target=current?.current??base;
 const enter=(next:NativeMemberTarget,from:NativeMemberExecution)=>{
  if(taskDraftScope()!==owner||from.root_run_id!==target.root_run_id||from.child_session_ref!==target.child_session_ref
    ||target.child_run_id!==undefined&&from.child_run_id!==target.child_run_id||next.root_run_id!==from.child_run_id){setError({identity,text:'下一层成员与当前执行来源尚未确认，请刷新原成员记录。'});return;}
  const prior:NativeMemberTarget={root_run_id:from.root_run_id,child_session_ref:from.child_session_ref,child_run_id:from.child_run_id};
  if(next.child_run_id===prior.child_run_id||next.child_run_id===current?.first.child_run_id||current?.back.some(value=>value.child_run_id===next.child_run_id)){
   setError({identity,text:'成员执行关联形成循环，已保留当前记录。'});return;
  }
  const back=[...(current?.back??[]),prior];setError(undefined);
  setNavigation({identity,current:{root_run_id:next.root_run_id,child_session_ref:next.child_session_ref,child_run_id:next.child_run_id},first:current?.first??prior,back:back.slice(-32),trimmed:!!current?.trimmed||back.length>32});
 };
 return <section className="jot-native-member-details" aria-label="原成员执行记录">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'收起原成员步骤':'查看原成员步骤'}</button>
  {open&&<>
   {current&&<nav aria-label="成员执行返回位置" data-chat-search-ignore>
    <button type="button" disabled={!current.back.length} onClick={()=>{setError(undefined);const previous=current.back.at(-1);if(previous)setNavigation({...current,current:previous,back:current.back.slice(0,-1)});}}>返回上一条成员记录</button>
    <button type="button" onClick={()=>{setError(undefined);setNavigation({...current,current:current.first,back:[],trimmed:false});}}>返回最初成员记录</button>
    {current.trimmed&&<small>保留最近32个返回位置，可随时返回最初成员记录。</small>}
   </nav>}
   {error?.identity===identity&&<p role="alert">{error.text}</p>}
   <ConversationDisplayBoundary key={JSON.stringify([identity,target])} label="当前成员执行"><MemberExecutionView target={target} onOpenMember={enter}/></ConversationDisplayBoundary>
  </>}
 </section>;
}
