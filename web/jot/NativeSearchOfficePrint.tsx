import type {PdfReferenceFocus} from './pdf-file-view-state';
import {nativeMemberViewingSource,nativeMemberDownloadUrl} from './activity-file-preview-client';
import React,{lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ApiError,taskDraftScope} from './client';
import {artifactPreviewErrorMessage} from './artifact-preview-bytes.mjs';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import {readNativeOfficePdf,type NativeOfficePrintPin,type NativeOfficePrintPreview} from './native-office-print-client';
import type {NativeMemberPreviewSource} from './activity-file-preview-client';
const PdfViewer=lazy(()=>import('./NativeSearchFilePdf'));

export default function NativeSearchOfficePrint({source,expectedOpenSha,expectedOpenProof,expectedPreview,focus,onOpened}:{source:NativeMemberPreviewSource;expectedOpenSha?:string|undefined;expectedOpenProof?:string|undefined;expectedPreview?:NativeOfficePrintPin|undefined;focus?:PdfReferenceFocus|undefined;onOpened?:(sha:string,proof?:string)=>boolean}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,source,expectedPreview]);
 const pin=useRef<{identity:string;value:NativeOfficePrintPin;revision:number}>(),active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{identity:string;preview?:NativeOfficePrintPreview;error?:string}>(),[revision,setRevision]=useState(0);
 const [download,setDownload]=useState<{preview:NativeOfficePrintPreview;url:string}>();
 useEffect(()=>{
  if(expectedOpenSha&&pin.current?.identity===identity&&pin.current.value.openSha===expectedOpenSha&&pin.current.value.openProof===expectedOpenProof&&pin.current.revision===revision&&state?.identity===identity&&state.preview)return;
  const controller=new AbortController();active.current=controller;setState({identity});
  const timer=window.setTimeout(()=>{controller.abort();if(taskDraftScope()===owner)setState({identity,error:'转换PDF读取超时，请稍后重试。'});},180000);
  const load=async()=>{
   const expected=pin.current?.identity===identity?pin.current.value:expectedPreview;
   const preview=await readNativeOfficePdf(source,owner,controller.signal,expectedOpenSha,expected,expectedOpenProof);
   controller.signal.throwIfAborted();
   if(taskDraftScope()!==owner||onOpened&&!onOpened(preview.openSha,preview.openProof))throw Error('原打开来源已变化，请重新打开文件');
   const value={openSha:preview.openSha,sourceSha:preview.sourceSha,sourceSize:preview.sourceSize,sha256:preview.sha256,size:preview.size,pageCount:preview.pageCount,...(preview.openProof?{openProof:preview.openProof}:{}),...(preview.pdfProof?{pdfProof:preview.pdfProof}:{})};pin.current={identity,value,revision};
   setState({identity,preview});
  };
  void load().catch(error=>{
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   const message=error instanceof ApiError&&error.message==='NATIVE_FILE_RETAINED_INVALID'?artifactPreviewErrorMessage(error)
    :error instanceof ApiError&&error.status===409?'原打开来源已变化，请重新打开文件。'
    :error instanceof ApiError&&error.status===429?'文档转换器正在处理另一个文件，请稍后重试。':artifactPreviewErrorMessage(error);
   setState({identity,error:message});
  }).finally(()=>window.clearTimeout(timer));
  return()=>{controller.abort();window.clearTimeout(timer);if(active.current===controller)active.current=null;};
 },[identity,revision,expectedOpenSha,expectedOpenProof]);
 const current=state?.identity===identity?state:undefined,preview=current?.preview;
 useEffect(()=>{
  if(!preview){setDownload(undefined);return;}
  const url=URL.createObjectURL(new Blob([preview.bytes.slice()],{type:'application/octet-stream'}));
  setDownload({preview,url});
  return()=>URL.revokeObjectURL(url);
 },[preview]);
 return <section aria-label="原生Office转换PDF预览">
  <h5>Office转换PDF</h5>
  <p>源文件上限100 MiB，转换PDF上限20 MiB。转换沿原配置服务和原打开来源核对。</p>
  {(!current||!preview&&!current.error)&&<p role="status">正在读取打开来源并转换PDF… <button type="button" onClick={()=>{active.current?.abort();setState({identity,error:'本次转换读取已取消。'});}}>取消转换读取</button></p>}
  {preview&&<>
   {preview.retained!==undefined&&<p role="status">{preview.retained?'已留存原文件打开内容，可按原版本重新打开。':'原文件打开内容未留存，需要的内容可下载保存。'}</p>}
   <a href={nativeMemberDownloadUrl(source)+'&open_sha256='+preview.openSha+(preview.openProof?'&open_proof='+preview.openProof:'')} download={source.member.path.split(/[\\/]/).at(-1)||'file'} onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载此转换所用原文件</a>
   <p>原文件 {preview.sourceSize} 字节 · 源SHA-256 <code>{preview.sourceSha}</code></p>
   <p>PDF {preview.size} 字节 · {preview.pageCount} 页 · SHA-256 <code>{preview.sha256}</code></p>
   {download?.preview===preview&&<a href={download.url} download="office-preview.pdf" onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载此转换PDF</a>}
   <ConversationDisplayBoundary key={preview.sha256} label="原生Office转换PDF"><Suspense fallback={<p role="status">正在载入PDF查看器…</p>}><PdfViewer bytes={preview.bytes} expectedPageCount={preview.pageCount} source={nativeMemberViewingSource(source,{openSha:preview.openSha,sha256:preview.sourceSha,size:preview.sourceSize,proof:preview.openProof})} printView={{protocol:1,sha256:preview.sha256,size:preview.size,pageCount:preview.pageCount,...(preview.pdfProof?{proof:preview.pdfProof}:{})}} focus={focus} onRetry={()=>setRevision(value=>value+1)}/></Suspense></ConversationDisplayBoundary>
  </>}
  {current?.error&&<p role="alert">{current.error}</p>}
  <button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取此转换预览</button>
 </section>;
}
