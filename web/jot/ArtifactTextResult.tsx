import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import type {ArtifactTextMatch,ArtifactTextPage} from './types';

export default function ArtifactTextResult({conversationId,runId,target}:{conversationId:string;runId?:string;target:ArtifactTextMatch}){
 const language=useApplicationLanguage(),t=useApplicationText();
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
   const query=new URLSearchParams({conversation_id:conversationId,version:String(target.version),sha256:target.sha256,...(target.document_job_id?{document_job_id:target.document_job_id,document_result_sha256:target.document_result_sha256!,text_sha256:target.text_sha256!,...(target.document_operation?{document_operation:target.document_operation}:{})}:{}),offset_chars:String(offset),...(target.part_index===undefined?{}:{part_index:String(target.part_index),group_sha256:target.group_sha256!}),...(runId?{run_id:runId}:{})});
   const page=await request<ArtifactTextPage>(`/artifacts/${encodeURIComponent(target.artifact_id)}/text?${query}`,'GET',undefined,undefined,controller.signal,120000);
   if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.artifact_id!==target.artifact_id||page.version!==target.version
    ||page.sha256!==target.sha256||page.part_index!==target.part_index||page.group_sha256!==target.group_sha256||page.size_bytes!==target.size_bytes||page.execution_authorized!==false||typeof page.file_name!=='string'
    ||page.document_job_id!==target.document_job_id||page.document_result_sha256!==target.document_result_sha256
    ||page.text_sha256!==target.text_sha256||page.text_total_chars!==target.text_total_chars||page.source_truncated!==target.source_truncated||page.document_operation!==target.document_operation||page.document_read_revision!==target.document_read_revision
    ||page.offset_chars!==offset||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>(target.text_total_chars??target.size_bytes)||target.document_job_id!==undefined&&page.total_chars!==target.text_total_chars
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars
     :!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars)
    ||offset===target.offset_chars&&page.text.slice(target.match_offset_chars-offset,target.match_offset_chars-offset+target.match_text.length)!==target.match_text)throw Error('文件原版本或命中内容尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{if(!controller.signal.aborted)setState({identity,offset,error:error instanceof ApiError&&error.status===409?'原文件或分卷清单已更新，请刷新文件搜索。':error instanceof Error?error.message:'原文件正文读取失败'});});
  return()=>controller.abort();
 },[identity,offset,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 const at=target.match_offset_chars-offset,marked=page&&at>=0&&page.text.slice(at,at+target.match_text.length)===target.match_text;
 return <section lang={language} ref={region} tabIndex={-1} className="jot-activity-content" aria-label={t('已选原文件正文','Selected Original File Body')}>
  <h4>{page?.file_name??target.file_name} · {t('版本','Version')} {target.version}{target.part_index===undefined?'':t(` · 第 ${target.part_index} 卷`,` · Part ${target.part_index}`)}{target.document_job_id?(target.document_operation==='document.read'?t(' · 已保存原读取结果',' · Saved Original Read Result'):t(' · 已保存文档预览',' · Saved Document Preview')):''}</h4>
  {(!current||!page&&!current.error)&&<p role="status">{t('正在读取并核对原文件…','Reading and verifying the original file…')}</p>}
  {page&&<>
   <section data-chat-search-content={JSON.stringify(['artifact-text',identity,offset])}>
    <pre>{marked?<>{page.text.slice(0,at)}<mark>{target.match_text}</mark>{page.text.slice(at+target.match_text.length)}</>:page.text}</pre>
   </section>
   {page.document_operation==='document.read'&&page.document_read_revision!==1
    ?<p role="status">{t('该历史读取结果未记录解析版本，其文档覆盖范围尚未确认。','This historical read result does not record a parser revision. Its document coverage is unconfirmed.')}</p>
    :page.source_truncated&&<p role="status">{t('已保存文档文本含覆盖缺口或显示截断，当前显示其留存文本。','The saved document text has coverage gaps or display truncation. Its retained text is shown.')}</p>}
   <nav aria-label={t('原文件正文翻页','Original File Body Pages')} data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1)!;
     setCursor({identity,offset:prior,previous});
    }}>{t('上一页正文','Previous Text Page')}</button>
    <span>{Math.min(offset+1,page.total_chars)}–{offset+page.text.length} / {page.total_chars}{t('（UTF-16 位置）',' (UTF-16 positions)')}</span>
    <button type="button" disabled={page.next_offset_chars===undefined} onClick={()=>{
     if(page.next_offset_chars!==undefined)setCursor({identity,offset:page.next_offset_chars,previous:[...currentCursor.previous,offset]});
    }}>{t('下一页正文','Next Text Page')}</button>
    {offset>0&&<button type="button" onClick={()=>setCursor({identity,offset:0,previous:[]})}>{t('从正文开头阅读','Read from the Beginning of the Text')}</button>}
   </nav>
  </>}
  {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重试读取','Retry Reading')}</button></p>}
 </section>;
}
