import type {OfficePrintFocus} from './pdf-file-view-state';
import React,{lazy,Suspense,useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {readOfficePrintPreviewBytes,type ListedFilePreviewSource,type OfficePrintPreview} from './activity-file-preview-client';
const PdfViewer=lazy(()=>import('./ActivityToolFilePdf'));

export default function OfficeFilePrintPreview(source:ListedFilePreviewSource&{focus?:OfficePrintFocus}){
 const owner=taskDraftScope(),[revision,setRevision]=useState(0);
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,source.focus?.key,source.focus?.view.sha256,source.focus?.view.size,source.focus?.view.pageCount,revision]);
 const [state,setState]=useState<{identity:string;preview?:OfficePrintPreview;confirmed?:boolean;error?:string}>();
 const cancel=useRef<()=>void>(()=>{});
 useEffect(()=>{
  const controller=new AbortController();let live=true;
  setState({identity});
  const stop=(message:string)=>{controller.abort();if(live&&taskDraftScope()===owner)setState({identity,error:message});};
  cancel.current=()=>stop('转换预览读取已取消。');
  const timer=window.setTimeout(()=>stop('转换PDF读取超时，请稍后重试。'),60000);
  void readOfficePrintPreviewBytes(source,owner,controller.signal).then(preview=>{
   if(live&&!controller.signal.aborted&&taskDraftScope()===owner)setState({identity,preview,confirmed:!source.focus||source.focus.view.sha256===preview.sha256&&source.focus.view.size===preview.size&&source.focus.view.pageCount===preview.pageCount});
  }).catch(error=>{
   if(live&&!controller.signal.aborted&&taskDraftScope()===owner)setState({identity,error:error instanceof Error?error.message:'转换PDF读取失败。'});
  }).finally(()=>window.clearTimeout(timer));
  return()=>{live=false;controller.abort();window.clearTimeout(timer);cancel.current=()=>{};};
 },[identity,owner]);
 const current=state?.identity===identity?state:undefined;
 const retry=()=>{if(taskDraftScope()===owner)setRevision(value=>value+1);};
 return <section aria-label="固定Office来源的转换PDF">
  <button type="button" onClick={retry} disabled={!current?.preview&&!current?.error}>重新转换固定版本</button>
  {(!current||!current.preview&&!current.error)&&<p role="status">正在核对固定来源并转换PDF… <button type="button" onClick={()=>cancel.current()}>取消转换读取</button></p>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={retry}>重试转换</button></p>}
  {current?.preview&&source.focus&&<p role="status">{current.confirmed?'已核对原转换PDF摘要，可定位原引用页。':'本次转换PDF摘要与原引用不同，请对照保留的原引用快照。'}</p>}
  {current?.preview&&<Suspense fallback={<p role="status">正在载入转换PDF查看器…</p>}>
   <PdfViewer key={identity+current.preview.sha256} {...source} officePrint={{...current.preview,onRetry:retry,...(current.confirmed?{focus:source.focus}:{})}}/>
  </Suspense>}
 </section>;
}
