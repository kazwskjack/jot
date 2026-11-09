import {createHash} from 'node:crypto';
import {mkdir,writeFile,lstat,chmod,chown} from 'node:fs/promises';
import {join} from 'node:path';
import type {GitCheckoutCreation,GitCheckoutReferenceSource} from '../../contracts/types.ts';
import type {GitReadContext} from './inspection.ts';
import {renderGitConfiguration} from './branch-configuration.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readGit,type GitProcessLimits} from './process.ts';

/** Observe private native creation permissions without touching source metadata. */
export async function readCheckoutCreation(options:{executable:string;root:string;context:GitReadContext;source:GitCheckoutReferenceSource;
 oid:string|null;objectFormat:'sha1'|'sha256';sourceObjects:string;limits:GitProcessLimits;signal?:AbortSignal}):Promise<GitCheckoutCreation>{
 const {source,context,signal}=options;signal?.throwIfAborted();
 if(source.head_log.sha256!==null||!source.log_policy.enabled)return{state:'not_required'};
 if(process.platform==='win32')return{state:'not_confirmed',reason:'platform_policy_required'};
 if(!source.layout||!options.oid)return{state:'not_confirmed',reason:'native_policy_required'};
 const stage=join(context.directory,'checkout-creation'),logs=join(stage,'logs'),umask=process.umask();
 await mkdir(stage,{mode:0o700});const initial=await lstat(stage,{bigint:true});
 const current=async(checkAbort=true)=>{
  if(checkAbort)signal?.throwIfAborted();const value=await lstat(stage,{bigint:true});
  if(!value.isDirectory()||value.isSymbolicLink()||value.dev!==initial.dev||value.ino!==initial.ino)throw Error('git_snapshot_changed');
 };
 const seed=async(path:string,fact:{mode:number;gid:string})=>{
  await current();const before=await lstat(path,{bigint:true});
  if(String(before.gid)!==fact.gid){
   const gid=Number(fact.gid);if(!Number.isSafeInteger(gid)||gid<0||gid>=0xffffffff)throw Error('git_checkout_creation_owner_required');
   await chown(path,-1,gid);
  }
  await chmod(path,fact.mode);await current();
  const after=await lstat(path,{bigint:true});
  if(Number(after.mode&0o7777n)!==fact.mode||String(after.gid)!==fact.gid)throw Error('git_checkout_creation_owner_required');
 };
 const directory=source.layout.parents.find(parent=>parent.scope==='git'&&parent.path==='logs')?.before??null;
 try{
  await mkdir(join(stage,'objects'),{mode:0o700});await mkdir(join(stage,'refs'),{mode:0o700});
  await writeFile(join(stage,'HEAD'),'ref: refs/heads/jot-permission-preview\n',{flag:'wx',mode:0o600});
  const base=options.objectFormat==='sha256'?'[core]\n repositoryformatversion = 1\n bare = false\n[extensions]\n objectformat = sha256\n':'[core]\n repositoryformatversion = 0\n bare = false\n';
  const shared=context.branchSharedRepository;
  await writeFile(join(stage,'config'),base+(shared?renderGitConfiguration([{key:'core.sharedrepository',value:shared.value}]):''),{flag:'wx',mode:0o600});
  if(directory){await mkdir(logs,{mode:0o700});await seed(logs,directory);}
  await seed(stage,source.layout.git);await current();
  const result=await readGit(options.executable,options.root,stage,['-c','core.logAllRefUpdates=true','-c','user.name=Jot permission preview',
   '-c','user.email=jot-permission-preview@localhost','update-ref','--create-reflog','--no-deref','-m','jot permission preview','HEAD',options.oid],
   options.limits,signal,join(stage,'objects'),undefined,options.sourceObjects);
  await current();
  if(result.code!==0)return{state:'not_confirmed',reason:'native_policy_required'};
  const file=await lstat(join(logs,'HEAD'),{bigint:true}),parent=await lstat(logs,{bigint:true});
  if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1n||file.size===0n||!parent.isDirectory()||parent.isSymbolicLink())throw Error('git_checkout_evidence_invalid');
  if(directory&&(Number(parent.mode&0o7777n)!==directory.mode||String(parent.gid)!==directory.gid))return{state:'not_confirmed',reason:'native_policy_required'};
  if(process.umask()!==umask)throw Error('git_snapshot_changed');
  const fact=(value:typeof file)=>({mode:Number(value.mode&0o7777n),uid:String(value.uid),gid:String(value.gid)});
  const policy_sha256=createHash('sha256').update(canonicalJson({shared:shared??null,umask,git:source.layout.git,logs:directory})).digest('hex');
  return{state:'observed',file:fact(file),directory:{created:directory===null,...(directory?{mode:directory.mode,uid:directory.uid,gid:directory.gid}:fact(parent))},umask,policy_sha256};
 }catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(['EPERM','EACCES','ENOSYS'].includes(code??'')||(error instanceof Error&&error.message==='git_checkout_creation_owner_required'))return{state:'not_confirmed',reason:'owner_policy_required'};
  throw error;
 }finally{
  await current(false);await chmod(stage,0o700);
  try{const value=await lstat(logs);if(!value.isDirectory()||value.isSymbolicLink())throw Error('git_snapshot_changed');await chmod(logs,0o700);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
}
