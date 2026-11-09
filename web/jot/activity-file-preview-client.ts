import {base,taskDraftScope} from './client';
import {readVerifiedPreviewBytes} from './artifact-preview-bytes.mjs';
import type {ActivityToolResultFile} from './types';

export type ListedFilePreviewSource={conversationId:string;runId:string;activityId:string;resultSha:string;file:ActivityToolResultFile};
export async function readListedFilePreviewBytes({conversationId,runId,activityId,resultSha,file}:ListedFilePreviewSource,owner:string,signal:AbortSignal){
 const check=()=>{signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
 check();
 // shortcut: previews retain the existing 20 MiB full-byte verifier, add larger retained source viewing later.
 if(file.size>20*1024*1024)throw Error('文件超过20 MiB预览范围，可下载固定版本查看。');
 const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,size_bytes:String(file.size)});
 const response=await fetch(`${base}/v1/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/download?${params}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 try{
  check();
  if(!response.ok||!response.body||response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'
   ||response.headers.get('x-activity-file-sha256')!==file.sha256||response.headers.get('x-activity-file-size')!==String(file.size)
   ||response.headers.get('x-activity-file-version')!==String(file.version)||response.headers.get('x-activity-tool-result-sha256')!==resultSha)throw Error('原列表文件的固定版本未能核对');
  const bytes=await readVerifiedPreviewBytes(response,{size_bytes:file.size,sha256:file.sha256},signal);check();return bytes;
 }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
}
