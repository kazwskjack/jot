import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {formatDocumentPreviewContent,isDocumentPreviewMediaType} from './document-preview-content.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
type DocumentSource={artifactId:string;ownerId:string;conversationId:string;version:number;sha256:string;mediaType:string};
/** Search only original completed inspection text. This never creates a file job. */
export function retainedDocumentText(db:DatabaseSync,source:DocumentSource,jobId?:string,resultSha?:string){
 if(!isDocumentPreviewMediaType(source.mediaType)||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_file_jobs'").get())throw Error('artifact_text_unsupported');
 const row=db.prepare(`SELECT id,request_json,request_sha256,
  CASE WHEN length(CAST(result_json AS BLOB))<=8388608 THEN result_json END result_json
  FROM ga_file_jobs WHERE owner_id=? AND conversation_id=? AND artifact_id=? AND base_version=? AND base_sha256=?
   AND operation='document.inspect' AND status='completed' AND (? IS NULL OR id=?) ORDER BY created_at DESC,id DESC LIMIT 1`)
  .get(source.ownerId,source.conversationId,source.artifactId,source.version,source.sha256,jobId??null,jobId??null) as
  {id:string;request_json:string;request_sha256:string;result_json:string|null}|undefined;
 if(!row)throw Error(jobId?'artifact_text_source_changed':'artifact_text_unsupported');
 if(!row.result_json)throw Error('artifact_text_unsupported');
 if(resultSha!==undefined&&sha(row.result_json)!==resultSha)throw Error('artifact_text_source_changed');
 let request:Record<string,unknown>|undefined,result:Record<string,unknown>|undefined;
 try{request=object(JSON.parse(row.request_json));result=object(JSON.parse(row.result_json));}catch{throw Error('artifact_content_mismatch');}
 const original=object(result?.source);
 if(!request||canonicalJson(request)!==row.request_json||sha(row.request_json)!==row.request_sha256
  ||request.operation!=='document.inspect'||request.base_version!==source.version||request.base_sha256!==source.sha256
  ||result?.ok!==true||!original||original.artifact_id!==source.artifactId||original.version!==source.version||original.sha256!==source.sha256)throw Error('artifact_content_mismatch');
 // shortcut: search covers the retained 200000-character preview, extend with complete document extraction.
 let formatted:ReturnType<typeof formatDocumentPreviewContent>;
 try{formatted=formatDocumentPreviewContent(source.mediaType,result.content);}catch{throw Error('artifact_content_mismatch');}
 return {text:formatted.text,document_job_id:row.id,document_result_sha256:sha(row.result_json),
  text_sha256:sha(formatted.text),text_total_chars:formatted.text.length,source_truncated:formatted.truncated};
}
