import React,{useEffect,useRef,useState} from 'react';
import {base,taskDraftScope} from './client';
import {artifactPreviewErrorMessage,readVerifiedPreviewBytes} from './artifact-preview-bytes.mjs';
import ActivityToolFileBytes from './ActivityToolFileBytes';

const imageTypes:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',ico:'image/vnd.microsoft.icon',tiff:'image/tiff',tif:'image/tiff',avif:'image/avif'};
export function listedFileImageType(path:string){
 const extension=path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase()??'';
 return Object.hasOwn(imageTypes,extension)?imageTypes[extension]:undefined;
}

export default function ActivityToolFileImage({conversationId,runId,activityId,resultSha,file}:React.ComponentProps<typeof ActivityToolFileBytes>){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file]),type=listedFileImageType(file.path);
 const region=useRef<HTMLElement>(null);
 const [state,setState]=useState<{identity:string;url?:string;error?:string}>(),[revision,setRevision]=useState(0);
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();let url='';setState({identity});
  const check=()=>{controller.signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
  const load=async()=>{
   if(!type)throw Error('此文件的图片格式尚未确认');
   // shortcut: preview uses the existing 20 MiB in-memory byte verifier, add larger retained image viewing later.
   if(file.size>20*1024*1024)throw Error('图片超过20 MiB预览范围，可下载固定版本查看。');
   const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,size_bytes:String(file.size)});
   const response=await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/download?${params}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
   check();
   if(!response.ok||!response.body||response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'
    ||response.headers.get('x-activity-file-sha256')!==file.sha256||response.headers.get('x-activity-file-size')!==String(file.size)
    ||response.headers.get('x-activity-file-version')!==String(file.version)||response.headers.get('x-activity-tool-result-sha256')!==resultSha){
    await response.body?.cancel();throw Error('原列表图片的固定版本未能核对');
   }
   const bytes=await readVerifiedPreviewBytes(response,{size_bytes:file.size,sha256:file.sha256},controller.signal);check();
   url=URL.createObjectURL(new Blob([bytes],{type}));setState({identity,url});
  };
  void load().catch(error=>{if(!controller.signal.aborted&&taskDraftScope()===owner)setState({identity,error:artifactPreviewErrorMessage(error)});});
  return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined;
 return <section ref={region} tabIndex={-1} className="jot-activity-content" aria-label="原列表固定图片版本">
  <h4>{file.path} · 版本 {file.version}</h4>
  <ActivityToolFileBytes key={identity} conversationId={conversationId} runId={runId} activityId={activityId} resultSha={resultSha} file={file}/>
  {(!current||!current.url&&!current.error)&&<p role="status">正在核对原图片完整内容…</p>}
  {current?.url&&<figure data-chat-search-ignore><img src={current.url} alt={file.path} style={{maxWidth:'100%',height:'auto'}} onError={()=>{URL.revokeObjectURL(current.url!);setState({identity,error:'浏览器无法显示此图片格式，可下载固定版本查看。'});}}/><figcaption>固定版本 {file.version} · {file.size} 字节</figcaption></figure>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试图片</button></p>}
 </section>;
}
