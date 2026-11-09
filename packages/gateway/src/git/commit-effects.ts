import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,linkSync,unlinkSync,rmdirSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join,dirname,relative,sep} from 'node:path';
import type {GitCommitMetadata} from '../../contracts/types.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {commitReviewMetadata,gitCommitOperatorPolicy} from './commit-metadata.ts';
import {readCommitTreeObjects,type GitCommitReviewWitness,type GitCommitTreeObject} from './commit-tree.ts';
import {GitPublicationEffects} from './publication-effects.ts';
import type {GitSourceWitness} from './index-effects.ts';
import type {GitReadContext} from './inspection.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import {gitCommitEvidence,gitCommitPreparation,type GitCommitPlan,type GitCommitEvidence,type GitCommitPreparation} from './commit-evidence.ts';
import {readGit} from './process.ts';

export type GitCommitSource={paths:readonly string[];message:string;review_sha256:string;witness:GitCommitReviewWitness;metadata:GitCommitMetadata};
type GitCommitMaterial={
 witness:GitCommitReviewWitness;
 metadata:GitCommitMetadata;
 review_sha256:string;
 source_sha256:string;
 paths:readonly string[];
 tree_objects:readonly GitCommitTreeObject[];
 commit_object:{oid:string;body:Buffer;sha256:string};
 execution_authorized:false;
};
type Stored={material:GitCommitMaterial;source:GitSourceWitness;ref:string|null;mode:number;state:'ready'|'locking'|'consumed'};
type CommitAuthority={
 authorize:()=>void;
 prepared:(preparation:GitCommitPreparation)=>void;
 acquire:(preparation:GitCommitPreparation,install:()=>void)=>void;
 dispatch:(evidence:GitCommitEvidence)=>void;
 cleanup:(remove:()=>void)=>void;
};
type OwnedLock={path:string;identity:string};
const identity=(stat:{dev:bigint;ino:bigint})=>stat.dev+':'+stat.ino;
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function synchronous<T>(operation:()=>T):T{
 if(operation.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
 const value=operation();
 if(value&&typeof(value as {then?:unknown}).then==='function'){
  Promise.resolve(value).catch(()=>{});throw Error('git_execution_authority_missing');
 }
 return value;
}
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const signature=(value:GitCommitMetadata['author'])=>value.name+' <'+value.email+'> '+Date.parse(value.timestamp)/1000+' +0000';

/** Original host-private commit kernel. Serialized proof is never a writable
 * plan. Owner, Worker and native custody belong to the original coordinator. */
export class GitCommitEffects extends GitPublicationEffects{
 private readonly commitPlans=new WeakMap<GitCommitPlan,Stored>();
 async prepareCommit(raw:GitCommitSource,signal?:AbortSignal):Promise<GitCommitPlan>{
  signal?.throwIfAborted();
  if(!raw||!Array.isArray(raw.paths)||!raw.paths.length||raw.paths.length>100
   ||new Set(raw.paths).size!==raw.paths.length||!/^([a-f0-9]{64})$/.test(raw.review_sha256)
   ||raw.paths.some(path=>typeof path!=='string'||path.startsWith('-')||workspaceRelativePath(path)!==path))throw Error('git_commit_plan_invalid');
  const source=structuredClone(raw),{witness,metadata,message,paths}=source;
  const policy=gitCommitOperatorPolicy({author:{name:metadata.author.name,email:metadata.author.email},committer:{name:metadata.committer.name,email:metadata.committer.email}});
  const expected=commitReviewMetadata(policy,witness,message,metadata.author.timestamp);
  if(canonicalJson(expected)!==canonicalJson(metadata)
   ||hash(JSON.stringify({action:'commit',paths,message,witness,commit_metadata:metadata}))!==source.review_sha256
   ||canonicalJson(await this.freezeCommit(witness.snapshot_id,paths,signal))!==canonicalJson(witness))throw Error('git_commit_review_changed');
  const ref=metadata.target_ref==='HEAD'?null:metadata.target_ref;
  const index=this.raw(join(this.gitDirectory,'index'));
  if(index===null||hash(index)!==witness.index_sha256)throw Error('git_commit_review_changed');
  const rawRefs=new Map<string,string|null>();
  for(const path of [join(this.gitDirectory,'HEAD'),join(this.commonDirectory,'packed-refs'),...(ref?[join(this.commonDirectory,ref)]:[])]){
   const bytes=this.raw(path);rawRefs.set(path,bytes===null?null:hash(bytes));
  }
  const attributes=new Map<string,string|null>();
  for(const path of paths){
   let folder=dirname(join(this.root,path));
   while(true){
    const attribute=join(folder,'.gitattributes'),bytes=this.raw(attribute,1024*1024);
    attributes.set(attribute,bytes===null?null:hash(bytes));
    if(same(folder,this.root))break;
    const parent=dirname(folder);
    if(parent===folder||relative(this.root,parent).startsWith('..'))throw Error('git_repository_changed');
    folder=parent;
   }
  }
  const directories=new Map<string,string>([...new Set([this.root,this.gitDirectory,this.commonDirectory,join(this.commonDirectory,'objects')])].map(path=>[path,this.directorySync(path)]));
  const retainedSource:GitSourceWitness={witness,index,rawRefs,attributes,directories,metadata:this.sourceMetadata(),dot:this.dotWitness()};
  const mode=Number(lstatSync(join(this.gitDirectory,'index'),{bigint:true}).mode&0o777n);
  const context=await this.context(signal);
  try{
   if(context.index!==witness.index_sha256||(await this.inspectContext(context,signal)).snapshot_id!==witness.snapshot_id)throw Error('git_commit_review_changed');
   const tree_objects=await readCommitTreeObjects(this.executable!,this.root,context,join(this.commonDirectory,'objects'),this.limits,witness.commit_tree,signal);
   const headers=[
    'tree '+metadata.tree_oid,
    ...(metadata.parent_oid===null?[]:['parent '+metadata.parent_oid]),
    'author '+signature(metadata.author),
    'committer '+signature(metadata.committer),
   ];
   // The reviewed message is appended byte-for-byte, including its original end.
   const body=Buffer.concat([Buffer.from(headers.join('\n')+'\n\n','utf8'),Buffer.from(message,'utf8')]);
   const oid=createHash(metadata.object_format).update('commit '+body.length+'\0').update(body).digest('hex');
   const written=await readGit(this.executable!,this.root,context.directory,['hash-object','-t','commit','-w','--stdin'],{...this.limits,maxOutputBytes:4096},signal,join(context.directory,'objects'),body);
   if(written.code!==0||written.bytes.toString('ascii').trim()!==oid)throw Error('git_commit_object_mismatch');
   const retained=await readGit(this.executable!,this.root,context.directory,['cat-file','commit',oid],{...this.limits,maxOutputBytes:64*1024},signal,join(context.directory,'objects'));
   if(retained.code!==0||!retained.bytes.equals(body))throw Error('git_commit_object_mismatch');
   if((await this.inspectContext(context,signal)).snapshot_id!==witness.snapshot_id
    ||canonicalJson(await this.freezeCommit(witness.snapshot_id,paths,signal))!==canonicalJson(witness))throw Error('git_commit_review_changed');
   signal?.throwIfAborted();
   if(this.sourceMetadata()!==retainedSource.metadata||this.dotWitness()!==retainedSource.dot)throw Error('git_commit_review_changed');
   for(const [path,expected] of directories)if(this.directorySync(path)!==expected)throw Error('git_repository_changed');
   const material:GitCommitMaterial={witness,metadata,review_sha256:source.review_sha256,source_sha256:hash(JSON.stringify(witness)),paths,
    tree_objects,commit_object:{oid,body,sha256:hash(body)},execution_authorized:false};
   const plan:GitCommitPlan=freezeWorkAdmission({protocol:1,plan_id:'git-commit-'+randomUUID(),action:'commit',paths:[...paths],
    repository_sha256:witness.repository_sha256,source_sha256:material.source_sha256,review_sha256:source.review_sha256,metadata_sha256:hash(canonicalJson(metadata)),
    object_format:metadata.object_format,tree_oid:metadata.tree_oid,parent_oid:metadata.parent_oid,target_ref:metadata.target_ref,index_sha256:hash(index),
    commit_oid:oid,commit_sha256:hash(body),commit_size:body.length,tree_objects:tree_objects.map(object=>({oid:object.oid,sha256:hash(object.body),size:object.body.length})),execution_authorized:false});
   this.commitPlans.set(plan,{material,source:retainedSource,ref,mode,state:'ready'});
   return plan;
  }finally{await context.dispose();}
 }
 /** Original coordinator only. Durable preparation precedes canonical locks,
  * and the publication callback stays inside the same locks/native custody. */
 async withCommitObjects<T>(plan:GitCommitPlan,authority:CommitAuthority,publish:(evidence:GitCommitEvidence,guard:()=>void)=>T|Promise<T>,signal?:AbortSignal):Promise<T>{
  const stored=this.commitPlans.get(plan);
  if(!stored)throw Error('git_commit_plan_invalid');
  if(stored.state!=='ready')throw Error('git_commit_plan_consumed');
  if(!authority||!['authorize','prepared','acquire','dispatch','cleanup'].every(key=>typeof authority[key as keyof CommitAuthority]==='function'&&authority[key as keyof CommitAuthority].constructor.name!=='AsyncFunction')||typeof publish!=='function')throw Error('git_execution_authority_missing');
  signal?.throwIfAborted();stored.state='locking';
  const locks:OwnedLock[]=[],pending:OwnedLock[]=[],created=new Map<string,string>();
  const targets=[join(this.gitDirectory,'index.lock'),join(this.gitDirectory,'HEAD.lock'),join(this.commonDirectory,'packed-refs.lock'),...(stored.ref?[join(this.commonDirectory,stored.ref+'.lock')]:[])];
  let context:GitReadContext|undefined,preparation:GitCommitPreparation|undefined,failure:unknown;
  const authorize=()=>{signal?.throwIfAborted();synchronous(()=>authority.authorize());};
  try{
   authorize();
   if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');
   for(const path of targets)try{lstatSync(path);throw Error('git_repository_busy');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   for(const [index,path] of targets.entries()){
    authorize();
    if(stored.ref&&same(path,join(this.commonDirectory,stored.ref+'.lock')))await this.parent(dirname(path),created);
    const base=index<2?this.gitDirectory:this.commonDirectory;
    const scratch=join(base,'jot-commit-lock-'+randomUUID()+'.pending');
    const handle=await open(scratch,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),stored.mode);
    try{
     pending.push({path:scratch,identity:identity(await handle.stat({bigint:true}))});
     if(index===0)await handle.writeFile(stored.source.index);
     await handle.sync();
    }finally{await handle.close();}
   }
   this.assertSource(stored.source,pending,created,pending[0]!.path);
   const lockFacts=targets.map((path,index)=>({scope:(index<2?'git':'common') as 'git'|'common',path:relative(index<2?this.gitDirectory:this.commonDirectory,path).split(sep).join('/'),identity:pending[index]!.identity,sha256:index===0?plan.index_sha256:hash('')}));
   const evidence=gitCommitEvidence({protocol:1,plan,index_lock_identity:pending[0]!.identity,
    directories:{root:stored.source.directories.get(this.root),git:stored.source.directories.get(this.gitDirectory),common:stored.source.directories.get(this.commonDirectory),objects:stored.source.directories.get(join(this.commonDirectory,'objects'))},
    dot_witness:stored.source.dot,refs:{ref:stored.ref,head_sha256:stored.source.rawRefs.get(join(this.gitDirectory,'HEAD')),packed_sha256:stored.source.rawRefs.get(join(this.commonDirectory,'packed-refs')),branch_sha256:stored.ref?stored.source.rawRefs.get(join(this.commonDirectory,stored.ref)):null},
    locks:lockFacts,parents:[...created].map(([path,id])=>({path:relative(this.commonDirectory,path).split(sep).join('/'),identity:id}))});
   freezeWorkAdmission(evidence);
   preparation=gitCommitPreparation({protocol:1,evidence,pending:pending.map((file,index)=>({scope:lockFacts[index]!.scope,target:lockFacts[index]!.path,path:relative(index<2?this.gitDirectory:this.commonDirectory,file.path),identity:file.identity,sha256:lockFacts[index]!.sha256}))});
   freezeWorkAdmission(preparation);
   authorize();synchronous(()=>authority.prepared(preparation!));
   let active=true,installed=false;
   const install=()=>{
    if(!active||installed)throw Error('git_commit_plan_consumed');
    installed=true;authorize();this.assertSource(stored.source,pending,created,pending[0]!.path);
    for(const [index,path] of targets.entries()){
     authorize();this.directorySync(dirname(path));
     try{linkSync(pending[index]!.path,path);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('git_repository_busy');throw error;}
     locks.push({path,identity:pending[index]!.identity});unlinkSync(pending[index]!.path);
    }
   };
   try{synchronous(()=>authority.acquire(preparation!,install));}finally{active=false;}
   if(!installed)throw Error('git_execution_authority_missing');
   const guard=()=>{authorize();this.assertSource(stored.source,locks,created);};
   guard();synchronous(()=>authority.dispatch(evidence));guard();
   context=await this.context(signal);
   const objects=[...stored.material.tree_objects.map(object=>({...object,type:'tree' as const})),{oid:stored.material.commit_object.oid,body:stored.material.commit_object.body,type:'commit' as const}];
   for(const object of objects){
    guard();stored.state='consumed';
    const loose=join(this.commonDirectory,'objects',object.oid.slice(0,2),object.oid.slice(2));
    this.raw(loose);
    const written=await this.controlled(context,['hash-object','-t',object.type,'-w','--stdin'],object.body,signal,true);
    if(written.toString('ascii').trim()!==object.oid)throw Error('git_commit_object_mismatch');
    this.raw(loose);guard();
    const actual=await this.controlled(context,['cat-file',object.type,object.oid],undefined,signal,true);
    if(!actual.equals(object.body))throw Error('git_commit_object_mismatch');
   }
   guard();return await publish(evidence,guard);
  }catch(error){failure=error;throw error;}finally{
   // A single attempt owns this plan even if it stopped before object writes.
   stored.state='consumed';
   let cleanupFailure:unknown;
   try{await context?.dispose();}catch(error){cleanupFailure=error;}
   try{
    if(preparation)await this.cleanupGitPreparation(preparation,()=>synchronous(()=>authority.authorize()),undefined,remove=>synchronous(()=>authority.cleanup(remove)));
    else this.cleanupAtomically(()=>{
     const check=()=>{
      for(const [path,id] of stored.source.directories)if(this.directorySync(path)!==id)throw Error('git_repository_changed');
      if(this.dotWitness()!==stored.source.dot)throw Error('git_repository_changed');
     };
     check();
     for(const file of [...pending].reverse()){
      check();let stat;try{stat=lstatSync(file.path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||identity(stat)!==file.identity)throw Error('git_commit_lock_unverified');
      // Before journaling, a failed write may leave partial bytes on this exact
      // private inode. No conventional lock has been installed at that point.
      unlinkSync(file.path);
     }
     for(const [path,id] of [...created].reverse())try{check();if(this.directorySync(path)!==id)throw Error('git_commit_lock_unverified');rmdirSync(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    },remove=>synchronous(()=>authority.cleanup(remove)));
   }catch(error){cleanupFailure??=error;}
   if(cleanupFailure)throw Error('git_commit_cleanup_unknown',{cause:failure??cleanupFailure});
  }
 }
 async cleanupCommitPreparation(input:unknown,guard:()=>void,signal?:AbortSignal,atomic?:((remove:()=>void)=>void)){
  return this.cleanupGitPreparation(gitCommitPreparation(input),guard,signal,atomic);
 }
 async cleanupCommitEvidence(input:unknown,guard:()=>void,signal?:AbortSignal,atomic?:((remove:()=>void)=>void)){
  return this.cleanupGitEvidence(gitCommitEvidence(input),guard,signal,atomic);
 }

}
