import React,{useEffect,useRef,useState} from 'react';
import {base,request,taskDraftScope} from './client';
import type {ActivityToolFileBytes as BytePage} from './types';
import type {ListedFilePreviewSource} from './activity-file-preview-client';

type WritableFile={write:(bytes:Uint8Array)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
type FilePicker={showSaveFilePicker?:(options:{suggestedName:string})=>Promise<{createWritable:()=>Promise<WritableFile>}>};
export default function ActivityToolFileBytes({conversationId,runId,activityId,resultSha,file}:ListedFilePreviewSource){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file]);
 const [cursor,setCursor]=useState<{identity:string;offset:number}>(),[page,setPage]=useState<{identity:string;offset:number;hex:string;next?:number}>();
 const [revision,setRevision]=useState(0);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[received,setReceived]=useState(0);
 const download=useRef<AbortController|null>(null);
 const offset=cursor?.identity===identity?cursor.offset:undefined;
 const current=page?.identity===identity&&page.offset===offset?page:undefined;
 const read=async(offset:number,limit:number,signal:AbortSignal)=>{
  const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
  check();
  const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,offset_bytes:String(offset),limit_bytes:String(limit)});
  const value=await request<BytePage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/bytes?${params}`,'GET',undefined,undefined,signal);
  check();
  const length=Math.min(limit,file.size-offset);
  if(!value||value.conversation_id!==conversationId||value.run_id!==runId||value.activity_id!==activityId||value.result_sha256!==resultSha
   ||value.path!==file.path||value.version!==file.version||value.sha256!==file.sha256||value.size!==file.size||!['workspace','isolated'].includes(value.source)||value.execution_authorized!==false
   ||value.offset_bytes!==offset||value.length_bytes!==length||typeof value.content_base64!=='string'||value.content_base64.length!==4*Math.ceil(length/3)
   ||typeof value.chunk_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.chunk_sha256)
   ||value.next_offset_bytes!==(offset+length<file.size?offset+length:undefined))throw Error('原文件分段信息未能核对');
  const encoded=atob(value.content_base64),bytes=Uint8Array.from(encoded,character=>character.charCodeAt(0));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  check();
  if(bytes.length!==length||digest!==value.chunk_sha256)throw Error('原文件分段内容未能核对');
  return {bytes,next:value.next_offset_bytes};
 };
 useEffect(()=>{
  setError('');setBusy(false);setReceived(0);
  return()=>{download.current?.abort();download.current=null;};
 },[identity]);
 useEffect(()=>{
  if(offset===undefined)return;
  const controller=new AbortController();setError('');
  void read(offset,256,controller.signal).then(value=>{
   const lines=[];
   for(let index=0;index<value.bytes.length;index+=16){
    const row=value.bytes.subarray(index,index+16),hex=Array.from(row,byte=>byte.toString(16).padStart(2,'0')).join(' ');
    const text=Array.from(row,byte=>byte>=32&&byte<=126?String.fromCharCode(byte):'.').join('');
    lines.push((offset+index).toString(16).padStart(8,'0')+'  '+hex.padEnd(47,' ')+'  '+text);
   }
   if(!controller.signal.aborted)setPage({identity,offset,hex:lines.join('\n'),next:value.next});
  }).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'原文件字节读取失败');});
  return()=>controller.abort();
 },[identity,offset,revision]);
 const save=async()=>{
  if(download.current)return;
  const controller=new AbortController();download.current=controller;setBusy(true);setError('');setReceived(0);
  let writer:WritableFile|undefined;
  const check=()=>{controller.signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
  try{
   const name=file.path.split(/[\\/]/).at(-1)||'listed-file',picker=(globalThis as typeof globalThis & FilePicker).showSaveFilePicker;
   const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,size_bytes:String(file.size)});
   const path=`${base}/v1/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/download`;
   if(!picker){
    check();const link=document.createElement('a');link.href=path+'?'+params;link.download=name;link.click();return;
   }
   const handle=await picker.call(globalThis,{suggestedName:name});check();writer=await handle.createWritable();check();
   params.set('download_protocol','2');
   const response=await fetch(path+'?'+params,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
   check();
   if(!response.ok||!response.body||response.headers.get('content-type')?.split(';')[0]!=='application/x-ndjson'
    ||response.headers.get('x-activity-file-sha256')!==file.sha256||response.headers.get('x-activity-file-size')!==String(file.size)
    ||response.headers.get('x-activity-file-version')!==String(file.version)||response.headers.get('x-activity-tool-result-sha256')!==resultSha){
    await response.body?.cancel();throw Error('原文件下载来源未能核对');
   }
   const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',offset=0,complete=false;
   const accept=async(line:string)=>{
    if(complete||line.length>131072)throw Error('原文件下载分段无效');
    const value=JSON.parse(line);
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('原文件下载分段无效');
    if(value.complete===true){
     if(Object.keys(value).sort().join(',')!=='complete,sha256,size_bytes'||value.size_bytes!==file.size||value.sha256!==file.sha256||offset!==file.size)throw Error('原文件下载未完成核对');
     complete=true;return;
    }
    if(Object.keys(value).sort().join(',')!=='chunk_sha256,content_base64,offset_bytes'||value.offset_bytes!==offset
     ||typeof value.content_base64!=='string'||!value.content_base64.length||value.content_base64.length>87384
     ||typeof value.chunk_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.chunk_sha256))throw Error('原文件下载分段无效');
    const bytes=Uint8Array.from(atob(value.content_base64),character=>character.charCodeAt(0));
    if(!bytes.length||bytes.length>65536||offset+bytes.length>file.size)throw Error('原文件下载长度无效');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
    check();if(digest!==value.chunk_sha256)throw Error('原文件下载分段摘要无效');
    await writer!.write(bytes);check();offset+=bytes.length;setReceived(offset);
   };
   try{
    for(;;){
     const result=await reader.read();check();
     if(result.done)break;
     pending+=decoder.decode(result.value,{stream:true});
     let newline:number;
     while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);await accept(line);}
     if(pending.length>131072)throw Error('原文件下载分段超出范围');
    }
    pending+=decoder.decode();
    if(pending||!complete)throw Error('原文件下载未完成核对');
   }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   check();await writer.close();writer=undefined;
  }catch(error){if(!controller.signal.aborted&&(error as DOMException)?.name!=='AbortError')setError(error instanceof Error?error.message:'原文件下载失败');}
  finally{
   if(writer)await writer.abort().catch(()=>{});
   if(download.current===controller){download.current=null;setBusy(false);}
  }
 };
 return <section aria-label="原文件字节和下载" data-chat-search-ignore>
  <button type="button" disabled={busy} onClick={()=>{setPage(undefined);setCursor({identity,offset:0});setRevision(value=>value+1);}}>查看原始字节</button>
  <button type="button" disabled={busy} onClick={()=>void save()}>下载固定版本</button>
  {busy&&<><span role="status">已核对下载 {received} / {file.size} 字节</span><button type="button" onClick={()=>download.current?.abort()}>取消下载</button></>}
  {offset!==undefined&&!current&&!error&&<p role="status">正在核对原文件字节…</p>}
  {current&&<><pre aria-label="原文件十六进制内容">{current.hex||'空文件'}</pre><nav aria-label="原文件字节翻页">
   <button type="button" disabled={busy||current.offset===0} onClick={()=>setCursor({identity,offset:Math.max(0,current.offset-256)})}>上一页字节</button>
   <span>{current.offset} / {file.size} 字节</span>
   <button type="button" disabled={busy||current.next===undefined} onClick={()=>{if(current.next!==undefined)setCursor({identity,offset:current.next});}}>下一页字节</button>
  </nav></>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
