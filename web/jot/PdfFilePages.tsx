import React,{useCallback,useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import PdfFilePage,{type Zoom} from './PdfFilePage';
import type {PdfSearchMatch} from './vendor/pilotdeck-pdf-search';

const noMatches:PdfSearchMatch[]=[],ignoreScale=()=>{};
type PagesProps={document:PDFDocumentProxy;root:RefObject<HTMLDivElement|null>;page:number;navigationRevision:number;zoom:Zoom;rotation:number;width:number;onScale:(scale:number)=>void;onReady:(page:number)=>void;onVisiblePage:(page:number)=>void;matches:PdfSearchMatch[];selected:string|null};
function PageSlot({number,rendered,height,active,onHeight,...props}:Omit<PagesProps,'root'|'page'|'navigationRevision'|'onVisiblePage'>&{number:number;rendered:boolean;height:number;active:boolean;onHeight:(page:number,height:number)=>void}){
 const reportHeight=useCallback((height:number)=>onHeight(number,height+80),[number,onHeight]);
 return <article data-pdf-file-page={number} aria-label={`PDF第 ${number} 页`} style={{height,minWidth:'max-content',boxSizing:'border-box',padding:8,overflow:'hidden'}}>
  <h5 style={{margin:'4px 0'}}>第 {number} 页</h5>
  {rendered?<PdfFilePage key={JSON.stringify([props.zoom,props.rotation,props.width,active])} document={props.document} pageNumber={number} zoom={props.zoom} rotation={props.rotation} width={props.width} onScale={active?props.onScale:ignoreScale} matches={props.matches} selected={props.selected} onReady={props.onReady} onSize={reportHeight}/>:<p>第 {number} 页将在接近可见区域时载入。</p>}
 </article>;
}

export default function PdfFilePages(props:PagesProps){
 const {document,root,page,navigationRevision,onVisiblePage,matches}=props;
 const container=useRef<HTMLDivElement>(null),target=useRef({revision:navigationRevision,page});
 if(target.current.revision!==navigationRevision)target.current={revision:navigationRevision,page};
 const [rendered,setRendered]=useState<Set<number>>(()=>new Set()),[heights,setHeights]=useState<Record<number,number>>({});
 const pages=useMemo(()=>Array.from({length:document.numPages},(_,index)=>index+1),[document]);
 const grouped=useMemo(()=>{
  const groups=new Map<number,PdfSearchMatch[]>();
  for(const match of matches){let values=groups.get(match.pageNumber);if(!values){values=[];groups.set(match.pageNumber,values);}values.push(match);}
  return groups;
 },[matches]);
 const reportHeight=useCallback((number:number,height:number)=>setHeights(previous=>previous[number]===height?previous:{...previous,[number]:height}),[]);
 useEffect(()=>{
  const element=container.current,viewport=root.current;if(!element||!viewport)return;
  let active=true,lastPage=0;const visible=new Set<number>();
  const renderObserver=new IntersectionObserver(entries=>{
   if(!active)return;
   setRendered(previous=>{
    const next=new Set(previous);
    for(const entry of entries){const number=Number(entry.target.getAttribute('data-pdf-file-page'));if(entry.isIntersecting)next.add(number);else next.delete(number);}
    return next;
   });
  },{root:viewport,rootMargin:'600px 0px'});
  const visibleObserver=new IntersectionObserver(entries=>{
   if(!active)return;
   for(const entry of entries){const number=Number(entry.target.getAttribute('data-pdf-file-page'));if(entry.isIntersecting)visible.add(number);else visible.delete(number);}
   let first=document.numPages+1;for(const number of visible)first=Math.min(first,number);
   if(first<=document.numPages&&first!==lastPage){lastPage=first;onVisiblePage(first);}
  },{root:viewport});
  for(const slot of element.querySelectorAll('[data-pdf-file-page]')){renderObserver.observe(slot);visibleObserver.observe(slot);}
  return()=>{active=false;renderObserver.disconnect();visibleObserver.disconnect();};
 },[document,root,onVisiblePage]);
 useEffect(()=>{
  // Scroll requests are explicit. Passive visible-page updates preserve the user's scroll position.
  container.current?.querySelector(`[data-pdf-file-page="${target.current.page}"]`)?.scrollIntoView({block:'start',inline:'nearest'});
 },[document,navigationRevision]);
 const estimatedHeight=Math.max(300,props.width*1.4);
 return <div ref={container} aria-label="连续PDF页面">
  {pages.map(number=><PageSlot key={number} document={document} number={number} rendered={rendered.has(number)||number===page} height={heights[number]??estimatedHeight} active={number===page} zoom={props.zoom} rotation={props.rotation} width={props.width} onScale={props.onScale} onReady={props.onReady} onHeight={reportHeight} matches={grouped.get(number)??noMatches} selected={props.selected}/>)}
 </div>;
}
