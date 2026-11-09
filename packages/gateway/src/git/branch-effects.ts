import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,linkSync,unlinkSync,renameSync,rmdirSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join,dirname,relative,sep} from 'node:path';
import type {GitCreateBranchWitness,GitBranchMetadata} from '../../contracts/types.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import {GitCommitEffects} from './commit-effects.ts';
import {branchReviewMetadata,branchReflogEntry} from './branch-metadata.ts';
import {planCreateBranchConfiguration} from './branch-configuration.ts';
import {gitBranchPreparation,gitBranchFileLayout,gitBranchLockLayout,type GitBranchPlan,type GitBranchPreparation,type GitBranchFileFact} from './branch-evidence.ts';

export type GitBranchSource={branch:string;witness:GitCreateBranchWitness;metadata:GitBranchMetadata;review_sha256:string};
export type GitBranchReceipt={protocol:1;plan_id:string;action:'create-branch';target_ref:string;target_oid:string|null;preparation_sha256:string;execution_authorized:false};
type Authority={
 authorize:()=>void;prepared:(preparation:GitBranchPreparation)=>void;
 acquire:(preparation:GitBranchPreparation,install:()=>void)=>void;
 dispatch:(preparation:GitBranchPreparation)=>void;
 publish:(preparation:GitBranchPreparation,publish:()=>GitBranchReceipt)=>GitBranchReceipt;
 cleanup:(remove:()=>void)=>void;
};
type Retained={
 directories:Map<string,string>;dot:string;metadata:string;
 files:Array<{scope:'git'|'common';path:string;before:GitBranchFileFact|null;body:Buffer;mode:number}>;
 sourceFiles:GitBranchPreparation['source_files'];state:'ready'|'consumed';
};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const identity=(value:{dev:bigint;ino:bigint})=>value.dev+':'+value.ino;
const equal=(left:unknown,right:unknown)=>canonicalJson(left)===canonicalJson(right);
function synchronous<T>(operation:()=>T):T{
 if(operation.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
 const result=operation();
 if(result&&typeof(result as {then?:unknown}).then==='function'){
  Promise.resolve(result).catch(()=>{});throw Error('git_execution_authority_missing');
 }
 return result;
}

/** Host-private branch kernel. Serialized records can observe and clean up an
 * original attempt, but cannot reconstruct writable buffers or start a write. */
export class GitBranchEffects extends GitCommitEffects{
 private readonly branchPlans=new WeakMap<GitBranchPlan,Retained>();
 private branchRoot(scope:'git'|'common'){return scope==='git'?this.gitDirectory:this.commonDirectory;}
 private branchFile(path:string):{fact:GitBranchFileFact|null;body:Buffer|null}{
  let stat;
  try{stat=lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{fact:null,body:null};throw error;}
  const body=this.raw(path),after=lstatSync(path,{bigint:true});
  const stamp=(value:typeof stat)=>[identity(value),value.size,value.mode,value.nlink,value.mtimeNs,value.ctimeNs].join(':');
  if(body===null||stamp(stat)!==stamp(after))throw Error('git_branch_source_changed');
  return{body,fact:{identity:identity(stat),sha256:hash(body),size:body.length,mode:Number(stat.mode&0o777n)}};
 }
 async prepareCreateBranch(raw:GitBranchSource,signal?:AbortSignal):Promise<GitBranchPlan>{
  signal?.throwIfAborted();
  if(!raw||typeof raw.review_sha256!=='string'||!/^([a-f0-9]{64})$/.test(raw.review_sha256))throw Error('git_branch_plan_invalid');
  const source=structuredClone(raw),{witness,metadata,branch}=source;
  if(witness.protocol!==2||!witness.configuration||branch!==witness.branch)throw Error('git_branch_review_required');
  const actor={name:metadata.committer.name,email:metadata.committer.email};
  const expected=branchReviewMetadata({author:actor,committer:actor},witness,metadata.committer.timestamp);
  if(!equal(expected,metadata)||hash(JSON.stringify({action:'create-branch',branch,witness,branch_metadata:metadata}))!==source.review_sha256
   ||!equal(await this.freezeCreateBranch(witness.snapshot_id,branch,signal),witness))throw Error('git_branch_review_changed');
  const directories=new Map<string,string>([...new Set([this.root,this.gitDirectory,this.commonDirectory,join(this.commonDirectory,'objects')])].map(path=>[path,this.directorySync(path)]));
  const dot=this.dotWitness(),originalMetadata=this.sourceMetadata();
  const sourceRef=witness.head.detached?null:'refs/heads/'+witness.head.branch;
  const plan:GitBranchPlan=freezeWorkAdmission({protocol:1,plan_id:'git-branch-'+randomUUID(),action:'create-branch',branch,
   target_ref:witness.target_ref,target_oid:witness.target_oid,source_ref:sourceRef,repository_sha256:witness.repository_sha256,
   source_sha256:hash(JSON.stringify(witness)),review_sha256:source.review_sha256,metadata_sha256:hash(canonicalJson(metadata)),
   index_sha256:witness.index_sha256,object_format:witness.object_format,configuration_changed:witness.configuration.changed,logs:metadata.logs,execution_authorized:false});
  const sourceFiles=[{scope:'git' as const,path:'index'},{scope:'common' as const,path:'packed-refs'},...(sourceRef?[{scope:'common' as const,path:sourceRef}]:[])]
   .map(file=>({...file,before:this.branchFile(join(this.branchRoot(file.scope),file.path)).fact}));
  if((sourceFiles[0]!.before?.sha256??null)!==plan.index_sha256)throw Error('git_branch_review_changed');
  const commonConfig=this.raw(join(this.commonDirectory,'config'),1024*1024),context=await this.context(signal,true);
  let configuration:Buffer|null;
  try{
   const worktreeConfig=context.worktreeConfigEnabled?this.raw(join(this.gitDirectory,'config.worktree'),1024*1024):null;
   const planned=await planCreateBranchConfiguration({executable:this.executable!,context,sourceObjects:join(this.commonDirectory,'objects'),
    branch,targetOid:plan.target_oid,commonConfig,worktreeConfig,limits:this.limits,...(signal?{signal}:{})});
   if(!equal({before_sha256:planned.before===null?null:hash(planned.before),after_sha256:planned.after===null?null:hash(planned.after),changed:planned.changed},witness.configuration))throw Error('git_branch_review_changed');
   configuration=planned.after;
  }finally{await context.dispose();}
  const files:Retained['files']=[];
  for(const item of gitBranchFileLayout(plan)){
   const path=join(this.branchRoot(item.scope),item.path),before=this.branchFile(path);
   let body:Buffer;
   if(item.path==='config'){
    if(configuration===null)throw Error('git_branch_configuration_invalid');body=configuration;
   }else if(item.path.startsWith('logs/')){
    const log=item.scope==='git'?witness.reflog.head:witness.reflog.branch;
    if((before.fact?.sha256??null)!==log.sha256||(before.body?.length??0)!==log.size
     ||before.body?.length&&before.body[before.body.length-1]!==10)throw Error('git_branch_reflog_invalid');
    body=Buffer.concat([before.body??Buffer.alloc(0),branchReflogEntry(witness,metadata,item.scope)]);
    if(body.length>32*1024*1024)throw Error('git_branch_reflog_limit');
   }else body=Buffer.from(item.path==='HEAD'?'ref: '+plan.target_ref+'\n':plan.target_oid+'\n','utf8');
   if(item.path===plan.target_ref&&before.fact!==null||item.path==='HEAD'&&before.fact===null)throw Error('git_branch_review_changed');
   files.push({...item,before:before.fact,body,mode:before.fact?.mode??0o600});
  }
  const retained:Retained={directories,dot,metadata:originalMetadata,sourceFiles,files,state:'ready'};
  const check=()=>{
   signal?.throwIfAborted();this.assertSourceRoots(retained);
   if(this.sourceMetadata()!==originalMetadata)throw Error('git_branch_review_changed');
   for(const file of [...sourceFiles,...files])if(!equal(this.branchFile(join(this.branchRoot(file.scope),file.path)).fact,file.before))throw Error('git_branch_review_changed');
  };
  check();
  if(!equal(await this.freezeCreateBranch(witness.snapshot_id,branch,signal),witness))throw Error('git_branch_review_changed');
  check();this.branchPlans.set(plan,retained);return plan;
 }

 async applyCreateBranch(plan:GitBranchPlan,authority:Authority,signal?:AbortSignal):Promise<GitBranchReceipt>{
  const stored=this.branchPlans.get(plan);
  if(!stored||stored.state!=='ready')throw Error('git_branch_plan_consumed');
  for(const name of ['authorize','prepared','acquire','dispatch','publish','cleanup'] as const){
   if(typeof authority?.[name]!=='function'||authority[name].constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  }
  stored.state='consumed';
  const locks=gitBranchLockLayout(plan).map(item=>{
   const file=stored.files.find(file=>file.scope===item.scope&&file.path+'.lock'===item.path),body=file?.body??Buffer.alloc(0);
   return{...item,pending:'jot-branch-'+randomUUID()+'.pending',identity:'',sha256:hash(body),size:body.length,mode:file?.mode??0o600,body,installed:false,published:false};
  });
  const created=new Map<string,string>(),createdScopes=new Map<string,'git'|'common'>();
  const expected=stored.files.map(file=>file.before),owned=new Map<string,{identity:string;sha256:string;ready:boolean}>();
  const ignored=new Set([...stored.files.map(file=>join(this.branchRoot(file.scope),file.path)),
   ...locks.flatMap(lock=>[join(this.branchRoot(lock.scope),lock.path),join(this.branchRoot(lock.scope),lock.pending)])]);
  let metadata:string|undefined,preparation:GitBranchPreparation|undefined,failure:unknown;
  const guard=()=>{
   signal?.throwIfAborted();synchronous(()=>authority.authorize());this.assertSourceRoots(stored);
   for(const [path,id] of created)if(this.directorySync(path)!==id)throw Error('git_repository_changed');
   if(this.sourceMetadata(metadata===undefined?new Set():ignored,new Set(created.keys()))!==(metadata??stored.metadata))throw Error('git_branch_source_changed');
   for(const file of stored.sourceFiles)if(!equal(this.branchFile(join(this.branchRoot(file.scope),file.path)).fact,file.before))throw Error('git_branch_source_changed');
   for(const [index,file] of stored.files.entries())if(!equal(this.branchFile(join(this.branchRoot(file.scope),file.path)).fact,expected[index]))throw Error('git_branch_source_changed');
   for(const lock of locks){
    const path=join(this.branchRoot(lock.scope),lock.path);
    if(!lock.installed){if(this.raw(path)!==null)throw Error('git_repository_busy');}
    else if(!lock.published){const fact=this.branchFile(path).fact;if(!fact||fact.identity!==lock.identity||fact.sha256!==lock.sha256||fact.size!==lock.size||fact.mode!==lock.mode)throw Error('git_branch_lock_unverified');}
   }
   for(const [path,file] of owned){
    const lock=locks.find(lock=>join(this.branchRoot(lock.scope),lock.pending)===path)!;
    const body=this.raw(path);
    if(body===null){if(lock.installed)continue;throw Error('git_branch_lock_unverified');}
    if(identity(lstatSync(path,{bigint:true}))!==file.identity||file.ready&&hash(body)!==file.sha256)throw Error('git_branch_lock_unverified');
   }
  };
  try{
   guard();metadata=this.sourceMetadata(ignored);
   for(const lock of locks){
    guard();await this.parent(dirname(join(this.branchRoot(lock.scope),lock.path)),created,this.branchRoot(lock.scope));
    for(const path of created.keys())if(!createdScopes.has(path))createdScopes.set(path,lock.scope);
    guard();
    const path=join(this.branchRoot(lock.scope),lock.pending),handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),lock.mode);
    try{
     lock.identity=identity(await handle.stat({bigint:true}));owned.set(path,{identity:lock.identity,sha256:lock.sha256,ready:false});
     await handle.writeFile(lock.body);await handle.chmod(lock.mode);await handle.sync();
     lock.mode=Number((await handle.stat({bigint:true})).mode&0o777n);owned.get(path)!.ready=true;
    }finally{await handle.close();}
   }
   guard();
   preparation=freezeWorkAdmission(gitBranchPreparation({protocol:1,plan,directories:{root:stored.directories.get(this.root)!,git:stored.directories.get(this.gitDirectory)!,common:stored.directories.get(this.commonDirectory)!,objects:stored.directories.get(join(this.commonDirectory,'objects'))!},
    dot_witness:stored.dot,metadata_sha256:metadata,source_files:stored.sourceFiles,
    files:stored.files.map(file=>{
     const lock=locks.find(lock=>lock.scope===file.scope&&lock.path===file.path+'.lock')!;
     return{scope:file.scope,path:file.path,before:file.before,after:{identity:lock.identity,sha256:lock.sha256,size:lock.size,mode:lock.mode}};
    }),locks:locks.map(({body,installed,published,...lock})=>lock),parents:[...created].map(([path,id])=>{
     const scope=createdScopes.get(path)!;return{scope,path:relative(this.branchRoot(scope),path).split(sep).join('/'),identity:id};
    })}));
   synchronous(()=>authority.prepared(preparation!));guard();
   let active=true,installed=false;
   const install=()=>{
    if(!active||installed)throw Error('git_branch_plan_consumed');installed=true;
    for(const lock of locks){
     guard();const root=this.branchRoot(lock.scope),pending=join(root,lock.pending),path=join(root,lock.path);
     try{linkSync(pending,path);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('git_repository_busy');throw error;}
     lock.installed=true;unlinkSync(pending);
    }
   };
   try{synchronous(()=>authority.acquire(preparation!,install));}finally{active=false;}
   if(!installed)throw Error('git_execution_authority_missing');
   guard();synchronous(()=>authority.dispatch(preparation!));guard();
   let publishing=true,published=false,receipt:GitBranchReceipt|undefined;
   const publish=()=>{
    if(!publishing||published)throw Error('git_branch_plan_consumed');published=true;
    for(const [index,file] of preparation!.files.entries()){
     guard();const lock=locks.find(lock=>lock.scope===file.scope&&lock.path===file.path+'.lock')!,root=this.branchRoot(file.scope);
     renameSync(join(root,lock.path),join(root,file.path));lock.published=true;expected[index]=file.after;
     guard();
    }
    return receipt=freezeWorkAdmission({protocol:1,plan_id:plan.plan_id,action:'create-branch',target_ref:plan.target_ref,target_oid:plan.target_oid,
     preparation_sha256:hash(canonicalJson(preparation)),execution_authorized:false});
   };
   let result:GitBranchReceipt;
   try{result=synchronous(()=>authority.publish(preparation!,publish));}finally{publishing=false;}
   if(!published||!receipt||!equal(result,receipt))throw Error('git_branch_outcome_unknown');return result;
  }catch(error){failure=error;throw error;}finally{
   try{
    if(preparation)await this.cleanupCreateBranchPreparation(preparation,()=>{},undefined,remove=>synchronous(()=>authority.cleanup(remove)));
    else this.cleanupAtomically(()=>{
     this.assertSourceRoots(stored);
     for(const [path,file] of owned){
      this.assertSourceRoots(stored);let stat;
      try{stat=lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||identity(stat)!==file.identity)throw Error('git_branch_lock_unverified');unlinkSync(path);
     }
     for(const [path,id] of [...created].reverse())try{
      this.assertSourceRoots(stored);if(this.directorySync(path)!==id)throw Error('git_branch_lock_unverified');rmdirSync(path);
     }catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    },remove=>synchronous(()=>authority.cleanup(remove)));
   }catch(error){throw Error('git_branch_cleanup_unknown',{cause:failure??error});}
  }
 }

 /** Recovery only observes the exact original files. A partial prefix remains
  * unknown and is never replayed or rolled back by observation. */
 async observeCreateBranch(input:unknown,source:GitBranchSource,signal?:AbortSignal){
  const preparation=gitBranchPreparation(input),{plan}=preparation;
  if(plan.source_sha256!==hash(JSON.stringify(source.witness))||plan.review_sha256!==source.review_sha256
   ||plan.metadata_sha256!==hash(canonicalJson(source.metadata))||plan.branch!==source.branch||plan.repository_sha256!==source.witness.repository_sha256)throw Error('git_execution_evidence_corrupt');
  const current=()=>{
   signal?.throwIfAborted();this.branchPreparationRoots(preparation);
   const ignored=new Set([...preparation.files.map(file=>join(this.branchRoot(file.scope),file.path)),...preparation.locks.flatMap(lock=>[join(this.branchRoot(lock.scope),lock.path),join(this.branchRoot(lock.scope),lock.pending)])]);
   const parents=new Set(preparation.parents.map(parent=>join(this.branchRoot(parent.scope),parent.path)));
   if(this.sourceMetadata(ignored,parents)!==preparation.metadata_sha256)return 'unknown' as const;
   for(const file of preparation.source_files)if(!equal(this.branchFile(join(this.branchRoot(file.scope),file.path)).fact,file.before))return 'unknown' as const;
   const observed=preparation.files.map(file=>this.branchFile(join(this.branchRoot(file.scope),file.path)));
   const files=observed.map(file=>file.fact);
   for(const [index,file] of preparation.files.entries())if(file.path.startsWith('logs/')&&equal(files[index],file.after)){
    const body=observed[index]!.body!,entry=branchReflogEntry(source.witness,source.metadata,file.scope),prefix=body.subarray(0,body.length-entry.length);
    if(body.length<entry.length||!body.subarray(body.length-entry.length).equals(entry)
     ||prefix.length!==(file.before?.size??0)||file.before!==null&&hash(prefix)!==file.before.sha256)return 'unknown' as const;
   }
   if(files.every((file,index)=>equal(file,preparation.files[index]!.before)))return 'not_observed' as const;
   return files.every((file,index)=>equal(file,preparation.files[index]!.after))?'applied' as const:'unknown' as const;
  };
  if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');
  const state=current();
  if(state!=='applied')return{state,execution_authorized:false as const};
  if(plan.target_oid!==null){
   const context=await this.context(signal);
   try{
    const body=await this.controlled(context,['cat-file','commit',plan.target_oid],undefined,signal,true);
    if(createHash(plan.object_format).update('commit '+body.length+'\0').update(body).digest('hex')!==plan.target_oid)return{state:'unknown' as const,execution_authorized:false as const};
   }finally{await context.dispose();}
  }
  if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');
  return{state:current()==='applied'?'applied' as const:'unknown' as const,execution_authorized:false as const};
 }
 private branchPreparationRoots(preparation:GitBranchPreparation){
  this.assertSourceRoots({dot:preparation.dot_witness,directories:[
   [this.root,preparation.directories.root],[this.gitDirectory,preparation.directories.git],
   [this.commonDirectory,preparation.directories.common],[join(this.commonDirectory,'objects'),preparation.directories.objects],
  ]});
  for(const parent of preparation.parents)try{
   if(this.directorySync(join(this.branchRoot(parent.scope),parent.path))!==parent.identity)throw Error('git_repository_changed');
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 async cleanupCreateBranchPreparation(input:unknown,guard:()=>void,signal?:AbortSignal,atomic?:((remove:()=>void)=>void)){
  const preparation=gitBranchPreparation(input);
  const check=()=>{signal?.throwIfAborted();synchronous(guard);this.branchPreparationRoots(preparation);};
  check();if((await this.anchors(signal)).repository!==preparation.plan.repository_sha256)throw Error('git_repository_changed');check();
  this.cleanupAtomically(()=>{
   const existing:Array<{path:string;identity:string;sha256:string;size:number;mode:number}>=[];
   for(const lock of preparation.locks)for(const name of [lock.pending,lock.path]){
    check();const path=join(this.branchRoot(lock.scope),name);let stat;
    try{stat=lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||identity(stat)!==lock.identity)throw Error('git_branch_lock_unverified');
    existing.push({path,identity:lock.identity,sha256:lock.sha256,size:lock.size,mode:lock.mode});
   }
   const verify=(file:typeof existing[number])=>{
    check();const stat=lstatSync(file.path,{bigint:true}),links=existing.filter(other=>other.identity===file.identity).length;
    const body=this.raw(file.path,32*1024*1024,links);
    if(identity(stat)!==file.identity||Number(stat.mode&0o777n)!==file.mode||body===null||body.length!==file.size||hash(body)!==file.sha256)throw Error('git_branch_lock_unverified');
   };
   for(const file of existing)verify(file);
   while(existing.length){const file=existing[existing.length-1]!;verify(file);unlinkSync(file.path);existing.pop();}
   for(const parent of [...preparation.parents].reverse())try{
    check();const path=join(this.branchRoot(parent.scope),parent.path);
    if(this.directorySync(path)!==parent.identity)throw Error('git_branch_lock_unverified');rmdirSync(path);
   }catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  },atomic);
 }
}
