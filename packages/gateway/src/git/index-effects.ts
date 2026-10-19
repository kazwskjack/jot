import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,realpathSync,readdirSync,openSync,closeSync,readFileSync,fstatSync,renameSync,unlinkSync,rmdirSync,type Stats} from 'node:fs';
import {open,lstat,mkdir} from 'node:fs/promises';
import {join,dirname,resolve,relative,sep} from 'node:path';
import {GitRepositoryInspection,type GitReviewWitness,type GitReadContext} from './inspection.ts';
import {readGit} from './process.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

type Action='stage'|'unstage';
export type GitIndexPlan=Readonly<{plan_id:string;action:Action;paths:readonly string[];repository_sha256:string;before_index_sha256:string|null;index_sha256:string;execution_authorized:false}>;
type Blob={oid:string;bytes:Buffer;sha256:string;write:boolean};
type Lock={path:string;identity:string};
type Stored={witness:GitReviewWitness;index:Buffer;blobs:Blob[];ref:string|null;metadata:string;directories:Map<string,string>;dot:string;rawRefs:Map<string,string|null>;attributes:Map<string,string|null>;mode:number;dispatch?:GitIndexDispatch;state:'ready'|'locking'|'consumed'};
export type GitIndexReceipt={plan_id:string;action:Action;repository_sha256:string;before_index_sha256:string|null;index_sha256:string;paths:string[]};
export type GitIndexDispatch={plan_id:string;action:Action;repository_sha256:string;source_sha256:string;index_sha256:string;index_lock_identity:string};
type Authority={authorize:(proof?:GitIndexDispatch)=>void;commit:(publish:()=>GitIndexReceipt,proof:GitIndexDispatch)=>GitIndexReceipt};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const id=(value:{dev:number;ino:number|bigint})=>String(value.dev)+':'+String(value.ino);
const stamp=(s:Stats)=>[id(s),s.size,s.mtimeMs,s.ctimeMs,s.nlink,s.mode].join(':');
const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const decoded=(value:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(value);

/** Internal index-effect kernel. Not mounted as a tool or route. A caller must
 * provide original owner/approval fences and the durable dispatch/receipt txn.
 * Temporary metadata computes bytes; only the original index is published. */
export class GitIndexEffects extends GitRepositoryInspection{
 private readonly plans=new WeakMap<GitIndexPlan,Stored>();
 private directorySync(path:string){let current=path;while(true){const s=lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('git_repository_changed');const parent=dirname(current);if(parent===current)break;current=parent;}if(!equalPath(realpathSync(path),path))throw Error('git_repository_changed');return id(lstatSync(path));}
 private raw(path:string,max=32*1024*1024):Buffer|null{
  try{this.directorySync(dirname(path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}let before;try{before=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max)throw Error('git_path_unavailable');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{if(stamp(fstatSync(fd))!==stamp(before))throw Error('git_review_changed');const value=readFileSync(fd);if(value.length>max||stamp(fstatSync(fd))!==stamp(before)||stamp(lstatSync(path))!==stamp(before))throw Error('git_review_changed');return value;}finally{closeSync(fd);}
 }
 private dotWitness(){const dot=join(this.root,'.git'),s=lstatSync(dot);if(s.isSymbolicLink())throw Error('git_repository_changed');return s.isDirectory()?'directory:'+id(s):'file:'+hash(this.raw(dot,4096)!);}
 /** Keep every non-object metadata file pinned. Ignore only exact owned locks
  * and newly created lock-parent directories; directory identities still hold.
  * Content-addressed object bytes are checked separately, never treated as refs. */
 private sourceMetadata(locks:ReadonlySet<string>=new Set(),created:ReadonlySet<string>=new Set()){
  const facts:string[]=[];let entries=0;const objects=join(this.commonDirectory,'objects');
  for(const root of [...new Set([this.gitDirectory,this.commonDirectory])]){const queue=[root];while(queue.length){const folder=queue.pop()!;for(const entry of readdirSync(folder,{withFileTypes:true})){if(++entries>100000)throw Error('git_metadata_limit');const path=join(folder,entry.name);if(locks.has(path)||equalPath(path,objects))continue;const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw Error('git_repository_changed');if(s.isDirectory()){if(!created.has(path))facts.push(path+':dir:'+id(s)+':'+s.mode);queue.push(path);}else facts.push(path+':file:'+stamp(s));}}}
  return hash(facts.sort().join('\n'));
 }
 private async controlled(context:GitReadContext,args:string[],input?:Buffer,signal?:AbortSignal,sourceObjects=false){
  const objects=join(this.commonDirectory,'objects'),result=await readGit(this.executable!,this.root,context.directory,args,{maxOutputBytes:32*1024*1024,timeoutMs:5000},signal,sourceObjects?objects:join(context.directory,'objects'),input,sourceObjects?undefined:objects);
  if(result.code!==0)throw Error('git_index_prepare_failed');return result.bytes;
 }
 async prepareIndex(input:GitReviewWitness,action:Action,signal?:AbortSignal):Promise<GitIndexPlan>{
  if(!input||!['stage','unstage'].includes(action))throw Error('git_index_plan_invalid');const witness=structuredClone(input),paths=witness.files.map(file=>file.path);
  if(JSON.stringify(await this.freeze(witness.snapshot_id,paths,signal))!==JSON.stringify(witness))throw Error('git_review_changed');
  const context=await this.context(signal);try{
   const snapshot=await this.inspectContext(context,signal);if(snapshot.snapshot_id!==witness.snapshot_id)throw Error('git_review_changed');
   const refResult=await this.run(context,['symbolic-ref','--quiet','HEAD'],signal,true),ref=refResult.code===1?null:decoded(refResult.bytes).trim();if(ref!==null&&(!ref.startsWith('refs/heads/')||workspaceRelativePath(ref)!==ref))throw Error('git_index_reference_unsupported');
   const rawRefs=new Map<string,string|null>();for(const path of [join(this.gitDirectory,'HEAD'),join(this.commonDirectory,'packed-refs'),...(ref?[join(this.commonDirectory,ref)]:[])]){const value=this.raw(path);rawRefs.set(path,value===null?null:hash(value));}
   const directories=new Map<string,string>();for(const path of [...new Set([this.root,this.gitDirectory,this.commonDirectory,join(this.commonDirectory,'objects')])])directories.set(path,await this.directory(path));
   const metadata=this.sourceMetadata(),dot=this.dotWitness(),blobs:Blob[]=[],attributes=new Map<string,string|null>();let total=0;
   for(const path of paths){let folder=dirname(join(this.root,path));while(true){const attribute=join(folder,'.gitattributes'),value=this.raw(attribute,1024*1024);attributes.set(attribute,value===null?null:hash(value));if(equalPath(folder,this.root))break;const parent=dirname(folder);if(parent===folder||relative(this.root,parent).startsWith('..'))throw Error('git_repository_changed');folder=parent;}}
   const remember=(oid:string,bytes:Buffer,write:boolean)=>{if(createHash(oid.length===64?'sha256':'sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==oid)throw Error('git_index_object_mismatch');if(!blobs.some(blob=>blob.oid===oid)){total+=bytes.length;if(total>64*1024*1024)throw Error('git_output_limit');blobs.push({oid,bytes,sha256:hash(bytes),write});}};
   await this.controlled(context,['update-index','--no-split-index'],undefined,signal);
   const modeResult=await this.run(context,['config','--bool','--get','core.filemode'],signal,true),filemode=modeResult.code===1||decoded(modeResult.bytes).trim()!=='false';
   for(const path of paths){
    const entry=snapshot.entries.find(row=>row.path===path);if(!entry||entry.conflicted)throw Error('git_selection_invalid');
    if(action==='unstage'&&entry.original_path&&!paths.includes(entry.original_path))throw Error('git_rename_review_incomplete');
    if(action==='stage'){
     if(entry.worktree_status===' ')throw Error('git_selection_invalid');
     const selected=witness.files.find(file=>file.path===path)!;
     if(selected.kind==='missing'){await this.controlled(context,['update-index','--force-remove','--',path],undefined,signal);continue;}
     const attributes=decoded(await this.run(context,['check-attr','-z','filter','--',path],signal).then(result=>result.bytes)).split('\0');if(!['unspecified','unset'].includes(attributes[2]??''))throw Error('git_filter_requires_explicit_support');
     const raw=this.raw(join(this.root,path));if(raw===null||hash(raw)!==selected.sha256)throw Error('git_review_changed');
     const oid=decoded(await this.controlled(context,['hash-object','-w','--stdin','--path='+path],raw,signal)).trim();if(!/^[a-f0-9]{40,64}$/.test(oid))throw Error('git_index_prepare_failed');
     const canonical=await this.controlled(context,['cat-file','blob',oid],undefined,signal);remember(oid,canonical,true);
     const current=decoded((await this.run(context,['ls-files','--stage','-z','--',path],signal)).bytes),old=/^(100644|100755) /.exec(current)?.[1],mode=filemode?(selected.mode&0o111?'100755':'100644'):(old??'100644');
     await this.controlled(context,['update-index','--add','--cacheinfo',mode+','+oid+','+path],undefined,signal);
    }else{
     if([' ','?'].includes(entry.index_status))throw Error('git_selection_invalid');
     const original=witness.head.oid===null?'':decoded((await this.run(context,['ls-tree','-z',witness.head.oid,'--',path],signal)).bytes),match=/^(100644|100755|120000) blob ([a-f0-9]{40,64})\t/.exec(original);
     if(original&&!match)throw Error('git_index_entry_unsupported');
     if(match){const oid=match[2]!;remember(oid,await this.controlled(context,['cat-file','blob',oid],undefined,signal),false);await this.controlled(context,['update-index','--add','--cacheinfo',match[1]+','+oid+','+path],undefined,signal);}else await this.controlled(context,['update-index','--force-remove','--',path],undefined,signal);
    }
   }
   const index=await this.bytes(join(context.directory,'index'),32*1024*1024);if(this.sourceMetadata()!==metadata||JSON.stringify(await this.freeze(witness.snapshot_id,paths,signal))!==JSON.stringify(witness))throw Error('git_review_changed');
   const plan=Object.freeze({plan_id:'git-index-'+randomUUID(),action,paths:Object.freeze([...paths]),repository_sha256:witness.repository_sha256,before_index_sha256:witness.index_sha256,index_sha256:hash(index),execution_authorized:false as const});
   let mode=0o600;try{mode=lstatSync(join(this.gitDirectory,'index')).mode&0o777;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   for(const [path,expected] of attributes){const value=this.raw(path,1024*1024);if((value===null?null:hash(value))!==expected)throw Error('git_review_changed');}
   this.plans.set(plan,{witness,index,blobs,ref,metadata,directories,dot,rawRefs,attributes,mode,state:'ready'});return plan;
  }finally{await context.dispose();}
 }
 private assertSource(stored:Stored,locks:Lock[],created:Map<string,string>){
  for(const [path,identity] of stored.directories)if(this.directorySync(path)!==identity)throw Error('git_repository_changed');if(this.dotWitness()!==stored.dot)throw Error('git_repository_changed');
  for(const [path,identity] of created)if(this.directorySync(path)!==identity)throw Error('git_repository_changed');
  for(const lock of locks){const s=lstatSync(lock.path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||id(s)!==lock.identity)throw Error('git_repository_changed');}
  const lockedIndex=this.raw(join(this.gitDirectory,'index.lock'));if(lockedIndex===null||hash(lockedIndex)!==hash(stored.index))throw Error('git_review_changed');
  if(this.sourceMetadata(new Set(locks.map(lock=>lock.path)),new Set(created.keys()))!==stored.metadata)throw Error('git_review_changed');
  for(const [path,expected] of stored.rawRefs){const value=this.raw(path);if((value===null?null:hash(value))!==expected)throw Error('git_review_changed');}
  for(const [path,expected] of stored.attributes){const value=this.raw(path,1024*1024);if((value===null?null:hash(value))!==expected)throw Error('git_review_changed');}
  const index=this.raw(join(this.gitDirectory,'index'));if((index===null?null:hash(index))!==stored.witness.index_sha256)throw Error('git_review_changed');
  const alternates=this.raw(join(this.commonDirectory,'objects','info','alternates'),1024*1024);if(alternates?.length)throw Error('git_repository_changed');
  for(const selected of stored.witness.files){const value=this.raw(join(this.root,selected.path));if(selected.kind==='missing'){if(value!==null)throw Error('git_review_changed');}else if(value===null||hash(value)!==selected.sha256||(lstatSync(join(this.root,selected.path)).mode&0o777)!==selected.mode)throw Error('git_review_changed');}
 }
 private async parent(path:string,created:Map<string,string>){
  const base=this.commonDirectory,rel=relative(base,path);if(rel.startsWith('..')||resolve(base,rel)!==path)throw Error('git_repository_changed');let current=base;
  for(const part of rel.split(sep).filter(Boolean)){current=join(current,part);try{await this.directory(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;try{await mkdir(current,{mode:0o700});created.set(current,await this.directory(current));}catch(next){if((next as NodeJS.ErrnoException).code!=='EEXIST')throw next;await this.directory(current);}}}
 }
 async applyIndex(plan:GitIndexPlan,authority:Authority,signal?:AbortSignal):Promise<GitIndexReceipt>{
  const stored=this.plans.get(plan);if(!stored)throw Error('git_index_plan_invalid');if(stored.state!=='ready')throw Error('git_index_plan_consumed');
  if(!authority||typeof authority.authorize!=='function'||typeof authority.commit!=='function'||authority.commit.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  signal?.throwIfAborted();stored.state='locking';const locks:Lock[]=[],created=new Map<string,string>();let context:GitReadContext|undefined,published=false;
  try{
   if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');
   for(const path of [join(this.gitDirectory,'index.lock'),join(this.gitDirectory,'HEAD.lock'),join(this.commonDirectory,'packed-refs.lock'),...(stored.ref?[join(this.commonDirectory,stored.ref+'.lock')]:[])]){
    signal?.throwIfAborted();if(stored.ref&&equalPath(path,join(this.commonDirectory,stored.ref+'.lock')))await this.parent(dirname(path),created);
    let handle;try{handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),stored.mode);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('git_repository_busy');throw error;}
    try{const s=await handle.stat();locks.push({path,identity:id(s)});if(equalPath(path,join(this.gitDirectory,'index.lock')))await handle.writeFile(stored.index);await handle.sync();}finally{await handle.close();}
   }
   this.assertSource(stored,locks,created);const proof:GitIndexDispatch={plan_id:plan.plan_id,action:plan.action,repository_sha256:plan.repository_sha256,source_sha256:hash(JSON.stringify(stored.witness)),index_sha256:plan.index_sha256,index_lock_identity:locks.find(lock=>equalPath(lock.path,join(this.gitDirectory,'index.lock')))!.identity};authority.authorize(proof);stored.dispatch=proof;context=await this.context(signal);
   for(const blob of stored.blobs){signal?.throwIfAborted();authority.authorize(proof);if(blob.write){stored.state='consumed';const oid=decoded(await this.controlled(context,['hash-object','-w','--stdin','--no-filters'],blob.bytes,signal,true)).trim();if(oid!==blob.oid)throw Error('git_index_object_mismatch');}const actual=await this.controlled(context,['cat-file','blob',blob.oid],undefined,signal,true);if(hash(actual)!==blob.sha256)throw Error('git_index_object_mismatch');}
   this.assertSource(stored,locks,created);signal?.throwIfAborted();
   const result=authority.commit(()=>{
    if(published)throw Error('git_index_plan_consumed');signal?.throwIfAborted();authority.authorize(proof);this.assertSource(stored,locks,created);
    stored.state='consumed';renameSync(join(this.gitDirectory,'index.lock'),join(this.gitDirectory,'index'));published=true;
    if(hash(this.raw(join(this.gitDirectory,'index'))!)!==plan.index_sha256)throw Error('git_index_outcome_unknown');
    return{plan_id:plan.plan_id,action:plan.action,repository_sha256:plan.repository_sha256,before_index_sha256:plan.before_index_sha256,index_sha256:plan.index_sha256,paths:[...plan.paths]};
   },proof);if(!published||result&&typeof (result as unknown as {then?:unknown}).then==='function')throw Error('git_index_commit_invalid');return result;
  }finally{
   if(stored.state==='locking')stored.state='ready';const failures:unknown[]=[];try{await context?.dispose();}catch(error){failures.push(error);}
   for(const lock of [...locks].reverse()){try{const s=lstatSync(lock.path);if(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&id(s)===lock.identity)unlinkSync(lock.path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')failures.push(error);}}
   for(const [path,identity] of [...created].reverse())try{if(this.directorySync(path)===identity)rmdirSync(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))failures.push(error);}if(failures.length)throw Error('git_index_cleanup_unknown');
  }
 }
 async observeIndex(plan:GitIndexPlan,signal?:AbortSignal){
  const stored=this.plans.get(plan);if(!stored)throw Error('git_index_plan_invalid');
  if((await this.anchors(signal)).repository!==plan.repository_sha256)throw Error('git_repository_changed');const index=this.raw(join(this.gitDirectory,'index')),current=index===null?null:hash(index);
  if(current!==plan.index_sha256)return{state:current===plan.before_index_sha256?'not_observed':'unknown',index_sha256:current,execution_authorized:false as const};
  if(!stored.dispatch||id(lstatSync(join(this.gitDirectory,'index')))!==stored.dispatch.index_lock_identity)return{state:'unknown',index_sha256:current,execution_authorized:false as const};
  for(const [path,expected] of stored.rawRefs){const value=this.raw(path);if((value===null?null:hash(value))!==expected)return{state:'unknown',index_sha256:current,execution_authorized:false as const};}
  const context=await this.context(signal);try{for(const blob of stored.blobs){const actual=await this.controlled(context,['cat-file','blob',blob.oid],undefined,signal,true);if(hash(actual)!==blob.sha256)return{state:'unknown',index_sha256:current,execution_authorized:false as const};}const after=this.raw(join(this.gitDirectory,'index'));return{state:after!==null&&hash(after)===current&&id(lstatSync(join(this.gitDirectory,'index')))===stored.dispatch.index_lock_identity?'applied':'unknown',index_sha256:current,execution_authorized:false as const};}finally{await context.dispose();}
 }
}
