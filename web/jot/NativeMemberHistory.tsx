import React,{useCallback,useEffect,useState} from 'react';
import {useResource} from '../workbench/useResource';
import {request} from './client';
import {parseNativeMemberExecution,parseNativeMemberParentRun} from './native-member-execution';
import NativeMemberDetails from './NativeMemberDetails';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {NativeMemberExecution,NativeMemberExecutionPage,NativeMemberParentRun,NativeMemberParentPage} from './types';

export default function NativeMemberHistory({conversationId}:{conversationId:string}){
 const [open,setOpen]=useState(false),[selection,setSelection]=useState<NativeMemberParentRun|null>(null);
 const [parentCursors,setParentCursors]=useState<Array<NativeMemberParentRun|undefined>>([undefined]),[parentPage,setParentPage]=useState(0);
 const [cursors,setCursors]=useState<Array<string|undefined>>([undefined]),[page,setPage]=useState(0);
 const [selected,setSelected]=useState<NativeMemberExecution|null>(null);
 const rootRunId=selection?.conversation_id===conversationId?selection.run_id:'',cursor=cursors[page];
 const boundary=parentCursors[parentPage],parentCursor=boundary?.run_id;
 const parents=useResource<{value:NativeMemberParentPage;cursor:string|undefined}>(async signal=>{
  const value=await request<NativeMemberParentPage>(`/conversations/${encodeURIComponent(conversationId)}/native-member-runs?limit=25${parentCursor?`&cursor=${encodeURIComponent(parentCursor)}`:''}`,'GET',undefined,undefined,signal);
  if(!value||value.conversation_id!==conversationId||value.execution_authorized!==false||!Array.isArray(value.items)||value.items.length>25)throw Error('父运行历史尚未确认');
  let previous=boundary;const seen=new Set(boundary?[boundary.run_id]:[]);
  for(const item of value.items){
   const source=parseNativeMemberParentRun(item);
   if(source.conversation_id!==conversationId||seen.has(source.run_id)||previous&&(source.created_at>previous.created_at||source.created_at===previous.created_at&&source.run_id>=previous.run_id))throw Error('父运行历史顺序尚未确认');
   seen.add(source.run_id);previous=source;
  }
  if(value.next_cursor!==undefined&&(!value.items.length||value.next_cursor!==previous?.run_id))throw Error('父运行历史分页尚未确认');
  return {value,cursor:parentCursor};
 },JSON.stringify([conversationId,parentPage,parentCursor??null]),open);
 const parentData=parents.data&&parents.data.cursor===parentCursor&&parents.data.value.conversation_id===conversationId?parents.data.value:null;
 const reset=useCallback(()=>{setPage(0);setCursors([undefined]);setSelected(null);},[]);
 useEffect(()=>{
  const first=parentData?.items[0];
  if(open&&!rootRunId&&first){setSelection(first);reset();}
 },[open,rootRunId,parentData,reset]);
 const resource=useResource<{value:NativeMemberExecutionPage;cursor:string|undefined}>(async signal=>{
  const value=await request<NativeMemberExecutionPage>(`/runs/${encodeURIComponent(rootRunId)}/native-member-executions?limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,'GET',undefined,undefined,signal);
  if(!value||value.root_run_id!==rootRunId||value.execution_authorized!==false||!Array.isArray(value.items)||value.items.length>25)throw Error('成员执行历史尚未确认');
  let previous=cursor??'';
  for(const item of value.items){
   const source=parseNativeMemberExecution(item);
   if(source.root_run_id!==rootRunId||source.child_run_id<=previous)throw Error('成员执行历史顺序尚未确认');
   previous=source.child_run_id;
  }
  if(value.next_cursor!==undefined&&(!value.items.length||value.next_cursor!==previous))throw Error('成员执行历史分页尚未确认');
  return {value,cursor};
 },JSON.stringify([rootRunId,page,cursor??null]),open&&!!rootRunId);
 const data=resource.data;
 const pageData=data&&data.cursor===cursor&&data.value.root_run_id===rootRunId?data.value:null;
 const changeRoot=(id:string)=>{
  const source=parentData?.items.find(run=>run.run_id===id);
  if(source){setSelection(source);reset();}
 };
 return <section className="jot-native-member-history" aria-label="原生成员执行历史">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'收起成员执行历史':'查看成员执行历史'}</button>
  {open&&<>
   <label>原会话父运行 <select value={rootRunId} disabled={parents.loading} onChange={event=>changeRoot(event.currentTarget.value)}>
    <option value="" disabled>选择父运行</option>
    {selection&&selection.conversation_id===conversationId&&!parentData?.items.some(run=>run.run_id===selection.run_id)&&<option value={selection.run_id}>{selection.created_at} · {selection.status} · {selection.run_id}</option>}
    {parentData?.items.map(run=><option key={run.run_id} value={run.run_id}>{run.created_at} · {run.status} · {run.run_id}</option>)}
   </select></label>
   <button type="button" disabled={parents.loading} onClick={()=>{setParentPage(0);setParentCursors([undefined]);parents.reload();}}>刷新父运行历史</button>
   {parents.loading&&<p role="status">正在读取原会话的父运行记录…</p>}
   {parents.error&&<p role="alert">父运行历史暂不可用或权限已更新，可刷新重试。</p>}
   {!parents.loading&&!parents.error&&parentData&&!parentData.items.length&&<p role="status">当前页没有包含已发布成员的父运行。</p>}
   <nav aria-label="父运行历史翻页">
    <button type="button" disabled={parents.loading||parentPage===0} onClick={()=>setParentPage(parentPage-1)}>较新父运行</button><span>第 {parentPage+1} 页父运行</span>
    <button type="button" disabled={parents.loading||!parentData?.next_cursor} onClick={()=>{
     const last=parentData?.items.at(-1);if(!last||parentData?.next_cursor!==last.run_id)return;
     setParentCursors(prior=>[...prior.slice(0,parentPage+1),last]);setParentPage(parentPage+1);
    }}>更早父运行</button>
   </nav>
   <button type="button" disabled={!rootRunId||resource.loading} onClick={()=>{reset();resource.reload();}}>刷新成员历史</button>
   {resource.loading&&<p role="status">正在读取已发布的原成员执行记录…</p>}
   {resource.error&&<p role="alert">成员执行历史暂不可用或权限已更新，可刷新重试。</p>}
   {!!rootRunId&&!resource.loading&&!resource.error&&pageData&&<>
    {!pageData.items.length&&<p role="status">当前页没有已发布的成员执行记录。</p>}
    <ul>{pageData.items.map(source=><li key={source.child_run_id}>
     <button type="button" aria-pressed={selected?.child_run_id===source.child_run_id} onClick={()=>setSelected(source)}>
      {source.child_session_ref} · {source.child_status} · {source.child_run_id}
     </button>
    </li>)}</ul>
    <nav aria-label="成员执行历史翻页">
     <button type="button" disabled={page===0} onClick={()=>{setPage(page-1);setSelected(null);}}>上一页执行</button><span>第 {page+1} 页</span>
     <button type="button" disabled={!pageData.next_cursor} onClick={()=>{
      const next=pageData?.next_cursor;if(!next)return;
      setCursors(prior=>[...prior.slice(0,page+1),next]);setPage(page+1);setSelected(null);
     }}>下一页执行</button>
    </nav>
   </>}
   {selected&&selected.root_run_id===rootRunId&&<ConversationDisplayBoundary label="历史成员步骤">
    <NativeMemberDetails key={selected.child_run_id} rootRunId={rootRunId} childSessionRef={selected.child_session_ref} childRunId={selected.child_run_id} initialOpen/>
   </ConversationDisplayBoundary>}
  </>}
 </section>;
}
