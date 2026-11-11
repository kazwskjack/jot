import {taskDraftScope} from './client';
import {pdfViewIdentity} from './pdf-file-view-state';
import type {FileViewingIdentity} from './activity-file-preview-client';
import {cellRangeCoordinates,validateOfficeRegionView} from '../../packages/gateway/src/messages/content-reference.js';

export type OfficeViewKind='docx'|'pptx'|'xlsx';
export type StructuredOfficeViewKind='structured-docx'|'structured-pptx'|'structured-xlsx';
type StoredViewKind=OfficeViewKind|StructuredOfficeViewKind;
export type StructuredOfficeView={protocol:1;kind:'structured-docx'|'structured-pptx';part:number;page:number;table:number;column:number;left:number}
 |{protocol:1;kind:'structured-xlsx';sheet:number;page:number;rowPage:number;columnPage:number;left:number;range?:string};
type Position={pageTop:number;pageLeft:number;top:number;left:number};
export type OfficeViewState=StructuredOfficeView|({protocol:1;kind:'docx';zoom:number;outlinePage:number}&Position)
 |({protocol:1;kind:'pptx';slide:number;zoom:number;thumbnails:boolean;thumbnailPage:number}&Position)
 |{protocol:1;kind:'xlsx';sheetId:string;sheetName:string;zoom:number;scroll:{sheetViewStartRow:number;sheetViewStartColumn:number;offsetX:number;offsetY:number}};
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).sort().join(',')===keys.sort().join(',');
const number=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export function validOfficeView(value:unknown,kind:StoredViewKind):value is OfficeViewState{
 if(!['docx','pptx','xlsx','structured-docx','structured-pptx','structured-xlsx'].includes(kind)||!value||typeof value!=='object'||Array.isArray(value))return false;
 const view=value as Record<string,unknown>;
 if(view.protocol!==1||view.kind!==kind)return false;
 if(kind.startsWith('structured-')){
  if(!number(view.left,0,33554432)||!Number.isSafeInteger(view.page)||!number(view.page,0,1048575))return false;
  if(kind==='structured-xlsx'){
   if(!exact(view,['protocol','kind','sheet','page','rowPage','columnPage','left',...(Object.hasOwn(view,'range')?['range']:[])])
    ||!Number.isSafeInteger(view.sheet)||!number(view.sheet,0,99)||!Number.isSafeInteger(view.rowPage)||!number(view.rowPage,0,52428)
    ||!Number.isSafeInteger(view.columnPage)||!number(view.columnPage,0,1638))return false;
   try{if(view.range!==undefined)cellRangeCoordinates(view.range);return true;}catch{return false;}
  }
  return exact(view,['protocol','kind','part','page','table','column','left'])&&Number.isSafeInteger(view.part)&&number(view.part,0,kind==='structured-docx'?1:0)
   &&Number.isSafeInteger(view.table)&&number(view.table,0,49999)&&Number.isSafeInteger(view.column)&&number(view.column,0,16383);
 }
 if(kind==='xlsx'){
  if(!exact(view,['protocol','kind','sheetId','sheetName','zoom','scroll']))return false;
  try{validateOfficeRegionView({protocol:view.protocol,sheetId:view.sheetId,sheetName:view.sheetName,zoom:view.zoom,scroll:view.scroll,width:1,height:1},'xlsx');return true;}catch{return false;}
 }
 const base=['protocol','kind','zoom','pageTop','pageLeft','top','left'];
 if(!['pageTop','pageLeft','top','left'].every(key=>number(view[key],0,33554432)))return false;
 return kind==='docx'?exact(view,[...base,'outlinePage'])&&number(view.zoom,0.25,3)&&Number.isSafeInteger(view.outlinePage)&&number(view.outlinePage,0,50000)
  :exact(view,[...base,'slide','thumbnails','thumbnailPage'])&&number(view.zoom,25,300)&&Number.isSafeInteger(view.slide)&&number(view.slide,1,50000)
   &&typeof view.thumbnails==='boolean'&&Number.isSafeInteger(view.thumbnailPage)&&number(view.thumbnailPage,0,12499);
}
type Entry={key:string;view:OfficeViewState};
const limit=32,memory=new Map<string,OfficeViewState>();
const storageKey=(owner:string)=>'jot.office-view.v1.'+encodeURIComponent(owner);
export const officeViewIdentity=(source:FileViewingIdentity,owner:string,kind:StoredViewKind)=>kind+':'+pdfViewIdentity(source,owner);
function entries(owner:string):Entry[]{
 const raw=globalThis.sessionStorage.getItem(storageKey(owner));if(!raw||raw.length>524288)return [];
 const data=JSON.parse(raw);if(data?.protocol!==1||!Array.isArray(data.entries)||data.entries.length>limit)return [];
 return data.entries.filter((item:Entry)=>item&&typeof item.key==='string'&&item.key.length<=8192&&validOfficeView(item.view,item.view?.kind));
}
export function readOfficeView(key:string,owner:string,kind:StoredViewKind):OfficeViewState|undefined{
 if(!owner||taskDraftScope()!==owner)return;
 try{const saved=entries(owner).find(item=>item.key===key&&validOfficeView(item.view,kind));if(saved)return structuredClone(saved.view);}catch{}
 const saved=memory.get(key);return validOfficeView(saved,kind)?structuredClone(saved):undefined;
}
export function writeOfficeView(key:string,owner:string,kind:StoredViewKind,view:unknown){
 if(!owner||taskDraftScope()!==owner||key.length>8192||!validOfficeView(view,kind))return;
 const saved=structuredClone(view);memory.delete(key);memory.set(key,saved);while(memory.size>limit)memory.delete(memory.keys().next().value!);
 try{const items=entries(owner).filter(item=>item.key!==key);items.push({key,view:saved});globalThis.sessionStorage.setItem(storageKey(owner),JSON.stringify({protocol:1,entries:items.slice(-limit)}));}catch{}
}
