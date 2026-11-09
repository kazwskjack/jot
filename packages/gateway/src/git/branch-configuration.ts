import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {GitReadContext} from './inspection.ts';
import {readGit,type GitProcessLimits} from './process.ts';

export type GitConfigurationEntry={key:string;value:string|null};
type Entry=GitConfigurationEntry;
const text=(value:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(value);
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const relevant=(key:string)=>['branch.autosetupmerge','branch.autosetuprebase'].includes(key)
 ||key.startsWith('branch.')&&/\.(remote|merge|rebase)$/.test(key)
 ||key.startsWith('remote.')&&key.endsWith('.fetch');
const quoted=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\t','\\t').replaceAll('\b','\\b')+'"';
export function renderGitConfiguration(entries:readonly GitConfigurationEntry[]){
 return entries.map(({key,value})=>{
  const first=key.indexOf('.'),last=key.lastIndexOf('.'),section=key.slice(0,first),name=key.slice(last+1);
  const subsection=first===last?'':' '+quoted(key.slice(first+1,last));
  return '['+section+subsection+']\n '+name+(value===null?'':' = '+quoted(value))+'\n';
 }).join('');
}

/** Fixed private branch/config operations derive the original automatic tracking
 * changes. Source working files, config, refs, logs and objects are read-only. */
export async function planCreateBranchConfiguration(options:{
 executable:string;context:GitReadContext;sourceObjects:string;branch:string;targetOid:string|null;
 commonConfig:Buffer|null;worktreeConfig:Buffer|null;limits:GitProcessLimits;signal?:AbortSignal;
}){
 const {executable,context,sourceObjects,branch,targetOid,commonConfig,worktreeConfig,limits,signal}=options;
 const unchanged=()=>({before:commonConfig,after:commonConfig,changed:false});
 signal?.throwIfAborted();
 const root=join(context.directory,'jot-branch-worktree');await mkdir(root,{mode:0o700});
 const run=async(args:string[],allowed:readonly number[]=[0])=>{
  const result=await readGit(executable,root,context.directory,args,limits,signal,join(context.directory,'objects'),undefined,sourceObjects);
  if(!allowed.includes(result.code))throw Error('git_branch_configuration_unavailable');return result.bytes;
 };
 const list=async(path:string):Promise<Entry[]>=>{
  const bytes=await run(['config','--file',path,'--no-includes','--null','--list']),value=text(bytes);
  if(value&&!value.endsWith('\0'))throw Error('git_branch_configuration_invalid');
  return value.split('\0').filter(Boolean).map(item=>{
   const at=item.indexOf('\n');return{key:at<0?item:item.slice(0,at),value:at<0?null:item.slice(at+1)};
  });
 };
 const source=join(context.directory,'jot-branch-source.config');
 await writeFile(source,commonConfig??Buffer.alloc(0),{flag:'wx',mode:0o600});
 const commonEntries=(await list(source)).filter(entry=>relevant(entry.key));
 const active=join(context.directory,'config'),base=await readFile(active),refPath=join(context.directory,'refs','heads',branch);
 let privateWorktreeCreated=false,refCreated=false;
 try{
  await writeFile(active,Buffer.concat([base,Buffer.from('\n'+renderGitConfiguration(commonEntries),'utf8')]));
  if(JSON.stringify((await list(active)).filter(entry=>relevant(entry.key)))!==JSON.stringify(commonEntries))throw Error('git_branch_configuration_invalid');
  if(worktreeConfig!==null){
   const worktree=join(context.directory,'jot-branch-worktree-source.config');
   await writeFile(worktree,worktreeConfig,{flag:'wx',mode:0o600});
   const entries=(await list(worktree)).filter(entry=>relevant(entry.key));
   const privateWorktree=join(context.directory,'config.worktree');
   await writeFile(privateWorktree,renderGitConfiguration(entries),{flag:'wx',mode:0o600});privateWorktreeCreated=true;
   if(JSON.stringify(await list(privateWorktree))!==JSON.stringify(entries))throw Error('git_branch_configuration_invalid');
   await run(['config','--file',active,'--no-includes','--add','extensions.worktreeconfig','true']);
  }
  if(targetOid===null){await run(['branch','--list']);signal?.throwIfAborted();return unchanged();}
  const before=await list(active),prefix='branch.'+branch+'.',keys=['remote','merge','rebase'].map(key=>prefix+key);
  const object=await run(['cat-file','commit','HEAD']);
  if(createHash(targetOid.length===64?'sha256':'sha1').update('commit '+object.length+'\0').update(object).digest('hex')!==targetOid)throw Error('git_branch_configuration_invalid');
  await run(['-c','core.logAllRefUpdates=false','branch','--',branch,'HEAD']);refCreated=true;
  const ref=await readFile(refPath);
  if(!ref.equals(Buffer.from(targetOid+'\n','ascii')))throw Error('git_branch_configuration_invalid');
  const after=await list(active),other=(entries:readonly Entry[])=>entries.filter(entry=>!keys.includes(entry.key));
  if(JSON.stringify(other(before))!==JSON.stringify(other(after)))throw Error('git_branch_configuration_invalid');
  const values=(entries:readonly Entry[],key:string)=>entries.filter(entry=>entry.key===key).map(entry=>entry.value);
  const changed=keys.filter(key=>JSON.stringify(values(before,key))!==JSON.stringify(values(after,key)));
  if(!changed.length)return unchanged();
  for(const key of changed){
   await run(['config','--file',source,'--no-includes','--unset-all',key],[0,5]);
   for(const value of values(after,key)){
    if(value===null)throw Error('git_branch_configuration_invalid');
    await run(['config','--file',source,'--no-includes','--add','--',key,value]);
   }
  }
  const output=await readFile(source);
  if(output.length>1024*1024)throw Error('git_branch_configuration_limit');
  signal?.throwIfAborted();
  return{before:commonConfig,after:output,changed:commonConfig===null||hash(commonConfig)!==hash(output)};
 }finally{
  await writeFile(active,base);
  if(privateWorktreeCreated)await unlink(join(context.directory,'config.worktree'));
  if(refCreated)await unlink(refPath);
 }
}
