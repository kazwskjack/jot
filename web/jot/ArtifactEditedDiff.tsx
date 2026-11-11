import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import type {Artifact,ArtifactDocumentTextSource,ArtifactEditedDiff as EditedDiff,ArtifactEditedDiffMatch} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/;
export const validEditedDiffSource=(value:ArtifactDocumentTextSource|undefined)=>value&&typeof value.document_job_id==='string'&&id.test(value.document_job_id)
 &&typeof value.document_result_sha256==='string'&&sha.test(value.document_result_sha256)&&typeof value.text_sha256==='string'&&sha.test(value.text_sha256)
 &&(value.document_operation===undefined?value.document_read_revision===undefined:value.document_operation==='document.read'&&(value.document_read_revision===undefined||value.document_read_revision===1))
 &&Number.isSafeInteger(value.text_total_chars)&&value.text_total_chars>=0&&value.text_total_chars<=(value.document_operation==='document.read'?8388608:200000)&&typeof value.source_truncated==='boolean';

type Props={conversationId:string;file:Pick<Artifact,'artifact_id'|'version'|'sha256'|'file_name'>;runId?:string;expected?:ArtifactEditedDiffMatch;match?:{offset:number;text:string};startOffset?:number};
type Cursor={identity:string;offset:number;previous:number[];page?:EditedDiff};

export default function ArtifactEditedDiff({conversationId,file,runId,expected,match,startOffset=0}:Props){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,file.artifact_id,file.version,file.sha256,runId,expected,match,startOffset]);
 const paged=expected===undefined||expected.diff_protocol===2;
 const [cursor,setCursor]=useState<Cursor>({identity,offset:startOffset,previous:[]});
 const currentCursor:Cursor=cursor.identity===identity?cursor:{identity,offset:startOffset,previous:[]};
 const offset=paged?currentCursor.offset:0,pinned=currentCursor.page??expected;
 const region=useRef<HTMLElement>(null),[revision,setRevision]=useState(0);
 const [state,setState]=useState<{identity:string;offset:number;diff?:EditedDiff;error?:string}>();
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;setState({identity,offset});
  const load=async()=>{
   const params=new URLSearchParams({conversation_id:conversationId,version:String(file.version),sha256:file.sha256,...(runId?{run_id:runId}:{}),
    ...(paged?{diff_protocol:'2',offset_chars:String(offset)}:{}),...(pinned?{edit_job_id:pinned.edit_job_id,edit_result_sha256:pinned.edit_result_sha256,diff_sha256:pinned.diff_sha256,
     before_document_job_id:pinned.before.document_job_id,before_document_result_sha256:pinned.before.document_result_sha256,
     after_document_job_id:pinned.after.document_job_id,after_document_result_sha256:pinned.after.document_result_sha256}:{})});
   const diff=await request<EditedDiff>(`/artifacts/${encodeURIComponent(file.artifact_id)}/edited-diff?${params}`,'GET',undefined,undefined,signal,120000);
   if(taskDraftScope()!==owner||!diff||diff.artifact_id!==file.artifact_id||diff.conversation_id!==conversationId||diff.run_id!==runId||diff.to_version!==file.version
    ||diff.after_sha256!==file.sha256||diff.execution_authorized!==false||!Number.isSafeInteger(diff.from_version)||diff.from_version<1||diff.from_version>=diff.to_version
    ||typeof diff.before_sha256!=='string'||!sha.test(diff.before_sha256)||typeof diff.edit_job_id!=='string'||!id.test(diff.edit_job_id)
    ||typeof diff.edit_result_sha256!=='string'||!sha.test(diff.edit_result_sha256)||!validEditedDiffSource(diff.before)||!validEditedDiffSource(diff.after)
    ||typeof diff.unified_diff!=='string'||diff.unified_diff.length>(paged?16384:200000)||typeof diff.diff_sha256!=='string'||!sha.test(diff.diff_sha256)||typeof diff.truncated!=='boolean')throw Error('原编辑差异来源尚未确认');
   if(paged&&(diff.diff_protocol!==2||diff.offset_chars!==offset||!Number.isSafeInteger(diff.total_chars)||Number(diff.total_chars)<offset||Number(diff.total_chars)>33554688
    ||offset+diff.unified_diff.length>Number(diff.total_chars)||diff.truncated!==false||typeof diff.page_sha256!=='string'||!sha.test(diff.page_sha256)
    ||(diff.next_offset_chars===undefined?offset+diff.unified_diff.length!==diff.total_chars
     :!diff.unified_diff.length||diff.next_offset_chars!==offset+diff.unified_diff.length||diff.next_offset_chars>=Number(diff.total_chars))))throw Error('原编辑差异分页尚未确认');
   if(pinned){
    for(const key of ['artifact_id','conversation_id','run_id','from_version','to_version','before_sha256','after_sha256','edit_job_id','edit_result_sha256','diff_sha256','truncated','execution_authorized','diff_protocol'] as const){
     if(diff[key]!==pinned[key])throw Error('原编辑差异来源已变化，请刷新搜索或版本目录。');
    }
    for(const side of ['before','after'] as const)for(const key of ['document_job_id','document_result_sha256','text_sha256','text_total_chars','source_truncated','document_operation','document_read_revision'] as const){
     if(diff[side][key]!==pinned[side][key])throw Error('原文档文本来源已变化，请刷新搜索或版本目录。');
    }
   }
   if(expected&&(paged?diff.total_chars:diff.unified_diff.length)!==expected.text_total_chars)throw Error('原编辑差异正文长度尚未确认');
   if(match&&offset===(paged?startOffset:0)&&(!Number.isSafeInteger(match.offset)||match.offset<offset||diff.unified_diff.slice(match.offset-offset,match.offset-offset+match.text.length)!==match.text))throw Error('原编辑差异命中位置尚未确认');
   const original=await request<Artifact>(`/artifacts/${encodeURIComponent(file.artifact_id)}?version=${diff.from_version}`,'GET',undefined,undefined,signal);
   if(original?.artifact_id!==file.artifact_id||original.conversation_id!==conversationId||original.version!==diff.from_version||original.sha256!==diff.before_sha256)throw Error('原编辑基准版本尚未确认');
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(diff.unified_diff))),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(digest!==(paged?diff.page_sha256:diff.diff_sha256))throw Error('原编辑差异正文摘要尚未确认');
   if(!signal.aborted&&taskDraftScope()===owner)setState({identity,offset,diff});
  };
  void load().catch(error=>{
   if(signal.aborted)return;
   const message=error instanceof ApiError&&error.status===422?'该版本暂无完整可确认的原编辑作业及前后文档文本。'
    :error instanceof ApiError&&error.status===409?'原编辑来源已变化，请刷新搜索或版本目录。':error instanceof Error?error.message:'原编辑差异读取失败';
   setState({identity,offset,error:message});
  });
  return()=>controller.abort();
 },[identity,offset,pinned,revision]);
 useEffect(()=>{if(state?.identity===identity&&state.offset===offset&&state.diff&&match)region.current?.querySelector('mark')?.scrollIntoView({block:'nearest'});},[state,identity,offset]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,diff=current?.diff;
 const at=match?match.offset-offset:-1,marked=diff&&match&&at>=0&&diff.unified_diff.slice(at,at+match.text.length)===match.text;
 return <section lang={language} ref={region} tabIndex={-1} className="jot-activity-content" aria-label={t('原文档编辑差异','Original Document Edit Diff')}>
  <h4>{file.file_name} · {t('原编辑差异','Original Edit Diff')}</h4>
  {(!current||!diff&&!current.error)&&<p role="status">{t('正在核对原编辑及前后文档文本…','Verifying the original edit and before/after document text…')}</p>}
  {diff&&<>
   <p>{t('版本','Version')} {diff.from_version} → {diff.to_version} · {t('已保存原文档文本','Saved Original Document Text')}</p>
   <section data-chat-search-content={JSON.stringify(['edited-document-diff',identity,diff.edit_result_sha256,diff.diff_sha256,offset])}><pre>{marked&&match?<>{diff.unified_diff.slice(0,at)}<mark>{match.text}</mark>{diff.unified_diff.slice(at+match.text.length)}</>:diff.unified_diff}</pre></section>
   {(diff.before.source_truncated||diff.after.source_truncated)&&<p role="status">{t('原文档文本存在覆盖缺口或截断，差异覆盖已保存的文本。','The original document text has coverage gaps or truncation. This diff covers the saved text.')}</p>}
   {diff.truncated&&<p role="status">{t('差异已显示前200000个字符。','The first 200000 characters of the diff are shown.')}</p>}
   {paged&&<nav aria-label={t('原编辑差异正文翻页','Original Edit Diff Body Pages')} data-chat-search-ignore>
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>setCursor({identity,offset:currentCursor.previous.at(-1)!,previous:currentCursor.previous.slice(0,-1),page:diff})}>{t('上一页差异','Previous Diff Page')}</button>
    <span>{Math.min(offset+1,Number(diff.total_chars))}–{offset+diff.unified_diff.length} / {diff.total_chars}{t('（UTF-16 位置）',' (UTF-16 positions)')}</span>
    <button type="button" disabled={diff.next_offset_chars===undefined} onClick={()=>{if(diff.next_offset_chars!==undefined)setCursor({identity,offset:diff.next_offset_chars,previous:[...currentCursor.previous,offset],page:diff});}}>{t('下一页差异','Next Diff Page')}</button>
    {offset>0&&<button type="button" onClick={()=>setCursor({identity,offset:0,previous:[],page:diff})}>{t('从差异开头阅读','Read from the Beginning of the Diff')}</button>}
   </nav>}
  </>}
  {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重试读取','Retry Reading')}</button></p>}
 </section>;
}
