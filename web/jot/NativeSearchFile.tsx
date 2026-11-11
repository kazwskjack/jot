import type {OfficeCellFocus,OfficeTextFocus,OfficeRegionFocus} from './FileTextReferences';
import type {PdfReferenceFocus} from './pdf-file-view-state';
import type {NativeOfficePrintPin} from './native-office-print-client';
import {officePreviewFormat} from '../../packages/gateway/src/artifacts/office-preview-format.js';
import React,{useEffect,useRef,useState,lazy,Suspense} from 'react';
import {taskDraftScope} from './client';
import {listedFileImageType} from './ActivityToolFileImage';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import {artifactPreviewErrorMessage} from './artifact-preview-bytes.mjs';
import {nativeMemberViewingSource,readNativeMemberPreviewBytes,type NativeMemberPreviewSource,type NativeMemberOpenedBytes} from './activity-file-preview-client';

const NativeSearchOfficePrint=lazy(()=>import('./NativeSearchOfficePrint'));
const NativeSearchOfficeDocument=lazy(()=>import('./NativeSearchOfficeDocument'));
const NativeSearchFileOffice=lazy(()=>import('./NativeSearchFileOffice'));
const NativeSearchFilePdf=lazy(()=>import('./NativeSearchFilePdf'));
type Opened=NativeMemberOpenedBytes&{downloadUrl:string;imageUrl?:string;text?:string};

export default function NativeSearchFile({source,expected,printPin,focus,officeFocus,officeTextFocus,officeRegionFocus}:{source:NativeMemberPreviewSource;expected?:{openSha:string;proof?:string;sha256:string;size:number};printPin?:NativeOfficePrintPin|undefined;focus?:PdfReferenceFocus|undefined;officeFocus?:OfficeCellFocus|undefined;officeTextFocus?:OfficeTextFocus|undefined;officeRegionFocus?:OfficeRegionFocus|undefined}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,source,expected,printPin]);
 const root=useRef<HTMLElement>(null),active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{identity:string;opened?:Opened;error?:string}>(),[revision,setRevision]=useState(0);
 const openPin=useRef<{identity:string;sha:string;proof?:string}>();
 const [printMode,setPrintMode]=useState(!!printPin),[structured,setStructured]=useState(!!officeFocus&&officeFocus.value.cell_view!==2||officeTextFocus?.value.text_view===1);
 const captureOpen=(sha:string,proof?:string)=>{
  if(taskDraftScope()!==owner||expected&&(sha!==expected.openSha||expected.proof!==undefined&&proof!==expected.proof)||openPin.current?.identity===identity&&(openPin.current.sha!==sha||openPin.current.proof!==undefined&&openPin.current.proof!==proof))return false;
  openPin.current={identity,sha,...(proof?{proof}:{})};return true;
 };
 const [raw,setRaw]=useState(false),[byteOffset,setByteOffset]=useState(0);
 const [cursor,setCursor]=useState<{sha:string;offset:number;previous:number[]}>();
 const imageType=listedFileImageType(source.member.path),pdf=source.member.path.toLowerCase().endsWith('.pdf'),office=officePreviewFormat(source.member.path);
 useEffect(()=>{root.current?.focus();root.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController(),urls:string[]=[];
  active.current=controller;
  setState({identity});
  const load=async()=>{
   const pin=openPin.current?.identity===identity?{openSha:openPin.current.sha,...(openPin.current.proof?{proof:openPin.current.proof}:{})}:expected;
   const value=await readNativeMemberPreviewBytes(source,owner,controller.signal,pin);
   controller.signal.throwIfAborted();
   if(expected&&(value.sha256!==expected.sha256||value.size!==expected.size))throw Error('原引用文件摘要或大小已变化');
   if(!captureOpen(value.openSha,value.proof))throw Error('原打开来源已变化，请重新打开文件');
   const downloadUrl=URL.createObjectURL(new Blob([value.bytes.slice()],{type:'application/octet-stream'}));
   urls.push(downloadUrl);
   let imageUrl:string|undefined,text:string|undefined;
   if(imageType){imageUrl=URL.createObjectURL(new Blob([value.bytes.slice()],{type:imageType}));urls.push(imageUrl);}
   else if(!pdf&&!office?.native){
    try{const decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value.bytes);if(!decoded.includes('\0'))text=decoded;}catch{}
   }
   setByteOffset(0);
   setCursor({sha:value.openSha,offset:0,previous:[]});
   setState({identity,opened:{...value,downloadUrl,...(imageUrl?{imageUrl}:{}),...(text!==undefined?{text}:{})}});
  };
  void load().catch(error=>{
   if(!controller.signal.aborted&&taskDraftScope()===owner)setState({identity,error:artifactPreviewErrorMessage(error)});
  });
  return()=>{controller.abort();if(active.current===controller)active.current=null;for(const url of urls)URL.revokeObjectURL(url);};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined,opened=current?.opened;
 const currentCursor=opened&&cursor?.sha===opened.openSha?cursor:undefined,offset=currentCursor?.offset??0;
 const sourceOpenSha=opened?.openSha??(openPin.current?.identity===identity?openPin.current.sha:expected?.openSha);
 const sourceOpenProof=opened?.proof??(openPin.current?.identity===identity?openPin.current.proof:expected?.proof);
 const text=opened?.text;
 let end=Math.min(offset+16384,text?.length??0);
 if(text&&end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;
 const bytes=opened?.bytes.subarray(byteOffset,byteOffset+256);
 const hex=bytes?Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join(' '):'';
 const showBytes=raw||opened&&!opened.imageUrl&&!pdf&&!office?.native&&text===undefined;
 return <section ref={root} tabIndex={-1} className="jot-activity-content" aria-label="原生成员打开内容预览">
  <h4>{source.member.path}</h4>
  {office?.native&&<button type="button" onClick={()=>{setPrintMode(false);setStructured(!structured);}}>{structured?'关闭结构化内容':'查看Office结构化内容'}</button>}
  {office&&<button type="button" onClick={()=>{setStructured(false);setPrintMode(!printMode);}}>{printMode?'关闭转换PDF':'查看Office转换PDF'}</button>}
  {printMode&&office&&<ConversationDisplayBoundary label="原生Office转换预览"><Suspense fallback={<p role="status">正在载入转换PDF查看器…</p>}><NativeSearchOfficePrint source={source} expectedOpenSha={sourceOpenSha} expectedOpenProof={sourceOpenProof} expectedPreview={printPin} focus={focus} onOpened={captureOpen}/></Suspense></ConversationDisplayBoundary>}
  {structured&&office?.native&&<ConversationDisplayBoundary label="原生Office结构化预览"><Suspense fallback={<p role="status">正在载入Office结构化查看器…</p>}><NativeSearchOfficeDocument source={source} expectedOpenSha={sourceOpenSha} expectedOpenProof={sourceOpenProof} expectedFile={expected} officeFocus={officeFocus} officeTextFocus={officeTextFocus} onOpened={captureOpen}/></Suspense></ConversationDisplayBoundary>}
  {!structured&&!printMode&&(!current||!opened&&!current.error)&&<p role="status">正在读取并核对完整打开内容… <button type="button" onClick={()=>{active.current?.abort();setState({identity,error:'本次读取已取消。'});}}>取消读取</button></p>}
  {opened&&<>
   {opened.retained!==undefined&&<p role="status">{opened.retained?'已留存本次打开内容，可按原版本重新打开。':'本次打开内容未留存，需要的内容可下载保存。'}</p>}
   <p>打开时内容 · {opened.size} 字节 · SHA-256 <code>{opened.sha256}</code></p>
   <nav aria-label="打开内容查看方式" data-chat-search-ignore>
    <button type="button" disabled={!raw&&!structured&&!printMode} onClick={()=>{setPrintMode(false);setStructured(false);setRaw(false);}}>查看内容</button>
    <button type="button" disabled={raw&&!structured&&!printMode} onClick={()=>{setPrintMode(false);setStructured(false);setRaw(true);}}>查看原始字节</button>
    <a href={opened.downloadUrl} download={source.member.path.split(/[\\/]/).at(-1)||'file'} onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载本次已打开内容</a>
   </nav>
   {!structured&&!printMode&&(showBytes?<>
    <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}} aria-label="打开文件十六进制字节">{hex||'空文件'}</pre>
    <nav aria-label="打开文件字节翻页" data-chat-search-ignore>
     <button type="button" disabled={byteOffset===0} onClick={()=>setByteOffset(Math.max(0,byteOffset-256))}>上一页字节</button>
     <span>{Math.min(byteOffset+1,opened.size)}–{byteOffset+(bytes?.length??0)} / {opened.size} 字节</span>
     <button type="button" disabled={byteOffset+256>=opened.size} onClick={()=>setByteOffset(byteOffset+256)}>下一页字节</button>
    </nav>
   </>:office?.native?<ConversationDisplayBoundary key={opened.openSha} label="原生Office预览"><Suspense fallback={<p role="status">正在载入Office查看器…</p>}><NativeSearchFileOffice key={JSON.stringify([opened.openSha,office.kind])} kind={office.kind} bytes={opened.bytes} source={nativeMemberViewingSource(source,opened)} officeFocus={officeFocus} officeTextFocus={officeTextFocus} officeRegionFocus={officeRegionFocus}/></Suspense></ConversationDisplayBoundary>
    :opened.imageUrl?<img src={opened.imageUrl} alt={source.member.path} style={{maxWidth:'100%',height:'auto'}} onError={()=>{setRaw(true);setState({identity,opened,error:'浏览器无法显示此图片格式，当前显示原始字节。'});}}/>
    :pdf?<ConversationDisplayBoundary key={opened.openSha} label="原生PDF预览"><Suspense fallback={<p role="status">正在载入PDF查看器…</p>}><NativeSearchFilePdf key={opened.openSha} bytes={opened.bytes} source={nativeMemberViewingSource(source,opened)} focus={focus}/></Suspense></ConversationDisplayBoundary>
    :text!==undefined?<>
     <pre data-chat-search-content={JSON.stringify(['native-opened-file',identity,opened.openSha,offset])}>{text.slice(offset,end)}</pre>
     <nav aria-label="打开文件正文翻页" data-chat-search-ignore>
      <button type="button" disabled={!currentCursor?.previous.length} onClick={()=>setCursor({sha:opened.openSha,offset:currentCursor!.previous.at(-1)!,previous:currentCursor!.previous.slice(0,-1)})}>上一页正文</button>
      <span>{Math.min(offset+1,text.length)}–{end} / {text.length}（UTF-16 位置）</span>
      <button type="button" disabled={end>=text.length} onClick={()=>setCursor({sha:opened.openSha,offset:end,previous:[...(currentCursor?.previous??[]),offset]})}>下一页正文</button>
     </nav>
    </>:null)}
  </>}
  {!structured&&!printMode&&current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取打开内容</button></p>}
 </section>;
}
