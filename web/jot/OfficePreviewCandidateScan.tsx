import React,{useEffect,useRef,useState} from 'react';
import type {OfficePreviewCandidates} from '../../packages/gateway/contracts/types';
import {request,taskDraftScope} from './client';

export default function OfficePreviewCandidateScan({owner,onSelect}:{owner:string;onSelect?:(path:string)=>void}){
 const active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{owner:string;loading:boolean;value?:OfficePreviewCandidates;error?:string}>();
 useEffect(()=>()=>{active.current?.abort();active.current=null;},[owner]);
 const current=state?.owner===owner?state:undefined;
 const scan=async()=>{
  if(taskDraftScope()!==owner||active.current)return;
  const controller=new AbortController();active.current=controller;setState({owner,loading:true});
  try{
   const value=await request<OfficePreviewCandidates>('/office-preview/candidates?refresh=1','GET',undefined,undefined,controller.signal,75000);
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==5||value.protocol!==1
    ||typeof value.checkedAt!=='string'||value.checkedAt.length>64||!Number.isFinite(Date.parse(value.checkedAt))
    ||typeof value.truncated!=='boolean'||value.execution_authorized!==false||!Array.isArray(value.candidates)||value.candidates.length>32
    ||!value.candidates.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===3
     &&typeof item.binaryPath==='string'&&item.binaryPath.length>0&&item.binaryPath.length<=4096&&!/[\u0000-\u001f\u007f]/.test(item.binaryPath)
     &&(item.available===true&&typeof item.version==='string'&&/^LibreOffice [^\r\n]{1,180}$/.test(item.version)
      ||item.available===false&&['probe_failed','version_unconfirmed'].includes(item.reason)))
    ||new Set(value.candidates.map(item=>item.binaryPath)).size!==value.candidates.length)throw Error('Office候选扫描结果尚未确认。');
   setState({owner,loading:false,value});
  }catch(error){
   if(!controller.signal.aborted&&taskDraftScope()===owner)setState({owner,loading:false,error:error instanceof Error?error.message:'Office候选扫描失败。'});
  }finally{if(active.current===controller)active.current=null;}
 };
 return <section aria-label="LibreOffice候选路径">
  <button type="button" disabled={current?.loading} onClick={()=>void scan()}>扫描LibreOffice候选路径</button>
  {current?.loading&&<p role="status">正在逐条扫描候选路径，每条最多2秒，最多32条…</p>}
  {current?.error&&<p role="alert">{current.error}</p>}
  {current?.value&&<>
   <p>版本扫描时间 <time dateTime={current.value.checkedAt}>{current.value.checkedAt}</time></p>
   <ul>{current.value.candidates.map(item=><li key={item.binaryPath}><code>{item.binaryPath}</code> · {item.available?item.version:item.reason==='probe_failed'?'版本探测失败':'版本信息未确认'} {item.available&&onSelect&&<button type="button" onClick={()=>{if(taskDraftScope()===owner)onSelect(item.binaryPath);}}>选择此路径</button>}</li>)}</ul>
   {current.value.truncated&&<p role="status">目录读取或候选数量受限，已显示当前有界扫描结果。</p>}
  </>}
 </section>;
}
