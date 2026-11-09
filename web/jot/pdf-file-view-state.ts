import {taskDraftScope} from './client';
import type {ListedFilePreviewSource} from './activity-file-preview-client';
import type {Zoom} from './PdfFilePage';

import type {NormalizedRect} from './vendor/pilotdeck-content-reference';

export type PdfReferenceFocus={key:string;pages:Array<{page:number;rect?:NormalizedRect}>;rotation?:number};
export type PdfViewState={page:number;zoom:Zoom;rotation:number;continuous:boolean;position:number;left:number};
export const defaultPdfView:PdfViewState={page:1,zoom:'width',rotation:0,continuous:false,position:0,left:0};
const limit=32,memory=new Map<string,PdfViewState>();
type Entry={key:string;view:PdfViewState};
export function pdfViewIdentity(source:ListedFilePreviewSource,owner:string){
 const {conversationId,runId,activityId,resultSha,file}=source;
 return JSON.stringify([owner,conversationId,runId,activityId,resultSha,file.path,file.version,file.sha256,file.size]);
}
function valid(value:unknown):value is PdfViewState{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const view=value as Record<string,unknown>;
 return Object.keys(view).sort().join(',')==='continuous,left,page,position,rotation,zoom'
  &&Number.isSafeInteger(view.page)&&Number(view.page)>=1
  &&(view.zoom==='width'||view.zoom==='page'||typeof view.zoom==='number'&&Number.isFinite(view.zoom)&&view.zoom>=0.1&&view.zoom<=4)
  &&[0,90,180,270].includes(Number(view.rotation))&&typeof view.rotation==='number'&&typeof view.continuous==='boolean'
  &&typeof view.position==='number'&&Number.isFinite(view.position)&&view.position>=0&&view.position<=1
  &&typeof view.left==='number'&&Number.isFinite(view.left)&&view.left>=0&&view.left<=Number.MAX_SAFE_INTEGER;
}
function entries(owner:string):Entry[]{
 const raw=globalThis.sessionStorage.getItem('jot.pdf-view.v1.'+encodeURIComponent(owner));
 if(!raw||raw.length>524288)return [];
 const parsed=JSON.parse(raw);
 if(!parsed||parsed.schema!==1||!Array.isArray(parsed.entries)||parsed.entries.length>limit)return [];
 return parsed.entries.filter((entry:unknown):entry is Entry=>{
  if(!entry||typeof entry!=='object')return false;
  const item=entry as Record<string,unknown>;
  return typeof item.key==='string'&&item.key.length<=8192&&valid(item.view);
 }).map((entry:Entry)=>({key:entry.key,view:{...entry.view}}));
}
export function readPdfView(key:string,owner:string):PdfViewState|undefined{
 if(!owner||taskDraftScope()!==owner)return;
 try{const saved=entries(owner).find(entry=>entry.key===key);if(saved)return {...saved.view};}catch{}
 const saved=memory.get(key);return saved?{...saved}:undefined;
}
export function writePdfView(key:string,owner:string,view:PdfViewState){
 if(!owner||taskDraftScope()!==owner||key.length>8192||!valid(view))return;
 memory.delete(key);memory.set(key,{...view});while(memory.size>limit)memory.delete(memory.keys().next().value!);
 try{const saved=entries(owner).filter(entry=>entry.key!==key);saved.push({key,view});globalThis.sessionStorage.setItem('jot.pdf-view.v1.'+encodeURIComponent(owner),JSON.stringify({schema:1,entries:saved.slice(-limit)}));}catch{}
}

export function capturePdfView(element:HTMLDivElement|null,view:PdfViewState):PdfViewState{
 if(!element)return {page:view.page,zoom:view.zoom,rotation:view.rotation,continuous:view.continuous,position:view.position,left:view.left};
 const bounds=element.getBoundingClientRect();let page=view.page;
 if(view.continuous){
  const hit=window.document.elementFromPoint(bounds.left+Math.min(16,bounds.width/2),bounds.top+Math.min(8,bounds.height/2));
  const slot=hit?.closest('[data-pdf-file-page]');
  if(slot&&element.contains(slot))page=Number(slot.getAttribute('data-pdf-file-page'));
 }
 const anchor=element.querySelector<HTMLElement>(view.continuous?`[data-pdf-file-page="${page}"]`:`[data-pdf-page-anchor="${page}"]`);
 const rect=anchor?.getBoundingClientRect();
 const position=rect&&rect.height>0?Math.max(0,Math.min(1,(bounds.top-rect.top)/rect.height)):view.position;
 return {page,zoom:view.zoom,rotation:view.rotation,continuous:view.continuous,position,left:Math.max(0,element.scrollLeft)};
}
