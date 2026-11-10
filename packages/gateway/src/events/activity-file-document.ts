import type {DatabaseSync} from 'node:sqlite';
import {createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {WorkbenchService} from '../workbench/service.ts';
import {FileEngineAdapter} from '../file-engine/engine.ts';
import {createPinnedByteStore} from '../artifacts/pinned-byte-source.ts';
import {normalizeOfficePreviewContent,officePreviewFormat} from '../artifacts/document-preview-content.ts';
import {readActivityToolResultFileDownload,parseActivityFileDownloadQuery} from './activity-tool-result.ts';

/** Inspect sealed original bytes outside the original database read transaction. */
export async function readActivityFileDocument(db:DatabaseSync,reader:Pick<WorkbenchService,'readBinaryFile'>,
 owner:string,conversationId:string,activityId:string,input:ReturnType<typeof parseActivityFileDownloadQuery>,root:string,signal:AbortSignal){
 const format=officePreviewFormat(input.path);
 if(!format)throw Error('UNSUPPORTED_FORMAT_OPERATION');
 if(input.size>20*1024*1024)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
 const store=createPinnedByteStore(root);let directory:string|undefined;
 try{
  const writer=await store.begin(input.fileSha,input.size,signal);signal.throwIfAborted();
  db.exec('BEGIN');let file:ReturnType<typeof readActivityToolResultFileDownload>;
  try{
   file=readActivityToolResultFileDownload(db,owner,conversationId,activityId,input,reader,writer.appendSync);
   db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  await writer.seal();signal.throwIfAborted();
  await mkdir(root,{recursive:true,mode:0o700});directory=await mkdtemp(join(root,'office-'));
  const path=join(directory,'input.'+format.kind);
  await pipeline(Readable.from(writer.source.stream(signal)),createWriteStream(path,{flags:'wx',mode:0o600}),{signal});
  const engine=new FileEngineAdapter({python:process.env.GENERAL_AGENT_FILE_ENGINE_PYTHON?.trim()||'/usr/bin/python3',
   workerPath:process.env.GENERAL_AGENT_FILE_ENGINE_SCRIPT?.trim()||fileURLToPath(new URL('../../file-engine/worker.py',import.meta.url)),timeoutMs:30000});
  const result=await engine.run({operation:'document.inspect',input_path:path,media_type:format.mediaType,job_dir:directory,request:format.kind==='xlsx'?{}:{[`verify_${format.kind}_visual`]:true}},
   {signal,maxOutputBytes:2*1024*1024});
  signal.throwIfAborted();
  if(result.output_path||!result.engine||typeof result.engine.name!=='string'||result.engine.name.length>200
   ||typeof result.engine.version!=='string'||result.engine.version.length>200)throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  const verified=result.checks?.[`${format.kind}_visual_source_verified`]===true;
  const reason=['DOCUMENT_VISUAL_LIMIT','FILE_CONTAINER_LIMIT'].includes(String(result.checks?.[`${format.kind}_visual_reason`]))?'source_limit' as const
   :result.checks?.[`${format.kind}_visual_source_verified`]===false?'format_invalid' as const:'source_unverified' as const;
  const visual=format.kind==='xlsx'?{}:{[`${format.kind}_visual`]:{protocol:1 as const,ready:verified,...(verified?{}:{reason})}};
  return {...file,...visual,document_protocol:1 as const,media_type:format.mediaType,document:normalizeOfficePreviewContent(format.mediaType,result.content),
   engine:{name:result.engine.name,version:result.engine.version},execution_authorized:false as const};
 }finally{
  try{await store.dispose();}finally{if(directory)await rm(directory,{recursive:true,force:true});}
 }
}
