import {constants,existsSync,lstatSync,readdirSync,renameSync} from 'node:fs';
import {mkdir,mkdtemp,lstat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type ExpectedPdf={sha256:string;size:number;pageCount:number};
type RetainedOfficePdf={pdf:{bytes:Buffer;sha256:string;size:number;page_count:number};engine:{name:string;version:string}};
const maxBytes=512*1024*1024,maxEntries=128,pdfLimit=20*1024*1024;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=()=>Error('office_print_retained_invalid');

async function readPrivateFile(path:string,limit:number,signal:AbortSignal){
 signal.throwIfAborted();
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=await handle.stat();
  if(!before.isFile()||before.nlink!==1||before.size<1||before.size>limit)throw invalid();
  const bytes=await handle.readFile();signal.throwIfAborted();const after=await handle.stat();
  if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw invalid();
  return bytes;
 }finally{await handle.close();}
}

export async function readRetainedOfficePdf(root:string,binding:string,expected:ExpectedPdf,signal:AbortSignal):Promise<RetainedOfficePdf>{
 if(typeof root!=='string'||!isAbsolute(root)||!hash(binding)||!hash(expected.sha256)||!Number.isSafeInteger(expected.size)||expected.size<100||expected.size>pdfLimit
  ||!Number.isSafeInteger(expected.pageCount)||expected.pageCount<1||expected.pageCount>50000)throw invalid();
 const folder=join(root,'retained-office-pdfs'),entry=join(folder,binding+'-'+expected.sha256);
 try{
  for(const path of [root,folder,entry]){const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw invalid();}
  const metadata=JSON.parse((await readPrivateFile(join(entry,'source.json'),8192,signal)).toString('utf8'));
  if(!metadata||typeof metadata!=='object'||Object.keys(metadata).sort().join(',')!=='binding,engine,pageCount,protocol,sha256,size'
   ||metadata.protocol!==1||metadata.binding!==binding||metadata.sha256!==expected.sha256||metadata.size!==expected.size||metadata.pageCount!==expected.pageCount
   ||!metadata.engine||Object.keys(metadata.engine).sort().join(',')!=='name,version'||metadata.engine.name!=='libreoffice_uno'
   ||typeof metadata.engine.version!=='string'||!metadata.engine.version||metadata.engine.version.length>200)throw invalid();
  const bytes=await readPrivateFile(join(entry,'preview.pdf'),pdfLimit,signal);
  if(bytes.length!==expected.size||bytes.subarray(0,5).toString('ascii')!=='%PDF-'||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw invalid();
  return {pdf:{bytes,sha256:expected.sha256,size:expected.size,page_count:expected.pageCount},engine:{name:metadata.engine.name,version:metadata.engine.version}};
 }catch(error){
  signal.throwIfAborted();
  if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('office_print_retained_unavailable');
  throw invalid();
 }
}

/** Stage outside the database transaction, then serialize only quota accounting and atomic publication. */
export async function retainOfficePdf(db:DatabaseSync,root:string,jobDirectory:string,binding:string,value:RetainedOfficePdf,signal:AbortSignal){
 const expected={sha256:value.pdf.sha256,size:value.pdf.size,pageCount:value.pdf.page_count};
 if(!hash(binding)||!hash(expected.sha256)||value.pdf.bytes.length!==expected.size||expected.size<100||expected.size>pdfLimit)throw invalid();
 const folder=join(root,'retained-office-pdfs'),destination=join(folder,binding+'-'+expected.sha256);
 await mkdir(folder,{recursive:true,mode:0o700});const parent=await lstat(folder);
 if(!parent.isDirectory()||parent.isSymbolicLink())throw invalid();
 const stage=await mkdtemp(join(jobDirectory,'retained-'));
 try{
  const metadata={protocol:1,binding,...expected,engine:value.engine};
  for(const [name,bytes] of [['source.json',Buffer.from(JSON.stringify(metadata))],['preview.pdf',value.pdf.bytes]] as const){
   signal.throwIfAborted();const handle=await open(join(stage,name),'wx',0o600);
   try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  }
  withImmediateTransaction(db,()=>{
   signal.throwIfAborted();
   if(existsSync(destination))return;
   const entries=readdirSync(folder);let used=0;
   if(entries.length>=maxEntries)throw Error('office_print_retention_full');
   for(const name of entries){
    if(!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(name))throw invalid();
    const path=join(folder,name),entry=lstatSync(path);
    if(!entry.isDirectory()||entry.isSymbolicLink())throw invalid();
    for(const file of ['source.json','preview.pdf']){
     const stat=lstatSync(join(path,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw invalid();used+=stat.size;
    }
   }
   if(used+value.pdf.bytes.length+Buffer.byteLength(JSON.stringify(metadata))>maxBytes)throw Error('office_print_retention_full');
   renameSync(stage,destination);
  });
  // Also validates an identical entry published by another gateway process.
  await readRetainedOfficePdf(root,binding,expected,signal);
 }finally{await rm(stage,{recursive:true,force:true});}
}
