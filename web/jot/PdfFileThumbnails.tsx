import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import PdfThumbnail from './vendor/pilotdeck-pdf-thumbnail';

const rowHeight=160,overscan=2;
export default function PdfFileThumbnails({document,page,rotation,onNavigate}:{document:PDFDocumentProxy;page:number;rotation:number;onNavigate:(page:number)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const root=useRef<HTMLDivElement>(null);
 const [top,setTop]=useState(0),[height,setHeight]=useState(400);
 useEffect(()=>{
  const element=root.current;if(!element)return;
  const observer=new ResizeObserver(entries=>setHeight(entries[0]?.contentRect.height??400));
  observer.observe(element);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const element=root.current;if(!element)return;
  const target=(page-1)*rowHeight;
  if(target<element.scrollTop)element.scrollTop=target;
  else if(target+rowHeight>element.scrollTop+element.clientHeight)element.scrollTop=Math.max(0,target+rowHeight-element.clientHeight);
  setTop(element.scrollTop);
 },[document,page,height]);
 const start=Math.max(0,Math.min(document.numPages-1,Math.floor(top/rowHeight)-overscan));
 const end=Math.min(document.numPages,Math.ceil((top+height)/rowHeight)+overscan);
 const pages=Array.from({length:Math.max(0,end-start)},(_,index)=>start+index+1);
 return <div lang={language} ref={root} aria-label={t("PDF缩略图导航","PDF Thumbnail Navigation")} role="region" tabIndex={0} style={{height:400,overflowY:'auto',width:180,maxWidth:'100%'}} onScroll={event=>setTop(event.currentTarget.scrollTop)} data-chat-search-ignore>
  <div style={{height:document.numPages*rowHeight,position:'relative'}}>
   <div style={{position:'absolute',top:start*rowHeight,left:0,right:0}}>
    {pages.map(number=><PdfThumbnail key={number+':'+rotation} document={document} pageNumber={number} rotation={rotation} active={number===page} navigationRoot={root} onSelect={onNavigate}/>)}
   </div>
  </div>
 </div>;
}
