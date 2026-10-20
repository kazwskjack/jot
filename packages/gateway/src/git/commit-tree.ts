import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {readGit,type GitProcessLimits} from './process.ts';
import type {GitReadContext,GitReviewWitness} from './inspection.ts';

export type GitCommitTreeEvidence={protocol:1;object_format:'sha1'|'sha256';tree_oid:string;index_sha256:string;entries_sha256:string;entry_count:number;blobs_sha256:string;blob_count:number;execution_authorized:false};
export type GitCommitReviewWitness=GitReviewWitness&{commit_tree:GitCommitTreeEvidence};
type Entry={path:string;mode:string;oid:string;type:'blob'|'commit'};
function unavailable():never{throw Error('git_commit_tree_unavailable')}
const text=(bytes:Buffer)=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return unavailable()}};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const OID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function entries(bytes:Buffer,tree:boolean,max:number):Entry[]{
 const value=text(bytes);if(value&&!value.endsWith('\0'))unavailable();const rows=value.split('\0').filter(Boolean);if(rows.length>max)unavailable();
 const seen=new Set<string>();return rows.map((row):Entry=>{
  const match=tree?/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row):/^(100644|100755|120000|160000) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(row);if(!match)unavailable();
  const mode=match[1]!,type=mode==='160000'?'commit':'blob',oid=match[tree?3:2]!,path=match[tree?4:3]!;if(!OID.test(oid)||tree&&match[2]!==type||seen.has(path)||path.startsWith('-'))unavailable();try{if(workspaceRelativePath(path)!==path)unavailable()}catch{unavailable()}seen.add(path);return{path,mode,oid,type};
 }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** Fixed internal read commands; object output and cache-tree updates are confined
 * to the original disposable metadata copy. No original ref/index/object writes. */
export async function readCommitTree(executable:string,root:string,context:GitReadContext,objects:string,limits:GitProcessLimits&{maxEntries:number},signal?:AbortSignal):Promise<GitCommitTreeEvidence>{
 signal?.throwIfAborted();if(!context.index)unavailable();
 const run=async(args:string[],output=limits.maxOutputBytes,input?:Buffer,privateOutput=false)=>{
  const result=await readGit(executable,root,context.directory,args,{...limits,maxOutputBytes:output},signal,privateOutput?join(context.directory,'objects'):objects,input,privateOutput?objects:undefined);if(result.code!==0)unavailable();return result.bytes;
 };
 const format=text(await run(['rev-parse','--show-object-format'])).trim();if(format!=='sha1'&&format!=='sha256')unavailable();
 const staged=entries(await run(['ls-files','--stage','-z']),false,limits.maxEntries);if(staged.some(entry=>entry.oid.length!==(format==='sha1'?40:64)))unavailable();
 const tree=text(await run(['write-tree'],limits.maxOutputBytes,undefined,true)).trim();if(!OID.test(tree)||tree.length!==(format==='sha1'?40:64))unavailable();
 const rendered=entries(await run(['ls-tree','-r','--full-tree','-z',tree],limits.maxOutputBytes,undefined,true),true,limits.maxEntries);if(canonicalJson(staged)!==canonicalJson(rendered))unavailable();
 const oids=[...new Set(staged.filter(entry=>entry.type==='blob').map(entry=>entry.oid))].sort(),blobs:Array<{oid:string;sha256:string;size:number}>=[];
 if(oids.length){
  const bytes=await run(['cat-file','--batch'],64*1024*1024,Buffer.from(oids.join('\n')+'\n'));let offset=0,total=0;
  for(const oid of oids){const end=bytes.indexOf(10,offset);if(end<0)unavailable();const header=bytes.subarray(offset,end).toString('ascii'),match=/^([a-f0-9]+) blob (0|[1-9][0-9]*)$/.exec(header);if(!match||match[1]!==oid)unavailable();const size=Number(match[2]);if(!Number.isSafeInteger(size)||size>32*1024*1024||(total+=size)>64*1024*1024)unavailable();offset=end+1;const content=bytes.subarray(offset,offset+size);if(content.length!==size||bytes[offset+size]!==10||createHash(format).update('blob '+size+'\0').update(content).digest('hex')!==oid)unavailable();blobs.push({oid,sha256:hash(content),size});offset+=size+1;
  }if(offset!==bytes.length)unavailable();
 }
 signal?.throwIfAborted();return{protocol:1,object_format:format,tree_oid:tree,index_sha256:context.index,entries_sha256:hash(canonicalJson(staged)),entry_count:staged.length,blobs_sha256:hash(canonicalJson(blobs)),blob_count:blobs.length,execution_authorized:false};
}
