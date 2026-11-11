import type {OfficePrintView} from '../../packages/gateway/contracts/types';
import {officePreviewFormat} from '../../packages/gateway/src/artifacts/document-preview-content';
// Selection lifecycle adapted from Jot AssistantReplyQuote.tsx and PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// Adapted portions retain GNU AGPL v3 terms.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
import React,{useContext,useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {taskDraftScope} from './client';
import {FileTextReferenceContext,type FileTextReference,type FileReferenceIdentity} from './FileTextReferences';
import {createTextContentReference,type NormalizedRect} from './vendor/pilotdeck-content-reference';

function selectionSnapshot(root:HTMLElement,range:Range){
 if(!root.contains(range.startContainer)||!root.contains(range.endContainer)||range.collapsed)return;
 const element=(node:Node)=>node instanceof Element?node:node.parentElement;
 const start=element(range.startContainer)?.closest<HTMLElement>('.textLayer'),end=element(range.endContainer)?.closest<HTMLElement>('.textLayer');
 if(!start||!end||!root.contains(start)||!root.contains(end))return;
 const pages:number[]=[],rects:NormalizedRect[]=[],parts:string[]=[];
 for(const layer of root.querySelectorAll<HTMLElement>('[data-pdf-page-anchor] .textLayer')){
  if(!range.intersectsNode(layer))continue;
  const selected=window.document.createRange();selected.selectNodeContents(layer);
  if(layer.contains(range.startContainer))selected.setStart(range.startContainer,range.startOffset);
  if(layer.contains(range.endContainer))selected.setEnd(range.endContainer,range.endOffset);
  const text=selected.toString();if(!text.trim())continue;
  const page=layer.closest<HTMLElement>('[data-pdf-page-anchor]')!,bounds=page.getBoundingClientRect(),rect=selected.getBoundingClientRect();
  if(bounds.width<=0||bounds.height<=0)return;
  pages.push(Number(page.dataset.pdfPageAnchor));parts.push(text);
  rects.push({x:(rect.left-bounds.left)/bounds.width,y:(rect.top-bounds.top)/bounds.height,width:rect.width/bounds.width,height:rect.height/bounds.height});
 }
 const selectedText=parts.join('\n').replace(/\u00a0/g,' ').trim();if(!selectedText)return;
 const before=window.document.createRange();before.selectNodeContents(start);before.setEnd(range.startContainer,range.startOffset);
 const after=window.document.createRange();after.selectNodeContents(end);after.setStart(range.endContainer,range.endOffset);
 return {selectedText,pages,rects,prefix:before.toString().slice(-500),suffix:after.toString().slice(0,500)};
}

type Action={range:Range;reference:FileTextReference;top:number;left:number};
export default function PdfFileTextReferenceAction({root,source,rotation,printView}:{root:RefObject<HTMLElement|null>;source:FileReferenceIdentity;rotation:number;printView?:OfficePrintView}){
 const context=useContext(FileTextReferenceContext),current=useRef(context);current.current=context;
 const owner=taskDraftScope(),identity=JSON.stringify([owner,source,rotation,printView]),button=useRef<HTMLButtonElement>(null);
 const [action,setAction]=useState<Action>(),[notice,setNotice]=useState('');
 const printMime=printView?officePreviewFormat(source.file.path)?.mediaType:undefined;
 const disabled=!!source.native_source&&!context?.nativeSources?.includes(1)||!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId||!!printView&&(!printMime||!context.printViews?.includes(1));
 useEffect(()=>{
  setAction(undefined);setNotice('');if(disabled)return;
  let timer:number|undefined;
  const clear=()=>{window.clearTimeout(timer);setAction(undefined);setNotice('');};
  const update=()=>{
   if(taskDraftScope()!==owner||current.current?.disabled){clear();return;}
   if(window.document.activeElement===button.current)return;
   const selected=window.getSelection();if(!selected||selected.rangeCount!==1||selected.isCollapsed||!root.current){clear();return;}
   const range=selected.getRangeAt(0),snapshot=selectionSnapshot(root.current,range);if(!snapshot){clear();return;}
   if(snapshot.selectedText.length>100000){clear();setNotice('选中文字超出消息范围，请缩小选区。');return;}
   setNotice('');const {file,conversationId,runId,activityId,resultSha}=source;
   const reference=createTextContentReference({selectionMode:'text',source:{relativePath:file.path,fileName:source.native_source?file.path.split(/[\\/]/).at(-1)!:file.path.split('/').at(-1)!,mimeType:printMime??'application/pdf',revision:{id:source.native_source?.openSha??String(file.version),sha256:file.sha256,size:file.size}},renderer:{id:printView?'office-pdf':'pdf',backend:printView?'libreoffice':'builtin',locatorQuality:printView?'approximate':'semantic'},locator:{surface:'page',pageNumbers:snapshot.pages,quote:{exact:snapshot.selectedText,prefix:snapshot.prefix,suffix:snapshot.suffix},rects:snapshot.rects},selectedText:snapshot.selectedText,surroundingText:snapshot.prefix+snapshot.selectedText+snapshot.suffix});
   const rect=range.getBoundingClientRect();
   setAction({range:range.cloneRange(),reference:{...(printView?{print_view:printView}:{}),rotation,owner,conversationId,runId,activityId,resultSha,...(source.native_source?{native_source:source.native_source,file:{path:file.path,sha256:file.sha256,size:file.size}}:{file:{path:file.path,version:file.version!,sha256:file.sha256,size:file.size}}),reference},top:Math.max(8,Math.min(rect.bottom+8,window.innerHeight-48)),left:Math.max(8,Math.min(rect.left,window.innerWidth-228))});
  };
  const schedule=()=>{window.clearTimeout(timer);timer=window.setTimeout(update,40);};
  const changed=()=>{if(window.document.activeElement!==button.current)clear();};
  window.document.addEventListener('selectionchange',changed);window.document.addEventListener('mouseup',schedule);window.document.addEventListener('touchend',schedule);window.document.addEventListener('keyup',schedule);
  window.addEventListener('scroll',clear,true);window.addEventListener('resize',clear);
  return()=>{window.clearTimeout(timer);window.document.removeEventListener('selectionchange',changed);window.document.removeEventListener('mouseup',schedule);window.document.removeEventListener('touchend',schedule);window.document.removeEventListener('keyup',schedule);window.removeEventListener('scroll',clear,true);window.removeEventListener('resize',clear);};
 },[root,identity,disabled]);
 const commit=()=>{
  const target=current.current;if(!action||!root.current||!target||target.disabled||target.owner!==owner||taskDraftScope()!==owner||target.conversationId!==source.conversationId||!!source.native_source&&!target.nativeSources?.includes(1)||!!printView&&!target.printViews?.includes(1))return;
  const snapshot=selectionSnapshot(root.current,action.range);
  if(!snapshot||snapshot.selectedText!==action.reference.reference.selectedText||snapshot.pages.join(',')!==action.reference.reference.locator.pageNumbers?.join(',')){setAction(undefined);return;}
  if(target.onAdd(action.reference)){window.getSelection()?.removeAllRanges();setAction(undefined);}
 };
 return <>{notice&&<p role="alert">{notice}</p>}{action&&!disabled&&createPortal(<button ref={button} type="button" className="jot-assistant-quote-action" style={{top:action.top,left:action.left}} onPointerDown={event=>event.preventDefault()} onMouseDown={event=>event.preventDefault()} onClick={commit}>引用PDF文字到当前对话</button>,window.document.body)}</>;
}
