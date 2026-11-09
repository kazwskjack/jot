import {createHash} from 'node:crypto';
import {gitCommitEvidence,type GitCommitEvidence} from './commit-evidence.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';

export type GitCommitRefFile={
 scope:'git'|'common';path:string;
 before:{identity:string;sha256:string;stat_sha256:string;size:number;mode:number}|null;
 pending:string;identity:string;sha256:string;size:number;mode:number;
};
export type GitCommitRefPreparation={
 protocol:1;evidence:GitCommitEvidence;
 files:GitCommitRefFile[];
 locks:Array<{scope:'git'|'common';path:string;pending:string;identity:string;sha256:string}>;
 parents:Array<{scope:'git'|'common';path:string;identity:string}>;
 metadata_sha256:string;
};
export type GitCommitRefReceipt={
 protocol:1;plan_id:string;action:'commit';target_ref:string;old_oid:string|null;new_oid:string;tree_oid:string;
 preparation_sha256:string;
 logs:Array<{scope:'git'|'common';path:string;before_sha256:string|null;sha256:string}>;
 execution_authorized:false;
};
const SHA=/^[a-f0-9]{64}$/,ID=/^[0-9]+:[0-9]+$/;
const shape=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const scratch=(value:unknown)=>typeof value==='string'&&/^jot-commit-ref-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/.test(value);
const identity=(value:unknown)=>typeof value==='string'&&ID.test(value);
const digest=(value:unknown)=>typeof value==='string'&&SHA.test(value);
const mode=(value:unknown)=>Number.isInteger(value)&&Number(value)>=0&&Number(value)<=0o777;
const size=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=32*1024*1024;

/** Original execution-owned effect journal only. Never an API command or a
 * reconstructed writable plan. Published refs/logs are never cleanup targets. */
export function gitCommitRefPreparation(value:unknown):GitCommitRefPreparation{
 try{
  const p=value as GitCommitRefPreparation;
  if(!shape(p,['protocol','evidence','files','locks','parents','metadata_sha256'])||p.protocol!==1||!digest(p.metadata_sha256))throw Error();
  const evidence=gitCommitEvidence(p.evidence),plan=evidence.plan;
  const targets=[{scope:'git',path:'logs/HEAD'},...(evidence.refs.ref?[{scope:'common',path:'logs/'+evidence.refs.ref}]:[]),{scope:evidence.refs.ref?'common':'git',path:plan.target_ref}];
  if(!Array.isArray(p.files)||p.files.length!==targets.length)throw Error();
  const names=new Set<string>(),identities=new Set<string>();let total=0;
  for(const [index,file] of p.files.entries()){
   const target=targets[index]!;
   if(!shape(file,['scope','path','before','pending','identity','sha256','size','mode'])||file.scope!==target.scope||file.path!==target.path
    ||!scratch(file.pending)||!identity(file.identity)||!digest(file.sha256)||!size(file.size)||!mode(file.mode)
    ||names.has(file.pending)||identities.has(file.identity))throw Error();
   names.add(file.pending);identities.add(file.identity);total+=file.size;
   if(file.before!==null&&(!shape(file.before,['identity','sha256','stat_sha256','size','mode'])||!identity(file.before.identity)
    ||!digest(file.before.sha256)||!digest(file.before.stat_sha256)||!size(file.before.size)||!mode(file.before.mode)))throw Error();
   if(index===p.files.length-1){
    if(file.sha256!==hash(plan.commit_oid+'\n')||file.size!==plan.commit_oid.length+1)throw Error();
    const expected=evidence.refs.ref?evidence.refs.branch_sha256:evidence.refs.head_sha256;
    if((file.before?.sha256??null)!==expected)throw Error();
   }else if(file.size<1||file.size<=(file.before?.size??0))throw Error();
  }
  if(total>64*1024*1024+65)throw Error();
  if(!Array.isArray(p.locks)||p.locks.length!==targets.length-1)throw Error();
  for(const [index,lock] of p.locks.entries()){
   const target=targets[index]!;
   if(!shape(lock,['scope','path','pending','identity','sha256'])||lock.scope!==target.scope||lock.path!==target.path+'.lock'
    ||!scratch(lock.pending)||!identity(lock.identity)||lock.sha256!==hash('')||names.has(lock.pending)||identities.has(lock.identity))throw Error();
   names.add(lock.pending);identities.add(lock.identity);
  }
  if(!Array.isArray(p.parents)||p.parents.length>1024||new Set(p.parents.map(parent=>parent.scope+':'+parent.path)).size!==p.parents.length)throw Error();
  for(const parent of p.parents){
   if(!shape(parent,['scope','path','identity'])||!['git','common'].includes(parent.scope)||typeof parent.path!=='string'
    ||workspaceRelativePath(parent.path)!==parent.path||!(parent.path==='logs'||parent.path.startsWith('logs/'))||!identity(parent.identity)
    ||!targets.some(target=>target.scope===parent.scope&&target.path.startsWith(parent.path+'/')))throw Error();
  }
  return {protocol:1,evidence,files:structuredClone(p.files),locks:structuredClone(p.locks),parents:structuredClone(p.parents),metadata_sha256:p.metadata_sha256};
 }catch{throw Error('git_commit_ref_preparation_invalid');}
}
