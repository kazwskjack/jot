import {withReadTransaction} from '../db/database.ts';
import {OFFICE_SOURCE_MAX_BYTES,OFFICE_PRINT_SOURCE_MAX_BYTES,OFFICE_NATIVE_SOURCE_MAX_BYTES} from '../artifacts/office-preview-format.js';
import {readRetainedOfficePdf,retainOfficePdf} from '../artifacts/office-print-store.ts';
import type {DatabaseSync} from 'node:sqlite';
import {constants,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {WorkbenchService} from '../workbench/service.ts';
import {FileEngineAdapter} from '../file-engine/engine.ts';
import {createPinnedByteStore,type PinnedByteSource} from '../artifacts/pinned-byte-source.ts';
import {normalizeOfficePreviewContent,officePreviewFormat} from '../artifacts/document-preview-content.ts';
import {readActivityToolResultFileDownload,parseActivityFileDownloadQuery} from './activity-tool-result.ts';

type OfficeSource={file:ReturnType<typeof readActivityToolResultFileDownload>;
 format:NonNullable<ReturnType<typeof officePreviewFormat>>;path:string;directory:string;engine:FileEngineAdapter};

/** Stage the same verified immutable bytes for either original or native Office sources. */
async function withPinnedOfficeInput<T>(source:PinnedByteSource,name:string,root:string,signal:AbortSignal,
 read:(source:Omit<OfficeSource,'file'>)=>Promise<T>,binaryPath?:string){
 const format=officePreviewFormat(name);
 if(!format)throw Error('UNSUPPORTED_FORMAT_OPERATION');
 if(source.sizeBytes>OFFICE_SOURCE_MAX_BYTES)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
 await mkdir(root,{recursive:true,mode:0o700});
 const directory=await mkdtemp(join(root,'office-'));
 try{
  const path=join(directory,'input.'+format.extension);
  await pipeline(Readable.from(source.stream(signal)),createWriteStream(path,{flags:'wx',mode:0o600}),{signal});
  const engine=new FileEngineAdapter({python:process.env.GENERAL_AGENT_FILE_ENGINE_PYTHON?.trim()||'/usr/bin/python3',
   workerPath:process.env.GENERAL_AGENT_FILE_ENGINE_SCRIPT?.trim()||fileURLToPath(new URL('../../file-engine/worker.py',import.meta.url)),timeoutMs:30000,...(binaryPath?{libreOffice:binaryPath}:{})});
  return await read({format,path,directory,engine});
 }finally{await rm(directory,{recursive:true,force:true});}
}

/** Seal original bytes and run preview work outside the database transaction. */
async function withPinnedOfficeSource<T>(db:DatabaseSync,reader:Pick<WorkbenchService,'readBinaryFile'>,
 owner:string,conversationId:string,activityId:string,input:ReturnType<typeof parseActivityFileDownloadQuery>,root:string,signal:AbortSignal,read:(source:OfficeSource)=>Promise<T>,binaryPath?:string){
 const format=officePreviewFormat(input.path);
 if(!format)throw Error('UNSUPPORTED_FORMAT_OPERATION');
 if(input.size>OFFICE_SOURCE_MAX_BYTES)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
 const store=createPinnedByteStore(root);
 try{
  const writer=await store.begin(input.fileSha,input.size,signal);signal.throwIfAborted();
  db.exec('BEGIN');let file:ReturnType<typeof readActivityToolResultFileDownload>;
  try{
   file=readActivityToolResultFileDownload(db,owner,conversationId,activityId,input,reader,writer.appendSync);
   db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  await writer.seal();signal.throwIfAborted();
  return await withPinnedOfficeInput(writer.source,input.path,root,signal,staged=>read({...staged,file}),binaryPath);
 }finally{await store.dispose();}
}

async function inspectOfficeInput({format,path,directory,engine}:Omit<OfficeSource,'file'>,size:number,signal:AbortSignal){
  const result=await engine.run({operation:'document.inspect',input_path:path,media_type:format.mediaType,job_dir:directory,request:{[`verify_${format.kind}_visual`]:size<=OFFICE_NATIVE_SOURCE_MAX_BYTES,...(format.kind==='xlsx'?{include_xlsx_raw:true}:{})}},
   {signal,maxOutputBytes:2*1024*1024});
  signal.throwIfAborted();
  if(result.output_path||!result.engine||typeof result.engine.name!=='string'||result.engine.name.length>200
   ||typeof result.engine.version!=='string'||result.engine.version.length>200)throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  const sourceLimited=size>OFFICE_NATIVE_SOURCE_MAX_BYTES;
  const verified=!sourceLimited&&result.checks?.[`${format.kind}_visual_source_verified`]===true;
  const reason=sourceLimited||['DOCUMENT_VISUAL_LIMIT','FILE_CONTAINER_LIMIT'].includes(String(result.checks?.[`${format.kind}_visual_reason`]))?'source_limit' as const
   :result.checks?.[`${format.kind}_visual_source_verified`]===false?'format_invalid' as const:'source_unverified' as const;
  const visual={[`${format.kind}_visual`]:{protocol:1 as const,ready:verified,...(verified?{}:{reason})}};
  return {...visual,document_protocol:1 as const,media_type:format.mediaType,document:normalizeOfficePreviewContent(format.mediaType,result.content),
   engine:{name:result.engine.name,version:result.engine.version},execution_authorized:false as const};
}

export async function inspectPinnedOfficeDocument(source:PinnedByteSource,name:string,root:string,signal:AbortSignal){
 if(!officePreviewFormat(name)?.native)throw Error('UNSUPPORTED_FORMAT_OPERATION');
 return withPinnedOfficeInput(source,name,root,signal,input=>inspectOfficeInput(input,source.sizeBytes,signal));
}

export async function readActivityFileDocument(db:DatabaseSync,reader:Pick<WorkbenchService,'readBinaryFile'>,
 owner:string,conversationId:string,activityId:string,input:ReturnType<typeof parseActivityFileDownloadQuery>,root:string,signal:AbortSignal){
 if(!officePreviewFormat(input.path)?.native)throw Error('UNSUPPORTED_FORMAT_OPERATION');
 return withPinnedOfficeSource(db,reader,owner,conversationId,activityId,input,root,signal,async({file,...staged})=>({
  ...file,...await inspectOfficeInput(staged,input.size,signal),
 }));
}

export function parseOfficePrintQuery(query:Record<string,unknown>){
 const {preview_sha256,preview_size_bytes,preview_page_count,...source}=query;
 const input=parseActivityFileDownloadQuery(source);
 if(input.framed)throw Error('invalid_activity_tool_result_query');
 let expected:{sha256:string;size:number;pageCount:number}|undefined;
 if(preview_sha256!==undefined||preview_size_bytes!==undefined||preview_page_count!==undefined){
  const size=Number(preview_size_bytes),pageCount=Number(preview_page_count);
  if(typeof preview_sha256!=='string'||!/^[a-f0-9]{64}$/.test(preview_sha256)
   ||typeof preview_size_bytes!=='string'||String(size)!==preview_size_bytes||!Number.isSafeInteger(size)||size<100||size>20*1024*1024
   ||typeof preview_page_count!=='string'||String(pageCount)!==preview_page_count||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>50000)throw Error('invalid_activity_tool_result_query');
  expected={sha256:preview_sha256,size,pageCount};
 }
 return {input,expected};
}

async function exportOfficeInput({format,path,directory,engine}:Omit<OfficeSource,'file'>,signal:AbortSignal){
  const output=join(directory,'preview.pdf');
  const result=await engine.run({operation:'office.export_pdf',input_path:path,output_path:output,
   media_type:format.mediaType,job_dir:directory,request:{save_as:{format:'pdf'},jot_preview_pdf:1}},
   {signal,maxOutputBytes:65536});
  signal.throwIfAborted();
  const checks=result.checks;
  if(result.output_path!==output||result.engine?.name!=='libreoffice_uno'||typeof result.engine.version!=='string'||result.engine.version.length>200
   ||checks?.engine_saved!=='PASS'||checks.saved_and_reopened!=='PASS'||checks.macro_execution!=='DISABLED'||checks.external_links!=='DISABLED'
   ||!Number.isSafeInteger(checks.page_count)||Number(checks.page_count)<1||Number(checks.page_count)>50000)throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  const handle=await open(output,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
   const before=await handle.stat();
   if(!before.isFile()||before.nlink!==1||before.size<100||before.size>20*1024*1024)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
   const bytes=await handle.readFile();signal.throwIfAborted();const after=await handle.stat();
   if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
   const retained={pdf:{bytes,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,page_count:Number(checks.page_count)},
    engine:{name:result.engine.name,version:result.engine.version}};
   return retained;
  }finally{await handle.close();}
}

export async function readPinnedOfficePdf(db:DatabaseSync,source:PinnedByteSource,name:string,root:string,binding:string,signal:AbortSignal,
 expected?:{sha256:string;size:number;pageCount:number},binaryPath?:string){
 if(!officePreviewFormat(name))throw Error('UNSUPPORTED_FORMAT_OPERATION');
 if(source.sizeBytes>OFFICE_PRINT_SOURCE_MAX_BYTES)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
 if(expected){
  const checksum=createHash('sha256');let received=0;
  for await(const bytes of source.stream(signal)){signal.throwIfAborted();received+=bytes.length;checksum.update(bytes);}
  if(received!==source.sizeBytes||checksum.digest('hex')!==source.sha256)throw Error('activity_tool_result_source_invalid');
  return readRetainedOfficePdf(root,binding,expected,signal);
 }
 return withPinnedOfficeInput(source,name,root,signal,async input=>{
  const retained=await exportOfficeInput(input,signal);
  await retainOfficePdf(db,root,input.directory,binding,retained,signal);
  return retained;
 },binaryPath);
}

export async function readActivityFileOfficePdf(db:DatabaseSync,reader:Pick<WorkbenchService,'readBinaryFile'>,
 owner:string,conversationId:string,activityId:string,input:ReturnType<typeof parseActivityFileDownloadQuery>,root:string,signal:AbortSignal,expected?:{sha256:string;size:number;pageCount:number},binaryPath?:string){
 const binding=createHash('sha256').update(JSON.stringify(['jot-office-print-store/v1',owner,conversationId,input.runId,activityId,input.resultSha,input.path,input.version,input.fileSha,input.size])).digest('hex');
 if(expected){
  if(!officePreviewFormat(input.path))throw Error('UNSUPPORTED_FORMAT_OPERATION');
  if(input.size>OFFICE_PRINT_SOURCE_MAX_BYTES)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
  signal.throwIfAborted();
  const checksum=createHash('sha256');let received=0;
  const file=withReadTransaction(db,()=>readActivityToolResultFileDownload(db,owner,conversationId,activityId,input,reader,bytes=>{
   signal.throwIfAborted();received+=bytes.length;
   if(received>input.size)throw Error('activity_tool_result_source_invalid');
   checksum.update(bytes);
  }));
  signal.throwIfAborted();
  if(received!==input.size||checksum.digest('hex')!==input.fileSha)throw Error('activity_tool_result_source_invalid');
  const retained=await readRetainedOfficePdf(root,binding,expected,signal);
  return {...file,...retained,execution_authorized:false as const};
 }
 return withPinnedOfficeSource(db,reader,owner,conversationId,activityId,input,root,signal,async({file,...staged})=>{
  const retained=await exportOfficeInput(staged,signal);
  await retainOfficePdf(db,root,staged.directory,binding,retained,signal);
  return {...file,...retained,execution_authorized:false as const};
 },binaryPath);
}
