import {ApiError,taskDraftScope} from './client';
import {nativeMemberDownloadUrl,type NativeMemberPreviewSource} from './activity-file-preview-client';
import {readVerifiedPreviewBytes} from './artifact-preview-bytes.mjs';

export type NativeOfficePrintPin={openSha:string;sourceSha:string;sourceSize:number;sha256:string;size:number;pageCount:number};
export type NativeOfficePrintPreview=NativeOfficePrintPin&{bytes:Uint8Array};
export async function readNativeOfficePdf(source:NativeMemberPreviewSource,owner:string,signal:AbortSignal,openSha?:string,expected?:NativeOfficePrintPin):Promise<NativeOfficePrintPreview>{
 const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
 check();
 const pin=openSha??expected?.openSha;
 if(expected&&pin!==expected.openSha)throw Error('原打开来源已变化，请重新打开文件');
 const url=new URL(nativeMemberDownloadUrl(source),window.location.href);
 url.pathname=url.pathname.replace(/\/download$/,'/print');
 if(pin)url.searchParams.set('open_sha256',pin);
 if(expected){url.searchParams.set('preview_sha256',expected.sha256);url.searchParams.set('preview_size_bytes',String(expected.size));url.searchParams.set('preview_page_count',String(expected.pageCount));}
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 try{
  check();
  if(!response.ok){const value=await response.json().catch(()=>({}));throw new ApiError(response.status,value.error?.code??'PDF转换预览暂不可用');}
  const header=(name:string)=>response.headers.get(name);
  const sourceSha=header('x-activity-file-sha256'),opened=header('x-activity-native-open-sha256'),sha256=header('x-jot-preview-sha256');
  const sourceSize=Number(header('x-activity-file-size')),size=Number(header('x-jot-preview-size')),pageCount=Number(header('x-jot-preview-pages'));
  const pathSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source.member.path))),byte=>byte.toString(16).padStart(2,'0')).join('');
  check();
  if(!response.body||header('content-type')?.split(';')[0]!=='application/octet-stream'||header('x-jot-preview-protocol')!=='1'
   ||header('x-jot-preview-renderer')!=='libreoffice'||header('x-jot-preview-media-type')!=='application/pdf'||header('x-jot-execution-authorized')!=='false'
   ||header('x-activity-tool-result-sha256')!==source.resultSha||header('x-activity-search-members-sha256')!==source.membersSha
   ||header('x-activity-native-member-index')!==String(source.member.index)||header('x-activity-native-member-path-sha256')!==pathSha
   ||!sourceSha||!/^[a-f0-9]{64}$/.test(sourceSha)||!opened||!/^[a-f0-9]{64}$/.test(opened)||!sha256||!/^[a-f0-9]{64}$/.test(sha256)
   ||pin!==undefined&&opened!==pin||header('x-activity-file-size')!==String(sourceSize)||!Number.isSafeInteger(sourceSize)||sourceSize<0||sourceSize>100*1024*1024
   ||header('x-jot-preview-size')!==String(size)||!Number.isSafeInteger(size)||size<100||size>20*1024*1024
   ||header('x-jot-preview-pages')!==String(pageCount)||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>50000
   ||expected&&(sha256!==expected.sha256||size!==expected.size||pageCount!==expected.pageCount||sourceSha!==expected.sourceSha||sourceSize!==expected.sourceSize))
   throw Error('原生Office转换PDF来源尚未确认');
  const bytes=await readVerifiedPreviewBytes(response,{sha256,size_bytes:size},signal);
  check();
  if(new TextDecoder('ascii').decode(bytes.subarray(0,5))!=='%PDF-')throw Error('转换PDF文件头尚未确认');
  return {bytes,openSha:opened,sourceSha,sourceSize,sha256,size,pageCount};
 }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
}
