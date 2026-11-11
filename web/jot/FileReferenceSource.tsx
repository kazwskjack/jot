import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useEffect,useMemo,useRef} from 'react';
import ActivityToolFile from './ActivityToolFile';
import NativeSearchFile from './NativeSearchFile';
import {isFileRegion,isFileCells,type FileSourceReference} from './FileTextReferences';
import {taskDraftScope} from './client';
import type {PdfReferenceFocus} from './pdf-file-view-state';

export default function FileReferenceSource({value,requestId,onClose}:{value:FileSourceReference;requestId:string;onClose:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const root=useRef<HTMLElement>(null),owner=taskDraftScope();
 const focus=useMemo<PdfReferenceFocus>(()=>({
  key:requestId,
  pages:isFileCells(value)?[]:isFileRegion(value)?(['pdf','office-pdf'].includes(value.reference.renderer.id)?[{page:value.reference.locator.pageNumber!,rect:value.reference.locator.rect}]:[])
   :(value.reference.locator.pageNumbers??[]).map((page,index)=>({page,rect:value.reference.locator.rects?.[index]})),
  ...(!isFileCells(value)&&value.rotation!==undefined?{rotation:value.rotation}:{}),
 }),[value,requestId]);
 useEffect(()=>{root.current?.focus();root.current?.scrollIntoView({block:'nearest'});},[requestId]);
 if(owner!==value.owner)return <p lang={language} role="alert">{t("原引用所属账户已变化，请重新打开会话。","The account owning the original reference has changed. Reopen the conversation.")}</p>;
 return <section lang={language} ref={root} tabIndex={-1} aria-label={t("原文件引用来源","Original File Reference Source")}>
  <h3>{t('原文件引用来源','Original File Reference Source')}</h3>
  <button type="button" onClick={onClose}>{t('关闭引用来源','Close Reference Source')}</button>
  <p>{value.file.path} · {t('原版本','Original Version')} {value.native_source?.openSha??value.file.version} · SHA-256 <code>{value.file.sha256}</code></p>
  {value.print_view&&<p>{t('原转换PDF','Original Converted PDF')} · {t(`${value.print_view.pageCount}页`,`${value.print_view.pageCount} pages`)} · SHA-256 <code>{value.print_view.sha256}</code></p>}
  {!isFileRegion(value)&&!isFileCells(value)&&<details><summary>{t('原引用文字','Original Quoted Text')}</summary><blockquote>{value.reference.selectedText}</blockquote></details>}
  {isFileCells(value)&&<details><summary>{t('原单元格引用快照','Original Cell Reference Snapshot')}</summary><pre>{JSON.stringify(value.reference.cells,null,2)}</pre></details>}
  <div lang="zh-CN">{value.native_source?<NativeSearchFile key={requestId} source={{conversationId:value.conversationId,runId:value.runId,activityId:value.activityId,
   resultSha:value.resultSha,membersSha:value.native_source.membersSha,member:{index:value.native_source.memberIndex,path:value.file.path},
   ...(value.native_source.asOfSeq!==undefined?{asOfSeq:value.native_source.asOfSeq}:{})}}
   expected={{openSha:value.native_source.openSha,proof:value.native_source.proof,sha256:value.file.sha256,size:value.file.size}}
   printPin={value.print_view?{openSha:value.native_source.openSha,openProof:value.native_source.proof,sourceSha:value.file.sha256,sourceSize:value.file.size,
    sha256:value.print_view.sha256,size:value.print_view.size,pageCount:value.print_view.pageCount,pdfProof:value.print_view.proof}:undefined} focus={focus} officeFocus={isFileCells(value)?{key:requestId,value}:undefined} officeTextFocus={!isFileRegion(value)&&!isFileCells(value)&&['docx','pptx'].includes(value.reference.renderer.id)?{key:requestId,value}:undefined} officeRegionFocus={isFileRegion(value)&&['docx','pptx','xlsx'].includes(value.reference.renderer.id)?{key:requestId,value}:undefined}/>
   :typeof value.file.version==='number'?<ActivityToolFile conversationId={value.conversationId} runId={value.runId} activityId={value.activityId} resultSha={value.resultSha} file={{path:value.file.path,version:value.file.version,sha256:value.file.sha256,size:value.file.size}} focus={focus} printFocus={value.print_view?{...focus,view:value.print_view}:undefined} officeFocus={isFileCells(value)?{key:requestId,value}:undefined} officeRegionFocus={isFileRegion(value)&&['docx','pptx','xlsx'].includes(value.reference.renderer.id)?{key:requestId,value}:undefined} officeTextFocus={!isFileRegion(value)&&!isFileCells(value)&&['docx','pptx'].includes(value.reference.renderer.id)?{key:requestId,value}:undefined}/>:<p lang={language} role="alert">{t('原文件引用来源尚未确认。','The original file reference source is unconfirmed.')}</p>}</div>
 </section>;
}
