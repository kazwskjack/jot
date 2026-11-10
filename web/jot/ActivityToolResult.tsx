import ActivityToolFile from './ActivityToolFile';
import React,{useEffect,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import type {ActivityToolResultPage,ActivityToolResultFile} from './types';

type Target={runId:string;activityId:string;toolName:string;offset?:number;resultSha?:string;textSha?:string;match?:{offset:number;text:string}};
const sha=/^[a-f0-9]{64}$/;

export default function ActivityToolResult({conversationId,target}:{conversationId:string;target:Target}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,target]);
 const region=useRef<HTMLDivElement>(null);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[];sha?:string;textSha?:string}>({identity,offset:target.offset??0,previous:[],sha:target.resultSha,textSha:target.textSha});
 const [state,setState]=useState<{identity:string;offset:number;page?:ActivityToolResultPage;error?:string}>();
 const [revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<{identity:string;resultSha:string;file:ActivityToolResultFile}>();
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,offset:target.offset??0,previous:[],sha:target.resultSha,textSha:target.textSha};
 const {offset,sha:expected,textSha:expectedText}=currentCursor;
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();
  setState({identity,offset});
  const load=async()=>{
   const query=new URLSearchParams({run_id:target.runId,offset_chars:String(offset),...(expected?{result_sha256:expected}:{}),...(expectedText?{text_sha256:expectedText}:{})});
   const page=await request<ActivityToolResultPage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(target.activityId)}/tool-result?${query}`,'GET',undefined,undefined,controller.signal);
   if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==target.runId||page.activity_id!==target.activityId
    ||page.tool_name!==target.toolName||page.execution_authorized!==false
    ||(target.toolName==='jot_workspace'
     ?page.source!=='workspace'||!['files.read','web.read','files.write','files.delete','files.list'].includes(page.operation??'')||typeof page.source_truncated!=='boolean'
     :target.toolName==='glob'||target.toolName==='grep'
      ?page.source!=='native'||page.operation!==target.toolName||typeof page.source_truncated!=='boolean'||page.has_other_content!==false
      :page.source!=='mcp'||page.operation!==undefined||page.source_truncated!==undefined)
    ||((page.operation==='files.write'||page.operation==='files.delete')? !['available','base_unrecorded','preview_limit','content_unavailable','non_text'].includes(page.file_diff_state??''):page.file_diff_state!==undefined)
    ||typeof page.result_sha256!=='string'||!sha.test(page.result_sha256)||expected!==undefined&&page.result_sha256!==expected
    ||typeof page.text_sha256!=='string'||!sha.test(page.text_sha256)||expectedText!==undefined&&page.text_sha256!==expectedText||page.offset_chars!==offset
    ||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>6*1048576
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars||typeof page.has_other_content!=='boolean'
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars
     :!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars))throw Error('工具结果来源或分页尚未确认');
   if(page.operation==='files.list'){
    if(!Array.isArray(page.file_links)||page.file_links.length>256||page.file_links.some((file,index,files)=>!file||typeof file.path!=='string'||!file.path||file.path.length>4096
     ||!Number.isSafeInteger(file.version)||file.version<0||!Number.isSafeInteger(file.size)||file.size<0||typeof file.sha256!=='string'||!sha.test(file.sha256)
     ||!Number.isSafeInteger(file.offset_chars)||file.offset_chars<0||!Number.isSafeInteger(file.end_offset_chars)||file.end_offset_chars<=file.offset_chars||file.end_offset_chars>page.total_chars
     ||file.end_offset_chars<=offset||file.offset_chars>=offset+page.text.length||index>0&&file.offset_chars<files[index-1]!.end_offset_chars))throw Error('原文件列表来源尚未确认');
   }else if(page.file_links!==undefined)throw Error('原文件列表来源尚未确认');
   if(target.match&&offset===(target.offset??0)
    &&(target.match.offset<offset||page.text.slice(target.match.offset-offset,target.match.offset-offset+target.match.text.length)!==target.match.text))throw Error('原结果命中位置尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{
   if(controller.signal.aborted)return;
   const message=error instanceof ApiError&&error.status===404?'此步骤暂无已保存且可确认的结果正文。'
    :error instanceof ApiError&&error.status===409?'正文来源已变化，请关闭后重新打开。'
    :error instanceof Error?error.message:'工具结果读取失败';
   setState({identity,offset,error:message});
  });
  return()=>controller.abort();
 },[identity,offset,expected,expectedText,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 const match=page&&target.match&&target.match.offset>=offset&&target.match.offset+target.match.text.length<=offset+page.text.length
  &&page.text.slice(target.match.offset-offset,target.match.offset-offset+target.match.text.length)===target.match.text?target.match:undefined;
 return <div ref={region} tabIndex={-1} className="jot-activity-content" aria-label="工具结果正文">
  <h4>工具结果正文</h4>
  {(!current||!page&&!current.error)&&<p role="status">正在读取原工具结果…</p>}
  {page&&<>
   <section data-chat-search-content={JSON.stringify(['tool-result',identity,page.result_sha256,offset])}>
    <pre>{match?<>{page.text.slice(0,match.offset-offset)}<mark>{match.text}</mark>{page.text.slice(match.offset-offset+match.text.length)}</>:page.text}</pre>
   </section>
   {page.file_diff_state&&page.file_diff_state!=='available'&&<p role="status">{{base_unrecorded:'该文件变更缺少原版本正文，当前显示已确认的操作信息。',preview_limit:'差异来源超过单文件 1 MiB 的文本比较范围。',content_unavailable:'固定版本内容暂不可用，当前显示已确认的操作信息。',non_text:'差异来源包含非 UTF-8 文本内容。'}[page.file_diff_state]}</p>}
   {page.file_links&&page.file_links.length>0&&<div role="group" aria-label="原列表固定版本文件" data-chat-search-ignore style={{display:'flex',flexWrap:'wrap',gap:'0.25rem',maxHeight:'12rem',overflow:'auto'}}>
    {page.file_links.map(file=><button type="button" key={JSON.stringify([file.path,file.version,file.sha256])} title={file.path} aria-label={`${file.path}，版本 ${file.version}`}
     onClick={()=>setSelected({identity,resultSha:page.result_sha256,file})}>{file.path.split('/').at(-1)} · 版本 {file.version}</button>)}
   </div>}
   {page.source_truncated&&<p role="status">{page.source==='native'?'原生公开结果未覆盖全部来源，当前显示已保留内容。':page.operation==='files.list'?'原文件列表含后续页面或超出显示范围，当前展示已确认的留存部分。':'原工具回执中的正文已截断，当前显示回执保存的全部文本。'}</p>}
   {page.total_chars===0&&<p role="status">原结果未包含文本内容。</p>}
   {page.has_other_content&&<p role="status">原结果还包含图片或其他非文本内容。</p>}
   {offset>0&&<button type="button" data-chat-search-ignore onClick={()=>setCursor({identity,offset:0,previous:[],sha:page.result_sha256,textSha:page.text_sha256})}>从正文开头阅读</button>}
   <nav aria-label="工具结果正文翻页" data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1)!;
     setCursor({identity,offset:prior,previous,sha:page.result_sha256,textSha:page.text_sha256});
    }}>上一页正文</button>
    <span>{Math.min(offset+1,page.total_chars)}–{offset+page.text.length} / {page.total_chars}（UTF-16 位置）</span>
    <button type="button" disabled={page.next_offset_chars===undefined} onClick={()=>{
     if(page.next_offset_chars!==undefined)setCursor({identity,offset:page.next_offset_chars,previous:[...currentCursor.previous,offset],sha:page.result_sha256,textSha:page.text_sha256});
    }}>下一页正文</button>
   </nav>
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取</button></p>}
  {selected?.identity===identity&&<>
   <button type="button" data-chat-search-ignore onClick={()=>setSelected(undefined)}>关闭原列表文件</button>
   <ActivityToolFile key={JSON.stringify(selected)} conversationId={conversationId} runId={target.runId} activityId={target.activityId} resultSha={selected.resultSha} file={selected.file}/>
  </>}
 </div>;
}
