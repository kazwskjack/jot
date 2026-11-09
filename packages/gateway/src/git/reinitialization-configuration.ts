import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink,readdir,lstat,realpath,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import type {GitReadContext} from './inspection.ts';
import {initializationDirectories} from './initialization-evidence.ts';
import type {GitReinitializationConfiguration,GitReinitializationLayout} from '../../contracts/types.ts';
import {readGit,type GitProcessLimits} from './process.ts';
import {withReinitializationAllocation} from './reinitialization-allocation.ts';
import {renderGitConfiguration,type GitConfigurationEntry} from './branch-configuration.ts';

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const text=(value:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(value);
const inputKey=(key:string)=>key.startsWith('extensions.')||['core.repositoryformatversion','core.filemode','core.bare',
 'core.logallrefupdates','core.sharedrepository','core.hidedotfiles','core.worktree','init.defaultsubmodulepathconfig'].includes(key);
const outputKey=(key:string)=>key.startsWith('extensions.')||['core.repositoryformatversion','core.filemode','core.bare',
 'core.logallrefupdates','core.sharedrepository','receive.denynonfastforwards'].includes(key);
const values=(entries:readonly GitConfigurationEntry[],key:string)=>entries.filter(entry=>entry.key===key).map(entry=>entry.value);
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

/** Fixed private init/config operations produce both reviewable filemode outcomes.
 * Native publication must repeat this inside its original same-volume allocation. */
export async function planReinitializationConfiguration(options:{
 executable:string;root:string;context:Pick<GitReadContext,'directory'>;commonConfig:Buffer|null;worktreeConfig:Buffer|null;
 worktreeConfigEnabled:boolean;objectFormat:'sha1'|'sha256';limits:GitProcessLimits;signal?:AbortSignal;
 layout?:GitReinitializationLayout;
 authority?:{authorize:()=>void;cleanup:(remove:()=>void)=>void};
}){
 const {executable,root,context:sourceContext,commonConfig,worktreeConfig,worktreeConfigEnabled,objectFormat,limits,signal}=options;
 const authority=options.authority??{authorize:()=>{},cleanup:(remove:()=>void)=>remove()};
 const originalDirectory=await lstat(sourceContext.directory,{bigint:true});
 if(!originalDirectory.isDirectory()||originalDirectory.isSymbolicLink())throw Error('git_repository_changed');
 const context={directory:await realpath(sourceContext.directory)};
 const parent=await lstat(context.directory,{bigint:true}),parentIdentity=parent.dev+':'+parent.ino;
 if(parentIdentity!==originalDirectory.dev+':'+originalDirectory.ino)throw Error('git_repository_changed');
 return withReinitializationAllocation({parent:context.directory,parent_identity:parentIdentity,scope:'private',
  authority:{authorize:authority.authorize,prepared:record=>{
   if(record.scope!=='private'||record.parent_identity!==parentIdentity)throw Error('git_reinitialization_allocation_invalid');
  },cleanup:authority.cleanup},...(signal?{signal}:{})},async(allocation,assertCurrent)=>{
  const active=join(context.directory,'config'),activeWorktree=join(context.directory,'config.worktree');
  const common=join(allocation,'common.config'),worktree=join(allocation,'worktree.config');
  const targets=[join(allocation,'false.config'),join(allocation,'true.config')],templates=join(allocation,'templates');
  const optional=async(path:string)=>{try{return await readFile(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  const original=await readFile(active),originalWorktree=await optional(activeWorktree);
  const run=async(args:string[],codes:readonly number[]=[0])=>{
   assertCurrent();const result=await readGit(executable,root,context.directory,args,limits,signal);assertCurrent();
   if(!codes.includes(result.code))throw Error('git_reinitialization_configuration_unavailable');return result.bytes;
  };
  const list=async(path:string):Promise<GitConfigurationEntry[]>=>{
   const value=text(await run(['config','--file',path,'--no-includes','--null','--list']));
   if(value&&!value.endsWith('\0'))throw Error('git_reinitialization_configuration_invalid');
   return value.split('\0').filter(Boolean).map(entry=>{const at=entry.indexOf('\n');return{key:at<0?entry:entry.slice(0,at),value:at<0?null:entry.slice(at+1)}});
  };
  const create=async(path:string,body:Buffer|string)=>{assertCurrent();await writeFile(path,body,{flag:'wx',mode:0o600});assertCurrent()};
  const metadata=async()=>{
   const result:Array<{path:string;sha256:string}>=[];let count=0,total=0;
   const visit=async(path:string)=>{
    signal?.throwIfAborted();if(++count>100000)throw Error('git_metadata_limit');
    const full=join(context.directory,path),stat=await lstat(full);
    if(stat.isSymbolicLink())throw Error('git_reinitialization_configuration_invalid');
    if(stat.isDirectory()){for(const name of (await readdir(full)).sort())await visit(path+'/'+name);return;}
    if(!stat.isFile()||stat.size>32*1024*1024)throw Error('git_metadata_limit');
    total+=stat.size;if(total>64*1024*1024)throw Error('git_metadata_limit');
    result.push({path,sha256:hash(await readFile(full))});
   };
   for(const name of (await readdir(context.directory)).sort())if(['HEAD','index','packed-refs','shallow','refs'].includes(name)||/^sharedindex\.[a-f0-9]+$/.test(name))await visit(name);
   return result;
  };
  const directories=new Map<string,string>([[context.directory,parentIdentity]]);
  const assertDirectories=async()=>{
   assertCurrent();
   await Promise.all([...directories].map(async([path,id])=>{
    const stat=await lstat(path,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev+':'+stat.ino!==id)throw Error('git_repository_changed');
   }));
   assertCurrent();
  };
  const directoryModes=async()=>{
   await assertDirectories();
   const modes=await Promise.all(initializationDirectories.map(async path=>{
    const stat=await lstat(path?join(context.directory,path):context.directory,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('git_repository_changed');
    return{path,mode:Number(stat.mode&0o7777n)};
   }));
   await assertDirectories();return modes;
  };
  if(options.layout){
   const layout=options.layout;
   for(const path of initializationDirectories){
    await assertDirectories();
    const full=path?join(context.directory,path):context.directory;
    const before=path?layout.directories.find(directory=>directory.path===path)!.before:layout.common;
    if(path){
     try{await mkdir(full,{mode:0o777});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    }
    const stat=await lstat(full,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('git_repository_changed');
    directories.set(full,stat.dev+':'+stat.ino);
    if(before)await chmod(full,before.mode);
    await assertDirectories();
   }
  }
  assertCurrent();const beforeMetadata=await metadata();assertCurrent();
  try{
   await create(common,commonConfig??Buffer.alloc(0));await create(worktree,worktreeConfig??Buffer.alloc(0));
   const entries=await list(common),worktreeEntries=await list(worktree);
   const selected=entries.filter(entry=>inputKey(entry.key));
   await writeFile(active,renderGitConfiguration(selected));
   if(!equal(await list(active),selected))throw Error('git_reinitialization_configuration_invalid');
   if(worktreeConfigEnabled){
    const selectedWorktree=worktreeEntries.filter(entry=>inputKey(entry.key));
    await writeFile(activeWorktree,renderGitConfiguration(selectedWorktree),{flag:originalWorktree===null?'wx':'w',mode:0o600});
    if(!equal(await list(activeWorktree),selectedWorktree))throw Error('git_reinitialization_configuration_invalid');
   }else if(originalWorktree!==null)await unlink(activeWorktree);
   await mkdir(templates,{mode:0o700});
   const before=await list(active);
   await assertDirectories();
   await run(['-c','init.defaultRefFormat=files','init','--quiet','--template='+templates,'--object-format='+objectFormat]);
   await assertDirectories();
   const projectedModes=options.layout?await directoryModes():undefined;
   if(!equal(await metadata(),beforeMetadata))throw Error('git_reinitialization_metadata_changed');
   const after=await list(active),effectiveWorktree=await optional(activeWorktree);
   if(worktreeConfigEnabled&&!equal(effectiveWorktree,Buffer.from(renderGitConfiguration(worktreeEntries.filter(entry=>inputKey(entry.key))),'utf8')))
    throw Error('git_reinitialization_configuration_invalid');
   const keys=[...new Set([...before,...after].map(entry=>entry.key))];
   const changed=keys.filter(key=>!equal(values(before,key),values(after,key)));
   if(changed.some(key=>key!=='core.worktree'&&!outputKey(key)))throw Error('git_reinitialization_configuration_invalid');
   if(!['true','false'].includes(values(after,'core.filemode').at(-1)??'')||values(after,'core.bare').at(-1)!=='false')throw Error('git_reinitialization_configuration_invalid');
   // The disposable Git directory introduces a worktree setting. Preserve
   // the bound repository's original worktree configuration.
   const edits=changed.filter(key=>key!=='core.worktree'&&key!=='core.filemode');
   await writeFile(active,original);
   if(originalWorktree===null){if(await optional(activeWorktree)!==null)await unlink(activeWorktree);}else await writeFile(activeWorktree,originalWorktree);
   const alternatives:Buffer[]=[];
   for(const [index,filemode] of ['false','true'].entries()){
    const target=targets[index]!;await create(target,commonConfig??Buffer.alloc(0));
    for(const key of [...edits,'core.filemode']){
     await run(['config','--file',target,'--no-includes','--unset-all',key],[0,5]);
     const replacements=key==='core.filemode'?[filemode]:values(after,key);
     for(const value of replacements){
      if(value===null)throw Error('git_reinitialization_configuration_invalid');
      await run(['config','--file',target,'--no-includes','--add',key,value]);
     }
    }
    const result=await list(target),untouched=(items:readonly GitConfigurationEntry[])=>items.filter(entry=>!edits.includes(entry.key)&&entry.key!=='core.filemode');
    if(!equal(untouched(result),untouched(entries)))throw Error('git_reinitialization_configuration_invalid');
    for(const key of edits)if(!equal(values(result,key),values(after,key)))throw Error('git_reinitialization_configuration_invalid');
    if(!equal(values(result,'core.filemode'),[filemode]))throw Error('git_reinitialization_configuration_invalid');
    const body=await readFile(target);
    if(body.length>1024*1024)throw Error('git_reinitialization_configuration_limit');
    alternatives.push(body);
   }
   if(!equal(await metadata(),beforeMetadata))throw Error('git_reinitialization_metadata_changed');
   if(projectedModes&&!equal(await directoryModes(),projectedModes))throw Error('git_reinitialization_metadata_changed');
   const review:GitReinitializationConfiguration={protocol:1,before_sha256:commonConfig===null?null:hash(commonConfig),
    filemode_false_sha256:hash(alternatives[0]!),filemode_true_sha256:hash(alternatives[1]!),
    worktree_sha256:worktreeConfig===null?null:hash(worktreeConfig)};
   return{review,filemode_false:alternatives[0]!,filemode_true:alternatives[1]!,observed_filemode:values(after,'core.filemode').at(-1)==='true',...(projectedModes?{directory_modes:projectedModes}:{})};
  }finally{
   await writeFile(active,original);
   if(originalWorktree===null){if(await optional(activeWorktree)!==null)await unlink(activeWorktree);}else await writeFile(activeWorktree,originalWorktree);
  }
 });
}
