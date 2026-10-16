import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import type {ResolvedAttachment} from '../artifacts/resolver.ts';
function invalid():never{throw Error('historical_output_integrity_unconfirmed');}
function safePath(root:string,path:string){
 const local=resolve(path),base=resolve(root);if(local===base||!local.startsWith(base+sep))invalid();
 for(let p=local;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())invalid();if(dirname(p)===p)break;}
 const actual=realpathSync(local),actualRoot=realpathSync(base);if(actual===actualRoot||!actual.startsWith(actualRoot+sep))invalid();return local;
}
function sameFile(a:BigIntStats,b:BigIntStats){
 return a.isFile()&&b.isFile()&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
export type HistoricalOutputWitness=Readonly<{assertUnchanged():void;close():void}>;
/** Hash actual bounded bytes outside a database write lock. Keep the verified
 * descriptors until the caller's catalog/source CAS commits. This process-local
 * witness is not a filesystem snapshot, native authority or a serialized proof. */
export function captureHistoricalOutputBytes(root:string,items:readonly ResolvedAttachment[],signal?:AbortSignal):HistoricalOutputWitness{
 const handles:number[]=[],facts:Array<{fd:number;path:string;stat:BigIntStats}>=[];let closed=false;
 const close=()=>{if(closed)return;closed=true;for(const fd of handles){try{closeSync(fd);}catch{/* Close every owned descriptor even after an earlier close fails. */}}};
 const assertUnchanged=()=>{
  if(closed)invalid();signal?.throwIfAborted();
  for(const fact of facts){
   const current=lstatSync(safePath(root,fact.path),{bigint:true}),descriptor=fstatSync(fact.fd,{bigint:true});
   if(!sameFile(fact.stat,descriptor)||!sameFile(fact.stat,current))invalid();
  }
 };
 try{
  const buffer=Buffer.alloc(65536);
  for(const item of items){
   signal?.throwIfAborted();
   if(!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<0||!Number.isSafeInteger(item.version)||Number(item.version)<1||!/^[a-f0-9]{64}$/.test(item.sha256))invalid();
   const path=safePath(root,item.localPath),fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));handles.push(fd);
   const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size!==BigInt(item.sizeBytes))invalid();
   const hash=createHash('sha256');let total=0;
   for(;;){signal?.throwIfAborted();const n=readSync(fd,buffer,0,Math.min(buffer.length,item.sizeBytes-total+1),total);if(!n)break;total+=n;if(total>item.sizeBytes)invalid();hash.update(buffer.subarray(0,n));}
   if(total!==item.sizeBytes||hash.digest('hex')!==item.sha256)invalid();
   facts.push({fd,path,stat:before});
  }
  assertUnchanged();return Object.freeze({assertUnchanged,close});
 }catch(error){close();throw error;}
}

/** Immediate validation for callers that do not cross a database CAS. */
export function verifyHistoricalOutputBytes(root:string,items:readonly ResolvedAttachment[]){
 const witness=captureHistoricalOutputBytes(root,items);try{witness.assertUnchanged();}finally{witness.close();}
}
