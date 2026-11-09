import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readGit,type GitProcessLimits} from './process.ts';
import type {GitReadContext} from './inspection.ts';

type Blob={oid:string;size:number};
const unavailable=():never=>{throw Error('git_checkout_unavailable')};

/** Verify the exact preflighted batch while retaining only a header and hash states. */
export async function readGitBlobDigests(executable:string,root:string,context:GitReadContext,objects:string,format:'sha1'|'sha256',expected:readonly Blob[],limits:GitProcessLimits,signal?:AbortSignal){
 signal?.throwIfAborted();
 if(!expected.length)return [];
 const oidPattern=new RegExp('^[a-f0-9]{'+(format==='sha1'?40:64)+'}$'),seen=new Set<string>();
 let wireBytes=0n;
 for(const entry of expected){
  if(!oidPattern.test(entry.oid)||seen.has(entry.oid)||!Number.isSafeInteger(entry.size)||entry.size<0)unavailable();
  seen.add(entry.oid);wireBytes+=BigInt(entry.size)+BigInt(Buffer.byteLength(entry.oid+' blob '+entry.size+'\n'))+1n;
 }
 if(wireBytes>BigInt(Number.MAX_SAFE_INTEGER))throw Error('git_output_limit');
 const start=(entry:Blob)=>({header:Buffer.from(entry.oid+' blob '+entry.size+'\n','ascii'),position:0,remaining:entry.size,
  object:createHash(format).update('blob '+entry.size+'\0'),content:createHash('sha256')});
 let row=0,state=start(expected[0]!);
 const digests:Array<{oid:string;size:number;sha256:string}>=[];
 const consume=(chunk:Buffer)=>{
  let offset=0;
  while(offset<chunk.length){
   if(row>=expected.length)unavailable();
   if(state.position<state.header.length){
    const count=Math.min(state.header.length-state.position,chunk.length-offset);
    if(!chunk.subarray(offset,offset+count).equals(state.header.subarray(state.position,state.position+count)))unavailable();
    offset+=count;state.position+=count;continue;
   }
   if(state.remaining){
    const count=Math.min(state.remaining,chunk.length-offset),body=chunk.subarray(offset,offset+count);
    state.object.update(body);state.content.update(body);state.remaining-=count;offset+=count;continue;
   }
   const entry=expected[row]!;
   if(chunk[offset++]!==10||state.object.digest('hex')!==entry.oid)unavailable();
   digests.push({oid:entry.oid,size:entry.size,sha256:state.content.digest('hex')});row++;
   if(row<expected.length)state=start(expected[row]!);
  }
 };
 const result=await readGit(executable,root,context.directory,['cat-file','--batch'],{...limits,maxOutputBytes:Number(wireBytes)},signal,
  join(context.directory,'objects'),Buffer.from(expected.map(entry=>entry.oid).join('\n')+'\n','ascii'),objects,undefined,consume);
 signal?.throwIfAborted();
 if(result.code!==0)return null;
 if(row!==expected.length)unavailable();
 return digests;
}
