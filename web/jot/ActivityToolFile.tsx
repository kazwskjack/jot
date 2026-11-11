import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import type {OfficeCellFocus,OfficeTextFocus,OfficeRegionFocus} from './FileTextReferences';
import {officePreviewFormat} from '../../packages/gateway/src/artifacts/document-preview-content';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import ActivityToolFileImage,{listedFileImageType} from './ActivityToolFileImage';
import ActivityToolFileBytes from './ActivityToolFileBytes';
import React,{useEffect,useRef,useState,lazy,Suspense} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import type {ActivityToolFilePage} from './types';

import type {ListedFilePreviewSource} from './activity-file-preview-client';
import type {PdfReferenceFocus,OfficePrintFocus} from './pdf-file-view-state';

const ActivityToolFilePdf=lazy(()=>import('./ActivityToolFilePdf'));
const ActivityToolFileOffice=lazy(()=>import('./ActivityToolFileOffice'));
const sha=/^[a-f0-9]{64}$/;
function ActivityToolFileText({conversationId,runId,activityId,resultSha,file}:ListedFilePreviewSource){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file]);
 const region=useRef<HTMLElement>(null);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[];textSha?:string}>({identity,offset:0,previous:[]});
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,offset:0,previous:[]};
 const {offset,textSha}=currentCursor;
 const [state,setState]=useState<{identity:string;offset:number;page?:ActivityToolFilePage;error?:string}>(),[revision,setRevision]=useState(0);
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();setState({identity,offset});
  const load=async()=>{
   const params=new URLSearchParams({text_protocol:'2',run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,offset_chars:String(offset),...(textSha?{text_sha256:textSha}:{})});
   const page=await request<ActivityToolFilePage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file?${params}`,'GET',undefined,undefined,controller.signal);
   if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==runId||page.activity_id!==activityId||page.result_sha256!==resultSha
    ||page.path!==file.path||page.version!==file.version||page.sha256!==file.sha256||page.size!==file.size||!['workspace','isolated'].includes(page.source)||page.execution_authorized!==false
    ||typeof page.text_sha256!=='string'||!sha.test(page.text_sha256)||page.text_sha256!==file.sha256||textSha!==undefined&&page.text_sha256!==textSha
    ||page.text_protocol!==2||page.offset_chars!==offset||!Number.isSafeInteger(page.total_chars)||page.total_chars<offset||page.total_chars>file.size
    ||typeof page.text!=='string'||page.text.length>16384||offset+page.text.length>page.total_chars
    ||(page.next_offset_chars===undefined?offset+page.text.length!==page.total_chars:!page.text.length||page.next_offset_chars!==offset+page.text.length||page.next_offset_chars>=page.total_chars))throw Error('原列表文件版本或正文分页尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{
   if(controller.signal.aborted)return;
   const message=error instanceof ApiError&&error.status===404?(file.version===0?'该原快照版本的已固定源文件暂不可用。':'此固定版本的原文件内容暂不可用。')
    :error instanceof ApiError&&error.status===422?'此固定版本包含无法按 UTF-8 解码的内容，暂不支持文本预览。'
    :error instanceof ApiError&&error.status===409?'原列表或文件来源已变化，请重新打开原列表。':error instanceof Error?error.message:'原文件读取失败';
   setState({identity,offset,error:message});
  });
  return()=>controller.abort();
 },[identity,offset,textSha,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 return <section lang={language} ref={region} tabIndex={-1} className="jot-activity-content" aria-label={t('原列表固定文件版本','Original List Pinned File Version')}>
  <h4>{file.path} · {t('版本','Version')} {file.version}</h4>
  <ActivityToolFileBytes key={identity} conversationId={conversationId} runId={runId} activityId={activityId} resultSha={resultSha} file={file}/>
  {(!current||!page&&!current.error)&&<p role="status">{t('正在读取并核对原文件版本…','Reading and verifying the original file version…')}</p>}
  {page&&<>
   <section data-chat-search-content={JSON.stringify(['listed-file',identity,page.text_sha256,offset])}><pre>{page.text}</pre></section>
   <nav aria-label={t('原列表文件正文翻页','Original List File Body Pages')} data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>setCursor({identity,offset:currentCursor.previous.at(-1)!,previous:currentCursor.previous.slice(0,-1),textSha:page.text_sha256})}>{t('上一页正文','Previous Body Page')}</button>
    <span>{Math.min(offset+1,page.total_chars)}–{offset+page.text.length} / {page.total_chars}{t('（UTF-16 位置）',' (UTF-16 positions)')}</span>
    <button type="button" disabled={page.next_offset_chars===undefined} onClick={()=>{if(page.next_offset_chars!==undefined)setCursor({identity,offset:page.next_offset_chars,previous:[...currentCursor.previous,offset],textSha:page.text_sha256});}}>{t('下一页正文','Next Body Page')}</button>
   </nav>
  </>}
  {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重试读取','Retry Reading')}</button></p>}
 </section>;
}

export default function ActivityToolFile(props:ListedFilePreviewSource&{focus?:PdfReferenceFocus;printFocus?:OfficePrintFocus;officeFocus?:OfficeCellFocus;officeTextFocus?:OfficeTextFocus;officeRegionFocus?:OfficeRegionFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const identity=JSON.stringify([taskDraftScope(),props.conversationId,props.runId,props.activityId,props.resultSha,props.file,props.focus?.key,props.officeFocus?.key,props.officeTextFocus?.key,props.officeRegionFocus?.key,props.printFocus?.key]),[textView,setTextView]=useState<string>();
 const pdf=props.file.path.toLowerCase().endsWith('.pdf'),office=officePreviewFormat(props.file.path);
 if(office)return <ConversationDisplayBoundary key={identity} label={t('Office查看器','Office Viewer')}><Suspense fallback={<p lang={language} role="status">{t('正在载入Office查看器…','Loading Office viewer…')}</p>}><div lang="zh-CN"><ActivityToolFileOffice {...props}/></div></Suspense></ConversationDisplayBoundary>;
 if(!pdf&&!listedFileImageType(props.file.path))return <ActivityToolFileText {...props}/>;
 return <>
  <nav lang={language} aria-label={t("原列表文件查看方式","Original List File View Mode")} data-chat-search-ignore>
   <button type="button" disabled={textView!==identity} onClick={()=>setTextView(undefined)}>{pdf?t('查看PDF','View PDF'):t('查看图片','View Image')}</button>
   <button type="button" disabled={textView===identity} onClick={()=>setTextView(identity)}>{t('查看正文','View Body')}</button>
  </nav>
  {textView===identity?<ActivityToolFileText {...props}/>:pdf?<ConversationDisplayBoundary key={identity} label={t('PDF查看器','PDF Viewer')}><Suspense fallback={<p lang={language} role="status">{t('正在载入PDF查看器…','Loading PDF viewer…')}</p>}><div lang={language}><ActivityToolFilePdf {...props}/></div></Suspense></ConversationDisplayBoundary>:<ActivityToolFileImage {...props}/>}
 </>;
}
