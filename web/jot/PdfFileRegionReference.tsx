// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// Original source ui/src/components/code-editor/view/subcomponents/RegionSelectionOverlay.tsx.
// Adapted portions retain GNU AGPL v3 terms.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
// Jot crops the completed PDF canvas and hands PNG bytes to the existing upload lifecycle.
import React,{useContext,useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {taskDraftScope} from './client';
import {FileTextReferenceContext} from './FileTextReferences';
import {createImageRegionContentReference,normalizeRect,type NormalizedRect} from './vendor/pilotdeck-content-reference';
import type {ListedFilePreviewSource} from './activity-file-preview-client';

// Native PNG encoding is allowed one in-flight bitmap across open PDF viewers.
let captureInFlight=false;

type Rect={left:number;top:number;right:number;bottom:number};
type Target={canvas:HTMLCanvasElement;page:number;bounds:DOMRect};
const fromPoints=(x:number,y:number,endX:number,endY:number):Rect=>({left:Math.min(x,endX),top:Math.min(y,endY),right:Math.max(x,endX),bottom:Math.max(y,endY)});
const clamp=(rect:Rect,bounds:DOMRect):Rect=>({left:Math.max(bounds.left,Math.min(bounds.right,rect.left)),top:Math.max(bounds.top,Math.min(bounds.bottom,rect.top)),right:Math.max(bounds.left,Math.min(bounds.right,rect.right)),bottom:Math.max(bounds.top,Math.min(bounds.bottom,rect.bottom))});
const normalized=(rect:Rect,bounds:DOMRect)=>normalizeRect({x:(rect.left-bounds.left)/bounds.width,y:(rect.top-bounds.top)/bounds.height,width:(rect.right-rect.left)/bounds.width,height:(rect.bottom-rect.top)/bounds.height});

export default function PdfFileRegionReference({root,source,page,rotation}:{root:RefObject<HTMLDivElement|null>;source:ListedFilePreviewSource;page:number;rotation:number}){
 const context=useContext(FileTextReferenceContext),latest=useRef(context);latest.current=context;
 const owner=taskDraftScope(),identity=JSON.stringify([owner,source,rotation]),sourceIdentity=useRef(identity);sourceIdentity.current=identity;
 const disabled=!context||context.disabled||context.regionDisabled||context.owner!==owner||context.conversationId!==source.conversationId;
 const [active,setActive]=useState(false),[bounds,setBounds]=useState<DOMRect>(),[target,setTarget]=useState<Target>(),[rect,setRect]=useState<Rect>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const overlay=useRef<HTMLDivElement>(null),panel=useRef<HTMLElement>(null),start=useRef<{x:number;y:number;target:Target}|undefined>(undefined),sequence=useRef(0),capturing=useRef(false);
 const cancel=()=>{sequence.current++;capturing.current=false;start.current=undefined;setActive(false);setTarget(undefined);setRect(undefined);setBusy(false);};
 const resolve=(element:Element|null):Target|undefined=>{
  const anchor=element?.closest<HTMLElement>('[data-pdf-page-anchor]');
  const canvas=anchor?.querySelector<HTMLCanvasElement>('canvas[data-pdf-capture-ready="true"]');
  if(!anchor||!canvas||!root.current?.contains(canvas)||!canvas.width||!canvas.height)return;
  return {canvas,page:Number(anchor.dataset.pdfPageAnchor),bounds:canvas.getBoundingClientRect()};
 };
 useEffect(()=>{
  if(!active||disabled){sequence.current++;capturing.current=false;setActive(false);setBusy(false);setTarget(undefined);setRect(undefined);return;}
  const update=(event?:Event)=>{if(event?.target instanceof Node&&panel.current?.contains(event.target))return;sequence.current++;capturing.current=false;start.current=undefined;setBusy(false);setTarget(undefined);setRect(undefined);setBounds(root.current?.getBoundingClientRect());};
  const keyboard=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}};
  window.getSelection()?.removeAllRanges();update();window.document.addEventListener('keydown',keyboard);window.addEventListener('scroll',update,true);window.addEventListener('resize',update);
  return()=>{sequence.current++;window.document.removeEventListener('keydown',keyboard);window.removeEventListener('scroll',update,true);window.removeEventListener('resize',update);};
 },[active,disabled,identity,root]);
 useEffect(()=>{if(active&&bounds)panel.current?.querySelector<HTMLButtonElement>('button')?.focus();},[active,!!bounds]);
 useEffect(()=>()=>{sequence.current++;},[]);
 const selectPage=()=>{
  const canvas=root.current?.querySelector<HTMLElement>(`[data-pdf-page-anchor="${page}"]`),value=resolve(canvas??null);
  if(!value){setError('当前PDF页面尚未完成绘制，请稍后重试。');return;}
  setTarget(value);setRect({left:value.bounds.left,top:value.bounds.top,right:value.bounds.right,bottom:value.bounds.bottom});setError('');
 };
 const capture=async()=>{
  if(!target||!rect||capturing.current)return;
  if(captureInFlight){setError('上一张截图仍在处理，请稍后重试。');return;}
  captureInFlight=true;
  const job=++sequence.current,expected=identity;capturing.current=true;setBusy(true);setError('');
  let allocated:HTMLCanvasElement|undefined;
  const check=()=>{
   const current=latest.current;
   if(sequence.current!==job||sourceIdentity.current!==expected||taskDraftScope()!==owner||!current
    ||current.disabled||current.regionDisabled||current.owner!==owner||current.conversationId!==source.conversationId)throw new DOMException('选区已变化','AbortError');
  };
  try{
   const crop=window.document.createElement('canvas');allocated=crop;
   check();const canvas=target.canvas,current=canvas.getBoundingClientRect();
   if(!canvas.isConnected||canvas.dataset.pdfCaptureReady!=='true'||!canvas.width||!canvas.height||Math.abs(current.left-target.bounds.left)>0.5||Math.abs(current.top-target.bounds.top)>0.5||Math.abs(current.width-target.bounds.width)>0.5||Math.abs(current.height-target.bounds.height)>0.5)throw Error('PDF页面已变化，请重新选择区域。');
   const selected=clamp(rect,current);
   if(selected.right-selected.left<8||selected.bottom-selected.top<8)throw Error('区域边长至少需要8个显示像素。');
   const canvasWidth=canvas.width,canvasHeight=canvas.height;
   const norm=normalized(selected,current),x=Math.floor(norm.x*canvasWidth),y=Math.floor(norm.y*canvasHeight);
   const endX=Math.min(canvasWidth,Math.ceil((norm.x+norm.width)*canvasWidth)),endY=Math.min(canvasHeight,Math.ceil((norm.y+norm.height)*canvasHeight));
   crop.width=endX-x;crop.height=endY-y;
   const drawing=crop.getContext('2d');if(!drawing||!crop.width||!crop.height)throw Error('区域画布暂不可用。');
   drawing.fillStyle='#ffffff';drawing.fillRect(0,0,crop.width,crop.height);
   drawing.drawImage(canvas,x,y,crop.width,crop.height,0,0,crop.width,crop.height);
   const blob=await new Promise<Blob>((resolve,reject)=>crop.toBlob(value=>value?resolve(value):reject(Error('截图编码失败')),'image/png'));check();
   const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join('');check();
   const name=`pdf-page-${target.page}-region-${crypto.randomUUID()}.png`,file=new File([blob],name,{type:'image/png'}),original=source.file;
   const reference=createImageRegionContentReference({
    selectionMode:'region',
    source:{relativePath:original.path,fileName:original.path.split('/').at(-1)!,mimeType:'application/pdf',revision:{id:String(original.version),size:original.size,sha256:original.sha256}},
    renderer:{id:'pdf',backend:'builtin',locatorQuality:'visual'},
    locator:{surface:'page',pageNumber:target.page,rect:{x:x/canvasWidth,y:y/canvasHeight,width:crop.width/canvasWidth,height:crop.height/canvasHeight}},
    image:{name,mimeType:'image/png',width:crop.width,height:crop.height,sha256:sha},
   });
   crop.width=0;crop.height=0;
   const accepted=await latest.current!.onAddRegion({owner,conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,file:{path:original.path,version:original.version,sha256:original.sha256,size:original.size},reference,imageBytes:file.size,rotation},file);
   if(sourceIdentity.current===expected){if(accepted)cancel();else if(sequence.current===job)setError('截图引用未被接收，请查看当前对话的提示。');}
  }catch(error){if(sequence.current===job&&(error as DOMException)?.name!=='AbortError')setError(error instanceof Error?error.message:'区域截图失败');}
  finally{captureInFlight=false;if(allocated){allocated.width=0;allocated.height=0;}if(sequence.current===job){capturing.current=false;setBusy(false);}}
 };
 const norm=target&&rect?normalized(rect,target.bounds):undefined;
 const adjust=(field:keyof NormalizedRect,value:number)=>{
  if(!target||!norm||!Number.isFinite(value))return;
  const next=normalizeRect({...norm,[field]:value/100}),bounds=target.bounds;
  setRect({left:bounds.left+next.x*bounds.width,top:bounds.top+next.y*bounds.height,right:bounds.left+(next.x+next.width)*bounds.width,bottom:bounds.top+(next.y+next.height)*bounds.height});
 };
 if(!context)return null;
 return <section aria-label="PDF区域引用" data-chat-search-ignore>
  <button type="button" disabled={disabled||active} onClick={()=>{setError('');setActive(true);}}>框选PDF区域</button>
  {active&&bounds&&createPortal(<>
   <div ref={overlay} role="region" aria-label="拖动选择PDF区域" style={{position:'fixed',zIndex:110,left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height,cursor:'crosshair',touchAction:'none',background:'rgba(60,120,255,0.04)'}}
    onPointerDown={event=>{
     if(busy||event.button!==0)return;event.preventDefault();const element=event.currentTarget;element.style.pointerEvents='none';const value=resolve(window.document.elementFromPoint(event.clientX,event.clientY));element.style.pointerEvents='';
     if(!value){setError('请从已绘制的PDF页面内开始选择。');return;}
     element.setPointerCapture(event.pointerId);start.current={x:event.clientX,y:event.clientY,target:value};setTarget(value);setRect(fromPoints(event.clientX,event.clientY,event.clientX,event.clientY));setError('');
    }}
    onPointerMove={event=>{const value=start.current;if(value)setRect(clamp(fromPoints(value.x,value.y,event.clientX,event.clientY),value.target.bounds));}}
    onPointerUp={event=>{const value=start.current;start.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(value)setRect(clamp(fromPoints(value.x,value.y,event.clientX,event.clientY),value.target.bounds));}}
    onPointerCancel={()=>{start.current=undefined;setRect(undefined);setTarget(undefined);}}>
    {rect&&<div style={{position:'absolute',pointerEvents:'none',left:rect.left-bounds.left,top:rect.top-bounds.top,width:rect.right-rect.left,height:rect.bottom-rect.top,border:'2px solid currentColor',background:'rgba(60,120,255,0.15)'}}/>}
   </div>
   <section ref={panel} role="dialog" aria-label="PDF区域引用控件" style={{position:'fixed',zIndex:112,left:8,right:8,bottom:8,maxHeight:'40vh',overflow:'auto',padding:12,background:'var(--jot-background,white)',border:'1px solid currentColor'}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();cancel();}}}>
   <button type="button" disabled={busy} onClick={selectPage}>选择当前整页</button><button type="button" onClick={cancel}>取消区域引用</button>
   <fieldset disabled={busy||!norm}><legend>调整区域百分比</legend>{([['x','左边'],['y','顶部'],['width','宽度'],['height','高度']] as const).map(([field,label])=><label key={field}>{label}<input type="number" min={0} max={100} step={0.1} value={norm?Math.round(norm[field]*1000)/10:0} onChange={event=>adjust(field,Number(event.target.value))}/></label>)}<button type="button" onClick={()=>void capture()}>添加截图引用</button></fieldset>
    {busy&&<p role="status">正在核对区域截图…</p>}{error&&<p role="alert">{error}</p>}
   </section>
  </>,window.document.body)}
 </section>;
}
