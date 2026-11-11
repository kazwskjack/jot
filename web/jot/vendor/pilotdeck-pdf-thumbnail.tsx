import {useApplicationLanguage,useApplicationText} from '../application-language';
// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// Original source ui/src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx, PdfThumbnail.
// Upstream GNU Affero General Public License v3.0 terms apply.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
// Jot uses a bounded thumbnail window, intrinsic page rotation and explicit canvas/page cleanup.
import React,{useEffect,useRef,useState,type RefObject} from 'react';
import type {PDFDocumentProxy,PDFPageProxy,RenderTask} from 'pdfjs-dist';

export default function PdfThumbnail({document,pageNumber,rotation,active,navigationRoot,onSelect}:{document:PDFDocumentProxy;pageNumber:number;rotation:number;active:boolean;navigationRoot:RefObject<HTMLDivElement|null>;onSelect:(page:number)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const button=useRef<HTMLButtonElement>(null),canvas=useRef<HTMLCanvasElement>(null);
 const [visible,setVisible]=useState(false),[error,setError]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{
  const element=button.current;if(!element)return;
  const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{root:navigationRoot.current,rootMargin:'600px 0px'});
  observer.observe(element);return()=>observer.disconnect();
 },[navigationRoot]);
 useEffect(()=>{if(active)button.current?.scrollIntoView({block:'nearest'});},[active]);
 useEffect(()=>{
  if(!visible)return;
  const target=canvas.current!;let cancelled=false,page:PDFPageProxy|undefined,render:RenderTask|undefined;
  setError(false);
  const draw=async()=>{
   page=await document.getPage(pageNumber);if(cancelled)return;
   const angle=(page.rotate+rotation)%360,base=page.getViewport({scale:1,rotation:angle});
   if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<=0||base.height<=0)throw Error('pdf_thumbnail_dimensions_invalid');
   const scale=Math.min(116/base.width,124/base.height),viewport=page.getViewport({scale,rotation:angle});
   const ratio=Math.min(Math.max(window.devicePixelRatio||1,1),2);
   target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));
   target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
   render=page.render({canvas:target,viewport,transform:[ratio,0,0,ratio,0,0]});await render.promise;
  };
  void draw().catch(()=>{if(!cancelled)setError(true);}).finally(()=>{try{page?.cleanup();}catch{}});
  return()=>{
   cancelled=true;render?.cancel();target.width=0;target.height=0;
   void Promise.resolve(render?.promise).catch(()=>{}).then(()=>{try{page?.cleanup();}catch{}});
  };
 },[document,pageNumber,rotation,visible,revision]);
 return <div lang={language} style={{height:160,boxSizing:'border-box',padding:4}}>
  <button ref={button} type="button" aria-label={t(`查看PDF第 ${pageNumber} 页`,`View PDF Page ${pageNumber}`)} aria-current={active?'page':undefined} onClick={()=>onSelect(pageNumber)} style={{display:'block',width:'100%',height:error?128:152,border:active?'2px solid currentColor':undefined}}>
   <span style={{display:'flex',alignItems:'center',justifyContent:'center',height:124}}><canvas ref={canvas} aria-hidden="true" style={{display:error?'none':'block'}}/>{error&&<span>{t('缩略图暂不可用','Thumbnail Unavailable')}</span>}</span>
   <span>{t(`第 ${pageNumber} 页`,`Page ${pageNumber}`)}</span>
  </button>
  {error&&<button type="button" onClick={()=>setRevision(value=>value+1)} aria-label={t(`重试PDF第 ${pageNumber} 页缩略图`,`Retry Thumbnail for PDF Page ${pageNumber}`)}>{t('重试缩略图','Retry Thumbnail')}</button>}
 </div>;
}
