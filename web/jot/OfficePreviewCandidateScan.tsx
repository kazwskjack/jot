import React,{useEffect,useRef,useState} from 'react';
import type {OfficePreviewCandidatePage} from '../../packages/gateway/contracts/types';
import {ApiError,request,taskDraftScope} from './client';

export default function OfficePreviewCandidateScan({owner,onSelect}:{owner:string;onSelect?:(path:string)=>void}){
 const active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{owner:string;loading:boolean;value?:OfficePreviewCandidatePage;page?:number;error?:string}>();
 useEffect(()=>()=>{active.current?.abort();active.current=null;},[owner]);
 const current=state?.owner===owner?state:undefined;
 const scan=async(next=false)=>{
  if(taskDraftScope()!==owner||active.current)return;
  const cursor=next?current?.value?.next_cursor:undefined;if(next&&!cursor)return;
  const previous=next&&current?.value?{value:current.value,page:current.page??1}:{};
  const controller=new AbortController();active.current=controller;setState({owner,loading:true,...previous});
  try{
   const params=new URLSearchParams({scan_protocol:'2',...(cursor?{cursor}:{})});
   const value=await request<OfficePreviewCandidatePage>('/office-preview/candidates?'+params,'GET',undefined,undefined,controller.signal,75000);
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==(Object.hasOwn(value,'next_cursor')?6:5)||value.protocol!==2
    ||Object.hasOwn(value,'next_cursor')&&(typeof value.next_cursor!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.next_cursor)||value.next_cursor===cursor)
    ||typeof value.checkedAt!=='string'||value.checkedAt.length>64||!Number.isFinite(Date.parse(value.checkedAt))
    ||typeof value.truncated!=='boolean'||value.execution_authorized!==false||!Array.isArray(value.candidates)||value.candidates.length>32
    ||!value.candidates.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===3
     &&typeof item.binaryPath==='string'&&item.binaryPath.length>0&&item.binaryPath.length<=4096&&!/[\u0000-\u001f\u007f]/.test(item.binaryPath)
     &&(item.available===true&&typeof item.version==='string'&&/^LibreOffice [^\r\n]{1,180}$/.test(item.version)
      ||item.available===false&&['probe_failed','version_unconfirmed'].includes(item.reason)))
    ||new Set(value.candidates.map(item=>item.binaryPath)).size!==value.candidates.length)throw Error('Office候选扫描结果尚未确认。');
   setState({owner,loading:false,value,page:next?(current?.page??1)+1:1});
  }catch(error){
   if(!controller.signal.aborted&&taskDraftScope()===owner)setState({owner,loading:false,...previous,error:error instanceof ApiError&&error.status===409?'原扫描游标已失效，请重新开始扫描。':error instanceof ApiError&&error.status===429?'候选扫描正在处理另一页，请稍后继续。':error instanceof Error?error.message:'Office候选扫描失败。'});
  }finally{if(active.current===controller)active.current=null;}
 };
 return <section aria-label="LibreOffice候选路径">
  <button type="button" disabled={current?.loading} onClick={()=>void scan()}>扫描LibreOffice候选路径</button>
  {current?.loading&&<p role="status">正在逐条扫描候选路径，每条最多2秒，每页最多32条…</p>}
  {current?.error&&<p role="alert">{current.error}</p>}
  {current?.value&&<>
   <p>候选扫描第{current.page??1}页</p>
   <p>版本扫描时间 <time dateTime={current.value.checkedAt}>{current.value.checkedAt}</time></p>
   <ul>{current.value.candidates.map(item=><li key={item.binaryPath}><code>{item.binaryPath}</code> · {item.available?item.version:item.reason==='probe_failed'?'版本探测失败':'版本信息未确认'} {item.available&&onSelect&&<button type="button" onClick={()=>{if(taskDraftScope()===owner)onSelect(item.binaryPath);}}>选择此路径</button>}</li>)}</ul>
   {current.value.truncated&&<p role="status">部分路径或目录暂不可读取，已显示当前页可读取的扫描结果。</p>}
   {current.value.next_cursor&&<button type="button" disabled={current.loading} onClick={()=>void scan(true)}>继续扫描后续目录项目</button>}
   {!current.value.next_cursor&&<p role="status">本次候选目录扫描已到末尾。</p>}
  </>}
 </section>;
}
