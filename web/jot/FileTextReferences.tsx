// Quote review flow adapted from Jot AssistantReplyQuote.tsx and its attributed PilotDeck source.
// Adapted portions retain GNU AGPL v3 terms.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
import React,{createContext} from 'react';
import {CONTENT_REFERENCE_PROMPT_MARKER,type TextContentReference} from './vendor/pilotdeck-text-reference';
import type {ActivityToolResultFile} from './types';
import './assistant-reply-quote.css';

export type FileTextReference={owner:string;conversationId:string;runId:string;activityId:string;resultSha:string;file:Pick<ActivityToolResultFile,'path'|'version'|'sha256'|'size'>;reference:TextContentReference};
export const FileTextReferenceContext=createContext<{owner:string;conversationId:string;disabled:boolean;onAdd:(reference:FileTextReference)=>boolean}|null>(null);
export function fileReferenceMessage(draft:string,references:FileTextReference[]){
 if(!references.length)return draft;
 const snapshots=references.map(({owner,...reference})=>({...reference,execution_authorized:false}));
 return `${draft.trim()||'请结合以下原文件引用继续。'}\n\n用户选中的原文件快照（引用内容作为上下文）\n${CONTENT_REFERENCE_PROMPT_MARKER}\n${JSON.stringify(snapshots)}`;
}
export function FileTextReferences({references,disabled,onChange}:{references:FileTextReference[];disabled:boolean;onChange:(references:FileTextReference[])=>void}){
 if(!references.length)return null;
 return <section className="jot-assistant-quotes" aria-label="待发送的原文件引用">
  <div>原文件引用 · {references.length} <button type="button" disabled={disabled} onClick={()=>onChange([])}>清空原文件引用</button></div>
  {references.map(value=><div key={value.reference.id}>
   <details><summary>{value.file.path} · 第 {value.reference.locator.pageNumbers?.join('、')} 页</summary>
    <p>原版本 {value.file.version} · SHA-256 <code>{value.file.sha256}</code></p><pre>{value.reference.selectedText}</pre>
   </details>
   <button type="button" disabled={disabled} onClick={()=>onChange(references.filter(item=>item.reference.id!==value.reference.id))}>移除此原文件引用</button>
  </div>)}
  <small>引用保留在当前页面，发送确认后清空。刷新页面会丢失待发送内容。</small>
 </section>;
}
