import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import {pdfViewIdentity} from './pdf-file-view-state';
import OfficeFileViewState from './OfficeFileViewState';
import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {fileViewingReferenceSource,readOfficeViewerUrl,readFileVisualSourceBytes,type FileViewingSource} from './activity-file-preview-client';
import {type OfficeCellFocus,type OfficeRegionFocus} from './FileTextReferences';
import OfficeFileRegionReference,{type OfficeRegionSession} from './OfficeFileRegionReference';
import XlsxCellReferences from './XlsxCellReferences';

function XlsxAttempt({source,owner,identity,officeFocus,officeRegionFocus}:{source:FileViewingSource;owner:string;identity:string;officeFocus?:OfficeCellFocus;officeRegionFocus?:OfficeRegionFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const referenceSource=fileViewingReferenceSource(source);
 const cellSession=useRef<OfficeRegionSession|undefined>(undefined);
 const frame=useRef<HTMLIFrameElement>(null),probe=useRef<(element:HTMLIFrameElement)=>void>(()=>{}),cancel=useRef<()=>void>(()=>{});
 const [url,setUrl]=useState<string>(),[state,setState]=useState<{phase:'loading'|'ready'|'error';message:string;working?:boolean;sheets?:number;warnings?:number}>({phase:'loading',message:'正在核对原工作簿并读取视觉内容…'});
 useEffect(()=>{
  const controller=new AbortController(),token=crypto.randomUUID();let closed=false,origin:string|undefined,instance:string|undefined,bytes:ArrayBuffer|undefined,booted=false,sent=false,ready=false,working=false,timer:number|undefined;
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
   if(value.type==='jot-xlsx-boot'&&value.protocol===1&&Object.keys(value).length===4&&typeof value.started==='boolean'
    &&typeof value.instance==='string'&&/^[a-f0-9-]{36}$/.test(value.instance)){
    if(sent){if(value.instance!==instance)fail('工作簿查看器已重新载入，请重新读取固定版本。');return;}
    instance=value.instance;
    if(value.started){fail('工作簿查看器已处理上次读取，请重新读取。');return;}
    booted=true;send();return;
   }
   if(!sent||value.protocol!==1||value.token!==token||Object.keys(value).length!==4)return;
   if(value.type==='jot-xlsx-closed'&&value.reason==='pagehide'){fail('工作簿查看器页面已离开，请重新读取固定版本。');return;}
   if(value.type==='jot-xlsx-error'&&value.code==='XLSX_RENDER_FAILED'){fail('工作簿视觉读取失败，可重读或切换结构化单元格查看。');return;}
   if(value.type==='jot-xlsx-ready'&&value.info&&Object.keys(value.info).length===2&&Number.isSafeInteger(value.info.sheets)&&value.info.sheets>=1&&value.info.sheets<=100&&Number.isSafeInteger(value.info.warnings)&&value.info.warnings>=0&&value.info.warnings<=2){
    if(frame.current?.contentWindow&&origin)cellSession.current={window:frame.current.contentWindow,origin,token,live,close:fail};
    ready=true;window.clearTimeout(timer);setState({phase:'ready',sheets:value.info.sheets,warnings:value.info.warnings,message:`已读取 ${value.info.sheets} 个原生工作表${value.info.warnings?'，存在工作簿显示提示，请对照原文件。':'。'}`});
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
   const verified=await readFileVisualSourceBytes(source,owner,controller.signal);if(!live())return;bytes=verified.buffer as ArrayBuffer;send();
  };
  void load().catch(error=>{if(!controller.signal.aborted)fail(error instanceof Error?error.message:'原工作簿读取失败');});
  return()=>{dispose();cellSession.current=undefined;probe.current=()=>{};cancel.current=()=>{};};
 },[identity,owner]);
 return <section lang={language} className="jot-xlsx-preview" aria-label={t('原工作簿视觉内容','Original Workbook Visual Content')}>
  <p role={state.phase==='error'?'alert':'status'}>{state.working?t('正在处理原生工作簿…','Processing native workbook…'):state.phase==='ready'&&state.sheets!==undefined?t(state.message,`${state.sheets} native sheets read${state.warnings?'; workbook display notices are present. Compare with the original file.':'.'}`):conversationUiError(state.message,language)} {(state.phase==='loading'||state.working)&&<button type="button" onClick={()=>cancel.current()}>{t('取消并关闭视觉查看器','Cancel and Close Visual Viewer')}</button>}</p>
  {state.phase==='ready'&&source.native_source&&!referenceSource&&<p>{t('此打开内容没有引用凭据，可阅读和下载；文字、单元格与选区引用暂不可用。',"This opened content has no reference credentials. You can read and download it; text, cell and region references are unavailable.")}</p>}
  {state.phase!=='error'&&url&&<iframe ref={frame} src={url} title={t('原固定版本工作簿视觉查看器','Original Pinned Workbook Visual Viewer')} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={event=>probe.current(event.currentTarget)}/>}
  {state.phase==='ready'&&cellSession.current&&<OfficeFileViewState kind="xlsx" source={source} owner={owner} session={cellSession.current} focused={!!referenceSource&&(!!officeFocus||!!officeRegionFocus)}/>}
  {state.phase==='ready'&&referenceSource&&cellSession.current&&<XlsxCellReferences source={referenceSource} owner={owner} session={cellSession.current} focus={officeFocus}/>}
  {state.phase==='ready'&&referenceSource&&cellSession.current&&<OfficeFileRegionReference kind="xlsx" source={referenceSource} owner={owner} session={cellSession.current} focus={officeRegionFocus}/>}
 </section>;
}
export default function ActivityToolFileXlsx(source:FileViewingSource&{officeFocus?:OfficeCellFocus;officeRegionFocus?:OfficeRegionFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),[revision,setRevision]=useState(0),identity=JSON.stringify([pdfViewIdentity(source,owner),source.native_source?.proof??null,source.officeFocus?.key,source.officeRegionFocus?.key,revision]);
 return <><button lang={language} type="button" onClick={()=>setRevision(value=>value+1)}>{t('重新读取工作簿视觉内容','Read Workbook Visual Content Again')}</button><XlsxAttempt key={identity} source={source} owner={owner} identity={identity} officeFocus={source.officeFocus?.value.cell_view===2?source.officeFocus:undefined} officeRegionFocus={source.officeRegionFocus}/></>;
}
