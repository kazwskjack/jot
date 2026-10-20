import {ApiError,base,request} from './client';
import type {TaskReviewOutput,TaskReviewOutputPage,TaskWorkReview,WorkReviewManifest,WorkReviewEntry} from './types';

export function reviewOutputPath(id:string,index:number){
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!Number.isSafeInteger(index)||index<0||index>9999)throw new Error('review_output_selector_invalid');
 return `/interactions/${id}/outputs/${index}`;
}
export function reviewPreviewKind(value:TaskReviewOutput){
 if((value.mime_type.startsWith('text/')||['application/json','application/xml','image/svg+xml'].includes(value.mime_type))&&value.size_bytes<=262144)return 'text';
 if(['image/png','image/jpeg','image/gif','image/webp'].includes(value.mime_type)&&value.size_bytes<=4194304)return 'image';
 return 'download';
}
const relativePath=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\\:\x00-\x1f\x7f]/.test(v)&&v.split('/').every(p=>p&&p!=='.'&&p!=='..');
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const entry=(v:WorkReviewEntry)=>v&&relativePath(v.path)&&(v.kind==='directory'||v.kind==='file'&&sha(v.sha256)&&Number.isSafeInteger(v.bytes)&&v.bytes>=0&&typeof v.executable==='boolean');
const manifest=(v:WorkReviewManifest)=>v&&v.protocol===1&&v.provider==='snapshot-copy'&&Array.isArray(v.paths)&&v.paths.length>0&&v.paths.length<=50000&&v.paths.every(relativePath)&&Array.isArray(v.entries)&&v.entries.length<=100000&&v.entries.every(entry);
export function validateWorkReview(v:TaskWorkReview){
 if(!v||v.protocol!==1||v.source!=='isolated'||v.execution_authorized!==false
  ||!['grant_id','work_occurrence_id','cycle_id','snapshot_id'].every(k=>typeof v[k as keyof TaskWorkReview]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v[k as keyof TaskWorkReview] as string))
  ||!['source_sha256','source_record_sha256','plans_sha256','paths_sha256','call_set_sha256','inspection_sha256'].every(k=>sha(v[k as keyof TaskWorkReview]))
  ||typeof v.selected_objective!=='string'||!v.selected_objective||v.selected_objective.length>65536||!manifest(v.base_manifest)||!manifest(v.result_manifest)
  ||!v.diff||v.diff.protocol!==1||v.diff.execution_authorized!==false||![v.diff.base_sha256,v.diff.result_sha256,v.diff.diff_sha256].every(sha)
  ||!Array.isArray(v.diff.changes)||v.diff.changes.length>200000||!v.diff.changes.every(c=>c&&['add','delete','replace','modify','rename'].includes(c.kind)&&relativePath(c.path)
   &&(c.kind!=='rename'||relativePath(c.from))&&(c.before===undefined||entry(c.before))&&(c.after===undefined||entry(c.after))))throw Error('review_work_evidence_invalid');
 return v;
}
export async function reviewOutputPage(id:string,signal:AbortSignal):Promise<TaskReviewOutputPage>{
 reviewOutputPath(id,0);const page=await request<TaskReviewOutputPage>(`/interactions/${id}/outputs`,'GET',undefined,undefined,signal);
 if(!page||!Array.isArray(page.items)||page.items.length>9999||!page.items.every((item,index)=>item&&item.output_index===index
  &&['workspace','native','generated'].includes(item.source)&&typeof item.file_name==='string'&&item.file_name.length>0&&item.file_name.length<=1000
  &&Number.isSafeInteger(item.version)&&item.version>0&&Number.isSafeInteger(item.size_bytes)&&item.size_bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256)
  &&typeof item.mime_type==='string'&&item.mime_type.length>0&&item.mime_type.length<=200&&item.download_url==='/v1'+reviewOutputPath(id,index)))throw new Error('review_output_list_invalid');
 if(page.work_review!==undefined)validateWorkReview(page.work_review);
 return page;
}
export async function reviewOutputList(id:string,signal:AbortSignal):Promise<TaskReviewOutput[]>{return (await reviewOutputPage(id,signal)).items;}
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
