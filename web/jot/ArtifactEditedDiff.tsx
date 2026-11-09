import React,{useEffect,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import type {Artifact,ArtifactDocumentText,ArtifactEditedDiff as EditedDiff,ArtifactEditedDiffMatch} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/;
export const validEditedDiffSource=(value:Required<ArtifactDocumentText>|undefined)=>value&&typeof value.document_job_id==='string'&&id.test(value.document_job_id)
 &&typeof value.document_result_sha256==='string'&&sha.test(value.document_result_sha256)&&typeof value.text_sha256==='string'&&sha.test(value.text_sha256)
 &&Number.isSafeInteger(value.text_total_chars)&&value.text_total_chars>=0&&value.text_total_chars<=200000&&typeof value.source_truncated==='boolean';

export default function ArtifactEditedDiff({conversationId,file,runId,expected,match}:{conversationId:string;file:Pick<Artifact,'artifact_id'|'version'|'sha256'|'file_name'>;runId?:string;expected?:ArtifactEditedDiffMatch;match?:{offset:number;text:string}}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,file.artifact_id,file.version,file.sha256,runId,expected,match]);
 const region=useRef<HTMLElement>(null),[revision,setRevision]=useState(0);
 const [state,setState]=useState<{identity:string;diff?:EditedDiff;error?:string}>();
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;setState({identity});
  const load=async()=>{
   const params=new URLSearchParams({conversation_id:conversationId,version:String(file.version),sha256:file.sha256,...(runId?{run_id:runId}:{}),...(expected?{edit_job_id:expected.edit_job_id,edit_result_sha256:expected.edit_result_sha256,diff_sha256:expected.diff_sha256,
    before_document_job_id:expected.before.document_job_id,before_document_result_sha256:expected.before.document_result_sha256,
    after_document_job_id:expected.after.document_job_id,after_document_result_sha256:expected.after.document_result_sha256}:{})});
   const diff=await request<EditedDiff>(`/artifacts/${encodeURIComponent(file.artifact_id)}/edited-diff?${params}`,'GET',undefined,undefined,signal);
   if(taskDraftScope()!==owner||!diff||diff.artifact_id!==file.artifact_id||diff.conversation_id!==conversationId||diff.run_id!==runId||diff.to_version!==file.version
    ||diff.after_sha256!==file.sha256||diff.execution_authorized!==false||!Number.isSafeInteger(diff.from_version)||diff.from_version<1||diff.from_version>=diff.to_version
    ||typeof diff.before_sha256!=='string'||!sha.test(diff.before_sha256)||typeof diff.edit_job_id!=='string'||!id.test(diff.edit_job_id)
    ||typeof diff.edit_result_sha256!=='string'||!sha.test(diff.edit_result_sha256)||!validEditedDiffSource(diff.before)||!validEditedDiffSource(diff.after)
    ||typeof diff.unified_diff!=='string'||diff.unified_diff.length>200000||typeof diff.diff_sha256!=='string'||!sha.test(diff.diff_sha256)||typeof diff.truncated!=='boolean')throw Error('原编辑差异来源尚未确认');
   if(expected){
    for(const key of ['artifact_id','conversation_id','run_id','from_version','to_version','before_sha256','after_sha256','edit_job_id','edit_result_sha256','diff_sha256','truncated','execution_authorized'] as const){
     if(diff[key]!==expected[key])throw Error('原编辑差异搜索来源已变化，请刷新搜索。');
    }
    for(const side of ['before','after'] as const)for(const key of ['document_job_id','document_result_sha256','text_sha256','text_total_chars','source_truncated'] as const){
     if(diff[side][key]!==expected[side][key])throw Error('原文档预览搜索来源已变化，请刷新搜索。');
    }
    if(diff.unified_diff.length!==expected.text_total_chars)throw Error('原编辑差异正文长度尚未确认');
   }
   if(match&&(!Number.isSafeInteger(match.offset)||match.offset<0||diff.unified_diff.slice(match.offset,match.offset+match.text.length)!==match.text))throw Error('原编辑差异命中位置尚未确认');
   const original=await request<Artifact>(`/artifacts/${encodeURIComponent(file.artifact_id)}?version=${diff.from_version}`,'GET',undefined,undefined,signal);
   if(original?.artifact_id!==file.artifact_id||original.conversation_id!==conversationId||original.version!==diff.from_version||original.sha256!==diff.before_sha256)throw Error('原编辑基准版本尚未确认');
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(diff.unified_diff))),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(digest!==diff.diff_sha256)throw Error('原编辑差异正文摘要尚未确认');
   if(!signal.aborted&&taskDraftScope()===owner)setState({identity,diff});
  };
  void load().catch(error=>{
   if(signal.aborted)return;
   const message=error instanceof ApiError&&error.status===422?'该版本暂无完整可确认的原编辑作业及前后文档预览。'
    :error instanceof ApiError&&error.status===409?'原编辑来源已变化，请刷新版本目录。':error instanceof Error?error.message:'原编辑差异读取失败';
   setState({identity,error:message});
  });
  return()=>controller.abort();
 },[identity,revision]);
 useEffect(()=>{if(state?.identity===identity&&state.diff&&match)region.current?.querySelector('mark')?.scrollIntoView({block:'nearest'});},[state,identity]);
 const current=state?.identity===identity?state:undefined,diff=current?.diff;
 return <section ref={region} tabIndex={-1} className="jot-activity-content" aria-label="原文档编辑差异">
  <h4>{file.file_name} · 原编辑差异</h4>
  {(!current||!diff&&!current.error)&&<p role="status">正在核对原编辑及前后文档预览…</p>}
  {diff&&<>
   <p>版本 {diff.from_version} → {diff.to_version} · 已保存文档预览</p>
   <section data-chat-search-content={JSON.stringify(['edited-document-diff',identity,diff.edit_result_sha256,diff.diff_sha256])}><pre>{match?<>{diff.unified_diff.slice(0,match.offset)}<mark>{match.text}</mark>{diff.unified_diff.slice(match.offset+match.text.length)}</>:diff.unified_diff}</pre></section>
   {(diff.before.source_truncated||diff.after.source_truncated)&&<p role="status">有版本的留存预览已截断，差异覆盖已保存的文本。</p>}
   {diff.truncated&&<p role="status">差异已显示前200000个字符。</p>}
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取</button></p>}
 </section>;
}
