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

/** Resolve a real completed edit publication, not an inferred neighboring version. */
export function retainedDocumentEdit(db:DatabaseSync,before:DocumentSource,after:DocumentSource&{size:number}){
 if(before.artifactId!==after.artifactId||before.ownerId!==after.ownerId||before.conversationId!==after.conversationId||before.version+1!==after.version)throw Error('artifact_content_mismatch');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_file_jobs'").get())throw Error('artifact_text_unsupported');
 const rows=db.prepare(`SELECT id,operation,request_json,request_sha256,
  CASE WHEN length(CAST(result_json AS BLOB))<=8388608 THEN result_json END result_json
  FROM ga_file_jobs WHERE owner_id=? AND conversation_id=? AND artifact_id=? AND base_version=? AND base_sha256=?
   AND output_version=? AND status='completed' AND operation NOT IN('document.inspect','document.read','file.job_status') LIMIT 2`)
  .all(after.ownerId,after.conversationId,after.artifactId,before.version,before.sha256,after.version) as
  Array<{id:string;operation:string;request_json:string;request_sha256:string;result_json:string|null}>;
 if(!rows.length)throw Error('artifact_text_unsupported');
 if(rows.length!==1||!rows[0]!.result_json)throw Error('artifact_content_mismatch');
 const row=rows[0]!;
 let request:Record<string,unknown>|undefined,result:Record<string,unknown>|undefined;
 try{request=object(JSON.parse(row.request_json));result=object(JSON.parse(row.result_json!));}catch{throw Error('artifact_content_mismatch');}
 const published=object(result?.artifact);
 if(!request||canonicalJson(request)!==row.request_json||sha(row.request_json)!==row.request_sha256
  ||request.operation!==row.operation||request.base_version!==before.version||request.base_sha256!==before.sha256
  ||result?.ok!==true||!published||published.artifact_ref!==after.artifactId||published.version!==after.version
  ||published.sha256!==after.sha256||published.size_bytes!==after.size||published.media_type!==after.mediaType)throw Error('artifact_content_mismatch');
 return {edit_job_id:row.id,edit_result_sha256:sha(row.result_json!)};
}
