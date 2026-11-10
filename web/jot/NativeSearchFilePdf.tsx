import {taskDraftScope} from './client';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import PdfFilePage,{clampZoom,type Zoom} from './PdfFilePage';
import PdfFileNavigation from './PdfFileNavigation';
import type {PdfSearchMatch} from './vendor/pilotdeck-pdf-search';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const assets=new URL('pdfjs/6.1.200/',new URL(workerUrl,document.baseURI)).href;

/** Reuse the existing PDF page renderer and outline/search over the same opened bytes. */
export default function NativeSearchFilePdf({bytes}:{bytes:Uint8Array}){
 const root=useRef<HTMLDivElement>(null),owner=taskDraftScope();
 const [document,setDocument]=useState<pdfjs.PDFDocumentProxy>(),[error,setError]=useState('');
 const [challenge,setChallenge]=useState<{update:(password:string)=>void;invalid:boolean}>(),[password,setPassword]=useState('');
 const [page,setPage]=useState(1),[zoom,setZoom]=useState<Zoom>('width'),[rotation,setRotation]=useState(0),[scale,setScale]=useState(1),[width,setWidth]=useState(800);
 const [search,setSearch]=useState<{matches:PdfSearchMatch[];selected:string|null}>({matches:[],selected:null});
 const onMatches=useCallback((matches:PdfSearchMatch[],selected:string|null)=>setSearch({matches,selected}),[]);
 useEffect(()=>{
  let cancelled=false;
  const loading=pdfjs.getDocument({data:bytes.slice(),cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
  loading.onPassword=(update,reason)=>{if(!cancelled&&taskDraftScope()===owner){setPassword('');setChallenge({update,invalid:reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD});}};
  void loading.promise.then(value=>{if(!cancelled&&taskDraftScope()===owner){setChallenge(undefined);setDocument(value);}},error=>{if(!cancelled&&taskDraftScope()===owner)setError(error instanceof Error?error.message:'PDF读取失败');});
  return()=>{cancelled=true;void loading.destroy().catch(()=>{});};
 },[bytes,owner]);
 useEffect(()=>{
  const element=root.current!;
  const update=()=>setWidth(element.clientWidth||800);
  update();
  const observer=new ResizeObserver(update);observer.observe(element);
  return()=>observer.disconnect();
 },[]);
 return <div ref={root} aria-label="原生打开内容PDF">
  {challenge&&<form onSubmit={event=>{event.preventDefault();challenge.update(password);setChallenge(undefined);setPassword('');}}>
   <label>PDF密码 <input type="password" autoComplete="off" value={password} onChange={event=>setPassword(event.target.value)}/></label>
   {challenge.invalid&&<p role="alert">PDF密码未能通过。</p>}
   <button type="submit">打开PDF</button>
  </form>}
  {!document&&!error&&!challenge&&<p role="status">正在解析PDF…</p>}
  {error&&<p role="alert">{error}</p>}
  {document&&<>
   <nav aria-label="PDF页面和缩放" data-chat-search-ignore>
    <button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button>
    <label>页码 <input type="number" min={1} max={document.numPages} value={page} onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=document.numPages)setPage(value);}}/></label>
    <span>/ {document.numPages}</span>
    <button type="button" disabled={page>=document.numPages} onClick={()=>setPage(page+1)}>下一页</button>
    <button type="button" onClick={()=>setZoom(clampZoom(scale/1.25))}>缩小</button><span>{Math.round(scale*100)}%</span>
    <button type="button" onClick={()=>setZoom(clampZoom(scale*1.25))}>放大</button>
    <button type="button" onClick={()=>setZoom('width')}>适合宽度</button>
    <button type="button" onClick={()=>setZoom('page')}>适合页面</button>
    <button type="button" onClick={()=>setRotation((rotation+90)%360)}>旋转90°</button>
   </nav>
   <PdfFileNavigation document={document} page={page} onNavigate={setPage} onMatches={onMatches}/>
   <div style={{maxHeight:'70vh',overflow:'auto'}}>
    <PdfFilePage key={page} document={document} pageNumber={page} zoom={zoom} rotation={rotation} width={width} onScale={setScale}
     matches={search.matches.filter(match=>match.pageNumber===page)} selected={search.selected}/>
   </div>
  </>}
 </div>;
}
