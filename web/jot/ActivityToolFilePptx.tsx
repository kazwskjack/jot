import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {readOfficeViewerUrl,readFileVisualSourceBytes,type FileVisualSource} from './activity-file-preview-client';
import {nativeReferenceIdentity,type OfficeRegionFocus} from './FileTextReferences';
import OfficeFileRegionReference,{type OfficeRegionSession} from './OfficeFileRegionReference';

function PptxAttempt({source,owner,identity,officeRegionFocus}:{source:FileVisualSource;owner:string;identity:string;officeRegionFocus?:OfficeRegionFocus}){
 const frame=useRef<HTMLIFrameElement>(null),probe=useRef<(element:HTMLIFrameElement)=>void>(()=>{}),cancel=useRef<()=>void>(()=>{});
 const regionSession=useRef<OfficeRegionSession|undefined>(undefined);
 const [url,setUrl]=useState<string>(),[state,setState]=useState<{phase:'loading'|'ready'|'error';message:string;working?:boolean}>({phase:'loading',message:'正在核对原幻灯片并读取视觉内容…'});
 useEffect(()=>{
  const controller=new AbortController(),token=crypto.randomUUID();let closed=false,origin:string|undefined,instance:string|undefined,bytes:ArrayBuffer|undefined,booted=false,sent=false,ready=false,working=false,timer:number|undefined;
  const live=()=>!closed&&!controller.signal.aborted&&taskDraftScope()===owner;
  const dispose=()=>{closed=true;controller.abort();bytes=undefined;window.clearTimeout(timer);window.removeEventListener('message',message);window.document.removeEventListener('securitypolicyviolation',policy);};
  const fail=(message:string)=>{if(closed)return;dispose();setState({phase:'error',message});};
  const arm=()=>{window.clearTimeout(timer);timer=window.setTimeout(()=>fail('幻灯片视觉读取超时，请重读或重新加载Jot页面。'),30000);};
  const send=()=>{
   if(!live()||!booted||sent||!origin||!bytes||!frame.current?.contentWindow)return;
   sent=true;
   try{frame.current.contentWindow.postMessage({type:'jot-pptx-init',protocol:1,token,bytes},origin,[bytes]);bytes=undefined;}
   catch{fail('原幻灯片未能交给视觉查看器，请重试。');}
  };
  const message=(event:MessageEvent)=>{
   if(!live()||event.origin!==origin||event.source!==frame.current?.contentWindow)return;
   const value=event.data;if(!value||typeof value!=='object'||Array.isArray(value))return;
   if(value.type==='jot-pptx-boot'&&value.protocol===1&&Object.keys(value).length===4&&typeof value.started==='boolean'
    &&typeof value.instance==='string'&&/^[a-f0-9-]{36}$/.test(value.instance)){
    if(sent){if(value.instance!==instance)fail('幻灯片查看器已重新载入，请重新读取固定版本。');return;}
    instance=value.instance;
    if(value.started){fail('幻灯片查看器已处理上次读取，请重新读取。');return;}
    booted=true;send();return;
   }
   if(!sent||value.protocol!==1||value.token!==token||Object.keys(value).length!==4)return;
   if(value.type==='jot-pptx-closed'&&value.reason==='pagehide'){fail('幻灯片查看器页面已离开，请重新读取固定版本。');return;}
   if(value.type==='jot-pptx-error'&&value.code==='PPTX_RENDER_FAILED'){fail('幻灯片视觉读取失败，可重读或切换结构化文字查看。');return;}
   if(value.type==='jot-pptx-ready'&&value.info&&Object.keys(value.info).length===2&&Number.isSafeInteger(value.info.slides)&&value.info.slides>=1&&value.info.slides<=50000&&typeof value.info.partial==='boolean'){
    if(frame.current?.contentWindow&&origin)regionSession.current={window:frame.current.contentWindow,origin,token,live,close:fail};
    ready=true;window.clearTimeout(timer);setState({phase:'ready',message:`已读取 ${value.info.slides} 张幻灯片${value.info.partial?'，部分节点尚未成功绘制，请对照原文件。':'。'}`});
   }else if(ready&&value.type==='jot-pptx-work'&&typeof value.busy==='boolean'){
    if(value.busy&&!working)arm();if(!value.busy)window.clearTimeout(timer);working=value.busy;
    setState(current=>({...current,working}));
   }
  };
  const policy=(event:SecurityPolicyViolationEvent)=>{if(origin&&event.effectiveDirective==='frame-src'&&(event.blockedURI===origin||event.blockedURI.startsWith(origin+'/')))fail('当前页面无法载入独立幻灯片查看器，请重新加载Jot页面后重试。');};
  probe.current=element=>{if(live()&&origin)element.contentWindow?.postMessage({type:'jot-pptx-probe',protocol:1},origin);};
  cancel.current=()=>fail('幻灯片视觉读取已取消。');window.addEventListener('message',message);window.document.addEventListener('securitypolicyviolation',policy);arm();
  const load=async()=>{
   const value=await readOfficeViewerUrl('pptx',controller.signal);if(!live())return;
   origin=new URL(value).origin;setUrl(value);
   const verified=await readFileVisualSourceBytes(source,owner,controller.signal);if(!live())return;bytes=verified.buffer as ArrayBuffer;send();
  };
  void load().catch(error=>{if(!controller.signal.aborted)fail(error instanceof Error?error.message:'原幻灯片读取失败');});
  return()=>{dispose();regionSession.current=undefined;probe.current=()=>{};cancel.current=()=>{};};
 },[identity,owner]);
 return <section className="jot-pptx-preview" aria-label="原幻灯片视觉内容">
  <p role={state.phase==='error'?'alert':'status'}>{state.working?'正在绘制或搜索幻灯片…':state.message} {(state.phase==='loading'||state.working)&&<button type="button" onClick={()=>cancel.current()}>取消并关闭视觉查看器</button>}</p>
  {state.phase!=='error'&&url&&<iframe ref={frame} src={url} title="原固定版本幻灯片视觉查看器" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={event=>probe.current(event.currentTarget)}/>}
  {state.phase==='ready'&&regionSession.current&&<OfficeFileRegionReference kind="pptx" source={source} owner={owner} session={regionSession.current} focus={officeRegionFocus}/>}
 </section>;
}
export default function ActivityToolFilePptx(source:FileVisualSource&{officeRegionFocus?:OfficeRegionFocus}){
 const owner=taskDraftScope(),[revision,setRevision]=useState(0),identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,nativeReferenceIdentity(source.native_source),source.officeRegionFocus?.key,revision]);
 return <><button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取幻灯片视觉内容</button><PptxAttempt key={identity} source={source} owner={owner} identity={identity} officeRegionFocus={source.officeRegionFocus}/></>;
}
