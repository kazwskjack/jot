import {constants,existsSync,mkdtempSync,renameSync} from 'node:fs';
import {mkdir,lstat,open,unlink,rmdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,isAbsolute,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {NativeFileProofSource} from '../messages/native-file-proof.ts';
import type {PinnedByteSource} from './pinned-byte-source.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {assertRetainedFileCapacity,nativeStageReservation} from './retained-file-quota.ts';

type NativeFileRecord={protocol:1;binding:string;source:NativeFileProofSource;source_metadata_sha256?:string};
const metadataHash=(source:NativeFileProofSource)=>createHash('sha256').update(canonicalJson(source)).digest('hex');
const sameRecord=(a:NativeFileRecord,b:NativeFileRecord)=>a.binding===b.binding&&canonicalJson(a.source)===canonicalJson(b.source);
const limit=512*1024*1024,metadataLimit=256*1024;
const sha=(value:unknown):value is string=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
const invalid=()=>Error('native_file_retained_invalid');
function validSource(value:unknown):value is NativeFileProofSource{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const source=value as NativeFileProofSource,keys=['conversationId','runId','activityId','resultSha','membersSha','memberIndex','path','openSha','sha256','size'];
 return keys.every(key=>Object.hasOwn(source,key))&&Object.keys(source).every(key=>keys.includes(key)||key==='asOfSeq')
  &&[source.conversationId,source.runId,source.activityId].every(value=>typeof value==='string'&&value.length>0&&value.length<=192)
  &&[source.resultSha,source.membersSha,source.openSha,source.sha256].every(sha)&&Number.isSafeInteger(source.memberIndex)&&source.memberIndex>=0&&source.memberIndex<=32*1024*1024
  &&typeof source.path==='string'&&source.path.length>0&&source.path.length<=32768&&!source.path.includes('\0')
  &&Number.isSafeInteger(source.size)&&source.size>=0&&source.size<=limit
  &&(source.asOfSeq===undefined||typeof source.asOfSeq==='string'&&source.asOfSeq.length<=19&&/^(0|[1-9][0-9]{0,18})$/.test(source.asOfSeq)&&String(BigInt(source.asOfSeq))===source.asOfSeq&&BigInt(source.asOfSeq)<=9223372036854775807n);
}
async function* privateBytes(path:string,maxBytes:number,signal:AbortSignal,expected?:{sha256:string;size:number}){
 signal.throwIfAborted();const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1)throw invalid();
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=await handle.stat();
  if(!before.isFile()||before.nlink!==1||before.dev!==entry.dev||before.ino!==entry.ino||before.size!==entry.size||before.mtimeMs!==entry.mtimeMs||before.ctimeMs!==entry.ctimeMs||!Number.isSafeInteger(before.size)||before.size<0||before.size>maxBytes||expected&&before.size!==expected.size)throw invalid();
  const hash=createHash('sha256');let offset=0;
  while(offset<before.size){
   signal.throwIfAborted();const bytes=Buffer.allocUnsafe(Math.min(65536,before.size-offset)),read=await handle.read(bytes,0,bytes.length,offset);
   if(read.bytesRead<1)throw invalid();offset+=read.bytesRead;const chunk=bytes.subarray(0,read.bytesRead);hash.update(chunk);yield chunk;
  }
  signal.throwIfAborted();const after=await handle.stat();
  if(!after.isFile()||after.nlink!==1||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.ino!==before.ino||after.dev!==before.dev
   ||expected&&hash.digest('hex')!==expected.sha256)throw invalid();
 }finally{await handle.close();}
}
async function directory(path:string){const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw invalid();}
/** The lookup binding is computed from the original owned database activity and exact opened digest. */
export async function readRetainedNativeFile(root:string,binding:string,signal:AbortSignal):Promise<NativeFileRecord|undefined>{
 if(!isAbsolute(root)||!sha(binding))throw invalid();
 const folder=join(root,'retained-native-files'),entry=join(folder,binding);
 try{for(const path of [root,folder,entry])await directory(path);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{
  const chunks:Buffer[]=[];for await(const chunk of privateBytes(join(entry,'source.json'),metadataLimit,signal))chunks.push(chunk);
  const record=JSON.parse(Buffer.concat(chunks).toString('utf8')) as NativeFileRecord;
  if(!record||!['binding,protocol,source','binding,protocol,source,source_metadata_sha256'].includes(Object.keys(record).sort().join(','))||record.protocol!==1||record.binding!==binding||!validSource(record.source)
   ||record.source_metadata_sha256!==undefined&&(!sha(record.source_metadata_sha256)||record.source_metadata_sha256!==metadataHash(record.source)))throw invalid();
  return record;
 }catch(error){signal.throwIfAborted();throw invalid();}
}
/** Inventory metadata only. The route must validate original actor/activity binding before returning any item. */
export async function listRetainedNativeFiles(root:string,signal:AbortSignal):Promise<NativeFileRecord[]>{
 if(!isAbsolute(root))throw invalid();
 const folder=join(root,'retained-native-files');
 try{await directory(root);await directory(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 const names=(await readdir(folder)).sort();if(names.length>128)throw invalid();
 const records:NativeFileRecord[]=[];
 for(const name of names){
  signal.throwIfAborted();
  if(nativeStageReservation(name)!==undefined){await directory(join(folder,name));continue;}
  if(!sha(name))throw invalid();
  const record=await readRetainedNativeFile(root,name,signal);if(!record)throw Error('native_file_retained_changed');records.push(record);
 }
 return records;
}
/** Copy into the original request-private unlinked spool before any response bytes are exposed. */
export async function loadRetainedNativeFile(root:string,record:NativeFileRecord,target:{source:PinnedByteSource;append(bytes:Buffer):Promise<void>;seal():Promise<void>},signal:AbortSignal){
 if(!isAbsolute(root)||!sha(record.binding)||!validSource(record.source))throw invalid();
 for(const path of [root,join(root,'retained-native-files'),join(root,'retained-native-files',record.binding)])await directory(path);
 try{
  for await(const chunk of privateBytes(join(root,'retained-native-files',record.binding,'source.bin'),limit,signal,record.source))await target.append(chunk);
  await target.seal();
  if(target.source.sha256!==record.source.sha256||target.source.sizeBytes!==record.source.size)throw invalid();
 }catch(error){signal.throwIfAborted();throw invalid();}
}

/** Admission already proved the actual owned native member and complete original opened bytes. */
export async function retainNativeFile(db:DatabaseSync,root:string,binding:string,source:NativeFileProofSource,bytes:PinnedByteSource,signal:AbortSignal):Promise<boolean>{
 if(!isAbsolute(root)||!sha(binding)||!validSource(source)||bytes.sha256!==source.sha256||bytes.sizeBytes!==source.size)throw invalid();
 const record:NativeFileRecord={protocol:1,binding,source,source_metadata_sha256:metadataHash(source)},metadata=Buffer.from(JSON.stringify(record));if(metadata.length>metadataLimit)throw invalid();
 await mkdir(root,{recursive:true,mode:0o700});await directory(root);
 const folder=join(root,'retained-native-files'),destination=join(folder,binding);
 await mkdir(folder,{recursive:true,mode:0o700});await directory(folder);
 if(existsSync(destination)){
  const actual=await readRetainedNativeFile(root,binding,signal);if(!actual||!sameRecord(actual,record))throw invalid();
  for await(const chunk of privateBytes(join(destination,'source.bin'),limit,signal,source))void chunk;
  return true;
 }
 let reserved:string|undefined;
 try{reserved=withImmediateTransaction(db,()=>{
  signal.throwIfAborted();if(existsSync(destination))return undefined;
  assertRetainedFileCapacity(root,source.size+metadata.length,'native_file_retention_full');
  return mkdtempSync(join(folder,`.native-stage-${source.size+metadata.length}-${binding}-`));
 });}
 catch(error){signal.throwIfAborted();if(error instanceof Error&&error.message==='native_file_retention_full')return false;throw error;}
 if(!reserved){
  const actual=await readRetainedNativeFile(root,binding,signal);if(!actual||!sameRecord(actual,record))throw invalid();
  for await(const chunk of privateBytes(join(destination,'source.bin'),limit,signal,source))void chunk;
  return true;
 }
 const stage=reserved;let existing=false;
 try{
  for(const [name,stream] of [['source.json',[metadata]],['source.bin',bytes.stream(signal)]] as const){
   signal.throwIfAborted();const handle=await open(join(stage,name),'wx',0o600);
   try{
    for await(const chunk of stream){signal.throwIfAborted();let offset=0;while(offset<chunk.length){const result=await handle.write(chunk,offset,chunk.length-offset);if(result.bytesWritten<1)throw invalid();offset+=result.bytesWritten;}}
    await handle.sync();
   }finally{await handle.close();}
  }
  withImmediateTransaction(db,()=>{
   signal.throwIfAborted();if(existsSync(destination)){existing=true;return;}
   assertRetainedFileCapacity(root,source.size+metadata.length,'native_file_retention_full',basename(stage));renameSync(stage,destination);
  });
  const actual=await readRetainedNativeFile(root,binding,signal);
  if(!actual||!sameRecord(actual,record))throw invalid();
  if(existing)for await(const chunk of privateBytes(join(destination,'source.bin'),limit,signal,source))void chunk;
  return true;
 }catch(error){signal.throwIfAborted();if(error instanceof Error&&error.message==='native_file_retention_full')return false;throw error;}
 finally{
  for(const name of ['source.json','source.bin'])await unlink(join(stage,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await rmdir(stage).catch(error=>{if(error.code!=='ENOENT')throw error;});
 }
}
