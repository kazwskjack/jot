import React,{useCallback,useMemo,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {request} from './client';
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

export default function NativeMemberDetails({rootRunId,childSessionRef}:{rootRunId:string;childSessionRef:string}){
 const [open,setOpen]=useState(false);
 const resource=useResource<View>(async signal=>{
  const source=await request<NativeMemberExecution>(`/runs/${encodeURIComponent(rootRunId)}/native-members/${encodeURIComponent(childSessionRef)}/execution`,'GET',undefined,undefined,signal);
  const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
  if(!source||source.root_run_id!==rootRunId||source.child_session_ref!==childSessionRef||source.execution_authorized!==false
   ||!id(source.child_run_id)||source.child_run_id===rootRunId||!id(source.child_conversation_id)||!id(source.role_ref)
   ||!Number.isSafeInteger(source.child_version)||source.child_version<1
   ||typeof source.child_as_of_seq!=='string'||!/^(0|[1-9]\d{0,18})$/.test(source.child_as_of_seq)||BigInt(source.child_as_of_seq)>9223372036854775807n)throw Error('原成员执行身份尚未确认');
  return {source};
 },`${rootRunId}:${childSessionRef}`,open);
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
