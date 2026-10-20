import React,{useEffect,useRef,useState} from 'react';
import {base} from './client';
import {reviewOutputPage,reviewOutputPath,reviewOutputPreview,reviewOutputBytes,reviewPreviewKind} from './review-output-client';
import type {TaskReviewOutput,TaskWorkReview} from './types';
import TaskWorkReviewView from './TaskWorkReview';

export default function TaskReviewFiles({id,version,disabled,onRefresh}:{id:string;version:number;disabled:boolean;onRefresh:()=>Promise<void>}){
 const [requestedFor,setRequestedFor]=useState(''),identity=id+':'+version,opened=requestedFor===identity;
 const [files,setFiles]=useState<TaskReviewOutput[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<{name:string;text?:string;url?:string}>();
 const [work,setWork]=useState<TaskWorkReview>();
 const active=useRef<AbortController|null>(null),url=useRef(''),locked=useRef(false),downloads=useRef(new Set<string>());
 const clear=()=>{active.current?.abort();active.current=null;locked.current=false;if(url.current)URL.revokeObjectURL(url.current);url.current='';setPreview(undefined);};
 useEffect(()=>{
  clear();setFiles([]);setWork(undefined);setError('');setBusy(false);if(disabled||!opened){setLoading(false);return;}
  const controller=new AbortController();setLoading(true);
  void reviewOutputPage(id,controller.signal).then(page=>{if(!controller.signal.aborted){setFiles(page.items);setWork(page.work_review);}}).catch(error=>{if(!controller.signal.aborted)setError([403,404,409,410].includes(error?.status)?'验收状态已变化，请刷新卡片。':'暂时无法读取冻结文件，请重试。');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>{controller.abort();active.current?.abort();locked.current=false;if(url.current)URL.revokeObjectURL(url.current);url.current='';for(const item of downloads.current)URL.revokeObjectURL(item);downloads.current.clear();};
 },[id,version,disabled,opened]);
 const show=async(file:TaskReviewOutput,download=false)=>{
  if(disabled||locked.current)return;
  clear();locked.current=true;const controller=new AbortController();active.current=controller;setBusy(true);setError('');
  try{if(download){const bytes=await reviewOutputBytes(id,file,controller.signal);if(controller.signal.aborted)return;
    const href=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));downloads.current.add(href);const link=document.createElement('a');link.href=href;link.download=file.file_name.split(/[\\/]/).at(-1)||'review-output';link.click();setTimeout(()=>{URL.revokeObjectURL(href);downloads.current.delete(href);},1000);
   }else{const value=await reviewOutputPreview(id,file,controller.signal);if(controller.signal.aborted)return;
    if(value.kind==='text')setPreview({name:file.file_name,text:value.text});
    else{url.current=URL.createObjectURL(new Blob([value.bytes!],{type:value.mime}));setPreview({name:file.file_name,url:url.current});}}
  }catch(error){if(!controller.signal.aborted){setFiles([]);setWork(undefined);setError([403,404,409,410].includes((error as any)?.status)?'验收状态已变化，请刷新卡片。':'文件内容未能核验，请刷新后重试。');}}
  finally{if(active.current===controller){active.current=null;locked.current=false;if(!controller.signal.aborted)setBusy(false);}}
 };
 if(disabled)return null;
 if(!opened)return <button type="button" onClick={()=>setRequestedFor(identity)}>查看待验收文件</button>;
 if(!loading&&!files.length&&!work&&!error)return null;
 return <section className="jot-review-files"><h4>核对冻结文件</h4>{loading&&<p role="status">正在读取文件清单</p>}
 {work&&<TaskWorkReviewView key={identity+':'+work.inspection_sha256} value={work}/>}
 {files.map(file=><div key={file.output_index} className="jot-review-file"><strong>{file.file_name}</strong><small>固定版本 {file.version} · {file.size_bytes} 字节</small><code title="SHA-256">{file.sha256}</code>
 {reviewPreviewKind(file)!=='download'&&<button type="button" disabled={disabled||busy} onClick={()=>void show(file)}>查看文件</button>}
 <a href={base+'/v1'+reviewOutputPath(id,file.output_index)} download rel="noreferrer" aria-disabled={disabled||busy} onClick={event=>{if(file.size_bytes<=20*1024*1024){event.preventDefault();void show(file,true);}else if(disabled||busy)event.preventDefault();}}>下载核对</a>
 </div>)}
 {preview&&<div className="jot-review-preview"><strong>{preview.name}</strong><button type="button" onClick={clear}>关闭预览</button>{preview.text!==undefined?<pre>{preview.text}</pre>:<img src={preview.url} alt={preview.name}/>}</div>}
 {error&&<p role="alert">{error} <button type="button" disabled={disabled} onClick={()=>void onRefresh()}>刷新验收卡</button></p>}
 </section>;
}
