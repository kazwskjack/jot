import OfficePreviewConfigurationEditor from './OfficePreviewConfigurationEditor';
import React,{useEffect,useRef,useState} from 'react';
import type {OfficePreviewStatus} from '../../packages/gateway/contracts/types';
import {request,taskDraftScope} from './client';

export default function OfficePreviewServiceStatus({owner,onRendererChange,onStatus}:{owner:string;onRendererChange:()=>void;onStatus:(value:OfficePreviewStatus)=>void}){
 const [revision,setRevision]=useState(0);
 const [state,setState]=useState<{loading:boolean;value?:OfficePreviewStatus;error?:string}>({loading:true});
 const signature=useRef<string|undefined>(undefined),changed=useRef(onRendererChange);changed.current=onRendererChange;
 const observed=useRef(onStatus);observed.current=onStatus;
 useEffect(()=>{
  const controller=new AbortController();let live=true;
  setState({loading:true});
  void request<OfficePreviewStatus>('/office-preview/status'+(revision?'?refresh=1':''),'GET',undefined,undefined,controller.signal,120000).then(value=>{
   if(!live||controller.signal.aborted||taskDraftScope()!==owner)return;
   const office=value?.libreOffice;
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==8||value.protocol!==1||!['builtin','libreoffice'].includes(value.service)
    ||typeof value.configuredBinaryPath!=='string'||value.configuredBinaryPath.length>4096
    ||value.rendererSignature!==JSON.stringify([value.service,value.configuredBinaryPath,office?.binaryPath])
    ||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt))
    ||!Array.isArray(value.supportedServices)||value.supportedServices.length!==2||value.supportedServices[0]!=='builtin'||value.supportedServices[1]!=='libreoffice'
    ||value.execution_authorized!==false||!office||typeof office!=='object'||Array.isArray(office)||Object.keys(office).length!==3
    ||typeof office.binaryPath!=='string'||office.binaryPath.length>4096
    ||!(office.available===true&&typeof office.version==='string'&&office.version.length<=200
     ||office.available===false&&['probe_failed','version_unconfirmed'].includes(office.reason)))throw Error('Office服务状态尚未确认。');
   const previous=signature.current;signature.current=value.rendererSignature;setState({loading:false,value});observed.current(value);
   if(previous!==undefined&&previous!==value.rendererSignature)changed.current();
  }).catch(()=>{
   if(live&&!controller.signal.aborted&&taskDraftScope()===owner)setState({loading:false,error:'Office服务状态读取失败，可刷新状态。'});
  });
  return()=>{live=false;controller.abort();};
 },[owner,revision]);
 return <details className="jot-office-service-status">
  <summary>Office预览服务状态</summary>
  <button type="button" disabled={state.loading} onClick={()=>{if(taskDraftScope()===owner)setRevision(value=>value+1);}}>刷新服务状态</button>
  {state.loading&&<p role="status">正在读取预览服务状态…</p>}
  {state.error&&<p role="alert">{state.error}</p>}
  {state.value&&<>
   <p>默认预览服务为{state.value.service==='builtin'?'内置查看器':'LibreOffice转换PDF'}。</p>
   <p role="status">{state.value.libreOffice.available?state.value.libreOffice.version:'当前文档引擎的LibreOffice版本尚未确认。'}</p>
   <p>{state.value.libreOffice.available?'预览引擎路径':'最后探测路径'} <code>{state.value.libreOffice.binaryPath}</code></p>
   <p>检查时间 <time dateTime={state.value.checkedAt}>{state.value.checkedAt}</time></p>
  </>}
  <OfficePreviewConfigurationEditor key={owner} owner={owner} onSaved={()=>setRevision(value=>value+1)}/>
 </details>;
}
