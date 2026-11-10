import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {readOfficeViewerUrl} from './activity-file-preview-client';

type Kind='docx'|'xlsx'|'pptx';
const labels={docx:'Word',xlsx:'工作簿',pptx:'幻灯片'};
function readyMessage(kind:Kind,value:Record<string,unknown>){
 if(kind==='docx')return Number.isSafeInteger(value.sections)&&Number(value.sections)>=0&&Number(value.sections)<=50000
  ?`已渲染 ${value.sections} 个Word分段。分段沿原文件分页标记。`:undefined;
 const info=value.info;
 if(!info||typeof info!=='object'||Array.isArray(info))return;
 const row=info as Record<string,unknown>;
 if(kind==='xlsx'&&Object.keys(row).sort().join(',')==='sheets,warnings'&&Number.isSafeInteger(row.sheets)
  &&Number(row.sheets)>=1&&Number(row.sheets)<=100&&Number.isSafeInteger(row.warnings)&&Number(row.warnings)>=0&&Number(row.warnings)<=2)
  return `已读取 ${row.sheets} 个原生工作表${row.warnings?'，存在显示提示，请对照本次打开文件。':'。'}`;
 if(kind==='pptx'&&Object.keys(row).sort().join(',')==='partial,slides'&&Number.isSafeInteger(row.slides)
  &&Number(row.slides)>=1&&Number(row.slides)<=50000&&typeof row.partial==='boolean')
  return `已读取 ${row.slides} 张幻灯片${row.partial?'，部分节点尚未成功绘制，请对照本次打开文件。':'。'}`;
}

/** The existing isolated Office frames receive only a copy of verified opened bytes. */
function OfficeAttempt({kind,bytes}:{kind:Kind;bytes:Uint8Array}){
 const owner=taskDraftScope(),frame=useRef<HTMLIFrameElement>(null);
 const probe=useRef<(element:HTMLIFrameElement)=>void>(()=>{}),cancel=useRef<()=>void>(()=>{});
 const [url,setUrl]=useState<string>(),[state,setState]=useState<{phase:'loading'|'ready'|'error';message:string;working?:boolean}>({phase:'loading',message:`正在载入独立${labels[kind]}查看器…`});
 useEffect(()=>{
  const controller=new AbortController(),token=crypto.randomUUID(),prefix=`jot-${kind}`;
  let closed=false,origin:string|undefined,instance:string|undefined,payload:ArrayBuffer|undefined,booted=false,sent=false,ready=false,working=false,timer:number|undefined;
  const live=()=>!closed&&!controller.signal.aborted&&taskDraftScope()===owner;
  const dispose=()=>{
   closed=true;controller.abort();payload=undefined;window.clearTimeout(timer);
   window.removeEventListener('message',message);window.document.removeEventListener('securitypolicyviolation',policy);
  };
  const fail=(message:string)=>{
   if(closed)return;
   dispose();
   if(taskDraftScope()===owner)setState({phase:'error',message});
  };
  const arm=(ms=30000)=>{window.clearTimeout(timer);timer=window.setTimeout(()=>fail(`${labels[kind]}视觉读取超时，请重开视觉内容。`),ms);};
  const send=()=>{
   if(!live()||!booted||sent||!origin||!payload||!frame.current?.contentWindow)return;
   sent=true;
   try{frame.current.contentWindow.postMessage({type:prefix+'-init',protocol:1,token,bytes:payload},origin,[payload]);payload=undefined;}
   catch{fail(`${labels[kind]}查看器未能接收本次打开内容。`);}
  };
  const message=(event:MessageEvent)=>{
   if(!live()||event.origin!==origin||event.source!==frame.current?.contentWindow)return;
   const value=event.data;
   if(!value||typeof value!=='object'||Array.isArray(value))return;
   if(value.type===prefix+'-boot'&&value.protocol===1&&Object.keys(value).length===4&&typeof value.started==='boolean'
    &&typeof value.instance==='string'&&/^[a-f0-9-]{36}$/.test(value.instance)){
    if(sent){if(value.instance!==instance)fail('独立查看器已重新载入，请重开视觉内容。');return;}
    instance=value.instance;
    if(value.started){fail('独立查看器已处理上次打开内容，请重开视觉内容。');return;}
    booted=true;send();return;
   }
   if(!sent||value.protocol!==1||value.token!==token||Object.keys(value).length!==4)return;
   if(value.type===prefix+'-closed'&&value.reason==='pagehide'){fail('独立查看器页面已离开，请重开视觉内容。');return;}
   if(value.type===prefix+'-error'&&(value.code===kind.toUpperCase()+'_RENDER_FAILED'||kind==='docx'&&value.code==='DOCX_VIEW_LIMIT')){
    fail(value.code==='DOCX_VIEW_LIMIT'?'Word内容超出当前视觉渲染范围，可下载本次打开内容查看。':`${labels[kind]}视觉读取失败，可重开视觉内容。`);return;
   }
   if(value.type===prefix+'-ready'){
    const summary=readyMessage(kind,value);
    if(!summary){fail('独立查看器返回的内容信息尚未确认。');return;}
    ready=true;window.clearTimeout(timer);setState({phase:'ready',message:summary});
   }else if(ready&&kind!=='docx'&&value.type===prefix+'-work'&&typeof value.busy==='boolean'){
    if(value.busy&&!working)arm();
    if(!value.busy)window.clearTimeout(timer);
    working=value.busy;setState(current=>({...current,working}));
   }
  };
  const policy=(event:SecurityPolicyViolationEvent)=>{
   if(origin&&event.effectiveDirective==='frame-src'&&(event.blockedURI===origin||event.blockedURI.startsWith(origin+'/')))
    fail('当前页面无法载入独立Office查看器，请重新加载Jot页面。');
  };
  probe.current=element=>{if(live()&&origin)element.contentWindow?.postMessage({type:prefix+'-probe',protocol:1},origin);};
  cancel.current=()=>fail('本次Office视觉读取已取消。');
  window.addEventListener('message',message);window.document.addEventListener('securitypolicyviolation',policy);arm(10000);
  const load=async()=>{
   const value=await readOfficeViewerUrl(kind,controller.signal);
   if(!live())return;
   origin=new URL(value).origin;
   payload=bytes.slice().buffer as ArrayBuffer;
   arm();setUrl(value);send();
  };
  void load().catch(error=>{if(!controller.signal.aborted)fail(error instanceof Error?error.message:'Office查看器配置读取失败');});
  return()=>{dispose();probe.current=()=>{};cancel.current=()=>{};};
 },[kind,bytes,owner]);
 return <section className={`jot-${kind}-preview`} aria-label={`原生打开内容${labels[kind]}视觉预览`}>
  <p role={state.phase==='error'?'alert':'status'}>{state.working?`正在处理${labels[kind]}内容…`:state.message}
   {(state.phase==='loading'||state.working)&&<button type="button" onClick={()=>cancel.current()}>取消并关闭视觉查看器</button>}
  </p>
  {state.phase!=='error'&&url&&<iframe ref={frame} src={url} title={`原生成员${labels[kind]}视觉查看器`} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={event=>probe.current(event.currentTarget)}/>}
 </section>;
}

export default function NativeSearchFileOffice({kind,bytes}:{kind:Kind;bytes:Uint8Array}){
 const [revision,setRevision]=useState(0);
 return <>
  <button type="button" onClick={()=>setRevision(value=>value+1)}>重新打开本次Office视觉内容</button>
  <OfficeAttempt key={JSON.stringify([kind,revision])} kind={kind} bytes={bytes}/>
 </>;
}
