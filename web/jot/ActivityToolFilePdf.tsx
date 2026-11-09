import PdfFileRegionReference from './PdfFileRegionReference';
import PdfFileTextReferenceAction from './PdfFileTextReferenceAction';
import {capturePdfView,defaultPdfView,pdfViewIdentity,readPdfView,writePdfView,type PdfViewState} from './pdf-file-view-state';
import PdfFileThumbnails from './PdfFileThumbnails';
import PdfFileNavigation from './PdfFileNavigation';
import type {PdfSearchMatch} from './vendor/pilotdeck-pdf-search';
import PdfFilePage,{clampZoom} from './PdfFilePage';
import PdfFilePages from './PdfFilePages';
import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {taskDraftScope} from './client';
import {artifactPreviewErrorMessage} from './artifact-preview-bytes.mjs';
import {readListedFilePreviewBytes,type ListedFilePreviewSource} from './activity-file-preview-client';
import ActivityToolFileBytes from './ActivityToolFileBytes';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const assets=new URL('pdfjs/6.1.200/',new URL(workerUrl,document.baseURI)).href;

export default function ActivityToolFilePdf(props:ListedFilePreviewSource){
 const {conversationId,runId,activityId,resultSha,file}=props,owner=taskDraftScope(),identity=pdfViewIdentity(props,owner);
 const root=useRef<HTMLElement>(null),viewport=useRef<HTMLDivElement>(null),scale=useRef(1);
 const [state,setState]=useState<{identity:string;document?:pdfjs.PDFDocumentProxy;error?:string}>(),[revision,setRevision]=useState(0);
 const restored=useMemo(()=>readPdfView(identity,owner)??defaultPdfView,[identity,owner]);
 const [view,setView]=useState<PdfViewState&{identity:string}>(()=>({identity,...restored}));
 const currentView=view.identity===identity?view:{identity,...restored},continuous=currentView.continuous;
 const latestView=useRef(currentView);latestView.current=currentView;
 const pendingRestore=useRef<{identity:string;view:PdfViewState}|undefined>({identity,view:restored}),ready=useRef(false),sourceIdentity=useRef(identity);
 const saveTimer=useRef<number|undefined>(undefined),restoreFrame=useRef<number|undefined>(undefined);
 const searchJump=useRef<string|null>(null),restoreSelection=useRef<string|null>(null);
 if(sourceIdentity.current!==identity){sourceIdentity.current=identity;pendingRestore.current={identity,view:restored};ready.current=false;}
 const persist=useCallback(()=>{
  if(!ready.current||pendingRestore.current||latestView.current.identity!==identity)return;
  writePdfView(identity,owner,capturePdfView(viewport.current,latestView.current));
 },[identity,owner]);
 const scheduleSave=useCallback(()=>{window.clearTimeout(saveTimer.current);saveTimer.current=window.setTimeout(persist,200);},[persist]);
 const restoreView=useCallback((pageNumber:number)=>{
  const requested=pendingRestore.current;
  if(!requested||requested.identity!==identity||requested.view.page!==pageNumber)return;
  if(restoreFrame.current!==undefined)window.cancelAnimationFrame(restoreFrame.current);
  restoreFrame.current=window.requestAnimationFrame(()=>{
   if(pendingRestore.current!==requested||taskDraftScope()!==owner)return;
   const element=viewport.current;
   const anchor=element?.querySelector<HTMLElement>(requested.view.continuous?`[data-pdf-file-page="${pageNumber}"]`:`[data-pdf-page-anchor="${pageNumber}"]`);
   if(!element||!anchor)return;
   const rect=anchor.getBoundingClientRect();if(rect.height<=0)return;
   element.scrollTo({top:Math.max(0,element.scrollTop+rect.top-element.getBoundingClientRect().top+requested.view.position*rect.height),left:requested.view.left});
   const selected=restoreSelection.current;restoreSelection.current=null;
   if(selected&&/^page-[0-9]+-match-[0-9]+$/.test(selected)&&selected.startsWith(`page-${pageNumber}-match-`))element.querySelector<HTMLElement>(`[data-pdf-search-match-id="${selected}"]`)?.scrollIntoView({block:'center',inline:'nearest'});
   pendingRestore.current=undefined;ready.current=true;persist();
  });
 },[identity,owner,persist]);
 useLayoutEffect(()=>{
  const element=viewport.current;if(!element)return;
  const flush=()=>{window.clearTimeout(saveTimer.current);persist();};
  element.addEventListener('scroll',scheduleSave,{passive:true});window.addEventListener('pagehide',flush);
  return()=>{element.removeEventListener('scroll',scheduleSave);window.removeEventListener('pagehide',flush);window.clearTimeout(saveTimer.current);if(restoreFrame.current!==undefined)window.cancelAnimationFrame(restoreFrame.current);persist();};
 },[identity,persist,scheduleSave]);
 useEffect(scheduleSave,[scheduleSave,currentView.page,currentView.zoom,currentView.rotation,currentView.continuous]);
 const [width,setWidth]=useState(800),[password,setPassword]=useState(''),[challenge,setChallenge]=useState<{identity:string;update:(password:string)=>void;invalid:boolean}>();
 const [actionError,setActionError]=useState('');
 const [navigationRevision,setNavigationRevision]=useState(0);
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
  if(ready.current){const saved=capturePdfView(viewport.current,latestView.current);pendingRestore.current={identity,view:saved};latestView.current={identity,...saved};setView({identity,...saved});}
  ready.current=false;searchJump.current=null;restoreSelection.current=null;
  setState({identity});setChallenge(undefined);setPassword('');setActionError('');
  const load=async()=>{
   const bytes=await readListedFilePreviewBytes(props,owner,controller.signal);controller.signal.throwIfAborted();
   loading=pdfjs.getDocument({data:bytes,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
   loading.onPassword=(update,reason)=>{if(!cancelled){setPassword('');setChallenge({identity,update,invalid:reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD});}};
   const document=await loading.promise;
   if(!cancelled&&taskDraftScope()===owner){
    const pending=pendingRestore.current;
    if(pending?.identity===identity){
     const canonical={...pending.view,page:Math.min(pending.view.page,document.numPages)};
     pendingRestore.current={identity,view:canonical};latestView.current={identity,...canonical};setView({identity,...canonical});
    }
    setChallenge(undefined);setState({identity,document});
   }
  };
  void load().catch(error=>{if(!cancelled&&taskDraftScope()===owner)setState({identity,error:artifactPreviewErrorMessage(error)});});
  return()=>{cancelled=true;controller.abort();void loading?.destroy().catch(()=>{});};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined,document=current?.document;
 const page=document?Math.min(currentView.page,document.numPages):1;
 const change=useCallback((patch:Partial<PdfViewState>)=>{
  const current=latestView.current.identity===identity?latestView.current:{identity,...restored};
  const next={...capturePdfView(viewport.current,current),...patch,identity};
  const sameLayout=next.page===current.page&&next.zoom===current.zoom&&next.rotation===current.rotation&&next.continuous===current.continuous;
  if(sameLayout&&patch.position===undefined&&patch.left===undefined)return;
  pendingRestore.current={identity,view:capturePdfView(null,next)};ready.current=false;latestView.current=next;setView(next);
  if(sameLayout)restoreView(next.page);
 },[identity,restored,restoreView]);
 const navigate=useCallback((page:number)=>{
  restoreSelection.current=searchJump.current;searchJump.current=null;
  change({page,position:0,left:0});setNavigationRevision(value=>value+1);
 },[change]);
 const reportVisiblePage=useCallback((page:number)=>{
  if(pendingRestore.current||latestView.current.identity!==identity||latestView.current.page===page)return;
  const next={...latestView.current,page};latestView.current=next;setView(next);
 },[identity]);
 const reportMatches=useCallback((matches:PdfSearchMatch[],selected:string|null)=>{if(document){searchJump.current=selected;setSearchResult({document,matches,selected});}},[document]);
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
  {document&&<><PdfFileTextReferenceAction root={root} source={props}/><PdfFileRegionReference root={viewport} source={props} page={page} rotation={currentView.rotation}/></>}
  <ActivityToolFileBytes key={identity} conversationId={conversationId} runId={runId} activityId={activityId} resultSha={resultSha} file={file}/>
  {challenge?.identity===identity&&<form onSubmit={event=>{event.preventDefault();challenge.update(password);setPassword('');setChallenge(undefined);}}>
   <label>PDF密码<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>
   <button type="submit">解锁PDF</button>{challenge.invalid&&<p role="alert">密码未匹配，请重试。</p>}
  </form>}
  {(!current||!document&&!current.error)&&<p role="status">正在核对并载入原PDF…</p>}
  {document&&<nav aria-label="PDF页面控制" data-chat-search-ignore>
   <label><input type="checkbox" checked={continuous} onChange={event=>change({continuous:event.target.checked,position:0,left:0})}/>连续显示PDF页面</label>
   <button type="button" disabled={page<=1} onClick={()=>navigate(page-1)}>上一页PDF</button>
   <label>PDF页码<input type="number" min={1} max={document.numPages} value={page} onChange={event=>{const value=Number(event.target.value);if(Number.isSafeInteger(value))navigate(Math.max(1,Math.min(document.numPages,value)));}}/></label><span> / {document.numPages}</span>
   <button type="button" disabled={page>=document.numPages} onClick={()=>navigate(page+1)}>下一页PDF</button>
   <button type="button" onClick={()=>change({zoom:clampZoom(scale.current-0.25)})}>缩小PDF</button>
   <button type="button" onClick={()=>change({zoom:clampZoom(scale.current+0.25)})}>放大PDF</button>
   <button type="button" onClick={()=>change({zoom:'width'})}>适合宽度</button>
   <button type="button" onClick={()=>change({zoom:'page'})}>适合整页</button>
   <label>PDF缩放百分比<input type="number" min={10} max={400} value={typeof currentView.zoom==='number'?Math.round(currentView.zoom*100):''} placeholder="自动" onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>0)change({zoom:clampZoom(value/100)});}}/></label>
   <button type="button" onClick={()=>change({rotation:(currentView.rotation+270)%360})}>逆时针旋转</button>
   <button type="button" onClick={()=>change({rotation:(currentView.rotation+90)%360})}>顺时针旋转</button>
   <button type="button" onClick={()=>void fullscreen()}>切换PDF全屏</button>
  </nav>}
  {document&&<details><summary>PDF缩略图</summary><PdfFileThumbnails key={identity+revision} document={document} page={page} rotation={currentView.rotation} onNavigate={navigate}/></details>}
  {document&&<PdfFileNavigation key={identity+revision} document={document} page={page} onNavigate={navigate} onMatches={reportMatches}/>}
  <div ref={viewport} style={{width:'100%',minWidth:0,overflow:'auto',maxHeight:'80vh'}}>
   {document&&continuous?<PdfFilePages key={identity+revision} document={document} root={viewport} page={page} navigationRevision={navigationRevision} zoom={currentView.zoom} rotation={currentView.rotation} width={width} onScale={reportScale} onReady={restoreView} onVisiblePage={reportVisiblePage} matches={activeSearch?.matches??[]} selected={activeSearch?.selected??null}/>:document&&<PdfFilePage key={JSON.stringify([identity,revision,page,currentView.zoom,currentView.rotation,width])} document={document} pageNumber={page} zoom={currentView.zoom} rotation={currentView.rotation} width={width} onScale={reportScale} onReady={restoreView} matches={activeSearch?.matches.filter(match=>match.pageNumber===page)??[]} selected={activeSearch?.selected??null}/>}
  </div>
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试PDF</button></p>}
  {actionError&&<p role="alert">{actionError}</p>}
 </section>;
}
