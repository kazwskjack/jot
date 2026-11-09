import React,{useEffect,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
import type {ActivityToolResultPage} from './types';

type Target={runId:string;activityId:string;toolName:string};
const sha=/^[a-f0-9]{64}$/;

export default function ActivityToolResult({conversationId,target}:{conversationId:string;target:Target}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,target]);
 const region=useRef<HTMLDivElement>(null);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[];sha?:string}>({identity,offset:0,previous:[]});
 const [state,setState]=useState<{identity:string;offset:number;page?:ActivityToolResultPage;error?:string}>();
 const [revision,setRevision]=useState(0);
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,offset:0,previous:[]};
 const {offset,sha:expected}=currentCursor;
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();
  setState({identity,offset});
  const load=async()=>{
   const query=new URLSearchParams({run_id:target.runId,offset_chars:String(offset),...(expected?{result_sha256:expected}:{})});
   const page=await request<ActivityToolResultPage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(target.activityId)}/tool-result?${query}`,'GET',undefined,undefined,controller.signal);
   if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==target.runId||page.activity_id!==target.activityId
    ||page.tool_name!==target.toolName||page.source!=='mcp'||page.execution_authorized!==false
    ||typeof page.result_sha256!=='string'||!sha.test(page.result_sha256)||expected!==undefined&&page.result_sha256!==expected
    ||typeof page.text_sha256!=='string'||!sha.test(page.text_sha256)||page.offset_chars!==offset
    ||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>524288
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars||typeof page.has_other_content!=='boolean'
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars
     :!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars))throw Error('工具结果来源或分页尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{if(!controller.signal.aborted)setState({identity,offset,error:error instanceof Error?error.message:'工具结果读取失败'});});
  return()=>controller.abort();
 },[identity,offset,expected,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 return <div ref={region} tabIndex={-1} className="jot-activity-content" aria-label="工具结果正文">
  <h4>工具结果正文</h4>
  {(!current||!page&&!current.error)&&<p role="status">正在读取原工具结果…</p>}
  {page&&<>
   <section data-chat-search-content={JSON.stringify(['tool-result',identity,page.result_sha256,offset])}>
    <pre>{page.text}</pre>
   </section>
   {page.total_chars===0&&<p role="status">原结果未包含文本内容。</p>}
   {page.has_other_content&&<p role="status">原结果还包含图片或其他非文本内容。</p>}
   <nav aria-label="工具结果正文翻页" data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1)!;
     setCursor({identity,offset:prior,previous,sha:page.result_sha256});
    }}>上一页正文</button>
    <span>{Math.min(offset+1,page.total_chars)}–{offset+page.text.length} / {page.total_chars}（UTF-16 位置）</span>
    <button type="button" disabled={page.next_offset_chars===undefined} onClick={()=>{
     if(page.next_offset_chars!==undefined)setCursor({identity,offset:page.next_offset_chars,previous:[...currentCursor.previous,offset],sha:page.result_sha256});
    }}>下一页正文</button>
   </nav>
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取</button></p>}
 </div>;
}
