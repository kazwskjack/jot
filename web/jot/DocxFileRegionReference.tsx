import React,{useContext,useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {FileTextReferenceContext,fileRegionCapture,type FileRegionDraft,type OfficeRegionFocus,type OfficeRegionView} from './FileTextReferences';
import {createImageRegionContentReference,type NormalizedRect} from './vendor/pilotdeck-content-reference';
import {validateRegionCaptureSource} from '../../packages/gateway/src/messages/content-reference.js';
import {readGeneratedPng} from './upload-recovery.mjs';
import type {ListedFilePreviewSource} from './activity-file-preview-client';

export type DocxRegionSession={window:Window;origin:string;token:string;live:()=>boolean;close:(message:string)=>void};
type Region={serial:number;rect:NormalizedRect;view:OfficeRegionView};
function readRegion(value:unknown):Region|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='rect,serial,view')return;
 const region=value as Region,rect=region.rect,view=region.view;
 if(!Number.isSafeInteger(region.serial)||region.serial<1||!rect||Array.isArray(rect)||Object.keys(rect).sort().join(',')!=='height,width,x,y'
  ||Object.values(rect).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)||!rect.width||!rect.height||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9
  ||!view||Array.isArray(view)||Object.keys(view).sort().join(',')!=='height,protocol,section,width'||view.protocol!==1||!Number.isSafeInteger(view.section)||view.section<1||view.section>50000
  ||[view.width,view.height].some(value=>typeof value!=='number'||!Number.isFinite(value)||value<=0||value>33554432))return;
 return region;
}
function originalFocus(focus:OfficeRegionFocus|undefined,source:ListedFilePreviewSource,owner:string){
 const value=focus?.value;
 if(!value||value.owner!==owner||value.conversationId!==source.conversationId||value.runId!==source.runId||value.activityId!==source.activityId||value.resultSha!==source.resultSha
  ||value.file.path!==source.file.path||value.file.version!==source.file.version||value.file.sha256!==source.file.sha256||value.file.size!==source.file.size||value.reference.renderer.id!=='docx')return;
 const capture={conversationId:value.conversationId,runId:value.runId,activityId:value.activityId,resultSha:value.resultSha,file:value.file,reference:value.reference,imageBytes:value.imageBytes,rotation:value.rotation,region_view:value.region_view};
 try{validateRegionCaptureSource(capture,source.conversationId);}catch{return;}
 return {rect:value.reference.locator.rect,view:value.region_view};
}

export default function DocxFileRegionReference({source,owner,session,focus}:{source:ListedFilePreviewSource;owner:string;session:DocxRegionSession;focus?:OfficeRegionFocus}){
 const context=useContext(FileTextReferenceContext),latest=useRef(context);latest.current=context;
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,focus?.key]);
 const [selection,setSelection]=useState<Region>(),selected=useRef<Region|undefined>(undefined),job=useRef<{selection:Region;lease:object;phase:'capture'|'png'|'upload'}|undefined>(undefined);
 const [phase,setPhase]=useState<'idle'|'capture'|'png'|'upload'>('idle'),[notice,setNotice]=useState(''),[ready,setReady]=useState(false),[confirmed,setConfirmed]=useState<boolean>();
 const startCapture=useRef<()=>void>(()=>{});
 const disabled=!context||context.disabled||context.regionDisabled||context.owner!==owner||context.conversationId!==source.conversationId||!context.regionRenderers?.includes('docx');
 const send=(type:string,payload:Record<string,unknown>)=>{if(session.live())session.window.postMessage({type,protocol:1,token:session.token,...payload},session.origin);};
 const release=()=>{if(job.current&&fileRegionCapture.owner===job.current.lease)fileRegionCapture.owner=undefined;};
 useEffect(()=>{send('jot-docx-region-enable',{enabled:!disabled});},[disabled,session]);
 useEffect(()=>{
  let active=true,timer:number|undefined;
  const canAdd=()=>{const ctx=latest.current;return active&&session.live()&&taskDraftScope()===owner&&!!ctx&&!ctx.disabled&&!ctx.regionDisabled&&ctx.owner===owner&&ctx.conversationId===source.conversationId&&!!ctx.regionRenderers?.includes('docx');};
  const receive=async(event:MessageEvent)=>{
   if(!active||!session.live()||event.source!==session.window||event.origin!==session.origin)return;
   const value=event.data;if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!==1||value.token!==session.token||Object.keys(value).length!==4)return;
   if(value.type==='jot-docx-region-ready'&&value.available===true){setReady(true);return;}
   if(value.type==='jot-docx-region-focus'&&typeof value.confirmed==='boolean'){setConfirmed(value.confirmed);return;}
   if(value.type==='jot-docx-region'){
    const next=readRegion(value.selection);selected.current=next;setSelection(next);return;
   }
   const current=job.current;
   if(!current)return;
   if(value.type==='jot-docx-capture-cancel'||value.type==='jot-docx-capture-error'){
    if(current.phase==='capture')session.close(value.type==='jot-docx-capture-cancel'?'Word截图已取消，请重新读取视觉内容。':'Word区域截图失败，请重新读取后重试。');return;
   }
   if(value.type!=='jot-docx-capture'||current.phase!=='capture')return;
   const capture=value.capture,region=readRegion(capture?.selection);
   try{
    if(!canAdd()||!capture||Object.keys(capture).sort().join(',')!=='bytes,height,nearbyText,selection,width'||typeof capture.nearbyText!=='string'||capture.nearbyText.length>1000||!region||JSON.stringify(region)!==JSON.stringify(current.selection)
     ||!(capture.bytes instanceof ArrayBuffer)||capture.bytes.byteLength<24||capture.bytes.byteLength>8*1024*1024
     ||!Number.isSafeInteger(capture.width)||!Number.isSafeInteger(capture.height)||capture.width<1||capture.height<1||capture.width>4096||capture.height>4096||capture.width*capture.height>4194304)throw Error('Word截图数据尚未通过来源或尺寸核对。');
    current.phase='png';setPhase('png');const metadata=await readGeneratedPng(capture.bytes);
    if(!canAdd()||job.current!==current)return;
    if(metadata.width!==capture.width||metadata.height!==capture.height)throw Error('Word截图PNG尺寸尚未确认。');
    window.clearTimeout(timer);
    const name=`word-region-${crypto.randomUUID()}.png`,file=new File([capture.bytes],name,{type:'image/png'}),original=source.file;
    const reference=createImageRegionContentReference({selectionMode:'region',source:{relativePath:original.path,fileName:original.path.split('/').at(-1)!,mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',revision:{id:String(original.version),sha256:original.sha256,size:original.size}},renderer:{id:'docx',backend:'builtin',locatorQuality:'visual'},locator:{surface:'document',rect:region.rect},image:{name,mimeType:'image/png',...metadata},nearbyText:capture.nearbyText});
    const draft:FileRegionDraft={owner,conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,file:{path:original.path,version:original.version,sha256:original.sha256,size:original.size},reference,imageBytes:file.size,rotation:0,region_view:region.view};
    current.phase='upload';setPhase('upload');setNotice('正在保存Word截图引用…');
    const accepted=await latest.current!.onAddRegion(draft,file);
    if(active&&session.live()){setNotice(accepted?'Word截图引用已交给原草稿和上传入口。':'截图引用尚未接收，请检查当前对话提示。');if(accepted)send('jot-docx-region-clear',{serial:region.serial});}
   }catch(error){if(active&&session.live())session.close(error instanceof Error?error.message:'Word截图核对失败。');}
   finally{release();if(job.current===current){job.current=undefined;if(active)setPhase('idle');}}
  };
  const message=(event:MessageEvent)=>{void receive(event).catch(()=>{if(active&&session.live())session.close('Word截图处理失败，请重新读取。');});};
  window.addEventListener('message',message);
  const original=originalFocus(focus,source,owner);if(focus&&!original)setConfirmed(false);
  send('jot-docx-region-probe',{focus:original??null});
  // A timer belongs to the current capture, and is also cleared when this viewer closes.
  startCapture.current=()=>{
   if(!canAdd()||!selected.current||job.current)return;
   if(fileRegionCapture.owner){setNotice('上一张截图仍在处理，请稍后重试。');return;}
   const lease={};fileRegionCapture.owner=lease;job.current={selection:selected.current,lease,phase:'capture'};setPhase('capture');setNotice('正在生成Word区域PNG…');
   timer=window.setTimeout(()=>{if(active&&session.live())session.close('Word截图超时，查看器已关闭，请重新读取。');},30000);
   send('jot-docx-capture',{serial:selected.current.serial});
  };
  return()=>{active=false;window.clearTimeout(timer);release();job.current=undefined;startCapture.current=()=>{};window.removeEventListener('message',message);};
 },[identity,session]);
 return <section aria-label="Word区域截图引用">
  {!context?.regionRenderers?.includes('docx')&&<p role="status">当前服务尚未声明Word截图的固定图片输入能力。</p>}
  {focus&&<p role="status">{confirmed===true?'已核对原Word分段尺寸并标记原截图区域。':confirmed===false?'原截图区域尚未与当前分段尺寸核对，请对照原PNG引用。':'正在核对原截图分段尺寸…'}</p>}
  {notice&&<p role="status">{notice}</p>}
  {selection&&<p>Word分段 {selection.view.section} 区域 · 宽 {(selection.rect.width*100).toFixed(1)}% · 高 {(selection.rect.height*100).toFixed(1)}%</p>}
  <button type="button" disabled={disabled||!ready||!selection||phase!=='idle'} onClick={()=>startCapture.current()}>生成截图并引用到当前对话</button>
  {(phase==='capture'||phase==='png')&&<button type="button" onClick={()=>session.close('Word截图已取消，请重新读取视觉内容。')}>取消截图并关闭查看器</button>}
 </section>;
}
