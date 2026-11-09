import React,{useEffect,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
import type {ArtifactTextMatch,ArtifactTextPage} from './types';

export default function ArtifactTextResult({conversationId,runId,target}:{conversationId:string;runId?:string;target:ArtifactTextMatch}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,target]);
 const region=useRef<HTMLElement>(null);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[]}>({identity,offset:target.offset_chars,previous:[]});
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,offset:target.offset_chars,previous:[]};
 const [state,setState]=useState<{identity:string;offset:number;page?:ArtifactTextPage;error?:string}>(),[revision,setRevision]=useState(0);
 const offset=currentCursor.offset;
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();setState({identity,offset});
  const load=async()=>{
   const query=new URLSearchParams({conversation_id:conversationId,version:String(target.version),sha256:target.sha256,offset_chars:String(offset),...(runId?{run_id:runId}:{})});
   const page=await request<ArtifactTextPage>(`/artifacts/${encodeURIComponent(target.artifact_id)}/text?${query}`,'GET',undefined,undefined,controller.signal,120000);
   if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.artifact_id!==target.artifact_id||page.version!==target.version
    ||page.sha256!==target.sha256||page.size_bytes!==target.size_bytes||page.execution_authorized!==false||typeof page.file_name!=='string'
    ||page.offset_chars!==offset||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>target.size_bytes
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars
     :!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars)
    ||offset===target.offset_chars&&page.text.slice(target.match_offset_chars-offset,target.match_offset_chars-offset+target.match_text.length)!==target.match_text)throw Error('文件原版本或命中内容尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{if(!controller.signal.aborted)setState({identity,offset,error:error instanceof Error?error.message:'原文件正文读取失败'});});
  return()=>controller.abort();
 },[identity,offset,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 const at=target.match_offset_chars-offset,marked=page&&at>=0&&page.text.slice(at,at+target.match_text.length)===target.match_text;
 return <section ref={region} tabIndex={-1} className="jot-activity-content" aria-label="已选原文件正文">
  <h4>{page?.file_name??target.file_name} · 版本 {target.version}</h4>
  {(!current||!page&&!current.error)&&<p role="status">正在读取并核对原文件…</p>}
  {page&&<>
   <section data-chat-search-content={JSON.stringify(['artifact-text',identity,offset])}>
    <pre>{marked?<>{page.text.slice(0,at)}<mark>{target.match_text}</mark>{page.text.slice(at+target.match_text.length)}</>:page.text}</pre>
   </section>
   <nav aria-label="原文件正文翻页" data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1)!;
     setCursor({identity,offset:prior,previous});
    }}>上一页正文</button>
    <span>{Math.min(offset+1,page.total_chars)}–{offset+page.text.length} / {page.total_chars}（UTF-16 位置）</span>
    <button type="button" disabled={page.next_offset_chars===undefined} onClick={()=>{
     if(page.next_offset_chars!==undefined)setCursor({identity,offset:page.next_offset_chars,previous:[...currentCursor.previous,offset]});
    }}>下一页正文</button>
    {offset>0&&<button type="button" onClick={()=>setCursor({identity,offset:0,previous:[]})}>从正文开头阅读</button>}
   </nav>
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取</button></p>}
 </section>;
}
