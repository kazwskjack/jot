import React,{useEffect,useRef,useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import {renderPdfSearchHighlights,type PdfSearchMatch} from './vendor/pilotdeck-pdf-search';
import type {NormalizedRect} from './vendor/pilotdeck-content-reference';
export type Zoom=number|'width'|'page';
export const clampZoom=(value:number)=>Math.max(0.1,Math.min(4,value));

export default function PdfFilePage({document,pageNumber,zoom,rotation,width,onScale,matches,selected,onSize,onReady,referenceRect}:{document:pdfjs.PDFDocumentProxy;pageNumber:number;zoom:Zoom;rotation:number;width:number;onScale:(scale:number)=>void;matches:PdfSearchMatch[];selected:string|null;onSize?:(height:number)=>void;onReady?:(page:number)=>void;referenceRect?:NormalizedRect}){
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
   setSize({width:viewport.width,height:viewport.height,scale});onSize?.(viewport.height);
   render=page.render({canvas:target,viewport,transform:[ratio,0,0,ratio,0,0]});await render.promise;if(cancelled)return;
   const content=await page.getTextContent();if(cancelled)return;
   textTarget.replaceChildren();layer=new pdfjs.TextLayer({textContentSource:content,container:textTarget,viewport});
   await layer.render();
   if(!cancelled){mapping.current={divs:layer.textDivs,items:layer.textContentItemsStr};setTextRevision(value=>value+1);setBusy(false);onReady?.(pageNumber);}
  };
  void draw().catch(error=>{if(!cancelled){setError(error instanceof Error?error.message:'PDF页面绘制失败');setBusy(false);}}).finally(()=>{if(cancelled){try{page?.cleanup();}catch{}}});
  return()=>{
   cancelled=true;mapping.current=undefined;render?.cancel();layer?.cancel();target.width=0;target.height=0;textTarget.replaceChildren();
   void Promise.resolve(render?.promise).catch(()=>{}).then(()=>{try{page?.cleanup();}catch{}});
  };
 },[document,pageNumber,zoom,rotation,width,onScale,onSize,onReady]);
 useEffect(()=>{
  if(!mapping.current)return;
  const element=renderPdfSearchHighlights(mapping.current.divs,mapping.current.items,matches,selected);
  element?.scrollIntoView({block:'center',inline:'nearest'});
 },[matches,selected,textRevision]);
 return <>
  {busy&&<p role="status">正在绘制第 {pageNumber} 页…</p>}
  {error&&<p role="alert">{error}</p>}
  <div data-pdf-page-anchor={pageNumber} style={{position:'relative',width:size.width,height:size.height,'--scale-factor':size.scale,'--total-scale-factor':size.scale} as React.CSSProperties}>
   <canvas ref={canvas} aria-hidden="true" data-pdf-capture-ready={!busy&&!error?'true':undefined}/>
   <div ref={text} className="textLayer" aria-label={`PDF第 ${pageNumber} 页文字`} style={{position:'absolute',inset:0}}/>
   {referenceRect&&<div role="img" aria-label="原引用选区" data-pdf-reference-region="" style={{position:'absolute',pointerEvents:'none',zIndex:4,left:`${referenceRect.x*100}%`,top:`${referenceRect.y*100}%`,width:`${referenceRect.width*100}%`,height:`${referenceRect.height*100}%`,outline:'2px solid #b45309',background:'rgba(255,197,0,.18)'}}/>}
  </div>
 </>;
}
