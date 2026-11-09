import {initializationInternalIgnore,initializationSnapshotId,normalizeGitInitializationReview} from './initialization-records.ts';
import type {GitInitializationWitness,GitInitializationFile,GitReinitializationLayout} from '../../contracts/types.ts';
import {planReinitializationConfiguration} from './reinitialization-configuration.ts';
import {planCreateBranchConfiguration} from './branch-configuration.ts';
import {validGitReference} from './references.ts';
import type {GitBranchInventory,GitCreateBranchWitness,GitBranchLogFile,GitBranchLogWitness} from '../../contracts/types.ts';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../db/canonical-json.ts';
import {constants} from 'node:fs';
import {lstat as nativeLstat,open,opendir,realpath,readdir,mkdir,mkdtemp,writeFile,rm,utimes} from 'node:fs/promises';
import {isAbsolute,resolve,join,dirname,relative,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {gitExecutable,readGit} from './process.ts';
import {readCommitTree,type GitCommitReviewWitness} from './commit-tree.ts';
import {taskmasterPrdPath} from '../workbench/taskmaster-path.ts';

export type GitInspectionOptions={root:string;gitDirectory?:string;commonDirectory?:string;executable?:string;limits?:Partial<{maxOutputBytes:number;timeoutMs:number;maxEntries:number;maxMetadataEntries:number;maxDiffBytes:number}>};
export type GitEntry={path:string;original_path?:string;index_status:string;worktree_status:string;conflicted:boolean;kind:'file'|'directory'|'symlink'|'missing'|'other'};
export type GitRemote={name:string;kind:'https'|'ssh'|'local'|'other';host?:string};
export type GitSnapshot={snapshot_id:string;repository_sha256:string;head:{oid:string|null;branch:string|null;detached:boolean};entries:GitEntry[];remotes:GitRemote[];omitted_count:number;read_only:true;execution_authorized:false};
export type GitDiff={snapshot_id:string;path:string;stage:'working'|'staged';kind:'text'|'binary';patch:string;read_only:true;execution_authorized:false};
export type GitReviewWitness={protocol:2;snapshot_id:string;repository_sha256:string;head:GitSnapshot['head'];index_sha256:string|null;files:Array<{path:string;kind:'file'|'missing';sha256:string|null;size:number;mode:number}>;attributes:Array<{path:string;sha256:string|null}>};
export type GitPublicationTargetFile={path:string;kind:'file'|'missing';sha256:string|null;size:number;mode:number;stat_sha256:string|null;
 ancestors:Array<{path:string|null;kind:'directory'|'missing';identity_sha256:string|null}>};
export type GitPublicationTargetWitness={protocol:1;kind:'publication_target';snapshot_id:string;repository_sha256:string;
 head:GitSnapshot['head'];index_sha256:string|null;files:GitPublicationTargetFile[];attributes:GitReviewWitness['attributes'];execution_authorized:false;target_sha256:string};
export type GitPublicationTargetRead={witness:GitPublicationTargetWitness;contents:Map<string,Buffer>};
export type TaskmasterProjectFile<Path extends string='.taskmaster/config.json'|'.taskmaster/tasks/tasks.json'>={path:Path;kind:'missing'|'too_large'|'file';size:number;sha256:string|null;content:Buffer|null};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root:string,path:string)=>same(root,path)||same(root+sep,path.slice(0,root.length+1));
const text=(value:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(value);
// NTFS file IDs can exceed Number's exact integer range. Never round physical
// identities or nanosecond witnesses before approval, execution or recovery.
const lstat=(path:string)=>nativeLstat(path,{bigint:true});
const identity=(s:Awaited<ReturnType<typeof lstat>>)=>[String(s.dev),String(s.ino)].join(':');
const witness=(s:Awaited<ReturnType<typeof lstat>>)=>[identity(s),String(s.size),String(s.mtimeNs),String(s.ctimeNs),String(s.nlink)].join(':');
const safe=(path:string)=>{if(path.startsWith('-'))throw Error('git_path_unavailable');return workspaceRelativePath(path);};
export type GitReadContext={directory:string;metadata:string;index:string|null;remotes:GitRemote[];branchLogPolicy?:Pick<GitBranchLogWitness,'configuration'|'enabled'>;worktreeConfigEnabled?:boolean;dispose():Promise<void>};
type ReadContext=GitReadContext;

/** Operator-bound, read-only physical repository. No caller-controlled root,
 * generic command, write intent, inference, credential or execution authority. */
export class GitRepositoryInspection{
 protected readonly root:string;protected readonly gitDirectory:string;protected readonly commonDirectory:string;
 protected readonly limits={maxOutputBytes:2*1024*1024,timeoutMs:5000,maxEntries:5000,maxMetadataEntries:100000,maxDiffBytes:256*1024};
 private readonly configuredExecutable:string|undefined;private binding?:string;protected executable?:string;
 constructor(options:GitInspectionOptions){
  if(!options||!isAbsolute(options.root)||options.gitDirectory!==undefined&&!isAbsolute(options.gitDirectory)||options.commonDirectory!==undefined&&!isAbsolute(options.commonDirectory)||options.executable!==undefined&&!isAbsolute(options.executable))throw Error('git_configuration_invalid');
  this.root=resolve(options.root);this.gitDirectory=resolve(options.gitDirectory??join(this.root,'.git'));this.commonDirectory=resolve(options.commonDirectory??this.gitDirectory);this.configuredExecutable=options.executable;
  if(options.limits)for(const [key,value] of Object.entries(options.limits)){if(!(key in this.limits)||!Number.isSafeInteger(value)||Number(value)<1||Number(value)>100*1024*1024)throw Error('git_configuration_invalid');(this.limits as Record<string,number>)[key]=Number(value);}
 }
 protected async directory(path:string){
  let current=path;while(true){const value=await lstat(current);if(!value.isDirectory()||value.isSymbolicLink())throw Error('git_repository_changed');const parent=dirname(current);if(parent===current)break;current=parent;}
  if(!same(await realpath(path),path))throw Error('git_repository_changed');return identity(await lstat(path));
 }
 private async metadata(signal?:AbortSignal,ignored:ReadonlySet<string>=new Set()){
  const facts:string[]=[];let count=0;
  for(const root of [...new Set([this.gitDirectory,this.commonDirectory])]){const queue=[root];while(queue.length){signal?.throwIfAborted();const directory=queue.pop()!;
   for(const item of await readdir(directory,{withFileTypes:true})){signal?.throwIfAborted();const path=join(directory,item.name);if(ignored.has(path))continue;if(++count>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');const s=await lstat(path);
    if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())throw Error('git_repository_changed');
    if(s.isDirectory())queue.push(path);else if(path===join(this.commonDirectory,'objects','info','alternates')&&s.size)throw Error('git_metadata_unavailable');
    facts.push(path+':'+witness(s));
   }
  }}return hash(facts.sort().join('\n'));
 }
 /** Original physical encoding, installed only after the initialization kernel
  * checks the proven publication under its owning service's authority. */
 protected bindInitializedRepository(root:string,git:string,executable:string,program:string){
  this.binding=hash(JSON.stringify({root:this.root,git:this.gitDirectory,common:this.commonDirectory,
   directories:[root,git,git],executable,program}));this.executable=executable;
 }
 // Writable kernels may exclude only their identity-checked owned scratch roots.
 protected async anchors(signal?:AbortSignal,ignored:ReadonlySet<string>=new Set()){
  signal?.throwIfAborted();const directories=await Promise.all([this.directory(this.root),this.directory(this.gitDirectory),this.directory(this.commonDirectory)]);
  const dot=join(this.root,'.git'),entry=await lstat(dot);if(entry.isSymbolicLink())throw Error('git_repository_changed');
  if(entry.isFile()){
   const bytes=await this.bytes(dot,4096);const value=text(bytes).trim();if(!value.startsWith('gitdir: ')||!same(resolve(this.root,value.slice(8)),this.gitDirectory))throw Error('git_repository_changed');
  }else if(!entry.isDirectory()||!same(dot,this.gitDirectory))throw Error('git_repository_changed');
  let common=this.gitDirectory;try{common=resolve(this.gitDirectory,text(await this.bytes(join(this.gitDirectory,'commondir'),4096)).trim());}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(!same(common,this.commonDirectory))throw Error('git_repository_changed');
  const executable=this.executable??await gitExecutable(this.configuredExecutable);if(within(this.root,executable))throw Error('git_configuration_invalid');
  const facts=hash(JSON.stringify({root:this.root,git:this.gitDirectory,common:this.commonDirectory,directories,executable,program:witness(await lstat(executable))}));
  if(this.binding!==undefined&&facts!==this.binding)throw Error('git_repository_changed');this.binding=facts;this.executable=executable;
  return{repository:hash(facts),metadata:await this.metadata(signal,ignored)};
 }
 protected async bytes(path:string,max:number,expected?:string){
  const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>max||expected!==undefined&&witness(before)!==expected)throw Error('git_path_unavailable');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
   if(witness(await file.stat({bigint:true}))!==witness(before))throw Error('git_snapshot_changed');
   // One overflow byte detects growth without allowing readFile to follow it indefinitely.
   const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
   while(length<bytes.length){const {bytesRead}=await file.read(bytes,length,bytes.length-length,length);if(!bytesRead)break;length+=bytesRead;}
   if(length!==Number(before.size)||witness(await file.stat({bigint:true}))!==witness(before)||witness(await lstat(path))!==witness(before))throw Error('git_snapshot_changed');return bytes.subarray(0,length);
  }finally{await file.close();}
 }
 protected async run(context:ReadContext,args:string[],signal?:AbortSignal,allowMissing=false){
  const result=await readGit(this.executable!,this.root,context.directory,args,this.limits,signal,join(this.commonDirectory,'objects'));
  if(result.code!==0&&!(allowMissing&&result.code===1))throw Error('git_read_unavailable');return result;
 }
 /** Private disposable read-copy, never an execution target or another Git
  * authority. Source config/hooks/filters are not loaded by Git operations. */
 protected async context(signal?:AbortSignal,branchLogs=false):Promise<ReadContext>{
  const before=await this.anchors(signal),scratchBase=resolve(tmpdir()),directory=await mkdtemp(join(scratchBase,'jot-git-read-'));
  const context:ReadContext={directory,metadata:before.metadata,index:null,remotes:[],dispose:async()=>{if(!within(scratchBase,directory)||same(scratchBase,directory)||(await lstat(directory)).isSymbolicLink())throw Error('git_cleanup_unavailable');await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}};
  try{
   await mkdir(join(directory,'objects'));await mkdir(join(directory,'refs'));await writeFile(join(directory,'HEAD'),'ref: refs/heads/main\n');await writeFile(join(directory,'config'),'[core]\n repositoryformatversion = 0\n bare = false\n');
   const settings=new Map<string,string>(),branchSources=new Map<string,string>();let worktreeConfig=false;
   for(const path of [join(this.commonDirectory,'config'),join(this.gitDirectory,'config.worktree')]){
    if(path.endsWith('config.worktree')&&!worktreeConfig)continue;
    signal?.throwIfAborted();try{await this.bytes(path,1024*1024);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const configured=await this.run(context,['config','--file',path,'--no-includes','--null','--list'],signal);
    for(const item of text(configured.bytes).split('\0')){
     const at=item.indexOf('\n'),key=at<0?item:item.slice(0,at);
     if(branchLogs&&['core.logallrefupdates','core.bare'].includes(key))branchSources.set(key,path);
     if(at<0){
      if(key==='extensions.refstorage')throw Error('git_reference_backend_unsupported');
      if(key==='extensions.worktreeconfig'||branchLogs&&['core.logallrefupdates','core.bare'].includes(key))settings.set(key,'true');continue;
     }
     const value=item.slice(at+1);
     if(key==='extensions.refstorage'&&value!=='files')throw Error('git_reference_backend_unsupported');
     settings.set(key,value);
    }
    if(path===join(this.commonDirectory,'config')&&settings.has('extensions.worktreeconfig')){
     const value=text((await this.run(context,['config','--file',path,'--no-includes','--type=bool','--get','extensions.worktreeconfig'],signal)).bytes).trim();
     if(value!=='true'&&value!=='false')throw Error('git_configuration_invalid');worktreeConfig=value==='true';
    }
   }
   context.worktreeConfigEnabled=worktreeConfig;
   if(branchLogs){
    const boolean=async(key:string,fallback:boolean)=>{
     const path=branchSources.get(key);if(!path)return fallback;
     const value=text((await this.run(context,['config','--file',path,'--no-includes','--type=bool','--get',key],signal)).bytes).trim();
     if(value!=='true'&&value!=='false')throw Error('git_branch_log_policy_invalid');return value==='true';
    };
    const explicit=branchSources.has('core.logallrefupdates'),always=settings.get('core.logallrefupdates')?.toLowerCase()==='always';
    const enabled=always||await boolean('core.logallrefupdates',!await boolean('core.bare',false));
    context.branchLogPolicy={configuration:explicit?(always?'always':enabled?'true':'false'):'default',enabled};
   }
   let config='[core]\n repositoryformatversion = 0\n bare = false\n';
   for(const key of ['filemode','ignorecase','symlinks','sparsecheckout','sparsecheckoutcone','safecrlf']){const value=settings.get('core.'+key)?.toLowerCase();if(value!==undefined){if(!['true','false','yes','no','on','off','1','0','warn'].includes(value))throw Error('git_configuration_invalid');config+=' '+key+' = '+value+'\n';}}
   for(const [key,allowed] of [['autocrlf',['true','false','input']],['eol',['lf','crlf','native']]] as const){const value=settings.get('core.'+key)?.toLowerCase();if(value!==undefined){if(!(allowed as readonly string[]).includes(value))throw Error('git_configuration_invalid');config+=' '+key+' = '+value+'\n';}}
   if(settings.get('extensions.objectformat')==='sha256')config=config.replace('repositoryformatversion = 0','repositoryformatversion = 1')+'[extensions]\n objectformat = sha256\n';
   await writeFile(join(directory,'config'),config);
   for(const [key,url] of settings){const match=/^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.url$/.exec(key);if(!match)continue;const name=match[1]!;let remote:GitRemote={name,kind:'other'};
    try{const parsed=new URL(url);if(['https:','http:','ssh:'].includes(parsed.protocol)&&/^[A-Za-z0-9.:[\]-]{1,255}$/.test(parsed.hostname))remote={name,kind:parsed.protocol==='ssh:'?'ssh':'https',host:parsed.hostname};else if(parsed.protocol==='file:')remote={name,kind:'local'};}catch{const ssh=/^(?:[^@\s]+@)?([A-Za-z0-9.-]+):[^\s]+$/.exec(url);remote=ssh?{name,kind:'ssh',host:ssh[1]!}:{name,kind:'local'};}if(context.remotes.length>=100)throw Error('git_entry_limit');context.remotes.push(remote);
   }
   let total=0;const copy=async(source:string,target:string,optional=false)=>{signal?.throwIfAborted();let bytes;try{bytes=await this.bytes(source,32*1024*1024);}catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}const original=await lstat(source);total+=bytes.length;if(total>64*1024*1024)throw Error('git_metadata_limit');await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{mode:0o600});
    // Git uses the index mtime to rehash racily clean stat-cache entries. Giving
    // a copy a newer timestamp can silently hide same-size/same-second edits.
    if(source===join(this.gitDirectory,'index')||/^sharedindex\.[a-f0-9]+$/.test(basename(source))){const seconds=(ns:bigint)=>Number(ns/1000000000n)+Number(ns%1000000000n)/1e9;await utimes(target,seconds(original.atimeNs),seconds(original.mtimeNs));}
    if(source===join(this.gitDirectory,'index'))context.index=hash(bytes);};
   await copy(join(this.gitDirectory,'HEAD'),join(directory,'HEAD'));
   await copy(join(this.gitDirectory,'index'),join(directory,'index'),true);
   await copy(join(this.commonDirectory,'packed-refs'),join(directory,'packed-refs'),true);
   for(const name of ['exclude','attributes','sparse-checkout'])await copy(join(this.commonDirectory,'info',name),join(directory,'info',name),true);
   for(const root of [...new Set([this.commonDirectory,this.gitDirectory])]){
    const queue=[join(root,'refs')];while(queue.length){const folder=queue.pop()!;let entries;try{entries=await readdir(folder,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}for(const entry of entries){const path=join(folder,entry.name);if(entry.isDirectory())queue.push(path);else await copy(path,join(directory,relative(root,path)));}}
    for(const entry of await readdir(root))if(/^sharedindex\.[a-f0-9]+$/.test(entry))await copy(join(root,entry),join(directory,entry));
   }
   if((await this.anchors(signal)).metadata!==before.metadata)throw Error('git_snapshot_changed');return context;
  }catch(error){await context.dispose();throw error;}
 }
 protected async file(path:string):Promise<{kind:GitEntry['kind'];stamp:string}>{
  const parts=safe(path).split('/');let current=this.root;
  for(let index=0;index<parts.length;index++){
   current=join(current,parts[index]!);let s;try{s=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{kind:'missing',stamp:'missing'};throw Error('git_path_unavailable');}
   if(index<parts.length-1){if(!s.isDirectory()||s.isSymbolicLink())throw Error('git_path_unavailable');}
   else return{kind:s.isSymbolicLink()?'symlink':s.isFile()&&s.nlink===1n?'file':s.isDirectory()?'directory':'other',stamp:witness(s)};
  }throw Error('git_path_unavailable');
 }
 private async collect(context:ReadContext,signal?:AbortSignal){
  const anchors=await this.anchors(signal);
  if(anchors.metadata!==context.metadata)throw Error('git_snapshot_changed');
  const oidResult=await this.run(context,['rev-parse','--verify','--quiet','HEAD'],signal,true),oid=oidResult.code===1?null:text(oidResult.bytes).trim();if(oid!==null&&!/^[a-f0-9]{40,64}$/.test(oid))throw Error('git_read_unavailable');
  const branchResult=await this.run(context,['symbolic-ref','--quiet','--short','HEAD'],signal,true),branch=branchResult.code===1?null:text(branchResult.bytes).trim();if(branch!==null&&(!branch||branch.length>1024||/[\x00-\x1f\x7f]/.test(branch)))throw Error('git_read_unavailable');
  const raw=(await this.run(context,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'],signal)).bytes;
  const records=text(raw).split('\0'),entries:GitEntry[]=[],files:Record<string,string>=Object.create(null);let omitted=0;
  for(let i=0;i<records.length;i++){const row=records[i]!;if(!row)continue;if(row.length<4||row[2]!==' ')throw Error('git_read_unavailable');const x=row[0]!,y=row[1]!,path=row.slice(3),original='RC'.includes(x)||'RC'.includes(y)?records[++i]:undefined;
   if(entries.length+omitted>=this.limits.maxEntries)throw Error('git_entry_limit');
   try{safe(path);if(original!==undefined)safe(original);}catch{omitted++;continue;}
   const file=await this.file(path);files[path]=file.stamp;if(original)files[original]=(await this.file(original)).stamp;
   entries.push({path,...(original?{original_path:original}:{}),index_status:x,worktree_status:y,conflicted:x==='U'||y==='U'||['DD','AA'].includes(x+y),kind:file.kind});
  }
  entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const remotes=context.remotes,index=context.index,attributes=await this.attributeManifest(entries.flatMap(entry=>[entry.path,...(entry.original_path?[entry.original_path]:[])]),signal);
  const head={oid,branch,detached:branch===null&&oid!==null},snapshot_id=hash(JSON.stringify({anchors,head,index,status:hash(raw),files,remotes,attributes}));
  return{value:{snapshot_id,repository_sha256:anchors.repository,head,entries,remotes,omitted_count:omitted,read_only:true,execution_authorized:false} as GitSnapshot,files};
 }
 protected async inspectContext(context:ReadContext,signal?:AbortSignal):Promise<GitSnapshot>{const first=await this.collect(context,signal),second=await this.collect(context,signal);if(first.value.snapshot_id!==second.value.snapshot_id)throw Error('git_snapshot_changed');return second.value;}
 async inspect(signal?:AbortSignal):Promise<GitSnapshot>{const context=await this.context(signal);try{return await this.inspectContext(context,signal);}finally{await context.dispose();}}
 /** Fixed Taskmaster inputs from the operator-bound repository, without a Git command or write. */
 async taskmasterFiles(signal?:AbortSignal){
  return this.taskmasterInputs([{path:'.taskmaster/config.json',maxBytes:65536},{path:'.taskmaster/tasks/tasks.json',maxBytes:1048576}] as const,signal);
 }
 async taskmasterPrdFile(fileName:string,signal?:AbortSignal){
  return this.taskmasterInputs([{path:taskmasterPrdPath(fileName),maxBytes:1048576}],signal);
 }
 private async taskmasterInputs<Path extends string>(inputs:readonly {path:Path;maxBytes:number}[],signal?:AbortSignal){
  const before=await this.anchors(signal),files:TaskmasterProjectFile<Path>[]=[];
  const facts:GitPublicationTargetFile[]=[];
  for(const {path,maxBytes} of inputs){
   signal?.throwIfAborted();
   const fact=await this.publicationPath(path,signal,Number.MAX_SAFE_INTEGER);
   let content:Buffer|null=null;
   if(fact.kind==='file'&&fact.size<=maxBytes){
    const stat=await lstat(join(this.root,path));
    if(hash(witness(stat))!==fact.stat_sha256)throw Error('git_snapshot_changed');
    content=await this.bytes(join(this.root,path),maxBytes,witness(stat));
   }
   if(canonicalJson(await this.publicationPath(path,signal,Number.MAX_SAFE_INTEGER))!==canonicalJson(fact))throw Error('git_snapshot_changed');
   const sha256=content===null?null:hash(content);
   facts.push({...fact,sha256});
   files.push({path,kind:fact.kind==='missing'?'missing':content===null?'too_large':'file',size:fact.size,sha256,content});
  }
  for(const {sha256,...fact} of facts){
   if(canonicalJson(await this.publicationPath(fact.path,signal,Number.MAX_SAFE_INTEGER))!==canonicalJson(fact))throw Error('git_snapshot_changed');
  }
  const after=await this.anchors(signal);
  if(after.repository!==before.repository||after.metadata!==before.metadata)throw Error('git_snapshot_changed');
  signal?.throwIfAborted();
  const directory=facts[0]?.ancestors.find(ancestor=>ancestor.path==='.taskmaster');
  if(!directory||facts.some(fact=>canonicalJson(fact.ancestors.find(ancestor=>ancestor.path==='.taskmaster'))!==canonicalJson(directory)))throw Error('git_snapshot_changed');
  return {repository_sha256:before.repository,source_sha256:hash(canonicalJson({repository:before.repository,metadata:before.metadata,files:facts})),
   directory_state:directory.kind==='directory'?'present' as const:'missing' as const,files};
 }
 private async taskmasterPrdNames(signal?:AbortSignal){
  let current=this.root;const directories=[hash(witness(await lstat(current)))];
  for(const part of ['.taskmaster','docs']){
   signal?.throwIfAborted();const aliases:string[]=[];let count=0;
   for await(const entry of await opendir(current)){
    signal?.throwIfAborted();if(++count>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');
    if(entry.name.normalize('NFC').toLowerCase()===part)aliases.push(entry.name);
   }
   if(aliases.length>1||aliases.length===1&&aliases[0]!==part)throw Error('git_path_unavailable');
   if(!aliases.length)return {state:'missing' as const,directories,names:[] as string[],unsupported_count:0};
   current=join(current,part);const stat=await lstat(current);
   if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('git_path_unavailable');
   directories.push(hash(witness(stat)));
  }
  const names:string[]=[];let count=0,unsupported=0;
  for await(const entry of await opendir(current)){
   signal?.throwIfAborted();if(++count>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');
   if(!/\.(md|markdown|txt)$/i.test(entry.name))continue;
   if(!entry.isFile()){unsupported++;continue;}
   try{taskmasterPrdPath(entry.name);}catch{unsupported++;continue;}
   names.push(entry.name);
  }
  names.sort();
  if(new Set(names.map(name=>name.normalize('NFC').toLowerCase())).size!==names.length)throw Error('git_path_unavailable');
  return {state:'present' as const,directories,names,unsupported_count:unsupported};
 }
 private async taskmasterPrdFact(path:string,signal?:AbortSignal){
  signal?.throwIfAborted();const fact=await this.file(path);
  if(fact.kind==='missing')return {path,kind:'missing' as const,size:0,stat_sha256:null};
  if(fact.kind!=='file')throw Error('git_path_unavailable');
  const stat=await lstat(join(this.root,path));
  if(witness(stat)!==fact.stamp||stat.size>BigInt(Number.MAX_SAFE_INTEGER))throw Error('git_snapshot_changed');
  return {path,kind:'file' as const,size:Number(stat.size),stat_sha256:hash(fact.stamp)};
 }
 async taskmasterPrdFiles(after:string|undefined,signal?:AbortSignal){
  if(after!==undefined)taskmasterPrdPath(after);
  const before=await this.anchors(signal),listing=await this.taskmasterPrdNames(signal);
  const candidates=listing.names.filter(name=>after===undefined||name>after),names=candidates.slice(0,50);
  const facts:Awaited<ReturnType<GitRepositoryInspection['taskmasterPrdFact']>>[]=[];
  for(const name of names)facts.push(await this.taskmasterPrdFact(taskmasterPrdPath(name),signal));
  if(canonicalJson(await this.taskmasterPrdNames(signal))!==canonicalJson(listing))throw Error('git_snapshot_changed');
  for(const fact of facts)if(canonicalJson(await this.taskmasterPrdFact(fact.path,signal))!==canonicalJson(fact))throw Error('git_snapshot_changed');
  const end=await this.anchors(signal);
  if(end.repository!==before.repository||end.metadata!==before.metadata)throw Error('git_snapshot_changed');
  signal?.throwIfAborted();
  return {repository_sha256:before.repository,source_sha256:hash(canonicalJson({repository:before.repository,metadata:before.metadata,listing,files:facts})),
   directory_state:listing.state,total:listing.names.length,unsupported_count:listing.unsupported_count,
   files:facts.map(fact=>({name:basename(fact.path),path:fact.path,size:fact.size,state:fact.kind==='missing'?'missing' as const:fact.size>1048576?'too_large' as const:'available' as const})),
   next_after:candidates.length>names.length?names[names.length-1]!:null};
 }
 private async attributeManifest(paths:readonly string[],signal?:AbortSignal):Promise<GitReviewWitness['attributes']>{
  const names=new Set<string>();for(const path of paths){const parts=path.split('/');parts.pop();while(true){names.add([...parts,'.gitattributes'].join('/'));if(names.size>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');if(!parts.length)break;parts.pop();}}
  if(names.size>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');const result:GitReviewWitness['attributes']=[];let size=0;
  for(const path of [...names].sort()){signal?.throwIfAborted();const fact=await this.file(path);if(fact.kind==='missing'){result.push({path,sha256:null});continue;}if(fact.kind!=='file')throw Error('git_path_unavailable');const bytes=await this.bytes(join(this.root,path),1024*1024,fact.stamp);size+=bytes.length;if(size>4*1024*1024)throw Error('git_metadata_limit');result.push({path,sha256:hash(bytes)});}
  return result;
 }
 /** A distinct before-state read for publication, including clean and absent
  * targets. It does not widen the dirty-only stage/unstage witness. */
 private async publicationPath(path:string,signal?:AbortSignal,maxBytes=32*1024*1024):Promise<Omit<GitPublicationTargetFile,'sha256'>>{
  signal?.throwIfAborted();const parts=path.split('/'),ancestors:GitPublicationTargetFile['ancestors']=[{path:null,kind:'directory',identity_sha256:hash(await this.directory(this.root))}];let current=this.root;
  const missing=():Omit<GitPublicationTargetFile,'sha256'>=>({path,kind:'missing',size:0,mode:0,stat_sha256:null,ancestors});
  for(let index=0;index<parts.length;index++){
   signal?.throwIfAborted();const part=parts[index]!,names=await readdir(current);
   if(names.length>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');
   if(index>0&&names.some(name=>name.toLowerCase()==='.git'))throw Error('git_path_unavailable');
   const aliases=names.filter(name=>name.normalize('NFC').toLowerCase()===part.normalize('NFC').toLowerCase());
   if(aliases.length>1||aliases.length===1&&aliases[0]!==part)throw Error('git_path_unavailable');
   if(!aliases.length){if(index<parts.length-1)ancestors.push({path:parts.slice(0,index+1).join('/'),kind:'missing',identity_sha256:null});return missing();}
   current=join(current,part);const stat=await lstat(current);
   if(stat.isSymbolicLink())throw Error('git_path_unavailable');
   if(index<parts.length-1){
    if(!stat.isDirectory())throw Error('git_path_unavailable');
    ancestors.push({path:parts.slice(0,index+1).join('/'),kind:'directory',identity_sha256:hash(identity(stat))});
   }else{
    if(!stat.isFile()||stat.nlink!==1n||stat.size>BigInt(maxBytes))throw Error('git_path_unavailable');
    return{path,kind:'file',size:Number(stat.size),mode:Number(stat.mode&0o777n),stat_sha256:hash(witness(stat)),ancestors};
   }
  }throw Error('git_path_unavailable');
 }
 async publicationTarget(paths:readonly string[],signal?:AbortSignal):Promise<GitPublicationTargetRead>{
  if(!Array.isArray(paths)||!paths.length||paths.length>100)throw Error('git_intent_invalid');
  const selected=paths.map(path=>{if(typeof path!=='string')throw Error('git_intent_invalid');return safe(path);}).sort();
  const folded=selected.map(path=>path.normalize('NFC').toLowerCase());
  if(new Set(folded).size!==selected.length||folded.some(path=>folded.some(other=>other!==path&&path.startsWith(other+'/'))))throw Error('git_intent_invalid');
  const context=await this.context(signal);try{
   const before=await this.inspectContext(context,signal),attributes=await this.attributeManifest(selected,signal),files:GitPublicationTargetFile[]=[],contents=new Map<string,Buffer>();let size=0;
   for(const path of selected){
    signal?.throwIfAborted();const entry=before.entries.find(row=>row.path===path);
    if(entry?.conflicted||entry?.original_path)throw Error('git_path_unavailable');
    const fact=await this.publicationPath(path,signal);
    if(fact.kind==='missing'){files.push({...fact,sha256:null});continue;}
    const stat=await lstat(join(this.root,path));if(hash(witness(stat))!==fact.stat_sha256)throw Error('git_publication_target_changed');
    const bytes=await this.bytes(join(this.root,path),32*1024*1024,witness(stat));size+=bytes.length;if(size>64*1024*1024)throw Error('git_output_limit');
    signal?.throwIfAborted();if(canonicalJson(await this.publicationPath(path,signal))!==canonicalJson(fact))throw Error('git_publication_target_changed');
    files.push({...fact,sha256:hash(bytes)});contents.set(path,bytes);
   }
   if((await this.inspectContext(context,signal)).snapshot_id!==before.snapshot_id||canonicalJson(await this.attributeManifest(selected,signal))!==canonicalJson(attributes))throw Error('git_snapshot_changed');
   for(const file of files){const {sha256,...fact}=file;if(canonicalJson(await this.publicationPath(file.path,signal))!==canonicalJson(fact))throw Error('git_publication_target_changed');}
   // The last await is followed by another original anchor check. A changed root
   // or metadata context must not leave a successful before-state observation.
   if((await this.anchors(signal)).metadata!==context.metadata)throw Error('git_snapshot_changed');signal?.throwIfAborted();
   const payload={protocol:1 as const,kind:'publication_target' as const,snapshot_id:before.snapshot_id,repository_sha256:before.repository_sha256,head:before.head,index_sha256:context.index,files,attributes,execution_authorized:false as const};
   return{witness:{...payload,target_sha256:hash(canonicalJson(payload))},contents};
  }finally{await context.dispose();}
 }
 /** Exact-byte review only. Never writes source files, index, refs or objects. */
 async freeze(snapshotId:string,paths:readonly string[],signal?:AbortSignal):Promise<GitReviewWitness>{
  if(!/^[a-f0-9]{64}$/.test(snapshotId)||!Array.isArray(paths)||!paths.length||paths.length>5000||new Set(paths).size!==paths.length)throw Error('git_intent_invalid');
  for(const path of paths){if(typeof path!=='string')throw Error('git_intent_invalid');safe(path);}
  const context=await this.context(signal);try{
   const before=await this.inspectContext(context,signal);if(before.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   const attributes=await this.attributeManifest(paths,signal),files:GitReviewWitness['files']=[];let size=0;
   for(const path of [...paths].sort()){
    signal?.throwIfAborted();const entry=before.entries.find(value=>value.path===path);if(!entry||!['file','missing'].includes(entry.kind))throw Error('git_path_unavailable');
    const original=await this.file(path);if(original.kind==='missing'){files.push({path,kind:'missing',sha256:null,size:0,mode:0});continue;}
    if(original.kind!=='file')throw Error('git_path_unavailable');const bytes=await this.bytes(join(this.root,path),32*1024*1024,original.stamp);size+=bytes.length;if(size>64*1024*1024)throw Error('git_output_limit');
    files.push({path,kind:'file',sha256:hash(bytes),size:bytes.length,mode:Number((await lstat(join(this.root,path))).mode&0o777n)});
   }
   if((await this.inspectContext(context,signal)).snapshot_id!==before.snapshot_id||JSON.stringify(await this.attributeManifest(paths,signal))!==JSON.stringify(attributes))throw Error('git_snapshot_changed');
   return{protocol:2,snapshot_id:before.snapshot_id,repository_sha256:before.repository_sha256,head:before.head,index_sha256:context.index,files,attributes};
  }finally{await context.dispose();}
 }
 /** Complete staged-tree proof for the original commit review. It grants no
  * commit effect authority and does not change stage/unstage witness encoding. */
 async freezeCommit(snapshotId:string,paths:readonly string[],signal?:AbortSignal):Promise<GitCommitReviewWitness>{
  const witness=await this.freeze(snapshotId,paths,signal),context=await this.context(signal);
  try{
   if((await this.inspectContext(context,signal)).snapshot_id!==snapshotId||context.index!==witness.index_sha256)throw Error('git_snapshot_changed');
   const commit_tree=await readCommitTree(this.executable!,this.root,context,join(this.commonDirectory,'objects'),this.limits,signal);
   if((await this.inspectContext(context,signal)).snapshot_id!==snapshotId||(await this.anchors(signal)).metadata!==context.metadata)throw Error('git_snapshot_changed');signal?.throwIfAborted();
   return{...witness,commit_tree};
  }finally{await context.dispose();}
 }
 initializationConfigured(){const dot=join(this.root,'.git');return same(this.gitDirectory,dot)&&same(this.commonDirectory,dot);}
 /** Original initialization binding also works during recovery after .git
  * publication. No metadata presence, stored plan or caller path grants access. */
 protected async initializationAnchors(signal?:AbortSignal){
  signal?.throwIfAborted();const root=await this.directory(this.root);
  if(!this.initializationConfigured())throw Error('git_initialization_binding_invalid');
  const executable=await gitExecutable(this.configuredExecutable),program=await lstat(executable);
  if(within(this.root,executable)||!program.isFile()||program.isSymbolicLink())throw Error('git_configuration_invalid');
  const stamp=witness(program);
  if(await this.directory(this.root)!==root||witness(await lstat(executable))!==stamp)throw Error('git_snapshot_changed');
  signal?.throwIfAborted();this.executable=executable;
  return{root,executable,program:stamp,repository:hash(canonicalJson({protocol:1,kind:'initialization_binding',root:this.root,
   git:this.gitDirectory,common:this.commonDirectory,root_identity:root,executable,program:stamp}))};
 }
 /** Initialization reads only the bound root, Git presence and internal-ignore
  * bytes. It never discovers or adopts an ancestor repository. */
 private async initializationSource(signal?:AbortSignal){
  signal?.throwIfAborted();const root=await this.directory(this.root),dot=join(this.root,'.git');
  const present=async()=>{
   try{
    const value=await lstat(dot);
    if(value.isSymbolicLink()||!value.isDirectory()&&!value.isFile())throw Error('git_repository_changed');
    return true;
   }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  };
  if(await present())return{initialized:true as const};
  const anchors=await this.initializationAnchors(signal),{executable}=anchors;
  if(anchors.root!==root)throw Error('git_snapshot_changed');
  const internal=join(this.root,'.pilotdeck');
  const directory=async()=>{
   try{return await this.directory(internal);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  };
  const internalIdentity=await directory(),ignorePath=join(internal,'.gitignore');
  let body:Buffer|null=null,ignore:GitInitializationFile|null=null;
  if(internalIdentity!==null)try{
   const before=await lstat(ignorePath);body=await this.bytes(ignorePath,1024*1024);const after=await lstat(ignorePath);
   if(witness(before)!==witness(after)||before.mode!==after.mode)throw Error('git_snapshot_changed');
   ignore={identity:identity(before),sha256:hash(body),size:body.length,mode:Number(before.mode&0o7777n)};
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;body=null;ignore=null;}
  signal?.throwIfAborted();
  if(await this.directory(this.root)!==root||await directory()!==internalIdentity||await present()
   ||witness(await lstat(executable))!==anchors.program)throw Error('git_snapshot_changed');
  const repository=anchors.repository;
  const source={repository_sha256:repository,root_identity:root,internal_directory_identity:internalIdentity,internal_ignore:ignore};
  return{initialized:false as const,source,snapshot_id:initializationSnapshotId(source),body};
 }
 async initialization(signal?:AbortSignal){
  const source=await this.initializationSource(signal);
  if(source.initialized)return{git_present:true as const,read_only:true as const,execution_authorized:false as const};
  return{git_present:false as const,snapshot_id:source.snapshot_id,repository_sha256:source.source.repository_sha256,
   internal_ignore:{path:'.pilotdeck/.gitignore' as const,sha256:source.source.internal_ignore?.sha256??null,size:source.source.internal_ignore?.size??0},
   read_only:true as const,execution_authorized:false as const};
 }
 private async initializationFileSource(path:string):Promise<{body:Buffer|null;fact:GitInitializationFile|null}>{
  try{
   const parent=await this.directory(dirname(path)),before=await lstat(path),body=await this.bytes(path,1024*1024),after=await lstat(path);
   if(witness(before)!==witness(after)||before.mode!==after.mode||await this.directory(dirname(path))!==parent)throw Error('git_snapshot_changed');
   return{body,fact:{identity:identity(before),sha256:hash(body),size:body.length,mode:Number(before.mode&0o7777n)}};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{body:null,fact:null};throw error;}
 }
 /** Directory modes and missing children are part of the original reinit
  * source, including common metadata on another configured volume. */
 private async reinitializationLayout(signal?:AbortSignal):Promise<GitReinitializationLayout>{
  const directory=async(path:string)=>{
   signal?.throwIfAborted();const id=await this.directory(path),before=await lstat(path);
   if(identity(before)!==id)throw Error('git_snapshot_changed');
   const after=await lstat(path);
   if(identity(after)!==id||before.mode!==after.mode||before.uid!==after.uid||before.gid!==after.gid)throw Error('git_snapshot_changed');
   return{identity:id,mode:Number(after.mode&0o7777n),uid:String(after.uid),gid:String(after.gid)};
  };
  const root=await directory(this.root),git=await directory(this.gitDirectory),common=await directory(this.commonDirectory);
  for(const path of [join(this.gitDirectory,'HEAD.lock'),join(this.gitDirectory,'index.lock'),join(this.commonDirectory,'config.lock'),
   join(this.commonDirectory,'packed-refs.lock'),join(this.root,'.git.jot-init.lock'),join(this.root,'.pilotdeck','.gitignore.lock')]){
   signal?.throwIfAborted();
   try{await lstat(path);throw Error('git_repository_busy');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const directories:GitReinitializationLayout['directories']=[];
  for(const path of ['objects','objects/info','objects/pack','refs','refs/heads','refs/tags']){
   try{directories.push({path,before:await directory(join(this.commonDirectory,path))});}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;directories.push({path,before:null});}
  }
  signal?.throwIfAborted();return{protocol:1,root,git,common,directories};
 }
 /** Freeze existing repository facts through the original sanitized read
  * context. Native reinitialization consumes this distinct protocol later. */
 private async freezeReinitialization(snapshotId:string,initialBranch:string,objectFormat:'sha1'|'sha256',signal?:AbortSignal):Promise<GitInitializationWitness>{
  const context=await this.context(signal,true),internal=join(this.root,'.pilotdeck');
  const internalDirectory=async()=>{
   try{return await this.directory(internal);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  };
  let result:Extract<GitInitializationWitness,{protocol:2}>;
  try{
   const snapshot=await this.inspectContext(context,signal);
   if(snapshot.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   const branch=await readGit(this.executable!,this.root,context.directory,['check-ref-format','refs/heads/'+initialBranch],this.limits,signal);
   if(branch.code!==0)throw Error('git_initialization_branch_invalid');
   const format=await readGit(this.executable!,this.root,context.directory,['rev-parse','--show-object-format'],this.limits,signal);
   if(format.code!==0||text(format.bytes).trim()!==objectFormat)throw Error('git_reinitialization_object_format_changed');
   const root=await this.directory(this.root),git=await this.directory(this.gitDirectory),common=await this.directory(this.commonDirectory);
   const internalIdentity=await internalDirectory(),ignore=await this.initializationFileSource(join(internal,'.gitignore'));
   if(internalIdentity===null&&ignore.fact!==null)throw Error('git_snapshot_changed');
   const dot=join(this.root,'.git'),dotFile=(await lstat(dot)).isFile()?(await this.initializationFileSource(dot)).fact:null;
   const config=await this.initializationFileSource(join(this.commonDirectory,'config'));
   const worktree=await this.initializationFileSource(join(this.gitDirectory,'config.worktree'));
   const planned=initializationInternalIgnore(ignore.body),layout=await this.reinitializationLayout(signal);
   const configuration=await planReinitializationConfiguration({executable:this.executable!,root:this.root,context,commonConfig:config.body,worktreeConfig:worktree.body,
    worktreeConfigEnabled:context.worktreeConfigEnabled===true,objectFormat,limits:this.limits,...(signal?{signal}:{})});
   if((await this.inspectContext(context,signal)).snapshot_id!==snapshotId||await internalDirectory()!==internalIdentity
    ||canonicalJson(await this.reinitializationLayout(signal))!==canonicalJson(layout))throw Error('git_snapshot_changed');
   result={protocol:2,kind:'initialize_repository',snapshot_id:snapshotId,repository_sha256:snapshot.repository_sha256,
    root_identity:root,internal_directory_identity:internalIdentity,internal_ignore:ignore.fact,initial_branch:initialBranch,object_format:objectFormat,
    ignore_after:{sha256:hash(planned.body),size:planned.body.length,changed:planned.changed},
    existing:{source_metadata_sha256:context.metadata,git_directory_identity:git,common_directory_identity:common,dot_file:dotFile,
     head:snapshot.head,common_config:config.fact,worktree_config:worktree.fact,worktree_config_enabled:context.worktreeConfigEnabled===true,configuration:configuration.review,layout},execution_authorized:false};
  }finally{await context.dispose();}
  const anchors=await this.anchors(signal),ignore=await this.initializationFileSource(join(internal,'.gitignore'));
  if(anchors.repository!==result.repository_sha256||anchors.metadata!==result.existing.source_metadata_sha256
   ||await this.directory(this.root)!==result.root_identity||await this.directory(this.gitDirectory)!==result.existing.git_directory_identity
   ||await this.directory(this.commonDirectory)!==result.existing.common_directory_identity||await internalDirectory()!==result.internal_directory_identity
   ||canonicalJson(ignore.fact)!==canonicalJson(result.internal_ignore))throw Error('git_snapshot_changed');
  const dot=join(this.root,'.git'),dotFile=(await lstat(dot)).isFile()?(await this.initializationFileSource(dot)).fact:null;
  if(canonicalJson(dotFile)!==canonicalJson(result.existing.dot_file))throw Error('git_snapshot_changed');
  if(canonicalJson(await this.reinitializationLayout(signal))!==canonicalJson(result.existing.layout))throw Error('git_snapshot_changed');
  const final=await this.anchors(signal);
  if(final.repository!==result.repository_sha256||final.metadata!==result.existing.source_metadata_sha256)throw Error('git_snapshot_changed');
  signal?.throwIfAborted();return result;
 }
 async freezeInitialization(snapshotId:string,initialBranch:string,objectFormat:'sha1'|'sha256',signal?:AbortSignal):Promise<GitInitializationWitness>{
  normalizeGitInitializationReview({request_id:'initialization-source',action:'init',snapshot_id:snapshotId,initial_branch:initialBranch,object_format:objectFormat});
  const before=await this.initializationSource(signal);
  if(before.initialized)return this.freezeReinitialization(snapshotId,initialBranch,objectFormat,signal);
  if(before.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
  const checked=await readGit(this.executable!,this.root,this.gitDirectory,['check-ref-format','refs/heads/'+initialBranch],this.limits,signal);
  if(checked.code!==0)throw Error('git_initialization_branch_invalid');
  const after=await this.initializationSource(signal);
  if(after.initialized||after.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
  const planned=initializationInternalIgnore(before.body);
  signal?.throwIfAborted();
  return{protocol:1,kind:'initialize_repository',snapshot_id:snapshotId,...before.source,initial_branch:initialBranch,object_format:objectFormat,
   ignore_after:{sha256:hash(planned.body),size:planned.body.length,changed:planned.changed},execution_authorized:false};
 }
 /** Frozen original facts for creating and switching to a branch at HEAD. */
 async freezeCreateBranch(snapshotId:string,branch:string,signal?:AbortSignal):Promise<GitCreateBranchWitness>{
  const target='refs/heads/'+branch;
  if(typeof branch!=='string'||branch.startsWith('-')||!validGitReference(target))throw Error('git_branch_invalid');
  const inventory=await this.branches(snapshotId,signal),folded=target.normalize('NFC').toLowerCase();
  for(const entry of inventory.branches){
   if(entry.kind!=='local')continue;
   const ref=entry.ref.normalize('NFC').toLowerCase();
   if(ref===folded||ref.startsWith(folded+'/')||folded.startsWith(ref+'/'))throw Error('git_branch_exists');
  }
  const context=await this.context(signal,true);let result:GitCreateBranchWitness;
  try{
   const checked=await readGit(this.executable!,this.root,context.directory,['check-ref-format','--branch',branch],this.limits,signal,join(this.commonDirectory,'objects'));
   if(checked.code!==0)throw Error('git_branch_invalid');
   const snapshot=await this.inspectContext(context,signal);
   if(snapshot.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   const log=async(path:string):Promise<GitBranchLogFile>=>{
    try{await this.directory(dirname(path));const bytes=await this.bytes(path,32*1024*1024);return{sha256:hash(bytes),size:bytes.length};}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{sha256:null,size:0};throw error;}
   };
   const headLog=await log(join(this.gitDirectory,'logs','HEAD')),branchLog=await log(join(this.commonDirectory,'logs',target));
   if(!context.branchLogPolicy)throw Error('git_branch_log_policy_invalid');
   const configuration=async(path:string)=>{
    try{await this.directory(dirname(path));return await this.bytes(path,1024*1024);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
   };
   const commonConfig=await configuration(join(this.commonDirectory,'config'));
   const worktreeConfig=context.worktreeConfigEnabled?await configuration(join(this.gitDirectory,'config.worktree')):null;
   const planned=await planCreateBranchConfiguration({executable:this.executable!,context,sourceObjects:join(this.commonDirectory,'objects'),
    branch,targetOid:snapshot.head.oid,commonConfig,worktreeConfig,limits:this.limits,...(signal?{signal}:{})});
   if((await this.inspectContext(context,signal)).snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   result={protocol:2,kind:'create_branch',snapshot_id:snapshotId,repository_sha256:snapshot.repository_sha256,
    source_metadata_sha256:context.metadata,index_sha256:context.index,object_format:inventory.object_format,
    head:snapshot.head,branch,target_ref:target,target_oid:snapshot.head.oid,reflog:{...context.branchLogPolicy,head:headLog,branch:branchLog},
    configuration:{before_sha256:planned.before===null?null:hash(planned.before),after_sha256:planned.after===null?null:hash(planned.after),changed:planned.changed},execution_authorized:false};
  }finally{await context.dispose();}
  const after=await this.anchors(signal);
  if(after.repository!==result.repository_sha256||after.metadata!==result.source_metadata_sha256)throw Error('git_snapshot_changed');
  signal?.throwIfAborted();return result;
 }
 /** Read registered metadata without opening another worktree's checkout path. */
 protected async branchWorktreeUses(context:ReadContext,branches:GitBranchInventory['branches'],oidPattern:RegExp,signal?:AbortSignal){
  type Use=NonNullable<GitBranchInventory['branches'][number]['worktree_uses']>[number];
  const uses=new Map<string,Use[]>(),listed=new Set(branches.filter(branch=>branch.kind==='local').map(branch=>branch.ref));let total=0;
  const optional=async(path:string,max=4096)=>{
   signal?.throwIfAborted();try{const body=await this.bytes(path,max);total+=body.length;if(total>8*1024*1024)throw Error('git_metadata_limit');return body;}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  };
  const present=async(path:string,directory=false)=>{
   signal?.throwIfAborted();try{
    const fact=await lstat(path);
    if(fact.isSymbolicLink()||(directory?!fact.isDirectory():!fact.isFile()||fact.nlink!==1n))throw Error('git_branches_unavailable');
    if(directory)await this.directory(path);return true;
   }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  };
  const symbolicTarget=(value:string)=>{
   const match=/^ref:\s*(refs\/[^\s]+)\s*$/.exec(value);
   if(!match||!validGitReference(match[1]))throw Error('git_branches_unavailable');return match[1]!;
  };
  const resolveHead=async(value:string,directory:string)=>{
   if(oidPattern.test(value.trim().toLowerCase()))return null;
   let ref=symbolicTarget(value);const seen=new Set<string>();
   for(let depth=0;depth<5;depth++){
    if(seen.has(ref))throw Error('git_branches_unavailable');seen.add(ref);
    const root=/^refs\/(?:bisect|worktree|rewritten)\//.test(ref)?directory:this.commonDirectory;
    const body=await optional(join(root,ref));
    if(body===null)return ref;
    const raw=text(body);
    if(oidPattern.test(raw.trim().toLowerCase()))return ref;
    ref=symbolicTarget(raw);
   }
   throw Error('git_branches_unavailable');
  };
  const record=(ref:string,worktree:Use['worktree'],reason:Use['reason'])=>{
   if(!validGitReference(ref))throw Error('git_branches_unavailable');
   if(!listed.has(ref))return;
   const list=uses.get(ref)??[];
   if(!list.some(item=>item.worktree===worktree&&item.reason===reason))list.push({worktree,reason});
   uses.set(ref,list);
  };
  const branchName=(body:Buffer|null)=>{
   if(body===null)return null;
   const value=text(body).replace(/\n+$/,'');
   if(!value||value==='detached HEAD'||oidPattern.test(value.toLowerCase()))return null;
   return value.startsWith('refs/heads/')?value:'refs/heads/'+value;
  };
  const current=await this.directory(this.gitDirectory);
  const collect=async(directory:string)=>{
   const identity=await this.directory(directory),worktree:Use['worktree']=identity===current?'current':'other';
   const head=await optional(join(directory,'HEAD'));
   if(head===null)throw Error('git_branches_unavailable');
   const ref=await resolveHead(text(head),directory);if(ref)record(ref,worktree,'head');
   let rebase:string|null=null;
   if(await present(join(directory,'rebase-apply'),true)){
    if(!await present(join(directory,'rebase-apply','applying')))rebase='rebase-apply';
   }else if(await present(join(directory,'rebase-merge'),true))rebase='rebase-merge';
   if(rebase){const branch=branchName(await optional(join(directory,rebase,'head-name')));if(branch)record(branch,worktree,'rebase');}
   if(await present(join(directory,'BISECT_LOG'))){const branch=branchName(await optional(join(directory,'BISECT_START')));if(branch)record(branch,worktree,'bisect');}
   if(await present(join(directory,'rebase-merge'),true)){
    const body=await optional(join(directory,'rebase-merge','update-refs'),1024*1024);
    if(body?.length){
     const rows=text(body).replace(/\n$/,'').split('\n').map(row=>row.replace(/\r$/,''));
     if(rows.length%3||rows.length/3>this.limits.maxEntries)throw Error('git_branches_unavailable');
     for(let index=0;index<rows.length;index+=3){
      if(!oidPattern.test(rows[index+1]!.toLowerCase())||!oidPattern.test(rows[index+2]!.toLowerCase()))throw Error('git_branches_unavailable');
      record(rows[index]!,worktree,'update_refs');
     }
    }
   }
   if(await this.directory(directory)!==identity)throw Error('git_snapshot_changed');
  };
  const common=await this.directory(this.commonDirectory);
  const configuredBare=async(path:string)=>{
   if(await optional(path,1024*1024)===null)return undefined;
   const result=await this.run(context,['config','--file',path,'--no-includes','--type=bool','--get','core.bare'],signal,true);
   if(result.code===1)return undefined;
   const value=text(result.bytes).trim();if(value!=='true'&&value!=='false')throw Error('git_configuration_invalid');return value==='true';
  };
  const commonBare=await configuredBare(join(this.commonDirectory,'config'));
  const currentBare=context.worktreeConfigEnabled?await configuredBare(join(this.gitDirectory,'config.worktree')):undefined;
  // Git also checks the main worktree's own bare flag when reading from a linked worktree.
  const mainBare=common!==current?await configuredBare(join(this.commonDirectory,'config.worktree')):undefined;
  if(!(currentBare??commonBare??false)&&mainBare!==true)await collect(this.commonDirectory);
  const registry=join(this.commonDirectory,'worktrees');
  if(await present(registry,true)){
   let count=0;
   for await(const entry of await opendir(registry)){
    signal?.throwIfAborted();if(++count>this.limits.maxEntries)throw Error('git_entry_limit');
    if(!entry.isDirectory())continue;
    const directory=join(registry,entry.name);await this.directory(directory);
    const registered=await optional(join(directory,'gitdir'));
    if(registered===null||registered.length===0)continue;
    await collect(directory);
   }
  }
  for(const branch of branches)if(branch.kind==='local')branch.worktree_uses=(uses.get(branch.ref)??[]).sort((a,b)=>(a.worktree+'-'+a.reason).localeCompare(b.worktree+'-'+b.reason));
 }
 async branches(snapshotId:string,signal?:AbortSignal):Promise<Omit<GitBranchInventory,'project_id'>>{
  if(typeof snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(snapshotId))throw Error('git_branches_invalid');
  const context=await this.context(signal);
  try{
   const snapshot=await this.inspectContext(context,signal);
   if(snapshot.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   const format=text((await this.run(context,['rev-parse','--show-object-format'],signal)).bytes).trim();
   if(format!=='sha1'&&format!=='sha256')throw Error('git_branches_unavailable');
   const raw=text((await this.run(context,['for-each-ref','--sort=refname','--count='+String(this.limits.maxEntries+1),
    '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00','refs/heads/','refs/remotes/'],signal)).bytes);
   const branches:GitBranchInventory['branches']=[],seen=new Set<string>(),oidPattern=new RegExp('^[a-f0-9]{'+(format==='sha1'?40:64)+'}$');
   for(const row of raw.split('\n')){
    if(!row)continue;
    const parts=row.split('\0');
    if(parts.length!==5||parts[4]!=='')throw Error('git_branches_unavailable');
    const ref=parts[0]!,oid=parts[1]!,objectType=parts[2]!,symbolic=parts[3]!;
    if(!validGitReference(ref)||seen.has(ref)||!oidPattern.test(oid)
     ||!['commit','tag','tree','blob'].includes(objectType)||symbolic!==''&&!validGitReference(symbolic))throw Error('git_branches_unavailable');
    const kind=ref.startsWith('refs/heads/')?'local':ref.startsWith('refs/remotes/')?'remote':undefined;
    if(!kind)throw Error('git_branches_unavailable');
    if(branches.length>=this.limits.maxEntries)throw Error('git_entry_limit');
    seen.add(ref);
    branches.push({ref,name:ref.slice(kind==='local'?'refs/heads/'.length:'refs/remotes/'.length),kind,oid,object_type:objectType as 'commit'|'tag'|'tree'|'blob',
     current:kind==='local'&&!snapshot.head.detached&&ref==='refs/heads/'+snapshot.head.branch,...(symbolic?{symbolic_target:symbolic}:{})});
   }
   if(branches.length){
    const expressions=branches.map(branch=>branch.oid+'^{commit}');
    const result=await readGit(this.executable!,this.root,context.directory,['cat-file','--batch-check=%(objectname) %(objecttype)'],
     this.limits,signal,join(this.commonDirectory,'objects'),Buffer.from(expressions.join('\n')+'\n','utf8'));
    if(result.code!==0)throw Error('git_branches_unavailable');
    const output=text(result.bytes);
    if(!output.endsWith('\n'))throw Error('git_branches_unavailable');
    const rows=output.slice(0,-1).split('\n');
    if(rows.length!==branches.length)throw Error('git_branches_unavailable');
    for(const [index,branch] of branches.entries()){
     const row=rows[index]!;
     if(row===expressions[index]+' missing'){
      if(branch.object_type==='commit')throw Error('git_branches_unavailable');
      branch.checkout_oid=null;continue;
     }
     const fields=row.split(' ');
     if(fields.length!==2||!oidPattern.test(fields[0]!)||fields[1]!=='commit'
      ||branch.object_type==='commit'&&fields[0]!==branch.oid)throw Error('git_branches_unavailable');
     branch.checkout_oid=fields[0]!;
    }
   }
   await this.branchWorktreeUses(context,branches,oidPattern,signal);
   if((await this.inspectContext(context,signal)).snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   if((await this.anchors(signal)).metadata!==context.metadata)throw Error('git_snapshot_changed');
   signal?.throwIfAborted();
   return {snapshot_id:snapshotId,repository_sha256:snapshot.repository_sha256,head:snapshot.head,object_format:format,branches,read_only:true,execution_authorized:false};
  }finally{await context.dispose();}
 }
 async diff(input:{snapshot_id:string;path:string;stage:'working'|'staged'},signal?:AbortSignal):Promise<GitDiff>{
  if(!input||!/^[a-f0-9]{64}$/.test(input.snapshot_id)||!['working','staged'].includes(input.stage))throw Error('git_diff_invalid');safe(input.path);
  const context=await this.context(signal);try{const before=await this.inspectContext(context,signal);if(before.snapshot_id!==input.snapshot_id)throw Error('git_snapshot_changed');const entry=before.entries.find(row=>row.path===input.path);if(!entry||!['file','missing'].includes(entry.kind))throw Error('git_path_unavailable');
  let bytes:Buffer;
  if(entry.index_status==='?'&&entry.worktree_status==='?'){
   if(input.stage==='staged')bytes=Buffer.alloc(0);else{const file=await this.file(entry.path),source=await this.bytes(join(this.root,entry.path),this.limits.maxDiffBytes,file.stamp);
    try{const content=text(source),lines=content?(content.endsWith('\n')?content.slice(0,-1):content).split('\n'):[],mode=(await lstat(join(this.root,entry.path))).mode&0o111n?'100755':'100644';
     bytes=source.includes(0)?Buffer.from([0]):Buffer.from('diff --git a/'+entry.path+' b/'+entry.path+'\nnew file mode '+mode+'\n--- /dev/null\n+++ b/'+entry.path+'\n'+(lines.length?'@@ -0,0 +1,'+lines.length+' @@\n'+lines.map(line=>'+'+line).join('\n')+'\n'+(content.endsWith('\n')?'':'\\ No newline at end of file\n'):''));
    }catch{bytes=Buffer.from([0]);}}
  }else bytes=(await this.run(context,['diff',...(input.stage==='staged'?['--cached']:[]),'--no-ext-diff','--no-textconv','--no-color','--no-renames','--src-prefix=a/','--dst-prefix=b/','--',...(entry.original_path?[entry.original_path]:[]),entry.path],signal)).bytes;
  if(bytes.length>this.limits.maxDiffBytes)throw Error('git_output_limit');let patch='',binary=bytes.includes(0);if(!binary)try{patch=text(bytes);binary=/^Binary files .* differ$/m.test(patch)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(patch);}catch{binary=true;}
  const after=await this.inspectContext(context,signal);if(after.snapshot_id!==before.snapshot_id)throw Error('git_snapshot_changed');
  return{snapshot_id:before.snapshot_id,path:entry.path,stage:input.stage,kind:binary?'binary':'text',patch:binary?'':patch,read_only:true,execution_authorized:false};
  }finally{await context.dispose();}
 }
}
