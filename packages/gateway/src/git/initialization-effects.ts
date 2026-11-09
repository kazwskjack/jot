import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,mkdirSync,chmodSync,linkSync,unlinkSync,renameSync,rmdirSync,readdirSync,type BigIntStats} from 'node:fs';
import {open} from 'node:fs/promises';
import {join,posix} from 'node:path';
import type {GitInitializationWitness,GitInitializationFile} from '../../contracts/types.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import {GitBranchEffects} from './branch-effects.ts';
import {gitInitializationWitness,initializationInternalIgnore} from './initialization-records.ts';
import {gitInitializationPlan,gitInitializationPreparation,gitInitializationEvidence,gitInitializationReceipt,initializationDirectories,initializationRootLock,
 type GitInitializationPlan,type GitInitializationPreparation,type GitInitializationEvidence,type GitInitializationReceipt} from './initialization-evidence.ts';
import {readGit} from './process.ts';

export type GitInitializationSource={witness:GitInitializationWitness;review_sha256:string};
export type {GitInitializationReceipt} from './initialization-evidence.ts';
type Anchors={root:string;executable:string;program:string;repository:string};
type Authority={
 authorize:()=>void;
 prepared:(preparation:GitInitializationPreparation)=>void;
 acquire:(preparation:GitInitializationPreparation,install:()=>void)=>void;
 dispatch:(evidence:GitInitializationEvidence)=>void;
 publish:(evidence:GitInitializationEvidence,publish:()=>GitInitializationReceipt)=>GitInitializationReceipt;
 cleanup:(remove:()=>void)=>void;
};
type Stored={anchors:Anchors;ignore:Buffer;state:'ready'|'consumed'};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const identity=(value:{dev:bigint;ino:bigint})=>value.dev+':'+value.ino;
const stamp=(value:BigIntStats)=>[identity(value),value.size,value.mtimeNs,value.ctimeNs,value.nlink].join(':');
const equal=(left:unknown,right:unknown)=>canonicalJson(left)===canonicalJson(right);
function synchronous<T>(operation:()=>T):T{
 if(operation.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
 const result=operation();
 if(result&&typeof(result as {then?:unknown}).then==='function'){
  Promise.resolve(result).catch(()=>{});throw Error('git_execution_authority_missing');
 }
 return result;
}

/** Only original native execution may apply a retained plan. Serialized facts
 * observe or clean its allocated scratch and never reconstruct write authority. */
export class GitInitializationEffects extends GitBranchEffects{
 private readonly initializationPlans=new WeakMap<GitInitializationPlan,Stored>();
 private initializationFile(path:string,links=1):{fact:GitInitializationFile|null;body:Buffer|null}{
  let before;
  try{before=lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{fact:null,body:null};throw error;}
  const body=this.raw(path,1024*1024,links),after=lstatSync(path,{bigint:true});
  if(body===null||stamp(before)!==stamp(after)||before.mode!==after.mode)throw Error('git_initialization_source_changed');
  return{body,fact:{identity:identity(before),sha256:hash(body),size:body.length,mode:Number(before.mode&0o777n)}};
 }
 private initializationLinks(pending:string,file:GitInitializationFile):number{
  let stat;
  try{stat=lstatSync(pending,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 1;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||identity(stat)!==file.identity)throw Error('git_initialization_metadata_unknown');
  return 2;
 }
 private initializationDirectory(path:string){
  try{return this.directorySync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 private assertInitializationAnchors(anchors:Anchors){
  if(this.directorySync(this.root)!==anchors.root||stamp(lstatSync(anchors.executable,{bigint:true}))!==anchors.program)throw Error('git_repository_changed');
 }
 private assertInitializationSource(witness:GitInitializationWitness,anchors:Anchors){
  this.assertInitializationAnchors(anchors);
  try{lstatSync(this.gitDirectory);throw Error('git_initialization_metadata_present');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(this.initializationDirectory(join(this.root,'.pilotdeck'))!==witness.internal_directory_identity
   ||!equal(this.initializationFile(join(this.root,'.pilotdeck','.gitignore')).fact,witness.internal_ignore))throw Error('git_initialization_source_changed');
 }
 async prepareInitialization(raw:GitInitializationSource,signal?:AbortSignal):Promise<GitInitializationPlan>{
  const witness=gitInitializationWitness(raw?.witness);
  if(witness.protocol!==1)throw Error('git_reinitialization_execution_unavailable');
  if(raw.review_sha256!==hash(JSON.stringify({action:'init',witness})))throw Error('git_initialization_review_changed');
  if(!equal(await this.freezeInitialization(witness.snapshot_id,witness.initial_branch,witness.object_format,signal),witness))throw Error('git_initialization_review_changed');
  const anchors=await this.initializationAnchors(signal);
  if(anchors.repository!==witness.repository_sha256)throw Error('git_repository_changed');
  this.assertInitializationSource(witness,anchors);
  const before=this.initializationFile(join(this.root,'.pilotdeck','.gitignore')),ignore=initializationInternalIgnore(before.body);
  if(!equal(before.fact,witness.internal_ignore)||hash(ignore.body)!==witness.ignore_after.sha256||ignore.body.length!==witness.ignore_after.size
   ||ignore.changed!==witness.ignore_after.changed)throw Error('git_initialization_review_changed');
  this.assertInitializationSource(witness,anchors);signal?.throwIfAborted();
  const plan=freezeWorkAdmission(gitInitializationPlan({protocol:1,plan_id:'git-init-'+randomUUID(),action:'init',witness,
   source_sha256:hash(JSON.stringify(witness)),review_sha256:raw.review_sha256,execution_authorized:false}));
  this.initializationPlans.set(plan,{anchors,ignore:ignore.body,state:'ready'});return plan;
 }
 private async initializationPendingFile(path:string,body:Buffer,mode:number,created?:(identity:string)=>void){
  const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),mode);
  try{created?.(identity(await handle.stat({bigint:true})));await handle.writeFile(body);await handle.chmod(mode);await handle.sync();}finally{await handle.close();}
  return this.initializationFile(path).fact!;
 }
 private metadataFiles(root:string,links:(path:string)=>number){
  const directories:GitInitializationEvidence['directories']=[],files:GitInitializationEvidence['files']=[];
  for(const path of initializationDirectories){
   const full=path?join(root,path):root,stat=lstatSync(full,{bigint:true});
   if(this.directorySync(full)!==identity(stat))throw Error('git_initialization_metadata_unknown');
   directories.push({path,identity:identity(stat),mode:Number(stat.mode&0o7777n)});
   const expected=[...initializationDirectories.filter(child=>child&&posix.dirname(child)===(path||'.'))
    .map(child=>posix.basename(child)),...(path===''?['config','HEAD']:[])].sort();
   if(!equal(readdirSync(full).sort(),expected))throw Error('git_initialization_metadata_unknown');
  }
  for(const path of ['config','HEAD'] as const){
   const fact=this.initializationFile(join(root,path),links(path)).fact;
   if(!fact)throw Error('git_initialization_metadata_unknown');files.push({path,...fact});
  }
  return{directories,files};
 }
 async applyInitialization(plan:GitInitializationPlan,authority:Authority,signal?:AbortSignal):Promise<GitInitializationReceipt>{
  const stored=this.initializationPlans.get(plan);
  if(!stored||stored.state!=='ready')throw Error('git_initialization_plan_consumed');
  for(const name of ['authorize','prepared','acquire','dispatch','publish','cleanup'] as const){
   if(typeof authority?.[name]!=='function'||authority[name].constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  }
  stored.state='consumed';const {witness}=plan;
  const allocation={name:'.git.jot-init-'+randomUUID()+'.pending',identity:''},stage=join(this.root,allocation.name),metadata=join(stage,'metadata');
  const internal=join(this.root,'.pilotdeck'),ignorePath=join(internal,'.gitignore'),rootLock=join(this.root,initializationRootLock),ignoreLock=join(internal,'.gitignore.lock');
  let preparation:GitInitializationPreparation|undefined,evidence:GitInitializationEvidence|undefined,rootLocked=false,ignoreLocked=false,internalIdentity=witness.internal_directory_identity;
  let publishedIgnore=false,failure:unknown;
  const canonical=new Map<string,string>(),privateDirectories=new Map<string,string>(),installed=new Set<string>(),earlyFiles=new Map<string,string>();
  const check=()=>{
   signal?.throwIfAborted();synchronous(()=>authority.authorize());this.assertInitializationAnchors(stored.anchors);
   if(allocation.identity&&this.directorySync(stage)!==allocation.identity)throw Error('git_repository_changed');
   for(const [path,id] of privateDirectories)if(this.directorySync(join(stage,path))!==id)throw Error('git_repository_changed');
   if(privateDirectories.has('templates')&&readdirSync(join(stage,'templates')).length)throw Error('git_initialization_configuration_invalid');
   if(canonical.size){
    for(const [path,id] of canonical){
     const target=path?join(this.gitDirectory,path):this.gitDirectory;
     if(this.directorySync(target)!==id||Number(lstatSync(target,{bigint:true}).mode&0o7777n)!==evidence!.directories.find(directory=>directory.path===path)!.mode)throw Error('git_repository_changed');
    }
    for(const [path,id] of canonical){
     const expected=[...canonical.keys()].filter(child=>child!==''&&posix.dirname(child)===(path||'.'))
      .map(child=>posix.basename(child));
     if(path==='')expected.push(...installed);
     if(!equal(readdirSync(path?join(this.gitDirectory,path):this.gitDirectory).sort(),expected.sort()))throw Error('git_initialization_metadata_unknown');
     if(this.directorySync(path?join(this.gitDirectory,path):this.gitDirectory)!==id)throw Error('git_repository_changed');
    }
    for(const path of installed){
     const expected=evidence!.files.find(file=>file.path===path)!;const {path:ignored,...fact}=expected;
     if(!equal(this.initializationFile(join(this.gitDirectory,path),this.initializationLinks(join(metadata,path),fact)).fact,fact))throw Error('git_initialization_metadata_unknown');
    }
   }else this.assertInitializationSource(witness,stored.anchors);
   if(this.initializationDirectory(internal)!==internalIdentity)throw Error('git_initialization_source_changed');
   const expectedIgnore=publishedIgnore?evidence!.ignore:witness.internal_ignore;
   if(!equal(this.initializationFile(ignorePath).fact,expectedIgnore))throw Error('git_initialization_source_changed');
   if(rootLocked&&!equal(this.initializationFile(rootLock,2).fact,preparation!.root_lock))throw Error('git_initialization_lock_unverified');
   if(ignoreLocked&&!equal(this.initializationFile(ignoreLock,2).fact,preparation!.ignore_lock))throw Error('git_initialization_lock_unverified');
  };
  const run=async(args:string[],codes:readonly number[]=[0])=>{
   check();const result=await readGit(stored.anchors.executable,this.root,metadata,args,this.limits,signal);check();
   if(!codes.includes(result.code))throw Error('git_initialization_prepare_failed');return result.bytes;
  };
  try{
   check();
   if(this.raw(rootLock)!==null||witness.ignore_after.changed&&internalIdentity!==null&&this.raw(ignoreLock)!==null)throw Error('git_repository_busy');
   mkdirSync(stage,{mode:0o700});allocation.identity=this.directorySync(stage);check();
   const rootFile=await this.initializationPendingFile(join(stage,'lease.lock'),Buffer.alloc(0),0o600,id=>earlyFiles.set('lease.lock',id));check();
   const ignoreFile=witness.ignore_after.changed?await this.initializationPendingFile(join(stage,'ignore.lock'),Buffer.alloc(0),0o600,id=>earlyFiles.set('ignore.lock',id)):null;
   check();
   preparation=freezeWorkAdmission(gitInitializationPreparation({protocol:1,plan,allocation,root_lock:rootFile,ignore_lock:ignoreFile}));
   synchronous(()=>authority.prepared(preparation!));check();
   let active=true,acquired=false;
   const acquire=()=>{
    if(!active||acquired)throw Error('git_initialization_plan_consumed');acquired=true;check();
    linkSync(join(stage,'lease.lock'),rootLock);rootLocked=true;
    if(ignoreFile&&internalIdentity!==null){check();linkSync(join(stage,'ignore.lock'),ignoreLock);ignoreLocked=true;}
    check();
   };
   try{synchronous(()=>authority.acquire(preparation!,acquire));}finally{active=false;}
   if(!acquired)throw Error('git_execution_authority_missing');
   for(const [path,mode] of [['templates',0o700],['metadata',0o777]] as const){
    check();mkdirSync(join(stage,path),{mode});privateDirectories.set(path,this.directorySync(join(stage,path)));check();
   }
   await run(['-c','init.defaultRefFormat=files','init','--quiet','--template='+join(stage,'templates'),
    '--initial-branch='+witness.initial_branch,'--object-format='+witness.object_format]);
   for(const directory of this.metadataFiles(metadata,()=>1).directories)privateDirectories.set(directory.path?'metadata/'+directory.path:'metadata',directory.identity);
   check();
   await run(['config','--file',join(metadata,'config'),'--no-includes','--unset-all','core.worktree'],[0,5]);
   const configured=new TextDecoder('utf-8',{fatal:true}).decode(await run(['config','--file',join(metadata,'config'),'--no-includes','--null','--list']));
   if(!configured.endsWith('\0'))throw Error('git_initialization_configuration_invalid');
   const values=new Map<string,string>();
   for(const entry of configured.slice(0,-1).split('\0')){
    const split=entry.indexOf('\n'),key=entry.slice(0,split),value=entry.slice(split+1);
    if(split<1||values.has(key))throw Error('git_initialization_configuration_invalid');values.set(key,value);
   }
   const allowed=new Map<string,readonly string[]>([
    ['core.filemode',['true','false']],['core.bare',['true','false']],['core.logallrefupdates',['true','false']],
    ['core.symlinks',['true','false']],['core.ignorecase',['true','false']],['core.precomposeunicode',['true','false']],
    ['core.repositoryformatversion',['0','1']],['extensions.objectformat',[witness.object_format]],['extensions.refstorage',['files']],
   ]);
   for(const [key,value] of values)if(!allowed.get(key)?.includes(value))throw Error('git_initialization_configuration_invalid');
   if(values.get('core.bare')!=='false'||values.get('core.logallrefupdates')!=='true'||!values.has('core.filemode')
    ||!values.has('core.repositoryformatversion')||witness.object_format==='sha256'&&(values.get('extensions.objectformat')!=='sha256'||values.get('core.repositoryformatversion')!=='1')
    ||new TextDecoder().decode(await run(['rev-parse','--show-object-format'])).trim()!==witness.object_format)throw Error('git_initialization_configuration_invalid');
   for(const path of ['config','HEAD']){
    check();const handle=await open(join(metadata,path),constants.O_RDWR|(constants.O_NOFOLLOW??0));try{await handle.sync();}finally{await handle.close();}check();
   }
   const ignore=witness.ignore_after.changed?await this.initializationPendingFile(join(stage,'internal-ignore'),stored.ignore,witness.internal_ignore?.mode??(0o666&~process.umask())):null;check();
   evidence=freezeWorkAdmission(gitInitializationEvidence({protocol:1,preparation,...this.metadataFiles(metadata,()=>1),ignore}));
   check();synchronous(()=>authority.dispatch(evidence!));check();
   let publishing=true,published=false,receipt:GitInitializationReceipt|undefined;
   const publish=()=>{
    if(!publishing||published)throw Error('git_initialization_plan_consumed');published=true;check();
    for(const directory of evidence!.directories){
     check();const target=directory.path?join(this.gitDirectory,directory.path):this.gitDirectory;
     mkdirSync(target,{mode:directory.mode});canonical.set(directory.path,this.directorySync(target));
     if(Number(lstatSync(target,{bigint:true}).mode&0o7777n)!==directory.mode)chmodSync(target,directory.mode);check();
    }
    if(witness.ignore_after.changed&&internalIdentity===null){check();mkdirSync(internal,{mode:0o777});internalIdentity=this.directorySync(internal);check();}
    if(witness.ignore_after.changed&&!ignoreLocked){check();linkSync(join(stage,'ignore.lock'),ignoreLock);ignoreLocked=true;check();}
    const config=evidence!.files[0]!;
    check();linkSync(join(metadata,config.path),join(this.gitDirectory,config.path));installed.add(config.path);unlinkSync(join(metadata,config.path));check();
    if(witness.ignore_after.changed){check();renameSync(join(stage,'internal-ignore'),ignorePath);publishedIgnore=true;check();}
    const head=evidence!.files[1]!;
    check();linkSync(join(metadata,head.path),join(this.gitDirectory,head.path));installed.add(head.path);unlinkSync(join(metadata,head.path));check();
    if(internalIdentity===null)throw Error('git_initialization_source_changed');
    return receipt=freezeWorkAdmission(gitInitializationReceipt({protocol:1,plan_id:plan.plan_id,action:'init',evidence_sha256:hash(canonicalJson(evidence)),
     directories:evidence!.directories.map(directory=>({...directory,identity:canonical.get(directory.path)!})),internal_directory_identity:internalIdentity,execution_authorized:false},evidence));
   };
   let result:GitInitializationReceipt;
   try{result=synchronous(()=>authority.publish(evidence!,publish));}finally{publishing=false;}
   if(!published||!receipt||!equal(result,receipt))throw Error('git_initialization_outcome_unknown');
   check();this.bindInitializedRepository(stored.anchors.root,canonical.get('')!,stored.anchors.executable,stored.anchors.program);return result;
  }catch(error){failure=error;throw error;}finally{
   this.initializationPlans.delete(plan);
   try{
    if(preparation)await this.cleanupInitializationPreparation(preparation,evidence,()=>{},undefined,remove=>synchronous(()=>authority.cleanup(remove)));
    else if(allocation.identity)this.cleanupAtomically(()=>{
     this.assertInitializationAnchors(stored.anchors);
     if(this.directorySync(stage)!==allocation.identity)throw Error('git_repository_changed');
     for(const [name,id] of earlyFiles){
      this.assertInitializationAnchors(stored.anchors);
      const fact=this.initializationFile(join(stage,name)).fact;
      if(!fact||fact.identity!==id||fact.sha256!==hash('')||fact.size!==0)throw Error('git_initialization_cleanup_unknown');unlinkSync(join(stage,name));
     }
     this.assertInitializationAnchors(stored.anchors);rmdirSync(stage);
    },remove=>synchronous(()=>authority.cleanup(remove)));
   }catch(error){throw Error('git_initialization_cleanup_unknown',{cause:failure??error});}
  }
 }
 /** Read-only recovery. Complete original file identities prove observed effects;
  * a partial layout remains unknown and is never completed by this method. */
 async observeInitialization(input:unknown,signal?:AbortSignal){
  const evidence=gitInitializationEvidence(input),{plan}=evidence.preparation,{witness}=plan;
  const anchors=await this.initializationAnchors(signal);
  if(anchors.repository!==witness.repository_sha256)throw Error('git_repository_changed');
  const stage=join(this.root,evidence.preparation.allocation.name),metadata=join(stage,'metadata'),internal=join(this.root,'.pilotdeck');
  const check=()=>{signal?.throwIfAborted();this.assertInitializationAnchors(anchors);};
  const result=(state:'applied'|'not_observed'|'unknown',receipt?:GitInitializationReceipt)=>({state,...(receipt?{receipt}:{}),execution_authorized:false as const});
  try{
   check();
   const allocation=this.initializationDirectory(stage);
   if(allocation!==null&&allocation!==evidence.preparation.allocation.identity)throw Error('git_repository_changed');
   if(this.initializationDirectory(this.gitDirectory)===null){
    this.assertInitializationSource(witness,anchors);check();return result('not_observed');
   }
   const snapshot=this.metadataFiles(this.gitDirectory,path=>this.initializationLinks(join(metadata,path),evidence.files.find(file=>file.path===path)!));
   if(!equal(snapshot.files,evidence.files)||snapshot.directories.some((directory,index)=>directory.mode!==evidence.directories[index]!.mode))return result('unknown');
   const internalIdentity=this.initializationDirectory(internal);
   if(internalIdentity===null||witness.internal_directory_identity!==null&&internalIdentity!==witness.internal_directory_identity)return result('unknown');
   const expectedIgnore=witness.ignore_after.changed?evidence.ignore:witness.internal_ignore;
   if(!equal(this.initializationFile(join(internal,'.gitignore')).fact,expectedIgnore))return result('unknown');
   check();
   for(const directory of snapshot.directories)if(this.directorySync(directory.path?join(this.gitDirectory,directory.path):this.gitDirectory)!==directory.identity)return result('unknown');
   if(this.initializationDirectory(internal)!==internalIdentity)return result('unknown');
   const after=this.metadataFiles(this.gitDirectory,path=>this.initializationLinks(join(metadata,path),evidence.files.find(file=>file.path===path)!));
   if(!equal(after,snapshot)||!equal(this.initializationFile(join(internal,'.gitignore')).fact,expectedIgnore))return result('unknown');
   check();
   return result('applied',gitInitializationReceipt({protocol:1,plan_id:plan.plan_id,action:'init',evidence_sha256:hash(canonicalJson(evidence)),
    directories:snapshot.directories,internal_directory_identity:internalIdentity,execution_authorized:false},evidence));
  }catch(error){check();return result('unknown');}
 }

 /** The owning service supplies either held native recovery authority or a
  * validated original settled outcome. Wire data cannot supply this callback. */
 async confirmInitializationBinding(input:unknown,rawReceipt:unknown,authorize:()=>void,signal?:AbortSignal){
  if(typeof authorize!=='function'||authorize.constructor.name==='AsyncFunction')throw Error('git_execution_authority_missing');
  const evidence=gitInitializationEvidence(input),receipt=gitInitializationReceipt(rawReceipt,evidence);
  signal?.throwIfAborted();synchronous(authorize);
  const anchors=await this.initializationAnchors(signal);
  if(anchors.repository!==evidence.preparation.plan.witness.repository_sha256)throw Error('git_repository_changed');
  const check=()=>{
   signal?.throwIfAborted();synchronous(authorize);this.assertInitializationAnchors(anchors);
   if(this.directorySync(this.gitDirectory)!==receipt.directories[0]!.identity)throw Error('git_repository_changed');
  };
  check();this.bindInitializedRepository(anchors.root,receipt.directories[0]!.identity,anchors.executable,anchors.program);check();
 }

 /** Caller retains original native drain and lease authority. Only the durably
  * allocated private namespace and exact original empty lock inodes are removed.
  * Canonical Git files and project-internal ignore contents are preserved. */
 async cleanupInitializationPreparation(raw:unknown,rawEvidence:unknown|undefined,guard:()=>void,signal?:AbortSignal,atomic?:((remove:()=>void)=>void)){
  const preparation=gitInitializationPreparation(raw),evidence=rawEvidence===undefined?undefined:gitInitializationEvidence(rawEvidence);
  if(evidence&&!equal(evidence.preparation,preparation))throw Error('git_initialization_evidence_invalid');
  const anchors=await this.initializationAnchors(signal),{witness}=preparation.plan;
  if(anchors.repository!==witness.repository_sha256)throw Error('git_repository_changed');
  const stage=join(this.root,preparation.allocation.name),internal=join(this.root,'.pilotdeck'),internalIdentity=this.initializationDirectory(internal);
  if(witness.internal_directory_identity!==null&&internalIdentity!==null&&internalIdentity!==witness.internal_directory_identity)throw Error('git_repository_changed');
  const check=()=>{
   signal?.throwIfAborted();synchronous(guard);this.assertInitializationAnchors(anchors);
   const current=this.initializationDirectory(stage);
   if(current!==null&&current!==preparation.allocation.identity||this.initializationDirectory(internal)!==internalIdentity)throw Error('git_repository_changed');
  };
  const locks=[{pending:'lease.lock',target:join(this.root,initializationRootLock),fact:preparation.root_lock},
   ...(preparation.ignore_lock?[{pending:'ignore.lock',target:join(internal,'.gitignore.lock'),fact:preparation.ignore_lock}]:[])];
  const canonicalFile=(path:string)=>evidence?.files.find(file=>'metadata/'+file.path===path);
  const targetFor=(path:string)=>locks.find(lock=>lock.pending===path)?.target
   ??(canonicalFile(path)?join(this.gitDirectory,canonicalFile(path)!.path):undefined);
  const links=(path:string,id:string)=>{
   const target=targetFor(path);if(!target)return 1;
   let stat;
   try{stat=lstatSync(target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 1;throw error;}
   if(!stat.isFile()||stat.isSymbolicLink())throw Error('git_initialization_cleanup_unknown');
   return identity(stat)===id?2:1;
  };
  check();
  this.cleanupAtomically(()=>{
   check();
   const directories:Array<{path:string;identity:string;entries:string[]}>=[],files:Array<{path:string;fact:GitInitializationFile}>=[];
   let count=0,total=0;
   const scan=(relative:string)=>{
    check();const path=relative?join(stage,relative):stage,id=this.directorySync(path),entries=readdirSync(path).sort();
    directories.push({path:relative,identity:id,entries});
    for(const name of entries){
     if(++count>512)throw Error('git_initialization_cleanup_unknown');
     const child=relative?relative+'/'+name:name,full=join(stage,child),stat=lstatSync(full,{bigint:true});
     if(stat.isSymbolicLink())throw Error('git_initialization_cleanup_unknown');
     if(stat.isDirectory()){scan(child);continue;}
     if(!stat.isFile())throw Error('git_initialization_cleanup_unknown');
     const fact=this.initializationFile(full,links(child,identity(stat))).fact;
     if(!fact||(total+=fact.size)>8*1024*1024)throw Error('git_initialization_cleanup_unknown');
     const expected=locks.find(lock=>lock.pending===child)?.fact??canonicalFile(child)
      ??(child==='internal-ignore'?evidence?.ignore:undefined);
     if(expected){const {path:ignored,...value}=expected as GitInitializationFile&{path?:string};if(!equal(fact,value))throw Error('git_initialization_cleanup_unknown');}
     files.push({path:child,fact});
    }
   };
   if(this.initializationDirectory(stage)!==null)scan('');
   const lockFact=(lock:typeof locks[number])=>{
    let stat;
    try{stat=lstatSync(lock.target,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    let pending=0;
    try{if(identity(lstatSync(join(stage,lock.pending),{bigint:true}))===lock.fact.identity)pending=1;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||!equal(this.initializationFile(lock.target,1+pending).fact,lock.fact))throw Error('git_initialization_lock_unverified');
    return stat;
   };
   for(const lock of locks){check();lockFact(lock);}
   for(const directory of directories){
    check();const path=directory.path?join(stage,directory.path):stage;
    if(this.directorySync(path)!==directory.identity||!equal(readdirSync(path).sort(),directory.entries))throw Error('git_initialization_cleanup_unknown');
   }
   for(const file of files){check();if(!equal(this.initializationFile(join(stage,file.path),links(file.path,file.fact.identity)).fact,file.fact))throw Error('git_initialization_cleanup_unknown');}
   for(const lock of locks){check();if(lockFact(lock))unlinkSync(lock.target);}
   for(const file of files){
    check();if(!equal(this.initializationFile(join(stage,file.path),links(file.path,file.fact.identity)).fact,file.fact))throw Error('git_initialization_cleanup_unknown');
    unlinkSync(join(stage,file.path));
   }
   for(const directory of [...directories].reverse()){
    check();const path=directory.path?join(stage,directory.path):stage;
    if(this.directorySync(path)!==directory.identity)throw Error('git_initialization_cleanup_unknown');rmdirSync(path);
   }
  },atomic);
 }

}
