import PdfFileRegionReference from './PdfFileRegionReference';
import PdfFileTextReferenceAction from './PdfFileTextReferenceAction';
import {capturePdfView,defaultPdfView,pdfViewIdentity,readPdfView,writePdfView,type PdfViewState,type PdfReferenceFocus} from './pdf-file-view-state';
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
import {fileViewingReferenceSource,readFileVisualSourceBytes,type FileViewingSource,type OfficePrintPreview} from './activity-file-preview-client';
import ActivityToolFileBytes from './ActivityToolFileBytes';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const assets=new URL('pdfjs/6.1.200/',new URL(workerUrl,document.baseURI)).href;

export type PdfViewingPrint=Omit<OfficePrintPreview,'proof'>&{proof?:string|undefined;onRetry:()=>void;focus?:PdfReferenceFocus|undefined};
export default function ActivityToolFilePdf(props:FileViewingSource&{focus?:PdfReferenceFocus|undefined;officePrint?:PdfViewingPrint|undefined}){
 const {conversationId,runId,activityId,resultSha,file,officePrint}=props,owner=taskDraftScope();
 const identity=pdfViewIdentity(props,owner,officePrint);
 const sourceFocus=officePrint?officePrint.focus:props.focus;
 const printView=useMemo(()=>officePrint&&typeof officePrint.proof==='string'&&officePrint.proof.length===43&&/^[A-Za-z0-9_-]{43}$/.test(officePrint.proof)?{protocol:1 as const,sha256:officePrint.sha256,size:officePrint.size,pageCount:officePrint.pageCount,proof:officePrint.proof}:undefined,[officePrint?.sha256,officePrint?.size,officePrint?.pageCount,officePrint?.proof]);
 const source=useMemo(()=>officePrint&&!printView?undefined:fileViewingReferenceSource(props),[conversationId,runId,activityId,resultSha,file.path,file.version,file.sha256,file.size,identity,props.native_source?.proof,!!officePrint,printView]);
 const focus=useRef(sourceFocus);focus.current=sourceFocus;
 const referenceJump=useRef<{key:string;page:number}|undefined>(undefined);
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
   const reference=referenceJump.current;
   if(reference&&reference.key===focus.current?.key&&reference.page===pageNumber){
    anchor.querySelector<HTMLElement>('[data-pdf-reference-region]')?.scrollIntoView({block:'center',inline:'center'});
    referenceJump.current=undefined;
   }
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
  ready.current=false;searchJump.current=null;restoreSelection.current=null;referenceJump.current=undefined;
  setState({identity});setChallenge(undefined);setPassword('');setActionError('');
  const load=async()=>{
   const bytes=officePrint?officePrint.bytes.slice():await readFileVisualSourceBytes(props,owner,controller.signal,20*1024*1024);controller.signal.throwIfAborted();
   if(officePrint){
    if(bytes.byteLength!==officePrint.size||bytes.byteLength>20*1024*1024)throw Error('转换PDF大小与来源结果不一致。');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice())),byte=>byte.toString(16).padStart(2,'0')).join('');
    controller.signal.throwIfAborted();if(digest!==officePrint.sha256)throw Error('转换PDF摘要与来源结果不一致。');
   }
   if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');
   loading=pdfjs.getDocument({data:bytes,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
   loading.onPassword=(update,reason)=>{if(!cancelled){setPassword('');setChallenge({identity,update,invalid:reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD});}};
   const document=await loading.promise;
   if(officePrint&&document.numPages!==officePrint.pageCount){await document.destroy();throw Error('转换PDF页数与已核对结果不一致。');}
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
  referenceJump.current=undefined;
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
 const locateReference=useCallback((pageNumber?:number)=>{
  const target=focus.current;if(!document||!target||taskDraftScope()!==owner)return;
  if(!target.pages.length||target.pages.some(value=>!Number.isSafeInteger(value.page)||value.page<1||value.page>document.numPages
   ||value.rect&&(Object.values(value.rect).some(number=>!Number.isFinite(number)||number<0||number>1)||value.rect.x+value.rect.width>1+1e-9||value.rect.y+value.rect.height>1+1e-9))
   ||target.rotation!==undefined&&![0,90,180,270].includes(target.rotation)){
   setActionError('此固定PDF的原引用位置未能核对，请核对引用页码和选区信息。');return;
  }
  const selected=pageNumber===undefined?target.pages[0]:target.pages.find(value=>value.page===pageNumber);
  if(!selected){setActionError('此页不属于原引用，请核对引用页码。');return;}
  setActionError('');searchJump.current=null;restoreSelection.current=null;
  setSearchResult(previous=>previous?.document===document?{...previous,selected:null}:previous);
  change({page:selected.page,continuous:false,position:target.rotation!==undefined?selected.rect?.y??0:0,left:0,...(target.rotation!==undefined?{rotation:target.rotation}:{})});
  referenceJump.current={key:target.key,page:selected.page};
  setNavigationRevision(value=>value+1);
 },[document,owner,identity,sourceFocus?.key,change]);
 useEffect(()=>{if(document&&sourceFocus)locateReference();},[document,sourceFocus?.key,locateReference]);
 const referencePages=sourceFocus?.rotation!==undefined&&sourceFocus.rotation===currentView.rotation?sourceFocus.pages:undefined;
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
 return <section ref={root} tabIndex={-1} className="jot-activity-content" aria-label={officePrint?"原Office固定版本的转换PDF":props.native_source?"原生固定打开PDF":"原列表固定PDF版本"} data-chat-search-scope="" data-desktop-find-surface="pdf" style={{background:'var(--jot-background,white)',overflow:'auto'}} onKeyDown={event=>{
   if(document&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&event.keyCode!==229&&(event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='f'){
    event.preventDefault();event.stopPropagation();const input=root.current?.querySelector<HTMLInputElement>('[data-pdf-file-search]');input?.focus();input?.select();
   }
  }}>
  <h4>{file.path} · 版本 {props.native_source?.openSha??file.version}</h4>
  {officePrint&&<p role="status">LibreOffice转换PDF · {officePrint.pageCount}页 · 摘要 <code>{officePrint.sha256}</code>。文字引用按近似页定位保存。</p>}
  {officePrint?.proof&&<details><summary>转换来源证明</summary><code>{officePrint.proof}</code></details>}
  {document&&source&&<><PdfFileTextReferenceAction root={root} source={source} rotation={currentView.rotation} printView={printView}/><PdfFileRegionReference root={viewport} source={source} page={page} rotation={currentView.rotation} printView={printView}/></>}
  {document&&props.native_source&&!source&&<p>此打开内容没有完整引用凭据，可阅读和下载；文字与选区引用暂不可用。</p>}
  {!props.native_source&&typeof file.version==='number'&&<ActivityToolFileBytes key={identity} conversationId={conversationId} runId={runId} activityId={activityId} resultSha={resultSha} file={{path:file.path,version:file.version,sha256:file.sha256,size:file.size}}/>}
  {challenge?.identity===identity&&<form onSubmit={event=>{event.preventDefault();challenge.update(password);setPassword('');setChallenge(undefined);}}>
   <label>PDF密码<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>
   <button type="submit">解锁PDF</button>{challenge.invalid&&<p role="alert">密码未匹配，请重试。</p>}
  </form>}
  {(!current||!document&&!current.error)&&<p role="status">{officePrint?'正在载入已核对的转换PDF…':'正在核对并载入原PDF…'}</p>}
  {document&&sourceFocus&&<p role="status">原引用页码 · {sourceFocus.pages.map(value=>value.page).join('、')} {sourceFocus.rotation===undefined?'此引用未记录选区旋转，当前仅定位原页。':''} <button type="button" onClick={()=>locateReference()}>定位原引用</button> {sourceFocus.pages.length>1&&sourceFocus.pages.map(value=><button key={value.page} type="button" onClick={()=>locateReference(value.page)}>定位引用第 {value.page} 页</button>)}</p>}
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
   {document&&continuous?<PdfFilePages key={identity+revision} document={document} root={viewport} page={page} navigationRevision={navigationRevision} zoom={currentView.zoom} rotation={currentView.rotation} width={width} onScale={reportScale} onReady={restoreView} onVisiblePage={reportVisiblePage} matches={activeSearch?.matches??[]} selected={activeSearch?.selected??null} referencePages={referencePages}/>:document&&<PdfFilePage key={JSON.stringify([identity,revision,page,currentView.zoom,currentView.rotation,width])} document={document} pageNumber={page} zoom={currentView.zoom} rotation={currentView.rotation} width={width} onScale={reportScale} onReady={restoreView} matches={activeSearch?.matches.filter(match=>match.pageNumber===page)??[]} selected={activeSearch?.selected??null} referenceRect={referencePages?.find(target=>target.page===page)?.rect}/>}
  </div>
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>officePrint?officePrint.onRetry():setRevision(value=>value+1)}>重试PDF</button></p>}
  {actionError&&<p role="alert">{actionError}</p>}
 </section>;
}
