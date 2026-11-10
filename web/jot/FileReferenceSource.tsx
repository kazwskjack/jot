import React,{useEffect,useMemo,useRef} from 'react';
import ActivityToolFile from './ActivityToolFile';
import {isFileRegion,isFileCells,type FileSourceReference} from './FileTextReferences';
import {taskDraftScope} from './client';
import type {PdfReferenceFocus} from './pdf-file-view-state';

export default function FileReferenceSource({value,requestId,onClose}:{value:FileSourceReference;requestId:string;onClose:()=>void}){
 const root=useRef<HTMLElement>(null),owner=taskDraftScope();
 const focus=useMemo<PdfReferenceFocus>(()=>({
  key:requestId,
  pages:isFileCells(value)?[]:isFileRegion(value)?(value.reference.renderer.id==='pdf'?[{page:value.reference.locator.pageNumber!,rect:value.reference.locator.rect}]:[])
   :(value.reference.locator.pageNumbers??[]).map((page,index)=>({page,rect:value.reference.locator.rects?.[index]})),
  ...(!isFileCells(value)&&value.rotation!==undefined?{rotation:value.rotation}:{}),
 }),[value,requestId]);
 useEffect(()=>{root.current?.focus();root.current?.scrollIntoView({block:'nearest'});},[requestId]);
 if(owner!==value.owner)return <p role="alert">原引用所属账户已变化，请重新打开会话。</p>;
 return <section ref={root} tabIndex={-1} aria-label="原文件引用来源">
  <h3>原文件引用来源</h3>
  <button type="button" onClick={onClose}>关闭引用来源</button>
  <p>{value.file.path} · 原版本 {value.file.version} · SHA-256 <code>{value.file.sha256}</code></p>
  {!isFileRegion(value)&&!isFileCells(value)&&<details><summary>原引用文字</summary><blockquote>{value.reference.selectedText}</blockquote></details>}
  {isFileCells(value)&&<details><summary>原单元格引用快照</summary><pre>{JSON.stringify(value.reference.cells,null,2)}</pre></details>}
  <ActivityToolFile conversationId={value.conversationId} runId={value.runId} activityId={value.activityId} resultSha={value.resultSha} file={value.file} focus={focus} officeFocus={isFileCells(value)?{key:requestId,value}:undefined} officeRegionFocus={isFileRegion(value)&&value.reference.renderer.id==='docx'?{key:requestId,value}:undefined} officeTextFocus={!isFileRegion(value)&&!isFileCells(value)&&['docx','pptx'].includes(value.reference.renderer.id)?{key:requestId,value}:undefined}/>
 </section>;
}
