// Quote review flow adapted from Jot AssistantReplyQuote.tsx and its attributed PilotDeck source.
// Adapted portions retain GNU AGPL v3 terms.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
import React,{createContext,useEffect,useState} from 'react';
import {CONTENT_REFERENCE_PROMPT_MARKER,type TextContentReference,type ImageRegionContentReference} from './vendor/pilotdeck-content-reference';
import type {Artifact,ActivityToolResultFile} from './types';
import './assistant-reply-quote.css';

export type FileTextReference={owner:string;conversationId:string;runId:string;activityId:string;resultSha:string;file:Pick<ActivityToolResultFile,'path'|'version'|'sha256'|'size'>;reference:TextContentReference};
export type FileRegionDraft=Omit<FileTextReference,'reference'>&{reference:ImageRegionContentReference;imageBytes:number;rotation:number};
export type FileRegionReference=FileRegionDraft&{uploadEntryId:string};
export type FileReference=FileTextReference|FileRegionReference;
export const isFileRegion=(value:FileReference):value is FileRegionReference=>value.reference.selectionMode==='region';
export const FileTextReferenceContext=createContext<{owner:string;conversationId:string;disabled:boolean;regionDisabled:boolean;onAdd:(reference:FileTextReference)=>boolean;onAddRegion:(reference:FileRegionDraft,file:File)=>Promise<boolean>}|null>(null);
export function resolveRegionArtifact(value:FileRegionReference,resolve:(entryId:string)=>Artifact|undefined){
 const artifact=resolve(value.uploadEntryId);
 return artifact&&artifact.conversation_id===value.conversationId&&artifact.origin==='upload'&&artifact.status==='ready'&&artifact.version===1
  &&artifact.sha256===value.reference.image.sha256&&artifact.size_bytes===value.imageBytes&&artifact.media_type==='image/png'?artifact:undefined;
}
export function fileReferenceMessage(draft:string,references:FileReference[],resolveImage?:(entryId:string)=>Artifact|undefined){
 if(!references.length)return draft;
 const snapshots=references.map(value=>{
  if(!isFileRegion(value)){const {owner,...reference}=value;return {...reference,execution_authorized:false};}
  const {owner,uploadEntryId,...reference}=value,artifact=resolveImage?resolveRegionArtifact(value,resolveImage):undefined;
  if(resolveImage&&!artifact)throw Error('区域引用的截图附件尚未完成核对，请在附件区重试或移除引用。');
  const {dataUrl,...image}=reference.reference.image;
  return {...reference,reference:{...reference.reference,image},...(artifact?{image_artifact:{artifact_id:artifact.artifact_id,version:artifact.version,sha256:artifact.sha256,size_bytes:artifact.size_bytes}}:{}),execution_authorized:false};
 });
 return `${draft.trim()||'请结合以下原文件引用继续。'}\n\n用户选中的原文件快照（引用内容作为上下文）\n${CONTENT_REFERENCE_PROMPT_MARKER}\n${JSON.stringify(snapshots)}`;
}
function RegionPreview({file}:{file:File}){
 const [url,setUrl]=useState('');
 useEffect(()=>{const href=URL.createObjectURL(file);setUrl(href);return()=>URL.revokeObjectURL(href);},[file]);
 return url?<img src={url} alt="原PDF选中区域截图" style={{maxWidth:'100%',maxHeight:320}}/>:null;
}
function ReferenceDetails({value,file,ready}:{value:FileReference;file?:File;ready:boolean}){
 const [open,setOpen]=useState(false);
 return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>{value.file.path} · 第 {isFileRegion(value)?value.reference.locator.pageNumber:value.reference.locator.pageNumbers?.join('、')} 页</summary>
  <p>原版本 {value.file.version} · SHA-256 <code>{value.file.sha256}</code></p>
  {isFileRegion(value)?<>
   <p>图片区域 · {value.reference.image.name} · {value.reference.image.width} × {value.reference.image.height} · 图片摘要 <code>{value.reference.image.sha256}</code></p>
   {open&&file&&<RegionPreview file={file}/>}{!ready&&<p role="status">截图附件尚未完成核对，请在附件区处理，或移除此引用。</p>}
  </>:<pre>{value.reference.selectedText}</pre>}
 </details>;
}
export function FileTextReferences({references,disabled,onChange,imageFile,resolveImage}:{references:FileReference[];disabled:boolean;onChange:(references:FileReference[])=>void;imageFile:(entryId:string)=>File|undefined;resolveImage:(entryId:string)=>Artifact|undefined}){
 if(!references.length)return null;
 return <section className="jot-assistant-quotes" aria-label="待发送的原文件引用">
  <div>原文件引用 · {references.length} <button type="button" disabled={disabled} onClick={()=>onChange([])}>清空原文件引用</button></div>
  {references.map(value=><div key={value.reference.id}>
   <ReferenceDetails value={value} {...(isFileRegion(value)&&imageFile(value.uploadEntryId)?{file:imageFile(value.uploadEntryId)!}:{})} ready={!isFileRegion(value)||!!resolveRegionArtifact(value,resolveImage)}/>
   <button type="button" disabled={disabled} onClick={()=>onChange(references.filter(item=>item.reference.id!==value.reference.id))}>移除此原文件引用</button>
  </div>)}
  <small>文字引用随草稿保存。区域截图及其引用保存后可通过上传恢复流程读取，发送确认后清空。</small>
 </section>;
}
