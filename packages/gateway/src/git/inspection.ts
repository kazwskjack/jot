import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath,readdir,mkdir,mkdtemp,writeFile,rm,utimes} from 'node:fs/promises';
import {isAbsolute,resolve,join,dirname,relative,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {gitExecutable,readGit} from './process.ts';

export type GitInspectionOptions={root:string;gitDirectory?:string;commonDirectory?:string;executable?:string;limits?:Partial<{maxOutputBytes:number;timeoutMs:number;maxEntries:number;maxMetadataEntries:number;maxDiffBytes:number}>};
export type GitEntry={path:string;original_path?:string;index_status:string;worktree_status:string;conflicted:boolean;kind:'file'|'directory'|'symlink'|'missing'|'other'};
export type GitRemote={name:string;kind:'https'|'ssh'|'local'|'other';host?:string};
export type GitSnapshot={snapshot_id:string;repository_sha256:string;head:{oid:string|null;branch:string|null;detached:boolean};entries:GitEntry[];remotes:GitRemote[];omitted_count:number;read_only:true;execution_authorized:false};
export type GitDiff={snapshot_id:string;path:string;stage:'working'|'staged';kind:'text'|'binary';patch:string;read_only:true;execution_authorized:false};
export type GitReviewWitness={protocol:2;snapshot_id:string;repository_sha256:string;head:GitSnapshot['head'];index_sha256:string|null;files:Array<{path:string;kind:'file'|'missing';sha256:string|null;size:number;mode:number}>;attributes:Array<{path:string;sha256:string|null}>};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root:string,path:string)=>same(root,path)||same(root+sep,path.slice(0,root.length+1));
const text=(value:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(value);
const identity=(s:Awaited<ReturnType<typeof lstat>>)=>[String(s.dev),String(s.ino)].join(':');
const witness=(s:Awaited<ReturnType<typeof lstat>>)=>[identity(s),String(s.size),String(s.mtimeMs),String(s.ctimeMs),String(s.nlink)].join(':');
const safe=(path:string)=>{if(path.startsWith('-'))throw Error('git_path_unavailable');return workspaceRelativePath(path);};
export type GitReadContext={directory:string;metadata:string;index:string|null;remotes:GitRemote[];dispose():Promise<void>};
type ReadContext=GitReadContext;

/** Operator-bound, read-only physical repository. No caller-controlled root,
 * generic command, write intent, inference, credential or execution authority. */
export class GitRepositoryInspection{
 protected readonly root:string;protected readonly gitDirectory:string;protected readonly commonDirectory:string;
 private readonly limits={maxOutputBytes:2*1024*1024,timeoutMs:5000,maxEntries:5000,maxMetadataEntries:100000,maxDiffBytes:256*1024};
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
 private async metadata(signal?:AbortSignal){
  const facts:string[]=[];let count=0;
  for(const root of [...new Set([this.gitDirectory,this.commonDirectory])]){const queue=[root];while(queue.length){signal?.throwIfAborted();const directory=queue.pop()!;
   for(const item of await readdir(directory,{withFileTypes:true})){signal?.throwIfAborted();if(++count>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');const path=join(directory,item.name),s=await lstat(path);
    if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile())throw Error('git_repository_changed');
    if(s.isDirectory())queue.push(path);else if(path===join(this.commonDirectory,'objects','info','alternates')&&s.size)throw Error('git_metadata_unavailable');
    facts.push(path+':'+witness(s));
   }
  }}return hash(facts.sort().join('\n'));
 }
 protected async anchors(signal?:AbortSignal){
  signal?.throwIfAborted();const directories=await Promise.all([this.directory(this.root),this.directory(this.gitDirectory),this.directory(this.commonDirectory)]);
  const dot=join(this.root,'.git'),entry=await lstat(dot);if(entry.isSymbolicLink())throw Error('git_repository_changed');
  if(entry.isFile()){
   const bytes=await this.bytes(dot,4096);const value=text(bytes).trim();if(!value.startsWith('gitdir: ')||!same(resolve(this.root,value.slice(8)),this.gitDirectory))throw Error('git_repository_changed');
  }else if(!entry.isDirectory()||!same(dot,this.gitDirectory))throw Error('git_repository_changed');
  let common=this.gitDirectory;try{common=resolve(this.gitDirectory,text(await this.bytes(join(this.gitDirectory,'commondir'),4096)).trim());}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(!same(common,this.commonDirectory))throw Error('git_repository_changed');
  const executable=this.executable??await gitExecutable(this.configuredExecutable);if(within(this.root,executable))throw Error('git_configuration_invalid');
  const facts=hash(JSON.stringify({root:this.root,git:this.gitDirectory,common:this.commonDirectory,directories,executable,program:witness(await lstat(executable))}));
  if(this.binding!==undefined&&facts!==this.binding)throw Error('git_repository_changed');this.binding=facts;this.executable=executable;
  return{repository:hash(facts),metadata:await this.metadata(signal)};
 }
 protected async bytes(path:string,max:number,expected?:string){
  const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max||expected!==undefined&&witness(before)!==expected)throw Error('git_path_unavailable');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
   if(witness(await file.stat())!==witness(before))throw Error('git_snapshot_changed');const bytes=await file.readFile();
   if(bytes.length>max||witness(await file.stat())!==witness(before)||witness(await lstat(path))!==witness(before))throw Error('git_snapshot_changed');return bytes;
  }finally{await file.close();}
 }
 protected async run(context:ReadContext,args:string[],signal?:AbortSignal,allowMissing=false){
  const result=await readGit(this.executable!,this.root,context.directory,args,this.limits,signal,join(this.commonDirectory,'objects'));
  if(result.code!==0&&!(allowMissing&&result.code===1))throw Error('git_read_unavailable');return result;
 }
 /** Private disposable read-copy, never an execution target or another Git
  * authority. Source config/hooks/filters are not loaded by Git operations. */
 protected async context(signal?:AbortSignal):Promise<ReadContext>{
  const before=await this.anchors(signal),scratchBase=resolve(tmpdir()),directory=await mkdtemp(join(scratchBase,'jot-git-read-'));
  const context:ReadContext={directory,metadata:before.metadata,index:null,remotes:[],dispose:async()=>{if(!within(scratchBase,directory)||same(scratchBase,directory)||(await lstat(directory)).isSymbolicLink())throw Error('git_cleanup_unavailable');await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}};
  try{
   await mkdir(join(directory,'objects'));await mkdir(join(directory,'refs'));await writeFile(join(directory,'HEAD'),'ref: refs/heads/main\n');await writeFile(join(directory,'config'),'[core]\n repositoryformatversion = 0\n bare = false\n');
   const settings=new Map<string,string>();
   for(const path of [join(this.commonDirectory,'config'),join(this.gitDirectory,'config.worktree')]){
    if(path.endsWith('config.worktree')&&!['true','yes','on','1'].includes(settings.get('extensions.worktreeconfig')??''))continue;
    signal?.throwIfAborted();try{await this.bytes(path,1024*1024);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const configured=await this.run(context,['config','--file',path,'--no-includes','--null','--list'],signal);
    for(const item of text(configured.bytes).split('\0')){const at=item.indexOf('\n');if(at<0)continue;settings.set(item.slice(0,at),item.slice(at+1));}
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
    if(source===join(this.gitDirectory,'index')||/^sharedindex\.[a-f0-9]+$/.test(basename(source)))await utimes(target,original.atimeMs/1000,original.mtimeMs/1000);
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
   else return{kind:s.isSymbolicLink()?'symlink':s.isFile()&&s.nlink===1?'file':s.isDirectory()?'directory':'other',stamp:witness(s)};
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
 private async attributeManifest(paths:readonly string[],signal?:AbortSignal):Promise<GitReviewWitness['attributes']>{
  const names=new Set<string>();for(const path of paths){const parts=path.split('/');parts.pop();while(true){names.add([...parts,'.gitattributes'].join('/'));if(names.size>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');if(!parts.length)break;parts.pop();}}
  if(names.size>this.limits.maxMetadataEntries)throw Error('git_metadata_limit');const result:GitReviewWitness['attributes']=[];let size=0;
  for(const path of [...names].sort()){signal?.throwIfAborted();const fact=await this.file(path);if(fact.kind==='missing'){result.push({path,sha256:null});continue;}if(fact.kind!=='file')throw Error('git_path_unavailable');const bytes=await this.bytes(join(this.root,path),1024*1024,fact.stamp);size+=bytes.length;if(size>4*1024*1024)throw Error('git_metadata_limit');result.push({path,sha256:hash(bytes)});}
  return result;
 }
 /** Exact-byte review only. Never writes source files, index, refs or objects. */
 async freeze(snapshotId:string,paths:readonly string[],signal?:AbortSignal):Promise<GitReviewWitness>{
  if(!/^[a-f0-9]{64}$/.test(snapshotId)||!Array.isArray(paths)||!paths.length||paths.length>100||new Set(paths).size!==paths.length)throw Error('git_intent_invalid');
  for(const path of paths){if(typeof path!=='string')throw Error('git_intent_invalid');safe(path);}
  const context=await this.context(signal);try{
   const before=await this.inspectContext(context,signal);if(before.snapshot_id!==snapshotId)throw Error('git_snapshot_changed');
   const attributes=await this.attributeManifest(paths,signal),files:GitReviewWitness['files']=[];let size=0;
   for(const path of [...paths].sort()){
    signal?.throwIfAborted();const entry=before.entries.find(value=>value.path===path);if(!entry||!['file','missing'].includes(entry.kind))throw Error('git_path_unavailable');
    const original=await this.file(path);if(original.kind==='missing'){files.push({path,kind:'missing',sha256:null,size:0,mode:0});continue;}
    if(original.kind!=='file')throw Error('git_path_unavailable');const bytes=await this.bytes(join(this.root,path),32*1024*1024,original.stamp);size+=bytes.length;if(size>64*1024*1024)throw Error('git_output_limit');
    files.push({path,kind:'file',sha256:hash(bytes),size:bytes.length,mode:(await lstat(join(this.root,path))).mode&0o777});
   }
   if((await this.inspectContext(context,signal)).snapshot_id!==before.snapshot_id||JSON.stringify(await this.attributeManifest(paths,signal))!==JSON.stringify(attributes))throw Error('git_snapshot_changed');
   return{protocol:2,snapshot_id:before.snapshot_id,repository_sha256:before.repository_sha256,head:before.head,index_sha256:context.index,files,attributes};
  }finally{await context.dispose();}
 }
 async diff(input:{snapshot_id:string;path:string;stage:'working'|'staged'},signal?:AbortSignal):Promise<GitDiff>{
  if(!input||!/^[a-f0-9]{64}$/.test(input.snapshot_id)||!['working','staged'].includes(input.stage))throw Error('git_diff_invalid');safe(input.path);
  const context=await this.context(signal);try{const before=await this.inspectContext(context,signal);if(before.snapshot_id!==input.snapshot_id)throw Error('git_snapshot_changed');const entry=before.entries.find(row=>row.path===input.path);if(!entry||!['file','missing'].includes(entry.kind))throw Error('git_path_unavailable');
  let bytes:Buffer;
  if(entry.index_status==='?'&&entry.worktree_status==='?'){
   if(input.stage==='staged')bytes=Buffer.alloc(0);else{const file=await this.file(entry.path),source=await this.bytes(join(this.root,entry.path),this.limits.maxDiffBytes,file.stamp);
    try{const content=text(source),lines=content?(content.endsWith('\n')?content.slice(0,-1):content).split('\n'):[],mode=(await lstat(join(this.root,entry.path))).mode&0o111?'100755':'100644';
     bytes=source.includes(0)?Buffer.from([0]):Buffer.from('diff --git a/'+entry.path+' b/'+entry.path+'\nnew file mode '+mode+'\n--- /dev/null\n+++ b/'+entry.path+'\n'+(lines.length?'@@ -0,0 +1,'+lines.length+' @@\n'+lines.map(line=>'+'+line).join('\n')+'\n'+(content.endsWith('\n')?'':'\\ No newline at end of file\n'):''));
    }catch{bytes=Buffer.from([0]);}}
  }else bytes=(await this.run(context,['diff',...(input.stage==='staged'?['--cached']:[]),'--no-ext-diff','--no-textconv','--no-color','--no-renames','--src-prefix=a/','--dst-prefix=b/','--',...(entry.original_path?[entry.original_path]:[]),entry.path],signal)).bytes;
  if(bytes.length>this.limits.maxDiffBytes)throw Error('git_output_limit');let patch='',binary=bytes.includes(0);if(!binary)try{patch=text(bytes);binary=/^Binary files .* differ$/m.test(patch)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(patch);}catch{binary=true;}
  const after=await this.inspectContext(context,signal);if(after.snapshot_id!==before.snapshot_id)throw Error('git_snapshot_changed');
  return{snapshot_id:before.snapshot_id,path:entry.path,stage:input.stage,kind:binary?'binary':'text',patch:binary?'':patch,read_only:true,execution_authorized:false};
  }finally{await context.dispose();}
 }
}
