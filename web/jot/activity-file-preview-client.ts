import {OFFICE_PRINT_SOURCE_MAX_BYTES,OFFICE_NATIVE_SOURCE_MAX_BYTES,officePreviewFormat} from '../../packages/gateway/src/artifacts/office-preview-format.js';
import type {OfficePrintView} from '../../packages/gateway/contracts/types';
import {ApiError,base,taskDraftScope} from './client';
import {readVerifiedPreviewBytes} from './artifact-preview-bytes.mjs';
import type {ActivityToolResultFile} from './types';

export type ListedFilePreviewSource={conversationId:string;runId:string;activityId:string;resultSha:string;file:Pick<ActivityToolResultFile,'path'|'version'|'sha256'|'size'>};
export async function readOfficeViewerUrl(kind:'docx'|'pptx'|'xlsx',signal:AbortSignal){
 const path=kind==='docx'?'/docx-preview/0.4.0/':kind==='pptx'?'/pptx-preview/1.2.4/':'/xlsx-preview/0.25.1/';
 const response=await fetch(path+'viewer',{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json')throw Error('独立Office查看器配置暂不可用。');
 const text=await response.text();signal.throwIfAborted();
 if(text.length>2048)throw Error('Office查看器配置尚未确认。');
 const value=JSON.parse(text);
 if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!==1||typeof value.url!=='string'||Object.keys(value).length!==2)throw Error('Office查看器配置尚未确认。');
 const url=new URL(value.url),parent=new URL(window.location.href);
 if(url.protocol!=='http:'||parent.protocol!=='http:'||url.origin===parent.origin||!/^jot-office-[a-f0-9]{32}\.localhost$/.test(url.hostname)
  ||url.port!==parent.port||url.username||url.password||url.hash||url.pathname!==path+'frame.html'
  ||url.searchParams.size!==1||url.searchParams.get('parent')!==parent.host)throw Error('Office查看器独立来源尚未确认。');
 return url.href;
}
export async function readListedFilePreviewBytes({conversationId,runId,activityId,resultSha,file}:ListedFilePreviewSource,owner:string,signal:AbortSignal){
 const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
 check();
 const nativeOffice=officePreviewFormat(file.path)?.native===true;
 const limit=nativeOffice?OFFICE_NATIVE_SOURCE_MAX_BYTES:20*1024*1024;
 if(file.size>limit)throw Error(nativeOffice?'Office文件超过32 MiB原生预览范围，可转换PDF或下载固定版本查看。':'文件超过20 MiB预览范围，可下载固定版本查看。');
 const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,size_bytes:String(file.size)});
 const response=await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/download?${params}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 try{
  check();
  if(!response.ok||!response.body||response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'
   ||response.headers.get('x-activity-file-sha256')!==file.sha256||response.headers.get('x-activity-file-size')!==String(file.size)
   ||response.headers.get('x-activity-file-version')!==String(file.version)||response.headers.get('x-activity-tool-result-sha256')!==resultSha)throw Error('原列表文件的固定版本未能核对');
  const bytes=await readVerifiedPreviewBytes(response,{size_bytes:file.size,sha256:file.sha256},signal,limit);check();return bytes;
 }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
}

export type OfficePrintPreview={bytes:Uint8Array}&Omit<OfficePrintView,'protocol'>;
export async function readOfficePrintPreviewBytes({conversationId,runId,activityId,resultSha,file}:ListedFilePreviewSource,owner:string,signal:AbortSignal,expected?:Pick<OfficePrintView,'sha256'|'size'|'pageCount'>):Promise<OfficePrintPreview>{
 const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
 check();
 if(file.size>OFFICE_PRINT_SOURCE_MAX_BYTES)throw Error('文件超过100 MiB转换源文件范围。');
 const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,size_bytes:String(file.size)});
 if(expected){params.set('preview_sha256',expected.sha256);params.set('preview_size_bytes',String(expected.size));params.set('preview_page_count',String(expected.pageCount));}
 const response=await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/print?${params}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 try{
  check();
  if(response.status===413)throw Error('转换源文件须在100 MiB以内，生成PDF须在20 MiB以内。');
  if(response.status===507)throw Error('转换PDF保留空间已满，已有副本继续保留。');
  if(expected&&response.status===404)throw Error('原转换PDF副本或原来源暂不可读取，可重新转换并对照原快照。');
  if(expected&&response.status===409)throw Error('原来源或转换PDF副本尚未通过核对，请对照原快照。');
  if(!expected&&response.status===409){
   const failure=await response.json().catch(()=>null);check();
   throw Error(failure?.error?.code==='OFFICE_PREVIEW_CONFIGURATION_CHANGED'?'Office预览配置已变化，请重新转换固定版本。':'原Office来源尚未通过核对，请重新打开原列表。');
  }
  if(response.status===429)throw new ApiError(429,'文档引擎正在处理另一个文件，请稍后重试转换。');
  if(response.status===503){
   const failure=await response.json().catch(()=>null);check();
   throw Error(failure?.error?.code==='OFFICE_PREVIEW_BINARY_UNAVAILABLE'?'未找到已确认的LibreOffice程序，请核对路径或扫描候选。':'Office预览服务暂不可用，请稍后重试。');
  }
  if(!response.ok||!response.body||response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'
   ||response.headers.get('x-activity-file-sha256')!==file.sha256||response.headers.get('x-activity-file-size')!==String(file.size)
   ||response.headers.get('x-activity-file-version')!==String(file.version)||response.headers.get('x-activity-tool-result-sha256')!==resultSha
   ||response.headers.get('x-jot-preview-protocol')!=='1'||response.headers.get('x-jot-preview-renderer')!=='libreoffice'
   ||response.headers.get('x-jot-preview-media-type')!=='application/pdf'||response.headers.get('x-jot-execution-authorized')!=='false')throw Error('原Office来源或转换PDF尚未确认。');
  const sha256=response.headers.get('x-jot-preview-sha256')??'',sizeText=response.headers.get('x-jot-preview-size'),pagesText=response.headers.get('x-jot-preview-pages');
  const size=Number(sizeText),pageCount=Number(pagesText),proof=response.headers.get('x-jot-preview-proof')??'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(proof)||!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(size)||String(size)!==sizeText||size<100||size>20*1024*1024
   ||!Number.isSafeInteger(pageCount)||String(pageCount)!==pagesText||pageCount<1||pageCount>50000
   ||response.headers.has('content-length')&&response.headers.get('content-length')!==String(size))throw Error('转换PDF摘要、大小或页数尚未确认。');
  if(expected&&(sha256!==expected.sha256||size!==expected.size||pageCount!==expected.pageCount))throw Error('读取结果与原转换PDF摘要不一致。');
  const bytes=await readVerifiedPreviewBytes(response,{size_bytes:size,sha256},signal);check();
  if(new TextDecoder('ascii').decode(bytes.subarray(0,5))!=='%PDF-')throw Error('转换PDF文件头尚未确认。');
  return Object.freeze({bytes,sha256,size,pageCount,proof});
 }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
}

export type NativeMemberPreviewSource={conversationId:string;runId:string;activityId:string;asOfSeq?:string;
 resultSha:string;membersSha:string;member:{index:number;path:string}};
export function nativeMemberDownloadUrl(source:NativeMemberPreviewSource){
 const query=new URLSearchParams({run_id:source.runId,result_sha256:source.resultSha,members_sha256:source.membersSha,
  ...(source.asOfSeq?{as_of_seq:source.asOfSeq}:{})});
 return `${base}/v1/conversations/${encodeURIComponent(source.conversationId)}/activities/${encodeURIComponent(source.activityId)}/tool-result/members/${source.member.index}/download?${query}`;
}
export type NativeMemberOpenedBytes={bytes:Uint8Array;sha256:string;size:number;openSha:string;proof?:string};
/** Download and preview share this single fully verified opened byte source. */
export async function readNativeMemberPreviewBytes(source:NativeMemberPreviewSource,owner:string,signal:AbortSignal,expected?:{openSha:string;proof?:string}):Promise<NativeMemberOpenedBytes>{
 const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
 check();
 const nativeOffice=officePreviewFormat(source.member.path)?.native===true;
 const limit=nativeOffice?OFFICE_NATIVE_SOURCE_MAX_BYTES:20*1024*1024,url=new URL(nativeMemberDownloadUrl(source),window.location.href);
 url.searchParams.set('max_bytes',String(limit));
 if(expected){url.searchParams.set('open_sha256',expected.openSha);if(expected.proof)url.searchParams.set('open_proof',expected.proof);}
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 try{
  check();
  if(!response.ok)throw new ApiError(response.status,response.status===422?(nativeOffice?'Office文件超过32 MiB视觉预览范围，可下载打开时内容查看。':'文件超过20 MiB预览范围，可下载打开时内容查看。')
   :response.status===409?'原成员或文件版本已变化，请重新打开。':response.status===404?'原文件内容暂不可用。':'文件预览暂不可用。');
  const sha256=response.headers.get('x-activity-file-sha256'),openSha=response.headers.get('x-activity-native-open-sha256'),proof=response.headers.get('x-activity-native-open-proof')??undefined;
  const sizeValue=response.headers.get('x-activity-file-size'),size=Number(sizeValue);
  const pathSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source.member.path))),byte=>byte.toString(16).padStart(2,'0')).join('');
  check();
  if(!response.body||response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'
   ||!sha256||!/^[a-f0-9]{64}$/.test(sha256)||!openSha||!/^[a-f0-9]{64}$/.test(openSha)
   ||proof!==undefined&&(proof.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(proof))||expected&&(openSha!==expected.openSha||expected.proof!==undefined&&proof!==expected.proof)
   ||sizeValue===null||String(size)!==sizeValue||!Number.isSafeInteger(size)||size<0||size>limit
   ||response.headers.get('x-activity-tool-result-sha256')!==source.resultSha
   ||response.headers.get('x-activity-search-members-sha256')!==source.membersSha
   ||response.headers.get('x-activity-native-member-index')!==String(source.member.index)
   ||response.headers.get('x-activity-native-member-path-sha256')!==pathSha
   ||response.headers.get('x-jot-execution-authorized')!=='false')throw Error('原成员打开内容来源尚未确认');
  const bytes=await readVerifiedPreviewBytes(response,{sha256,size_bytes:size},signal,limit);
  check();
  return {bytes,sha256,size,openSha,...(proof?{proof}:{})};
 }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
}
