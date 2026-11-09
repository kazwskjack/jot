import {validGitReference} from './references.ts';
import {createHash} from 'node:crypto';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

export type GitCommitPlan=Readonly<{
 protocol:1;plan_id:string;action:'commit';paths:readonly string[];
 repository_sha256:string;source_sha256:string;review_sha256:string;metadata_sha256:string;
 object_format:'sha1'|'sha256';tree_oid:string;parent_oid:string|null;target_ref:string;
 index_sha256:string;commit_oid:string;commit_sha256:string;commit_size:number;
 tree_objects:readonly {oid:string;sha256:string;size:number}[];execution_authorized:false;
}>;
export type GitCommitEvidence={
 protocol:1;plan:GitCommitPlan;index_lock_identity:string;
 directories:{root:string;git:string;common:string;objects:string};dot_witness:string;
 refs:{ref:string|null;head_sha256:string;packed_sha256:string|null;branch_sha256:string|null};
 locks:Array<{scope:'git'|'common';path:string;identity:string;sha256:string}>;
 parents:Array<{path:string;identity:string}>;
};
export type GitCommitPreparation={protocol:1;evidence:GitCommitEvidence;pending:Array<{scope:'git'|'common';target:string;path:string;identity:string;sha256:string}>};
const SHA=/^[a-f0-9]{64}$/,IDENTITY=/^[0-9]+:[0-9]+$/;
const shape=(value:any,names:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...names].sort().join('\0');
const nullableHash=(value:unknown)=>value===null||typeof value==='string'&&SHA.test(value);
const emptyHash=createHash('sha256').update('').digest('hex');

/** Persisted facts are observation/cleanup input. A writable plan is retained
 * only by the original kernel's in-process identity map. */
export function gitCommitEvidence(value:unknown):GitCommitEvidence{
 try{
  const e=value as GitCommitEvidence,p=e?.plan;
  if(!shape(e,['protocol','plan','index_lock_identity','directories','dot_witness','refs','locks','parents'])||e.protocol!==1
   ||!shape(p,['protocol','plan_id','action','paths','repository_sha256','source_sha256','review_sha256','metadata_sha256','object_format','tree_oid','parent_oid','target_ref','index_sha256','commit_oid','commit_sha256','commit_size','tree_objects','execution_authorized'])
   ||p.protocol!==1||p.action!=='commit'||p.execution_authorized!==false
   ||typeof p.plan_id!=='string'||!/^git-commit-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.plan_id)
   ||!['sha1','sha256'].includes(p.object_format))throw Error();
  for(const digest of [p.repository_sha256,p.source_sha256,p.review_sha256,p.metadata_sha256,p.index_sha256,p.commit_sha256])if(typeof digest!=='string'||!SHA.test(digest))throw Error();
  const oid=(input:unknown)=>typeof input==='string'&&new RegExp('^[a-f0-9]{'+(p.object_format==='sha1'?40:64)+'}$').test(input);
  if(!oid(p.tree_oid)||!oid(p.commit_oid)||p.parent_oid!==null&&!oid(p.parent_oid)
   ||!Number.isSafeInteger(p.commit_size)||p.commit_size<1||p.commit_size>64*1024
   ||typeof p.target_ref!=='string'||p.target_ref.length>1024)throw Error();
  if(p.target_ref!=='HEAD'&&(!p.target_ref.startsWith('refs/heads/')||workspaceRelativePath(p.target_ref)!==p.target_ref||!validGitReference(p.target_ref)))throw Error();
  if(p.target_ref==='HEAD'&&p.parent_oid===null)throw Error();
  if(!Array.isArray(p.paths)||!p.paths.length||p.paths.length>5000||new Set(p.paths).size!==p.paths.length)throw Error();
  for(const path of p.paths)if(typeof path!=='string'||path.startsWith('-')||workspaceRelativePath(path)!==path)throw Error();
  if(!Array.isArray(p.tree_objects)||!p.tree_objects.length||p.tree_objects.length>100001)throw Error();
  const seenObjects=new Set<string>();let size=0;
  for(const object of p.tree_objects){
   if(!shape(object,['oid','sha256','size'])||!oid(object.oid)||typeof object.sha256!=='string'||!SHA.test(object.sha256)
    ||!Number.isSafeInteger(object.size)||object.size<0||object.size>8*1024*1024||seenObjects.has(object.oid))throw Error();
   seenObjects.add(object.oid);size+=object.size;
  }
  if(size>16*1024*1024||!seenObjects.has(p.tree_oid))throw Error();
  if(!shape(e.directories,['root','git','common','objects'])||Object.values(e.directories).some(id=>typeof id!=='string'||!IDENTITY.test(id))
   ||typeof e.index_lock_identity!=='string'||!IDENTITY.test(e.index_lock_identity)
   ||typeof e.dot_witness!=='string'||!/^directory:[0-9]+:[0-9]+$|^file:[a-f0-9]{64}$/.test(e.dot_witness)
   ||!shape(e.refs,['ref','head_sha256','packed_sha256','branch_sha256'])||typeof e.refs.head_sha256!=='string'||!SHA.test(e.refs.head_sha256)
   ||!nullableHash(e.refs.packed_sha256)||!nullableHash(e.refs.branch_sha256)
   ||e.refs.ref!==(p.target_ref==='HEAD'?null:p.target_ref)||e.refs.ref===null&&e.refs.branch_sha256!==null)throw Error();
  const expected=['git:index.lock','git:HEAD.lock','common:packed-refs.lock',...(e.refs.ref?['common:'+e.refs.ref+'.lock']:[])].sort();
  if(!Array.isArray(e.locks)||e.locks.length!==expected.length)throw Error();
  const seenLocks:string[]=[],identities=new Set<string>();
  for(const lock of e.locks){
   if(!shape(lock,['scope','path','identity','sha256'])||!['git','common'].includes(lock.scope)||typeof lock.path!=='string'
    ||typeof lock.identity!=='string'||!IDENTITY.test(lock.identity)||identities.has(lock.identity))throw Error();
   const index=lock.scope==='git'&&lock.path==='index.lock';
   if(lock.sha256!==(index?p.index_sha256:emptyHash)||index&&lock.identity!==e.index_lock_identity)throw Error();
   seenLocks.push(lock.scope+':'+lock.path);identities.add(lock.identity);
  }
  if(seenLocks.sort().join('\0')!==expected.join('\0'))throw Error();
  if(!Array.isArray(e.parents)||e.parents.length>512||new Set(e.parents.map(parent=>parent.path)).size!==e.parents.length)throw Error();
  for(const parent of e.parents)if(!shape(parent,['path','identity'])||typeof parent.path!=='string'||workspaceRelativePath(parent.path)!==parent.path
   ||!(parent.path==='refs'||parent.path.startsWith('refs/'))||!e.refs.ref?.startsWith(parent.path+'/')||typeof parent.identity!=='string'||!IDENTITY.test(parent.identity))throw Error();
  return structuredClone(e);
 }catch{throw Error('git_commit_evidence_invalid');}
}

export function gitCommitPreparation(value:unknown):GitCommitPreparation{
 try{
  const p=value as GitCommitPreparation;
  if(!shape(p,['protocol','evidence','pending'])||p.protocol!==1)throw Error();
  const evidence=gitCommitEvidence(p.evidence);
  if(!Array.isArray(p.pending)||p.pending.length!==evidence.locks.length)throw Error();
  const names=new Set<string>(),targets=new Set<string>(),identities=new Set<string>();
  for(const file of p.pending){
   if(!shape(file,['scope','target','path','identity','sha256'])||typeof file.path!=='string'
    ||!/^jot-commit-lock-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/.test(file.path))throw Error();
   const target=evidence.locks.find(lock=>lock.scope===file.scope&&lock.path===file.target);
   if(!target||target.identity!==file.identity||target.sha256!==file.sha256||names.has(file.path)||targets.has(file.scope+':'+file.target)||identities.has(file.identity))throw Error();
   names.add(file.path);targets.add(file.scope+':'+file.target);identities.add(file.identity);
  }
  return {protocol:1,evidence,pending:structuredClone(p.pending)};
 }catch{throw Error('git_commit_preparation_invalid');}
}
