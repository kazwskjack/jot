import React,{useCallback,useMemo,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {request} from './client';
import {parseNativeMemberExecution} from './native-member-execution';
import ActivityHistory from './ActivityHistory';
import ActivityTimeline from './ActivityTimeline';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {Activity,NativeMemberExecution} from './types';

type View={source:NativeMemberExecution};
function MemberTimeline({view}:{view:View}){
 const [history,setHistory]=useState<Activity[]|null>(null);
 const retainHistory=useCallback((values:Activity[])=>setHistory(values),[]);
 const activities=useMemo(()=>(history??[]).filter(activity=>activity.run_id===view.source.child_run_id),[history,view.source.child_run_id]);
 return <section aria-label="所选原成员公开步骤">
  <p>子运行 <code>{view.source.child_run_id}</code> · {view.source.child_status} · 版本 {view.source.child_version}</p>
  <p>原父运行 <code>{view.source.root_run_id}</code> · 角色 <code>{view.source.role_ref}</code></p>
  <small>读取时事件序号 {view.source.child_as_of_seq}，可刷新查看最新记录。</small>
  <ConversationDisplayBoundary label="成员步骤历史"><ActivityHistory conversationId={view.source.child_conversation_id}
   runId={view.source.child_run_id} snapshotSeq={view.source.child_as_of_seq} requestVersion={1} onLoaded={retainHistory}/></ConversationDisplayBoundary>
  <ConversationDisplayBoundary label="成员时间线"><ActivityTimeline activities={activities} runs={{[view.source.child_run_id]:{status:view.source.child_status}}}/></ConversationDisplayBoundary>
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
