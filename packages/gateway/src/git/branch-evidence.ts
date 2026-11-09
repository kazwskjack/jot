import {createHash} from 'node:crypto';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {validGitReference} from './references.ts';

export type GitBranchPlan=Readonly<{
 protocol:1;plan_id:string;action:'create-branch';branch:string;target_ref:string;target_oid:string|null;source_ref:string|null;
 repository_sha256:string;source_sha256:string;review_sha256:string;metadata_sha256:string;index_sha256:string|null;
 object_format:'sha1'|'sha256';configuration_changed:boolean;logs:Readonly<{head:boolean;branch:boolean}>;execution_authorized:false;
}>;
export type GitBranchFileFact={identity:string;sha256:string;size:number;mode:number};
export type GitBranchFile={scope:'git'|'common';path:string;before:GitBranchFileFact|null;after:GitBranchFileFact};
export type GitBranchLock={scope:'git'|'common';path:string;pending:string;identity:string;sha256:string;size:number;mode:number};
export type GitBranchPreparation={
 protocol:1;plan:GitBranchPlan;directories:{root:string;git:string;common:string;objects:string};dot_witness:string;
 metadata_sha256:string;source_files:Array<{scope:'git'|'common';path:string;before:GitBranchFileFact|null}>;
 files:GitBranchFile[];locks:GitBranchLock[];parents:Array<{scope:'git'|'common';path:string;identity:string}>;
};
const SHA=/^[a-f0-9]{64}$/,IDENTITY=/^[0-9]+:[0-9]+$/;
const shape=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
const digest=(value:unknown)=>typeof value==='string'&&SHA.test(value);
const nullableDigest=(value:unknown)=>value===null||digest(value);
const emptyHash=createHash('sha256').update('').digest('hex');
const fileFact=(value:GitBranchFileFact)=>shape(value,['identity','sha256','size','mode'])&&typeof value.identity==='string'&&IDENTITY.test(value.identity)
 &&digest(value.sha256)&&Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=32*1024*1024
 &&Number.isSafeInteger(value.mode)&&value.mode>=0&&value.mode<=0o777;
const ref=(value:unknown)=>typeof value==='string'&&value.startsWith('refs/heads/')&&workspaceRelativePath(value)===value&&validGitReference(value);
export function gitBranchFileLayout(plan:GitBranchPlan){
 return [
  ...(plan.configuration_changed?[{scope:'common' as const,path:'config'}]:[]),
  ...(plan.logs.branch?[{scope:'common' as const,path:'logs/'+plan.target_ref}]:[]),
  ...(plan.logs.head?[{scope:'git' as const,path:'logs/HEAD'}]:[]),
  ...(plan.target_oid!==null?[{scope:'common' as const,path:plan.target_ref}]:[]),
  {scope:'git' as const,path:'HEAD'},
 ];
}
export function gitBranchLockLayout(plan:GitBranchPlan){
 const files=gitBranchFileLayout(plan);
 return [{scope:'git' as const,path:'index.lock'},{scope:'common' as const,path:'packed-refs.lock'},
  ...(plan.source_ref?[{scope:'common' as const,path:plan.source_ref+'.lock'}]:[]),
  ...(plan.target_oid===null?[{scope:'common' as const,path:plan.target_ref+'.lock'}]:[]),
  ...files.map(file=>({scope:file.scope,path:file.path+'.lock'}))];
}

/** Durable observation and cleanup facts only. Writable buffers stay in the
 * original kernel's private identity map. */
export function gitBranchPreparation(value:unknown):GitBranchPreparation{
 try{
  const e=value as GitBranchPreparation,p=e?.plan;
  if(!shape(e,['protocol','plan','directories','dot_witness','metadata_sha256','source_files','files','locks','parents'])||e.protocol!==1
   ||!shape(p,['protocol','plan_id','action','branch','target_ref','target_oid','source_ref','repository_sha256','source_sha256','review_sha256','metadata_sha256','index_sha256','object_format','configuration_changed','logs','execution_authorized'])
   ||p.protocol!==1||p.action!=='create-branch'||p.execution_authorized!==false||typeof p.plan_id!=='string'
   ||!/^git-branch-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.plan_id)
   ||typeof p.branch!=='string'||p.branch.startsWith('-')||p.target_ref!=='refs/heads/'+p.branch||!ref(p.target_ref)
   ||p.source_ref!==null&&(!ref(p.source_ref)||p.source_ref===p.target_ref)||!['sha1','sha256'].includes(p.object_format)
   ||typeof p.configuration_changed!=='boolean'||!shape(p.logs,['head','branch'])||typeof p.logs.head!=='boolean'||typeof p.logs.branch!=='boolean')throw Error();
  for(const hash of [p.repository_sha256,p.source_sha256,p.review_sha256,p.metadata_sha256,e.metadata_sha256])if(!digest(hash))throw Error();
  if(!nullableDigest(p.index_sha256)||p.target_oid!==null&&(typeof p.target_oid!=='string'||!new RegExp('^[a-f0-9]{'+(p.object_format==='sha1'?40:64)+'}$').test(p.target_oid))
   ||p.target_oid===null&&(p.source_ref===null||p.configuration_changed||p.logs.head||p.logs.branch))throw Error();
  if(!shape(e.directories,['root','git','common','objects'])||Object.values(e.directories).some(id=>typeof id!=='string'||!IDENTITY.test(id))
   ||typeof e.dot_witness!=='string'||!/^directory:[0-9]+:[0-9]+$|^file:[a-f0-9]{64}$/.test(e.dot_witness))throw Error();
  const source=[{scope:'git',path:'index'},{scope:'common',path:'packed-refs'},...(p.source_ref?[{scope:'common',path:p.source_ref}]:[])];
  if(!Array.isArray(e.source_files)||e.source_files.length!==source.length)throw Error();
  for(const [i,file] of e.source_files.entries()){
   if(!shape(file,['scope','path','before'])||file.scope!==source[i]!.scope||file.path!==source[i]!.path||file.before!==null&&!fileFact(file.before))throw Error();
  }
  if((e.source_files[0]!.before?.sha256??null)!==p.index_sha256)throw Error();
  const layout=gitBranchFileLayout(p),locks=gitBranchLockLayout(p);
  if(!Array.isArray(e.files)||e.files.length!==layout.length||!Array.isArray(e.locks)||e.locks.length!==locks.length)throw Error();
  for(const [i,file] of e.files.entries()){
   if(!shape(file,['scope','path','before','after'])||file.scope!==layout[i]!.scope||file.path!==layout[i]!.path
    ||file.before!==null&&!fileFact(file.before)||!fileFact(file.after)||file.path===p.target_ref&&file.before!==null
    ||file.path==='HEAD'&&file.before===null||file.path==='config'&&file.after.size>1024*1024)throw Error();
  }
  const names=new Set<string>(),identities=new Set<string>();
  for(const [i,lock] of e.locks.entries()){
   if(!shape(lock,['scope','path','pending','identity','sha256','size','mode'])||lock.scope!==locks[i]!.scope||lock.path!==locks[i]!.path
    ||typeof lock.pending!=='string'||!/^jot-branch-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/.test(lock.pending)
    ||names.has(lock.pending)||identities.has(lock.identity)||!fileFact({identity:lock.identity,sha256:lock.sha256,size:lock.size,mode:lock.mode}))throw Error();
   names.add(lock.pending);identities.add(lock.identity);
   const file=e.files.find(file=>file.scope===lock.scope&&file.path+'.lock'===lock.path);
   if(file?JSON.stringify(file.after)!==JSON.stringify({identity:lock.identity,sha256:lock.sha256,size:lock.size,mode:lock.mode}):lock.sha256!==emptyHash||lock.size!==0)throw Error();
  }
  if(!Array.isArray(e.parents)||e.parents.length>1024)throw Error();
  const parents=new Set<string>();
  for(const parent of e.parents){
   if(!shape(parent,['scope','path','identity'])||!['git','common'].includes(parent.scope)||typeof parent.path!=='string'||workspaceRelativePath(parent.path)!==parent.path
    ||typeof parent.identity!=='string'||!IDENTITY.test(parent.identity)||parents.has(parent.scope+':'+parent.path)
    ||!locks.some(lock=>lock.scope===parent.scope&&lock.path.startsWith(parent.path+'/')))throw Error();
   parents.add(parent.scope+':'+parent.path);
  }
  return structuredClone(e);
 }catch{throw Error('git_branch_preparation_invalid');}
}
