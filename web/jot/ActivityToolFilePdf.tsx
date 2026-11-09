import PdfFileNavigation from './PdfFileNavigation';
import {renderPdfSearchHighlights,type PdfSearchMatch} from './vendor/pilotdeck-pdf-search';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {taskDraftScope} from './client';
import {artifactPreviewErrorMessage} from './artifact-preview-bytes.mjs';
import {readListedFilePreviewBytes,type ListedFilePreviewSource} from './activity-file-preview-client';
import ActivityToolFileBytes from './ActivityToolFileBytes';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const assets=new URL('pdfjs/6.1.200/',new URL(workerUrl,document.baseURI)).href;
type Zoom=number|'width'|'page';
const clampZoom=(value:number)=>Math.max(0.1,Math.min(4,value));

function PdfPage({document,pageNumber,zoom,rotation,width,onScale,matches,selected}:{document:pdfjs.PDFDocumentProxy;pageNumber:number;zoom:Zoom;rotation:number;width:number;onScale:(scale:number)=>void;matches:PdfSearchMatch[];selected:string|null}){
 const canvas=useRef<HTMLCanvasElement>(null),text=useRef<HTMLDivElement>(null);
 const mapping=useRef<{divs:HTMLElement[];items:string[]}|undefined>(undefined);
 const [textRevision,setTextRevision]=useState(0);
 const [size,setSize]=useState({width:0,height:0,scale:1}),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 useEffect(()=>{
  let cancelled=false,page:pdfjs.PDFPageProxy|undefined,render:pdfjs.RenderTask|undefined,layer:pdfjs.TextLayer|undefined;
  const target=canvas.current!,textTarget=text.current!;
  const draw=async()=>{
   page=await document.getPage(pageNumber);if(cancelled)return;
   const angle=(page.rotate+rotation)%360,base=page.getViewport({scale:1,rotation:angle});
   if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<=0||base.height<=0)throw Error('PDF页面尺寸无效');
   const fitWidth=Math.max(1,width-16)/base.width;
   const scale=clampZoom(typeof zoom==='number'?zoom:zoom==='width'?fitWidth:Math.min(fitWidth,Math.max(300,window.innerHeight*0.65)/base.height));
   const viewport=page.getViewport({scale,rotation:angle});onScale(scale);
   const ratio=Math.min(Math.max(window.devicePixelRatio||1,1),2,Math.sqrt(16777216/(viewport.width*viewport.height)));
   target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));
   target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
   setSize({width:viewport.width,height:viewport.height,scale});
   render=page.render({canvas:target,viewport,transform:[ratio,0,0,ratio,0,0]});await render.promise;if(cancelled)return;
   const content=await page.getTextContent();if(cancelled)return;
   textTarget.replaceChildren();layer=new pdfjs.TextLayer({textContentSource:content,container:textTarget,viewport});
   await layer.render();
   if(!cancelled){mapping.current={divs:layer.textDivs,items:layer.textContentItemsStr};setTextRevision(value=>value+1);setBusy(false);}
  };
  void draw().catch(error=>{if(!cancelled){setError(error instanceof Error?error.message:'PDF页面绘制失败');setBusy(false);}}).finally(()=>{if(cancelled){try{page?.cleanup();}catch{}}});
  return()=>{
   cancelled=true;mapping.current=undefined;render?.cancel();layer?.cancel();target.width=0;target.height=0;textTarget.replaceChildren();
   void Promise.resolve(render?.promise).catch(()=>{}).then(()=>{try{page?.cleanup();}catch{}});
  };
 },[document,pageNumber,zoom,rotation,width,onScale]);
 useEffect(()=>{
  if(!mapping.current)return;
  const element=renderPdfSearchHighlights(mapping.current.divs,mapping.current.items,matches,selected);
  element?.scrollIntoView({block:'center',inline:'nearest'});
 },[matches,selected,textRevision]);
 return <>
  {busy&&<p role="status">正在绘制第 {pageNumber} 页…</p>}
  {error&&<p role="alert">{error}</p>}
  <div style={{position:'relative',width:size.width,height:size.height,'--scale-factor':size.scale,'--total-scale-factor':size.scale} as React.CSSProperties}>
   <canvas ref={canvas} aria-hidden="true"/>
   <div ref={text} className="textLayer" aria-label={`PDF第 ${pageNumber} 页文字`} style={{position:'absolute',inset:0}}/>
  </div>
 </>;
}

export default function ActivityToolFilePdf(props:ListedFilePreviewSource){
 const {conversationId,runId,activityId,resultSha,file}=props,owner=taskDraftScope(),identity=JSON.stringify([owner,props]);
 const root=useRef<HTMLElement>(null),viewport=useRef<HTMLDivElement>(null),scale=useRef(1);
 const [state,setState]=useState<{identity:string;document?:pdfjs.PDFDocumentProxy;error?:string}>(),[revision,setRevision]=useState(0);
 const [view,setView]=useState<{identity:string;page:number;zoom:Zoom;rotation:number}>({identity,page:1,zoom:'width',rotation:0});
 const currentView=view.identity===identity?view:{identity,page:1,zoom:'width' as Zoom,rotation:0};
 const [width,setWidth]=useState(800),[password,setPassword]=useState(''),[challenge,setChallenge]=useState<{identity:string;update:(password:string)=>void;invalid:boolean}>();
 const [actionError,setActionError]=useState('');
 const [searchResult,setSearchResult]=useState<{document:pdfjs.PDFDocumentProxy;matches:PdfSearchMatch[];selected:string|null}>();
 const reportScale=useCallback((value:number)=>{scale.current=value;},[]);
 useEffect(()=>{root.current?.focus();root.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const element=viewport.current;if(!element)return;
  const observer=new ResizeObserver(entries=>setWidth(Math.max(1,entries[0]?.contentRect.width??800)));
  observer.observe(element);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const controller=new AbortController();let cancelled=false,loading:pdfjs.PDFDocumentLoadingTask|undefined;
  setState({identity});setChallenge(undefined);setPassword('');setActionError('');
  const load=async()=>{
   const bytes=await readListedFilePreviewBytes(props,owner,controller.signal);controller.signal.throwIfAborted();
   loading=pdfjs.getDocument({data:bytes,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
   loading.onPassword=(update,reason)=>{if(!cancelled){setPassword('');setChallenge({identity,update,invalid:reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD});}};
   const document=await loading.promise;
   if(!cancelled&&taskDraftScope()===owner){setChallenge(undefined);setState({identity,document});}
  };
  void load().catch(error=>{if(!cancelled&&taskDraftScope()===owner)setState({identity,error:artifactPreviewErrorMessage(error)});});
  return()=>{cancelled=true;controller.abort();void loading?.destroy().catch(()=>{});};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined,document=current?.document;
 const page=document?Math.min(currentView.page,document.numPages):1;
 const change=useCallback((patch:Partial<typeof currentView>)=>{
  setView(previous=>{
   const current=previous.identity===identity?previous:{identity,page:1,zoom:'width' as Zoom,rotation:0};
   return {...current,...patch,identity};
  });
 },[identity]);
 const navigate=useCallback((page:number)=>change({page}),[change]);
 const reportMatches=useCallback((matches:PdfSearchMatch[],selected:string|null)=>{if(document)setSearchResult({document,matches,selected});},[document]);
 const activeSearch=searchResult?.document===document?searchResult:undefined;
 const fullscreen=async()=>{
  try{if(window.document.fullscreenElement===root.current)await window.document.exitFullscreen();else await root.current?.requestFullscreen();}
  catch(error){setActionError(error instanceof Error?error.message:'暂时无法切换全屏');}
 };
 return <section ref={root} tabIndex={-1} className="jot-activity-content" aria-label="原列表固定PDF版本" data-chat-search-scope="" style={{background:'var(--jot-background,white)',overflow:'auto'}} onKeyDown={event=>{
   if(document&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&event.keyCode!==229&&(event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='f'){
    event.preventDefault();event.stopPropagation();const input=root.current?.querySelector<HTMLInputElement>('[data-pdf-file-search]');input?.focus();input?.select();
   }
  }}>
  <h4>{file.path} · 版本 {file.version}</h4>
  <ActivityToolFileBytes key={identity} conversationId={conversationId} runId={runId} activityId={activityId} resultSha={resultSha} file={file}/>
  {challenge?.identity===identity&&<form onSubmit={event=>{event.preventDefault();challenge.update(password);setPassword('');setChallenge(undefined);}}>
   <label>PDF密码<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>
   <button type="submit">解锁PDF</button>{challenge.invalid&&<p role="alert">密码未匹配，请重试。</p>}
  </form>}
  {(!current||!document&&!current.error)&&<p role="status">正在核对并载入原PDF…</p>}
  {document&&<nav aria-label="PDF页面控制" data-chat-search-ignore>
   <button type="button" disabled={page<=1} onClick={()=>change({page:page-1})}>上一页PDF</button>
   <label>PDF页码<input type="number" min={1} max={document.numPages} value={page} onChange={event=>{const value=Number(event.target.value);if(Number.isSafeInteger(value))change({page:Math.max(1,Math.min(document.numPages,value))});}}/></label><span> / {document.numPages}</span>
   <button type="button" disabled={page>=document.numPages} onClick={()=>change({page:page+1})}>下一页PDF</button>
   <button type="button" onClick={()=>change({zoom:clampZoom(scale.current-0.25)})}>缩小PDF</button>
   <button type="button" onClick={()=>change({zoom:clampZoom(scale.current+0.25)})}>放大PDF</button>
   <button type="button" onClick={()=>change({zoom:'width'})}>适合宽度</button>
   <button type="button" onClick={()=>change({zoom:'page'})}>适合整页</button>
   <label>PDF缩放百分比<input type="number" min={10} max={400} value={typeof currentView.zoom==='number'?Math.round(currentView.zoom*100):''} placeholder="自动" onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>0)change({zoom:clampZoom(value/100)});}}/></label>
   <button type="button" onClick={()=>change({rotation:(currentView.rotation+270)%360})}>逆时针旋转</button>
   <button type="button" onClick={()=>change({rotation:(currentView.rotation+90)%360})}>顺时针旋转</button>
   <button type="button" onClick={()=>void fullscreen()}>切换PDF全屏</button>
  </nav>}
  {document&&<PdfFileNavigation key={identity+revision} document={document} page={page} onNavigate={navigate} onMatches={reportMatches}/>}
  <div ref={viewport} style={{width:'100%',minWidth:0,overflow:'auto',maxHeight:'80vh'}}>
   {document&&<PdfPage key={JSON.stringify([identity,revision,page,currentView.zoom,currentView.rotation,width])} document={document} pageNumber={page} zoom={currentView.zoom} rotation={currentView.rotation} width={width} onScale={reportScale} matches={activeSearch?.matches.filter(match=>match.pageNumber===page)??[]} selected={activeSearch?.selected??null}/>}
  </div>
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试PDF</button></p>}
  {actionError&&<p role="alert">{actionError}</p>}
 </section>;
}
