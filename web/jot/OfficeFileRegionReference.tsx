import React,{useContext,useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {FileTextReferenceContext,nativeReferenceIdentity,type FileReferenceIdentity,fileRegionCapture,type FileRegionDraft,type OfficeRegionFocus,type OfficeRegionView} from './FileTextReferences';
import {createImageRegionContentReference,type NormalizedRect} from './vendor/pilotdeck-content-reference';
import {validateRegionCaptureSource,validateOfficeRegionView,cellRangeCoordinates} from '../../packages/gateway/src/messages/content-reference.js';
import {readGeneratedPng} from './upload-recovery.mjs';

export type OfficeRegionSession={window:Window;origin:string;token:string;live:()=>boolean;close:(message:string)=>void};
type Region={serial:number;rect:NormalizedRect;view:OfficeRegionView;anchorRange?:string};
function readRegion(value:unknown,kind:'docx'|'pptx'|'xlsx'):Region|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value)||!['rect','serial','view'].every(key=>Object.hasOwn(value,key))||Object.keys(value).some(key=>!['rect','serial','view'].includes(key)&&!(kind==='xlsx'&&key==='anchorRange')))return;
 const region=value as Region,rect=region.rect,view=region.view;
 if(!view||typeof view!=='object'||Array.isArray(view))return;
 try{validateOfficeRegionView(view,kind);}catch{return;}
 if(region.anchorRange!==undefined)try{cellRangeCoordinates(region.anchorRange);}catch{return;}
 if(!Number.isSafeInteger(region.serial)||region.serial<1||!rect||Array.isArray(rect)||Object.keys(rect).sort().join(',')!=='height,width,x,y'
  ||Object.values(rect).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)||!rect.width||!rect.height||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9)return;
 return region;
}
function originalFocus(focus:OfficeRegionFocus|undefined,source:FileReferenceIdentity,owner:string,kind:'docx'|'pptx'|'xlsx'){
 const value=focus?.value;
 if(!value||value.owner!==owner||value.conversationId!==source.conversationId||value.runId!==source.runId||value.activityId!==source.activityId||value.resultSha!==source.resultSha
  ||value.file.path!==source.file.path||value.file.version!==source.file.version||nativeReferenceIdentity(value.native_source)!==nativeReferenceIdentity(source.native_source)||value.file.sha256!==source.file.sha256||value.file.size!==source.file.size||value.reference.renderer.id!==kind)return;
 const capture={conversationId:value.conversationId,runId:value.runId,activityId:value.activityId,resultSha:value.resultSha,file:value.file,...(value.native_source?{native_source:value.native_source}:{}),reference:value.reference,imageBytes:value.imageBytes,rotation:value.rotation,region_view:value.region_view};
 try{validateRegionCaptureSource(capture,source.conversationId);}catch{return;}
 return {rect:value.reference.locator.rect,view:value.region_view};
}

export default function OfficeFileRegionReference({source,owner,session,focus,kind}:{source:FileReferenceIdentity;owner:string;session:OfficeRegionSession;focus?:OfficeRegionFocus;kind:'docx'|'pptx'|'xlsx'}){
 const label=kind==='docx'?'Word':kind==='pptx'?'幻灯片':'工作表',positionLabel=kind==='docx'?'Word分段':kind==='pptx'?'幻灯片':'工作表视口';
 const context=useContext(FileTextReferenceContext),latest=useRef(context);latest.current=context;
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,nativeReferenceIdentity(source.native_source),focus?.key]);
 const [selection,setSelection]=useState<Region>(),selected=useRef<Region|undefined>(undefined),job=useRef<{selection:Region;lease:object;phase:'capture'|'png'|'upload'}|undefined>(undefined);
 const [phase,setPhase]=useState<'idle'|'capture'|'png'|'upload'>('idle'),[notice,setNotice]=useState(''),[ready,setReady]=useState(false),[confirmed,setConfirmed]=useState<boolean>();
 const startCapture=useRef<()=>void>(()=>{});
 const disabled=!!source.native_source&&!context?.nativeSources?.includes(1)||!context||context.disabled||context.regionDisabled||context.owner!==owner||context.conversationId!==source.conversationId||!context.regionRenderers?.includes(kind);
 const send=(type:string,payload:Record<string,unknown>)=>{if(session.live())session.window.postMessage({type,protocol:1,token:session.token,...payload},session.origin);};
 const release=(lease=job.current?.lease)=>{if(lease&&fileRegionCapture.owner===lease)fileRegionCapture.owner=undefined;};
 useEffect(()=>{send(`jot-${kind}-region-enable`,{enabled:!disabled});},[disabled,session,kind]);
 useEffect(()=>{
  let active=true,timer:number|undefined;
  const canAdd=()=>{const ctx=latest.current;return active&&session.live()&&taskDraftScope()===owner&&!!ctx&&(!source.native_source||!!ctx.nativeSources?.includes(1))&&!ctx.disabled&&!ctx.regionDisabled&&ctx.owner===owner&&ctx.conversationId===source.conversationId&&!!ctx.regionRenderers?.includes(kind);};
  const receive=async(event:MessageEvent)=>{
   if(!active||!session.live()||event.source!==session.window||event.origin!==session.origin)return;
   const value=event.data;if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!==1||value.token!==session.token||Object.keys(value).length!==4)return;
   if(value.type===`jot-${kind}-region-ready`&&value.available===true){setReady(true);return;}
   if(value.type===`jot-${kind}-region-focus`&&typeof value.confirmed==='boolean'){setConfirmed(value.confirmed);return;}
   if(value.type===`jot-${kind}-region`){
    const next=readRegion(value.selection,kind);selected.current=next;setSelection(next);return;
   }
   const current=job.current;
   if(!current)return;
   if(value.type===`jot-${kind}-capture-cancel`||value.type===`jot-${kind}-capture-error`){
    if(current.phase==='capture')session.close(value.type===`jot-${kind}-capture-cancel`?`${label}截图已取消，请重新读取视觉内容。`:`${label}区域截图失败，请重新读取后重试。`);return;
   }
   if(value.type!==`jot-${kind}-capture`||current.phase!=='capture')return;
   const capture=value.capture,region=readRegion(capture?.selection,kind);
   try{
    if(!canAdd()||!capture||Object.keys(capture).sort().join(',')!=='bytes,height,nearbyText,selection,width'||typeof capture.nearbyText!=='string'||capture.nearbyText.length>1000||!region||JSON.stringify(region)!==JSON.stringify(current.selection)
     ||!(capture.bytes instanceof ArrayBuffer)||capture.bytes.byteLength<24||capture.bytes.byteLength>8*1024*1024
     ||!Number.isSafeInteger(capture.width)||!Number.isSafeInteger(capture.height)||capture.width<1||capture.height<1||capture.width>4096||capture.height>4096||capture.width*capture.height>4194304)throw Error(`${label}截图数据尚未通过来源或尺寸核对。`);
    current.phase='png';setPhase('png');const metadata=await readGeneratedPng(capture.bytes);
    if(!canAdd()||job.current!==current)return;
    if(metadata.width!==capture.width||metadata.height!==capture.height)throw Error(`${label}截图PNG尺寸尚未确认。`);
    window.clearTimeout(timer);
    const name=`${kind}-region-${crypto.randomUUID()}.png`,file=new File([capture.bytes],name,{type:'image/png'}),original=source.file;
    const reference=createImageRegionContentReference({
     selectionMode:'region',
     source:{relativePath:original.path,fileName:source.native_source?original.path.split(/[\\/]/).at(-1)!:original.path.split('/').at(-1)!,
      mimeType:kind==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':kind==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      revision:{id:source.native_source?.openSha??String(original.version),sha256:original.sha256,size:original.size}},
     renderer:{id:kind,backend:'builtin',locatorQuality:'visual'},
     locator:kind==='docx'?{surface:'document',rect:region.rect}:kind==='pptx'?{surface:'slide',slideNumber:'slideNumber' in region.view?region.view.slideNumber:undefined,rect:region.rect}:{surface:'sheet',sheetId:'sheetId' in region.view?region.view.sheetId:undefined,sheetName:'sheetName' in region.view?region.view.sheetName:undefined,rect:region.rect,...(region.anchorRange!==undefined?{anchorRange:region.anchorRange}:{})},
     image:{name,mimeType:'image/png',...metadata},nearbyText:capture.nearbyText
    });
    const draft:FileRegionDraft={owner,conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,...(source.native_source?{native_source:source.native_source,file:{path:original.path,sha256:original.sha256,size:original.size}}:{file:{path:original.path,version:original.version!,sha256:original.sha256,size:original.size}}),reference,imageBytes:file.size,rotation:0,region_view:region.view};
    current.phase='upload';setPhase('upload');setNotice(`正在保存${label}截图引用…`);
    const accepted=await latest.current!.onAddRegion(draft,file);
    if(active&&session.live()){setNotice(accepted?`${label}截图引用已交给原草稿和上传入口。`:'截图引用尚未接收，请检查当前对话提示。');if(accepted)send(`jot-${kind}-region-clear`,{serial:region.serial});}
   }catch(error){if(active&&session.live())session.close(error instanceof Error?error.message:`${label}截图核对失败。`);}
   finally{release(current.lease);if(job.current===current){job.current=undefined;if(active)setPhase('idle');}}
  };
  const message=(event:MessageEvent)=>{void receive(event).catch(()=>{if(active&&session.live())session.close(`${label}截图处理失败，请重新读取。`);});};
  window.addEventListener('message',message);
  const original=originalFocus(focus,source,owner,kind);if(focus&&!original)setConfirmed(false);
  send(`jot-${kind}-region-probe`,{focus:original??null});
  // A timer belongs to the current capture, and is also cleared when this viewer closes.
  startCapture.current=()=>{
   if(!canAdd()||!selected.current||job.current)return;
   if(fileRegionCapture.owner){setNotice('上一张截图仍在处理，请稍后重试。');return;}
   const lease={};fileRegionCapture.owner=lease;job.current={selection:selected.current,lease,phase:'capture'};setPhase('capture');setNotice(`正在生成${label}区域PNG…`);
   timer=window.setTimeout(()=>{if(active&&session.live())session.close(`${label}截图超时，查看器已关闭，请重新读取。`);},30000);
   send(`jot-${kind}-capture`,{serial:selected.current.serial});
  };
  return()=>{
   active=false;window.clearTimeout(timer);
   // The original upload may finish after this viewer unmounts and retains its lease until settlement.
   if(job.current?.phase!=='upload')release();
   job.current=undefined;startCapture.current=()=>{};window.removeEventListener('message',message);
  };
 },[identity,session,kind]);
 return <section aria-label={`${label}区域截图引用`}>
  {!context?.regionRenderers?.includes(kind)&&<p role="status">当前服务尚未声明{label}截图的固定图片输入能力。</p>}
  {focus&&<p role="status">{confirmed===true?`已核对原${positionLabel}尺寸并标记原截图区域。`:confirmed===false?`原截图区域尚未与当前${positionLabel}尺寸核对，请对照原PNG引用。`:`正在核对原${positionLabel}尺寸…`}</p>}
  {notice&&<p role="status">{notice}</p>}
  {selection&&<p>{positionLabel} {'section' in selection.view?selection.view.section:'slideNumber' in selection.view?selection.view.slideNumber:selection.view.sheetName} 区域 · 宽 {(selection.rect.width*100).toFixed(1)}% · 高 {(selection.rect.height*100).toFixed(1)}%</p>}
  <button type="button" disabled={disabled||!ready||!selection||phase!=='idle'} onClick={()=>startCapture.current()}>生成截图并引用到当前对话</button>
  {(phase==='capture'||phase==='png')&&<button type="button" onClick={()=>session.close(`${label}截图已取消，请重新读取视觉内容。`)}>取消截图并关闭查看器</button>}
 </section>;
}
