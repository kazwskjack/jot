// Selection lifecycle adapted from PdfFileTextReferenceAction.tsx and its retained PilotDeck source.
// Adapted portions retain GNU AGPL v3 terms.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
import React,{useContext,useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {taskDraftScope} from './client';
import {FileTextReferenceContext,type FileTextReference,type FileReferenceIdentity} from './FileTextReferences';
import {createTextContentReference} from './vendor/pilotdeck-content-reference';
import {officeTextOccurrence,type OfficeTextView} from './office-text-reference';

function selectionReferences(root:HTMLElement,range:Range,view:OfficeTextView,source:FileReferenceIdentity,owner:string){
 if(range.collapsed||!root.contains(range.startContainer)||!root.contains(range.endContainer))return [];
 const element=(node:Node)=>node instanceof Element?node:node.parentElement;
 if(!element(range.startContainer)?.closest('[data-office-text-block]')||!element(range.endContainer)?.closest('[data-office-text-block]'))return [];
 const references:FileTextReference[]=[];let total=0;
 for(const node of root.querySelectorAll<HTMLElement>('[data-office-text-block]')){
  if(!range.intersectsNode(node))continue;
  if(!node.textContent?.trim())continue;
  const block=view.byKey.get(node.dataset.officeTextBlock??'');
  if(!block||node.textContent!==block.text)return [];
  const fragment=window.document.createRange();fragment.selectNodeContents(node);
  if(node.contains(range.startContainer))fragment.setStart(range.startContainer,range.startOffset);
  if(node.contains(range.endContainer))fragment.setEnd(range.endContainer,range.endOffset);
  const raw=fragment.toString(),selectedText=raw.trim();if(!selectedText)continue;
  total+=selectedText.length;if(total>100000)throw Error('选中文字超出消息范围，请缩小选区。');
  const before=window.document.createRange();before.selectNodeContents(node);before.setEnd(fragment.startContainer,fragment.startOffset);
  const start=block.offset+before.toString().length+raw.length-raw.trimStart().length;
  const occurrence=officeTextOccurrence(view.text,selectedText,{offset:start});
  if(!occurrence)return [];
  const occurrenceIndex=occurrence.index;
  const prefix=view.text.slice(Math.max(block.offset,start-80),start);
  const suffix=view.text.slice(start+selectedText.length,Math.min(block.offset+block.text.length,start+selectedText.length+80));
  const {conversationId,runId,activityId,resultSha,file}=source;
  const reference=createTextContentReference({selectionMode:'text',
   source:{relativePath:file.path,fileName:source.native_source?file.path.split(/[\\/]/).at(-1)!:file.path.split('/').at(-1)!,mimeType:view.kind==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/vnd.openxmlformats-officedocument.presentationml.presentation',revision:{id:source.native_source?.openSha??String(file.version),sha256:file.sha256,size:file.size}},
   renderer:{id:view.kind,backend:'builtin',locatorQuality:'semantic'},
   locator:{surface:view.kind==='docx'?'document':'slide',...(block.slide!==undefined?{slideNumbers:[block.slide]}:{}),quote:{exact:selectedText,prefix,suffix},occurrenceIndex},
   selectedText,surroundingText:prefix+selectedText+suffix,truncated:view.truncated});
  references.push({text_view:1,owner,conversationId,runId,activityId,resultSha,...(source.native_source?{native_source:source.native_source,file:{path:file.path,sha256:file.sha256,size:file.size}}:{file:{path:file.path,version:file.version!,sha256:file.sha256,size:file.size}}),reference});
 }
 return references;
}

type Action={identity:string;range:Range;references:FileTextReference[];top:number;left:number};
export default function OfficeTextReferenceAction({root,source,view}:{root:RefObject<HTMLElement|null>;source:FileReferenceIdentity;view:OfficeTextView}){
 const context=useContext(FileTextReferenceContext),current=useRef(context);current.current=context;
 const owner=taskDraftScope(),button=useRef<HTMLButtonElement>(null);
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,source.native_source,view.kind]);
 const [action,setAction]=useState<Action>(),[notice,setNotice]=useState('');
 const disabled=!!source.native_source&&!context?.nativeSources?.includes(1)||!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId;
 useEffect(()=>{
  setAction(undefined);setNotice('');if(disabled)return;
  let timer:number|undefined;
  const clear=()=>{window.clearTimeout(timer);setAction(undefined);setNotice('');};
  const update=()=>{
   if(taskDraftScope()!==owner||current.current?.disabled){clear();return;}
   if(window.document.activeElement===button.current)return;
   const selected=window.getSelection();
   if(!selected||selected.rangeCount!==1||selected.isCollapsed||!root.current){clear();return;}
   try{
    const range=selected.getRangeAt(0),references=selectionReferences(root.current,range,view,source,owner);
    if(!references.length){clear();return;}
    const rect=range.getBoundingClientRect();setNotice('');
    setAction({identity,range:range.cloneRange(),references,top:Math.max(8,Math.min(rect.bottom+8,window.innerHeight-48)),left:Math.max(8,Math.min(rect.left,window.innerWidth-228))});
   }catch(error){clear();setNotice(error instanceof Error?error.message:'文字选区尚未完成核对');}
  };
  const schedule=()=>{window.clearTimeout(timer);timer=window.setTimeout(update,40);};
  const changed=()=>{if(window.document.activeElement!==button.current)clear();};
  window.document.addEventListener('selectionchange',changed);window.document.addEventListener('mouseup',schedule);window.document.addEventListener('touchend',schedule);window.document.addEventListener('keyup',schedule);
  window.addEventListener('scroll',clear,true);window.addEventListener('resize',clear);
  return()=>{window.clearTimeout(timer);window.document.removeEventListener('selectionchange',changed);window.document.removeEventListener('mouseup',schedule);window.document.removeEventListener('touchend',schedule);window.document.removeEventListener('keyup',schedule);window.removeEventListener('scroll',clear,true);window.removeEventListener('resize',clear);};
 },[root,view,source,owner,disabled,identity]);
 const commit=()=>{
  const target=current.current;
  if(!action||action.identity!==identity||!root.current||!target||target.disabled||target.owner!==owner||taskDraftScope()!==owner||target.conversationId!==source.conversationId||!!source.native_source&&!target.nativeSources?.includes(1))return;
  let references:FileTextReference[];
  try{references=selectionReferences(root.current,action.range,view,source,owner);}catch{setAction(undefined);return;}
  if(!references.length||JSON.stringify(references.map(value=>value.reference.locator))!==JSON.stringify(action.references.map(value=>value.reference.locator))){setAction(undefined);return;}
  const added=target.onAddMany?target.onAddMany(references):references.length===1&&target.onAdd(references[0]);
  if(added){window.getSelection()?.removeAllRanges();setAction(undefined);}else setNotice('文字引用尚未保存，请检查草稿状态或缩小选区。');
 };
 return <>{notice&&<p role="alert">{notice}</p>}{action&&!disabled&&createPortal(<button ref={button} type="button" className="jot-assistant-quote-action" style={{top:action.top,left:action.left}} onPointerDown={event=>event.preventDefault()} onMouseDown={event=>event.preventDefault()} onClick={commit}>引用Office文字到当前对话</button>,window.document.body)}</>;
}
