import React,{useEffect,useRef,useState} from 'react';
import {OfficeContent} from './ActivityToolFileOffice';
import {normalizeOfficePreviewContent,officePreviewFormat} from '../../packages/gateway/src/artifacts/document-preview-content';
import {ApiError,request,taskDraftScope} from './client';
import type {NativeMemberOfficeDocumentPage} from '../../packages/gateway/contracts/types';
import {nativeMemberDownloadUrl,type NativeMemberPreviewSource} from './activity-file-preview-client';
import {artifactPreviewErrorMessage} from './artifact-preview-bytes.mjs';

export default function NativeSearchOfficeDocument({source,expectedOpenSha,expectedOpenProof,onOpened}:{source:NativeMemberPreviewSource;expectedOpenSha?:string|undefined;expectedOpenProof?:string|undefined;onOpened?:(sha:string,proof?:string)=>boolean}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,source]);
 const held=useRef<{identity:string;sha:string;proof?:string;revision:number}>();
 const [state,setState]=useState<{identity:string;page?:NativeMemberOfficeDocumentPage;error?:string}>(),[revision,setRevision]=useState(0);
 useEffect(()=>{
  if(expectedOpenSha&&held.current?.identity===identity&&held.current.sha===expectedOpenSha&&held.current.proof===expectedOpenProof&&held.current.revision===revision&&state?.identity===identity&&state.page)return;
  const controller=new AbortController();setState({identity});
  const load=async()=>{
   const format=officePreviewFormat(source.member.path);
   if(!format?.native)throw Error('此格式的原生结构化解析尚未确认');
   const pin=expectedOpenSha??(held.current?.identity===identity?held.current.sha:undefined);
   const proof=expectedOpenProof??(held.current?.identity===identity?held.current.proof:undefined);
   const query=new URLSearchParams({run_id:source.runId,result_sha256:source.resultSha,members_sha256:source.membersSha,
    ...(source.asOfSeq?{as_of_seq:source.asOfSeq}:{}),...(pin?{open_sha256:pin}:{}),...(proof?{open_proof:proof}:{})});
   const page=await request<NativeMemberOfficeDocumentPage>(`/conversations/${encodeURIComponent(source.conversationId)}/activities/${encodeURIComponent(source.activityId)}/tool-result/members/${source.member.index}/document?${query}`,'GET',undefined,undefined,controller.signal,120000);
   controller.signal.throwIfAborted();
   if(taskDraftScope()!==owner||!page||page.document_protocol!==1||page.conversation_id!==source.conversationId||page.run_id!==source.runId
    ||page.activity_id!==source.activityId||page.member_index!==source.member.index||page.path!==source.member.path||page.as_of_seq!==source.asOfSeq
    ||page.result_sha256!==source.resultSha||page.members_sha256!==source.membersSha||page.execution_authorized!==false
    ||typeof page.open_sha256!=='string'||!/^[a-f0-9]{64}$/.test(page.open_sha256)||pin!==undefined&&page.open_sha256!==pin
    ||page.open_proof!==undefined&&(typeof page.open_proof!=='string'||page.open_proof.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(page.open_proof))
    ||proof!==undefined&&page.open_proof!==proof
    ||typeof page.sha256!=='string'||!/^[a-f0-9]{64}$/.test(page.sha256)||!Number.isSafeInteger(page.size_bytes)||page.size_bytes<0||page.size_bytes>100*1024*1024
    ||page.media_type!==format.mediaType||page.document?.kind!==format.kind||!page.engine||typeof page.engine.name!=='string'||page.engine.name.length>200
    ||typeof page.engine.version!=='string'||page.engine.version.length>200)throw Error('原生Office结构化来源尚未确认');
   const document=normalizeOfficePreviewContent(page.media_type,page.document);
   if(onOpened&&!onOpened(page.open_sha256,page.open_proof))throw Error('原打开来源已变化，请重新打开文件');
   held.current={identity,sha:page.open_sha256,revision,...(page.open_proof?{proof:page.open_proof}:{})};
   setState({identity,page:{...page,document}});
  };
  void load().catch(error=>{
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   const message=error instanceof ApiError&&error.status===409?'本次打开来源已变化，请重新打开文件。'
    :error instanceof ApiError&&error.status===429?'文档引擎正在处理另一个文件，请稍后重试。'
    :error instanceof ApiError&&error.message==='ACTIVITY_TOOL_RESULT_FILE_UNSUPPORTED'?'文件超过100 MiB结构化来源范围。'
    :artifactPreviewErrorMessage(error);
   setState({identity,error:message});
  });
  return()=>controller.abort();
 },[identity,revision,expectedOpenSha,expectedOpenProof]);
 const current=state?.identity===identity?state:undefined,page=current?.page;
 return <section aria-label="原生Office结构化内容">
  <h5>Office结构化内容</h5>
  <p>最多读取100 MiB原生成员来源。文字和单元格沿原解析范围显示。</p>
  {(!current||!page&&!current.error)&&<p role="status">正在核对打开来源并解析Office…</p>}
  {page&&<>
   <p>{page.size_bytes} 字节 · SHA-256 <code>{page.sha256}</code></p>
   <a href={nativeMemberDownloadUrl(source)+'&open_sha256='+page.open_sha256+(page.open_proof?'&open_proof='+page.open_proof:'')} download={source.member.path.split(/[\\/]/).at(-1)||'file'} onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载此结构化来源</a>
   {page.document.truncated&&<p role="status">当前解析结果存在截断，请对照完整打开文件。</p>}
   <section className="jot-office-content" data-chat-search-content={JSON.stringify(['native-office',identity,page.open_sha256])}><OfficeContent key={page.open_sha256} value={page.document}/></section>
  </>}
  {current?.error&&<p role="alert">{current.error}</p>}
  <button type="button" onClick={()=>setRevision(value=>value+1)}>重新解析同次打开来源</button>
 </section>;
}
