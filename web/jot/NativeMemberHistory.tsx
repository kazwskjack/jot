import React,{useState} from 'react';
import {useResource} from '../workbench/useResource';
import {request} from './client';
import {parseNativeMemberExecution} from './native-member-execution';
import NativeMemberDetails from './NativeMemberDetails';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import type {NativeMemberExecution,NativeMemberExecutionPage,Run} from './types';

export default function NativeMemberHistory({runs}:{runs:Run[]}){
 const [open,setOpen]=useState(false),[selection,setSelection]=useState('');
 const [cursors,setCursors]=useState<Array<string|undefined>>([undefined]),[page,setPage]=useState(0);
 const [selected,setSelected]=useState<NativeMemberExecution|null>(null);
 const rootRunId=selection||runs[0]?.run_id||'',cursor=cursors[page];
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
 const reset=()=>{setPage(0);setCursors([undefined]);setSelected(null);};
 const changeRoot=(id:string)=>{setSelection(id);reset();};
 return <section className="jot-native-member-history" aria-label="原生成员执行历史">
  <button type="button" aria-expanded={open} disabled={!rootRunId} onClick={()=>{
   if(!open&&!selection)setSelection(rootRunId);
   setOpen(value=>!value);
  }}>{open?'收起成员执行历史':'查看成员执行历史'}</button>
  {open&&<>
   <label>已加载父运行 <select value={rootRunId} onChange={event=>changeRoot(event.currentTarget.value)}>
    {selection&&!runs.some(run=>run.run_id===selection)&&<option value={selection}>{selection}</option>}
    {runs.map(run=><option key={run.run_id} value={run.run_id}>{run.created_at} · {run.status} · {run.run_id}</option>)}
   </select></label>
   <button type="button" disabled={resource.loading} onClick={()=>{reset();resource.reload();}}>刷新成员历史</button>
   {resource.loading&&<p role="status">正在读取已发布的原成员执行记录…</p>}
   {resource.error&&<p role="alert">成员执行历史暂不可用或权限已更新，可刷新重试。</p>}
   {!resource.loading&&!resource.error&&pageData&&<>
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
