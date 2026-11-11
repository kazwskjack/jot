import {useApplicationLanguage,useApplicationText} from './application-language';
import type {NativeFileReferenceProvenance,NativeFileReferenceFile,OfficePrintView} from '../../packages/gateway/contracts/types';
// Quote review flow adapted from Jot AssistantReplyQuote.tsx and its attributed PilotDeck source.
// Adapted portions retain GNU AGPL v3 terms.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
import React,{createContext,useEffect,useState} from 'react';
import {CONTENT_REFERENCE_PROMPT_MARKER,type TextContentReference,type ImageRegionContentReference,type CellRangeContentReference} from './vendor/pilotdeck-content-reference';
import type {Artifact,ActivityToolResultFile} from './types';
import './assistant-reply-quote.css';

export type FileReferenceIdentity={conversationId:string;runId:string;activityId:string;resultSha:string;native_source?:NativeFileReferenceProvenance;file:Pick<ActivityToolResultFile,'path'|'version'|'sha256'|'size'>|(NativeFileReferenceFile&{version?:never})};
export const nativeReferenceIdentity=(source:NativeFileReferenceProvenance|undefined)=>source?JSON.stringify([source.protocol,source.membersSha,source.memberIndex,source.openSha,source.proof,source.asOfSeq??null]):undefined;
export type FileTextReference=FileReferenceIdentity&{print_view?:OfficePrintView;text_view?:1|2;rotation?:number;owner:string;reference:TextContentReference};
export type FileCellReference=Omit<FileTextReference,'reference'|'rotation'|'text_view'|'print_view'>&{print_view?:never;cell_view?:1|2;reference:CellRangeContentReference};
export type FileSelectionReference=FileTextReference|FileCellReference;
export type OfficeTextFocus={key:string;value:FileTextReference};
export type OfficeCellFocus={key:string;value:FileCellReference};
export type XlsxRegionView={protocol:1;width:number;height:number;sheetId:string;sheetName:string;zoom:number;scroll:{sheetViewStartRow:number;sheetViewStartColumn:number;offsetX:number;offsetY:number}};
export type OfficeRegionView=({protocol:1;width:number;height:number}&({section:number}|{slideNumber:number}))|XlsxRegionView;
export type FileRegionDraft=Omit<FileTextReference,'reference'|'text_view'>&{reference:ImageRegionContentReference;imageBytes:number;rotation:number;region_view?:OfficeRegionView};
export type OfficeRegionFocus={key:string;value:FileRegionDraft};
export const fileRegionCapture={owner:undefined as object|undefined};
export type FileRegionReference=FileRegionDraft&{uploadEntryId:string};
export type FileReference=FileSelectionReference|FileRegionReference;
export type FileSourceReference=FileSelectionReference|FileRegionDraft;
export function isFileRegion<T extends FileSourceReference>(value:T):value is Extract<T,FileRegionDraft>{return value.reference.selectionMode==='region';}
export function isFileCells<T extends FileSourceReference>(value:T):value is Extract<T,FileCellReference>{return value.reference.selectionMode==='cells';}
export const FileTextReferenceContext=createContext<{owner:string;conversationId:string;disabled:boolean;regionDisabled:boolean;cellViews?:Array<1|2>;printViews?:Array<1>;nativeSources?:Array<1>;regionRenderers?:Array<'pdf'|'docx'|'pptx'|'xlsx'|'office-pdf'>;onAdd:(reference:FileSelectionReference)=>boolean;onAddMany?:(references:FileTextReference[])=>boolean;onAddRegion:(reference:FileRegionDraft,file:File)=>Promise<boolean>}|null>(null);
export function resolveRegionArtifact(value:FileRegionReference,resolve:(entryId:string)=>Artifact|undefined){
 const artifact=resolve(value.uploadEntryId);
 return artifact&&artifact.conversation_id===value.conversationId&&artifact.origin==='upload'&&artifact.status==='ready'&&artifact.version===1
  &&artifact.sha256===value.reference.image.sha256&&artifact.size_bytes===value.imageBytes&&artifact.media_type==='image/png'?artifact:undefined;
}
export function fileReferenceSnapshots(references:FileReference[],resolveImage?:(entryId:string)=>Artifact|undefined){
 return references.map(value=>{
  if(!isFileRegion(value)){const {owner,...reference}=value;return {...reference,execution_authorized:false};}
  const {owner,uploadEntryId,...reference}=value,artifact=resolveImage?resolveRegionArtifact(value,resolveImage):undefined;
  if(resolveImage&&!artifact)throw Error('区域引用的截图附件尚未完成核对，请在附件区重试或移除引用。');
  const {dataUrl,...image}=reference.reference.image;
  return {...reference,reference:{...reference.reference,image},...(artifact?{image_artifact:{artifact_id:artifact.artifact_id,version:artifact.version,sha256:artifact.sha256,size_bytes:artifact.size_bytes}}:{}),execution_authorized:false};
 });
}
export function fileReferenceMessage(draft:string,references:FileReference[],resolveImage?:(entryId:string)=>Artifact|undefined){
 if(!references.length)return draft;
 const snapshots=fileReferenceSnapshots(references,resolveImage);
 return `${draft.trim()||'请结合以下原文件引用继续。'}\n\n用户选中的原文件快照（引用内容作为上下文）\n${CONTENT_REFERENCE_PROMPT_MARKER}\n${JSON.stringify(snapshots)}`;
}
function RegionPreview({file}:{file:File}){
 const t=useApplicationText();
 const [url,setUrl]=useState('');
 useEffect(()=>{const href=URL.createObjectURL(file);setUrl(href);return()=>URL.revokeObjectURL(href);},[file]);
 return url?<img src={url} alt={t("原文件选中区域截图","Screenshot of the Selected Original File Region")} style={{maxWidth:'100%',maxHeight:320}}/>:null;
}
export function FileReferenceDetails({value,file,ready}:{value:FileSourceReference;file?:File;ready?:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [open,setOpen]=useState(false);
 const location=isFileCells(value)?`${value.cell_view===2?t('原生视图 · ','Native View · '):''}${value.reference.locator.sheetName} · ${value.reference.locator.ranges.join('、')}`
  :isFileRegion(value)&&value.reference.renderer.id==='docx'?t('Word区域','Word Region')
  :isFileRegion(value)&&value.reference.renderer.id==='pptx'?t(`幻灯片 ${value.reference.locator.slideNumber} 区域`,`Slide ${value.reference.locator.slideNumber} Region`)
  :isFileRegion(value)&&value.reference.renderer.id==='xlsx'?t(`工作表 ${value.reference.locator.sheetName} 区域`,`Sheet ${value.reference.locator.sheetName} Region`)
  :!isFileRegion(value)&&value.reference.renderer.id==='docx'?t('Word文字','Word Text')
  :!isFileRegion(value)&&value.reference.renderer.id==='pptx'?t(`幻灯片 ${value.reference.locator.slideNumbers?.join('、')}`,`Slides ${value.reference.locator.slideNumbers?.join(', ')}`)
  :t(`第 ${isFileRegion(value)?value.reference.locator.pageNumber:value.reference.locator.pageNumbers?.join('、')} 页`,`Pages ${isFileRegion(value)?value.reference.locator.pageNumber:value.reference.locator.pageNumbers?.join(', ')}`);
 return <details lang={language} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{value.file.path} · {location}</summary>
  {value.print_view&&<p>{t('转换PDF','Converted PDF')} · {t(`${value.print_view.pageCount}页`,`${value.print_view.pageCount} pages`)} · {t('摘要','Digest')} <code>{value.print_view.sha256}</code> · {isFileRegion(value)?t('视觉区域定位','Visual Region Location'):t('近似文字定位','Approximate Text Location')}</p>}
  <p>{t('原版本','Original Version')} {value.native_source?.openSha??value.file.version} · SHA-256 <code>{value.file.sha256}</code></p>
  {isFileRegion(value)?<>
   <p>{t('图片区域','Image Region')} · {value.reference.image.name} · {value.reference.image.width} × {value.reference.image.height} · {t('图片摘要','Image Digest')} <code>{value.reference.image.sha256}</code></p>
   {value.reference.renderer.id==='xlsx'&&value.region_view&&<details><summary>{t('原工作表视口、缩放及滚动状态','Original Sheet Viewport, Zoom and Scroll State')}</summary><pre>{JSON.stringify(value.region_view,null,2)}</pre></details>}
   {open&&file&&<RegionPreview file={file}/>}{ready===false&&<p role="status">{t('截图附件尚未完成核对，请在附件区处理，或移除此引用。','The screenshot attachment is not yet verified. Resolve it in the attachments area or remove this reference.')}</p>}
  </>:isFileCells(value)?<pre>{JSON.stringify(value.reference.cells,null,2)}</pre>:<pre>{value.reference.selectedText}</pre>}
  {isFileCells(value)&&value.reference.headers&&<><p>{t('原选区上方行','Rows Above the Original Selection')}</p><pre>{JSON.stringify(value.reference.headers,null,2)}</pre></>}
  {isFileCells(value)&&value.reference.surroundingValues&&<><p>{t('原选区周边上下文','Context Around the Original Selection')}</p><pre>{JSON.stringify(value.reference.surroundingValues,null,2)}</pre></>}
 </details>;
}
export function FileTextReferences({references,disabled,onChange,imageFile,resolveImage,onOpen}:{references:FileReference[];disabled:boolean;onChange:(references:FileReference[])=>void;imageFile:(entryId:string)=>File|undefined;resolveImage:(entryId:string)=>Artifact|undefined;onOpen:(value:FileReference)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 if(!references.length)return null;
 return <section lang={language} className="jot-assistant-quotes" aria-label={t("待发送的原文件引用","Original File References to Send")}>
  <div>{t('原文件引用','Original File References')} · {references.length} <button type="button" disabled={disabled} onClick={()=>onChange([])}>{t('清空原文件引用','Clear Original File References')}</button></div>
  {references.map(value=><div key={value.reference.id}>
   <FileReferenceDetails value={value} {...(isFileRegion(value)&&imageFile(value.uploadEntryId)?{file:imageFile(value.uploadEntryId)!}:{})} ready={!isFileRegion(value)||!!resolveRegionArtifact(value,resolveImage)}/>
   <button type="button" onClick={()=>onOpen(value)}>{t('打开原文件并定位引用','Open Original File at Reference')}</button>
   <button type="button" disabled={disabled} onClick={()=>onChange(references.filter(item=>item.reference.id!==value.reference.id))}>{t('移除此原文件引用','Remove This Original File Reference')}</button>
  </div>)}
  <small>{t('文字引用随草稿保存。区域截图及其引用保存后可通过上传恢复流程读取，发送确认后清空。','Text references are saved with the draft. Saved region screenshots and their references can be restored through upload recovery and are cleared after sending is confirmed.')}</small>
 </section>;
}
