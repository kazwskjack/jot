import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {readOfficeViewerUrl,readListedFilePreviewBytes,type ListedFilePreviewSource} from './activity-file-preview-client';
import type {OfficeCellFocus} from './FileTextReferences';
import type {OfficeRegionSession} from './OfficeFileRegionReference';
import XlsxCellReferences from './XlsxCellReferences';

function XlsxAttempt({source,owner,identity,officeFocus}:{source:ListedFilePreviewSource;owner:string;identity:string;officeFocus?:OfficeCellFocus}){
 const cellSession=useRef<OfficeRegionSession|undefined>(undefined);
 const frame=useRef<HTMLIFrameElement>(null),probe=useRef<(element:HTMLIFrameElement)=>void>(()=>{}),cancel=useRef<()=>void>(()=>{});
 const [url,setUrl]=useState<string>(),[state,setState]=useState<{phase:'loading'|'ready'|'error';message:string;working?:boolean}>({phase:'loading',message:'正在核对原工作簿并读取视觉内容…'});
 useEffect(()=>{
  const controller=new AbortController(),token=crypto.randomUUID();let closed=false,origin:string|undefined,bytes:ArrayBuffer|undefined,booted=false,sent=false,ready=false,working=false,timer:number|undefined;
  const live=()=>!closed&&!controller.signal.aborted&&taskDraftScope()===owner;
  const dispose=()=>{closed=true;controller.abort();bytes=undefined;window.clearTimeout(timer);window.removeEventListener('message',message);window.document.removeEventListener('securitypolicyviolation',policy);};
  const fail=(message:string)=>{if(closed)return;dispose();setState({phase:'error',message});};
  const arm=()=>{window.clearTimeout(timer);timer=window.setTimeout(()=>fail('工作簿视觉读取超时，请重读或重新加载Jot页面。'),30000);};
  const send=()=>{
   if(!live()||!booted||sent||!origin||!bytes||!frame.current?.contentWindow)return;
   sent=true;
   try{frame.current.contentWindow.postMessage({type:'jot-xlsx-init',protocol:1,token,bytes},origin,[bytes]);bytes=undefined;}
   catch{fail('原工作簿未能交给视觉查看器，请重试。');}
  };
  const message=(event:MessageEvent)=>{
   if(!live()||event.origin!==origin||event.source!==frame.current?.contentWindow)return;
   const value=event.data;if(!value||typeof value!=='object'||Array.isArray(value))return;
   if(!sent&&value.type==='jot-xlsx-boot'&&value.protocol===1&&Object.keys(value).length===3&&typeof value.started==='boolean'){
    if(value.started){fail('工作簿查看器已处理上次读取，请重新读取。');return;}
    booted=true;send();return;
   }
   if(!sent||value.protocol!==1||value.token!==token||Object.keys(value).length!==4)return;
   if(value.type==='jot-xlsx-error'&&value.code==='XLSX_RENDER_FAILED'){fail('工作簿视觉读取失败，可重读或切换结构化单元格查看。');return;}
   if(value.type==='jot-xlsx-ready'&&value.info&&Object.keys(value.info).length===2&&Number.isSafeInteger(value.info.sheets)&&value.info.sheets>=1&&value.info.sheets<=100&&Number.isSafeInteger(value.info.warnings)&&value.info.warnings>=0&&value.info.warnings<=2){
    if(frame.current?.contentWindow&&origin)cellSession.current={window:frame.current.contentWindow,origin,token,live,close:fail};
    ready=true;window.clearTimeout(timer);setState({phase:'ready',message:`已读取 ${value.info.sheets} 个原生工作表${value.info.warnings?'，存在工作簿显示提示，请对照原文件。':'。'}`});
   }else if(ready&&value.type==='jot-xlsx-work'&&typeof value.busy==='boolean'){
    if(value.busy&&!working)arm();if(!value.busy)window.clearTimeout(timer);working=value.busy;
    setState(current=>({...current,working}));
   }
  };
  const policy=(event:SecurityPolicyViolationEvent)=>{if(origin&&event.effectiveDirective==='frame-src'&&(event.blockedURI===origin||event.blockedURI.startsWith(origin+'/')))fail('当前页面无法载入独立工作簿查看器，请重新加载Jot页面后重试。');};
  probe.current=element=>{if(live()&&origin)element.contentWindow?.postMessage({type:'jot-xlsx-probe',protocol:1},origin);};
  cancel.current=()=>fail('工作簿视觉读取已取消。');window.addEventListener('message',message);window.document.addEventListener('securitypolicyviolation',policy);arm();
  const load=async()=>{
   const value=await readOfficeViewerUrl('xlsx',controller.signal);if(!live())return;
   origin=new URL(value).origin;setUrl(value);
   const verified=await readListedFilePreviewBytes(source,owner,controller.signal);if(!live())return;bytes=verified.buffer as ArrayBuffer;send();
  };
  void load().catch(error=>{if(!controller.signal.aborted)fail(error instanceof Error?error.message:'原工作簿读取失败');});
  return()=>{dispose();cellSession.current=undefined;probe.current=()=>{};cancel.current=()=>{};};
 },[identity,owner]);
 return <section className="jot-xlsx-preview" aria-label="原工作簿视觉内容">
  <p role={state.phase==='error'?'alert':'status'}>{state.working?'正在处理原生工作簿…':state.message} {(state.phase==='loading'||state.working)&&<button type="button" onClick={()=>cancel.current()}>取消并关闭视觉查看器</button>}</p>
  {state.phase!=='error'&&url&&<iframe ref={frame} src={url} title="原固定版本工作簿视觉查看器" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={event=>probe.current(event.currentTarget)}/>}
  {state.phase==='ready'&&cellSession.current&&<XlsxCellReferences source={source} owner={owner} session={cellSession.current} focus={officeFocus}/>}
 </section>;
}
export default function ActivityToolFileXlsx(source:ListedFilePreviewSource&{officeFocus?:OfficeCellFocus}){
 const owner=taskDraftScope(),[revision,setRevision]=useState(0),identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,source.officeFocus?.key,revision]);
 return <><button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取工作簿视觉内容</button><XlsxAttempt key={identity} source={source} owner={owner} identity={identity} officeFocus={source.officeFocus?.value.cell_view===2?source.officeFocus:undefined}/></>;
}
