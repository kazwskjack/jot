import React,{useEffect,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
import type {ActivityToolFileBytes as BytePage,ActivityToolResultFile} from './types';

type WritableFile={write:(bytes:Uint8Array)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
type FilePicker={showSaveFilePicker?:(options:{suggestedName:string})=>Promise<{createWritable:()=>Promise<WritableFile>}>};
export default function ActivityToolFileBytes({conversationId,runId,activityId,resultSha,file}:{conversationId:string;runId:string;activityId:string;resultSha:string;file:ActivityToolResultFile}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file]);
 const [cursor,setCursor]=useState<{identity:string;offset:number}>(),[page,setPage]=useState<{identity:string;offset:number;hex:string;next?:number}>();
 const [revision,setRevision]=useState(0);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[received,setReceived]=useState(0);
 const download=useRef<AbortController|null>(null),urls=useRef(new Set<string>());
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
  return()=>{download.current?.abort();download.current=null;for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();};
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
   if(picker){const handle=await picker.call(globalThis,{suggestedName:name});check();writer=await handle.createWritable();check();}
   // shortcut: Blob fallback retains all chunks, add a verified streamed download for larger files.
   const chunks:Uint8Array[]=[];let offset=0;
   do{
    const value=await read(offset,65536,controller.signal);check();
    if(writer)await writer.write(value.bytes);else chunks.push(value.bytes);
    check();offset+=value.bytes.length;setReceived(offset);
   }while(offset<file.size);
   if(writer){await writer.close();writer=undefined;}
   else{
    check();const url=URL.createObjectURL(new Blob(chunks,{type:'application/octet-stream'}));urls.current.add(url);
    const link=document.createElement('a');link.href=url;link.download=name;link.click();
    setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},1000);
   }
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
