import {ApiError,base,request} from './client';
import type {TaskReviewOutput,TaskReviewOutputPage} from './types';

export function reviewOutputPath(id:string,index:number){
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!Number.isSafeInteger(index)||index<0||index>9999)throw new Error('review_output_selector_invalid');
 return `/interactions/${id}/outputs/${index}`;
}
export function reviewPreviewKind(value:TaskReviewOutput){
 if((value.mime_type.startsWith('text/')||['application/json','application/xml','image/svg+xml'].includes(value.mime_type))&&value.size_bytes<=262144)return 'text';
 if(['image/png','image/jpeg','image/gif','image/webp'].includes(value.mime_type)&&value.size_bytes<=4194304)return 'image';
 return 'download';
}
export async function reviewOutputList(id:string,signal:AbortSignal):Promise<TaskReviewOutput[]>{
 reviewOutputPath(id,0);const page=await request<TaskReviewOutputPage>(`/interactions/${id}/outputs`,'GET',undefined,undefined,signal);
 if(!page||!Array.isArray(page.items)||page.items.length>9999||!page.items.every((item,index)=>item&&item.output_index===index
  &&['workspace','native','generated'].includes(item.source)&&typeof item.file_name==='string'&&item.file_name.length>0&&item.file_name.length<=1000
  &&Number.isSafeInteger(item.version)&&item.version>0&&Number.isSafeInteger(item.size_bytes)&&item.size_bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256)
  &&typeof item.mime_type==='string'&&item.mime_type.length>0&&item.mime_type.length<=200&&item.download_url==='/v1'+reviewOutputPath(id,index)))throw new Error('review_output_list_invalid');
 return page.items;
}
export async function reviewOutputBytes(id:string,value:TaskReviewOutput,signal:AbortSignal){
 if(!Number.isSafeInteger(value.size_bytes)||value.size_bytes<0||value.size_bytes>20*1024*1024)throw new Error('review_output_too_large');
 const response=await fetch(base+'/v1'+reviewOutputPath(id,value.output_index),{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 if(!response.ok)throw new ApiError(response.status,'review_output_unavailable');
 if(!response.body)throw new Error('review_output_integrity_failed');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{while(true){const {done,value:chunk}=await reader.read();signal.throwIfAborted();if(done)break;length+=chunk.byteLength;if(length>value.size_bytes)throw new Error('review_output_integrity_failed');chunks.push(chunk);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 if(bytes.byteLength!==value.size_bytes||sha!==value.sha256)throw new Error('review_output_integrity_failed');
 return bytes;
}
export async function reviewOutputPreview(id:string,value:TaskReviewOutput,signal:AbortSignal){
 const kind=reviewPreviewKind(value);if(kind==='download')throw new Error('review_output_download_required');
 const bytes=await reviewOutputBytes(id,value,signal);
 return kind==='text'?{kind,text:new TextDecoder().decode(bytes)}:{kind,bytes,mime:value.mime_type};
}
