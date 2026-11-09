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
export function gitTreeEntries(bytes:Buffer,tree:boolean,max:number):Entry[]{
 const value=text(bytes);if(value&&!value.endsWith('\0'))unavailable();const rows=value.split('\0').filter(Boolean);if(rows.length>max)unavailable();
 const seen=new Set<string>();return rows.map((row):Entry=>{
  const match=tree?/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row):/^(100644|100755|120000|160000) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(row);if(!match)unavailable();
  const mode=match[1]!,type=mode==='160000'?'commit':'blob',oid=match[tree?3:2]!,path=match[tree?4:3]!;if(!OID.test(oid)||tree&&match[2]!==type||seen.has(path)||path.startsWith('-'))unavailable();try{if(workspaceRelativePath(path)!==path)unavailable()}catch{unavailable()}seen.add(path);return{path,mode,oid,type};
 }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export type GitCommitTreeObject={oid:string;body:Buffer};

export function gitObjectBatch(bytes:Buffer,oids:readonly string[],type:'blob'|'tree',format:'sha1'|'sha256',maxSize:number,maxTotal:number):GitCommitTreeObject[]{
 let offset=0,total=0;
 const objects=oids.map(oid=>{
  const end=bytes.indexOf(10,offset);
  if(end<0)unavailable();
  const header=bytes.subarray(offset,end).toString('ascii');
  const match=/^([a-f0-9]+) (blob|tree) (0|[1-9][0-9]*)$/.exec(header);
  if(!match||match[1]!==oid||match[2]!==type)unavailable();
  const size=Number(match[3]);
  if(!Number.isSafeInteger(size)||size>maxSize||(total+=size)>maxTotal)unavailable();
  offset=end+1;
  const body=bytes.subarray(offset,offset+size);
  if(body.length!==size||bytes[offset+size]!==10
   ||createHash(format).update(type+' '+size+'\0').update(body).digest('hex')!==oid)unavailable();
  offset+=size+1;
  return {oid,body};
 });
 if(offset!==bytes.length)unavailable();
 return objects;
}

/** Fixed internal read commands; object output and cache-tree updates are confined
 * to the original disposable metadata copy. No original ref/index/object writes. */
export async function readCommitTree(executable:string,root:string,context:GitReadContext,objects:string,limits:GitProcessLimits&{maxEntries:number},signal?:AbortSignal):Promise<GitCommitTreeEvidence>{
 signal?.throwIfAborted();if(!context.index)unavailable();
 const run=async(args:string[],output=limits.maxOutputBytes,input?:Buffer,privateOutput=false)=>{
  const result=await readGit(executable,root,context.directory,args,{...limits,maxOutputBytes:output},signal,privateOutput?join(context.directory,'objects'):objects,input,privateOutput?objects:undefined);if(result.code!==0)unavailable();return result.bytes;
 };
 const format=text(await run(['rev-parse','--show-object-format'])).trim();if(format!=='sha1'&&format!=='sha256')unavailable();
 const staged=gitTreeEntries(await run(['ls-files','--stage','-z']),false,limits.maxEntries);if(staged.some(entry=>entry.oid.length!==(format==='sha1'?40:64)))unavailable();
 const tree=text(await run(['write-tree'],limits.maxOutputBytes,undefined,true)).trim();if(!OID.test(tree)||tree.length!==(format==='sha1'?40:64))unavailable();
 const rendered=gitTreeEntries(await run(['ls-tree','-r','--full-tree','-z',tree],limits.maxOutputBytes,undefined,true),true,limits.maxEntries);if(canonicalJson(staged)!==canonicalJson(rendered))unavailable();
 const oids=[...new Set(staged.filter(entry=>entry.type==='blob').map(entry=>entry.oid))].sort(),blobs:Array<{oid:string;sha256:string;size:number}>=[];
 if(oids.length){
  const bytes=await run(['cat-file','--batch'],64*1024*1024,Buffer.from(oids.join('\n')+'\n'));
  for(const object of gitObjectBatch(bytes,oids,'blob',format,32*1024*1024,64*1024*1024)){
   blobs.push({oid:object.oid,sha256:hash(object.body),size:object.body.length});
  }
 }
 signal?.throwIfAborted();return{protocol:1,object_format:format,tree_oid:tree,index_sha256:context.index,entries_sha256:hash(canonicalJson(staged)),entry_count:staged.length,blobs_sha256:hash(canonicalJson(blobs)),blob_count:blobs.length,execution_authorized:false};
}

/** Retain only the exact reviewed tree graph from the original isolated copy.
 * Staged blobs and submodule commits stay in the original object store. */
export async function readCommitTreeObjects(executable:string,root:string,context:GitReadContext,objects:string,limits:GitProcessLimits&{maxEntries:number},expected:GitCommitTreeEvidence,signal?:AbortSignal):Promise<GitCommitTreeObject[]>{
 const evidence=await readCommitTree(executable,root,context,objects,limits,signal);
 if(canonicalJson(evidence)!==canonicalJson(expected))throw Error('git_commit_review_changed');
 const run=async(args:string[],input?:Buffer)=>{
  const result=await readGit(executable,root,context.directory,args,{...limits,maxOutputBytes:16*1024*1024},signal,join(context.directory,'objects'),input,objects);
  if(result.code!==0)unavailable();
  return result.bytes;
 };
 const rendered=text(await run(['ls-tree','-r','-t','--full-tree','-z',evidence.tree_oid]));
 if(rendered&&!rendered.endsWith('\0'))unavailable();
 const treeOids=new Set([evidence.tree_oid]);
 for(const row of rendered.split('\0').filter(Boolean)){
  const match=/^(040000|100644|100755|120000|160000) (tree|blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
  if(!match||match[3]!.length!==(evidence.object_format==='sha1'?40:64))unavailable();
  const path=match[4]!;
  try{if(workspaceRelativePath(path)!==path)unavailable()}catch{unavailable()}
  if(match[1]==='040000'){
   if(match[2]!=='tree')unavailable();
   treeOids.add(match[3]!);
   if(treeOids.size>limits.maxEntries+1)unavailable();
  }else if(match[2]!== (match[1]==='160000'?'commit':'blob'))unavailable();
 }
 const oids=[...treeOids].sort();
 const bytes=await run(['cat-file','--batch'],Buffer.from(oids.join('\n')+'\n'));
 signal?.throwIfAborted();
 return gitObjectBatch(bytes,oids,'tree',evidence.object_format,8*1024*1024,16*1024*1024);
}
