import type {GitIndexPlan} from './index-effects.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

/** Internal persisted observation data. Never a writable plan or API input. */
export type GitIndexEvidence={
 protocol:1;plan:GitIndexPlan;source_sha256:string;index_lock_identity:string;
 directories:{root:string;git:string;common:string;objects:string};dot_witness:string;
 refs:{ref:string|null;head_sha256:string;packed_sha256:string|null;branch_sha256:string|null};
 blobs:Array<{oid:string;sha256:string;size:number}>;
 locks:Array<{scope:'git'|'common';path:string;identity:string;sha256:string}>;
 parents:Array<{path:string;identity:string}>;
};
const SHA=/^[a-f0-9]{64}$/,IDENTITY=/^[0-9]+:[0-9]+$/;
const shape=(value:any,names:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...names].sort().join('\0');
const nullableHash=(value:unknown)=>value===null||typeof value==='string'&&SHA.test(value);
export function indexEvidence(value:unknown):GitIndexEvidence{
 try{
  const e=value as GitIndexEvidence,p=e?.plan;
  if(!shape(e,['protocol','plan','source_sha256','index_lock_identity','directories','dot_witness','refs','blobs','locks','parents'])||e.protocol!==1
   ||!shape(p,['plan_id','action','paths','repository_sha256','before_index_sha256','index_sha256','execution_authorized'])
   ||typeof p.plan_id!=='string'||!/^git-index-[a-f0-9-]{36}$/.test(p.plan_id)||!['stage','unstage'].includes(p.action)||p.execution_authorized!==false
   ||!SHA.test(p.repository_sha256)||!SHA.test(p.index_sha256)||!nullableHash(p.before_index_sha256)||!SHA.test(e.source_sha256)||!IDENTITY.test(e.index_lock_identity)
   ||!Array.isArray(p.paths)||!p.paths.length||p.paths.length>100||new Set(p.paths).size!==p.paths.length)throw Error();
  for(const path of p.paths)if(typeof path!=='string'||path.startsWith('-')||workspaceRelativePath(path)!==path)throw Error();
  if(!shape(e.directories,['root','git','common','objects'])||Object.values(e.directories).some(id=>typeof id!=='string'||!IDENTITY.test(id))
   ||typeof e.dot_witness!=='string'||!/^directory:[0-9]+:[0-9]+$|^file:[a-f0-9]{64}$/.test(e.dot_witness)
   ||!shape(e.refs,['ref','head_sha256','packed_sha256','branch_sha256'])||!SHA.test(e.refs.head_sha256)||!nullableHash(e.refs.packed_sha256)||!nullableHash(e.refs.branch_sha256))throw Error();
  if(e.refs.ref!==null&&(typeof e.refs.ref!=='string'||!e.refs.ref.startsWith('refs/heads/')||workspaceRelativePath(e.refs.ref)!==e.refs.ref)||e.refs.ref===null&&e.refs.branch_sha256!==null)throw Error();
  const expected=['git:index.lock','git:HEAD.lock','common:packed-refs.lock',...(e.refs.ref?['common:'+e.refs.ref+'.lock']:[])].sort(),seenLocks:string[]=[];
  if(!Array.isArray(e.locks)||e.locks.length!==expected.length)throw Error();
  for(const lock of e.locks){if(!shape(lock,['scope','path','identity','sha256'])||!['git','common'].includes(lock.scope)||typeof lock.path!=='string'||!IDENTITY.test(lock.identity)||!SHA.test(lock.sha256))throw Error();seenLocks.push(lock.scope+':'+lock.path);if(lock.scope==='git'&&lock.path==='index.lock'&&(lock.identity!==e.index_lock_identity||lock.sha256!==p.index_sha256))throw Error();}
  if(seenLocks.sort().join('\0')!==expected.join('\0'))throw Error();
  if(!Array.isArray(e.parents)||e.parents.length>256||new Set(e.parents.map(parent=>parent.path)).size!==e.parents.length)throw Error();
  for(const parent of e.parents)if(!shape(parent,['path','identity'])||typeof parent.path!=='string'||workspaceRelativePath(parent.path)!==parent.path||!parent.path.startsWith('refs')||!e.refs.ref?.startsWith(parent.path+'/')||!IDENTITY.test(parent.identity))throw Error();
  if(!Array.isArray(e.blobs)||e.blobs.length>100)throw Error();let size=0;const seen=new Set<string>();
  for(const blob of e.blobs){if(!shape(blob,['oid','sha256','size'])||typeof blob.oid!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob.oid)||!SHA.test(blob.sha256)||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>32*1024*1024||seen.has(blob.oid))throw Error();seen.add(blob.oid);size+=blob.size;}
  if(size>64*1024*1024)throw Error();return structuredClone(e);
 }catch{throw Error('git_index_evidence_invalid');}
}
