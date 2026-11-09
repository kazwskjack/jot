import {createHash} from 'node:crypto';
import type {GitInitializationWitness,GitInitializationFile} from '../../contracts/types.ts';
import {gitInitializationWitness} from './initialization-records.ts';

export type GitInitializationPlan=Readonly<{
 protocol:1;plan_id:string;action:'init';witness:GitInitializationWitness;source_sha256:string;review_sha256:string;execution_authorized:false;
}>;
export type GitInitializationPreparation={
 protocol:1;plan:GitInitializationPlan;allocation:{name:string;identity:string};
 root_lock:GitInitializationFile;ignore_lock:GitInitializationFile|null;
};
export type GitInitializationEvidence={
 protocol:1;preparation:GitInitializationPreparation;
 directories:Array<{path:string;identity:string;mode:number}>;
 files:Array<GitInitializationFile&{path:'config'|'HEAD'}>;
 ignore:GitInitializationFile|null;
};
export const initializationDirectories=['','objects','objects/info','objects/pack','refs','refs/heads','refs/tags'] as const;
export const initializationRootLock='.git.jot-init.lock';
const SHA=/^[a-f0-9]{64}$/,IDENTITY=/^[0-9]+:[0-9]+$/;
const shape=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const mode=(value:unknown,maximum=0o777)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=maximum;
const identity=(value:unknown)=>typeof value==='string'&&IDENTITY.test(value);
function file(value:GitInitializationFile){
 return shape(value,['identity','sha256','size','mode'])&&identity(value.identity)&&typeof value.sha256==='string'&&SHA.test(value.sha256)
  &&Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=1024*1024&&mode(value.mode);
}
/** Serialized facts are read/recovery input. Only the in-process plan identity
 * retained by the original kernel can enter a writable attempt. */
export function gitInitializationPlan(value:unknown):GitInitializationPlan{
 try{
  const plan=value as GitInitializationPlan;
  if(!shape(plan,['protocol','plan_id','action','witness','source_sha256','review_sha256','execution_authorized'])||plan.protocol!==1||plan.action!=='init'
   ||plan.execution_authorized!==false||typeof plan.plan_id!=='string'
   ||!/^git-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(plan.plan_id))throw Error();
  const witness=gitInitializationWitness(plan.witness);
  if(plan.source_sha256!==hash(JSON.stringify(witness))||plan.review_sha256!==hash(JSON.stringify({action:'init',witness})))throw Error();
  return structuredClone(plan);
 }catch{throw Error('git_initialization_plan_invalid');}
}
export function gitInitializationPreparation(value:unknown):GitInitializationPreparation{
 try{
  const preparation=value as GitInitializationPreparation;
  if(!shape(preparation,['protocol','plan','allocation','root_lock','ignore_lock'])||preparation.protocol!==1)throw Error();
  const plan=gitInitializationPlan(preparation.plan),{allocation,root_lock:root,ignore_lock:ignore}=preparation;
  if(!shape(allocation,['name','identity'])||typeof allocation.name!=='string'
   ||!/^\.git\.jot-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/.test(allocation.name)
   ||!identity(allocation.identity)||!file(root)||root.sha256!==hash('')||root.size!==0)throw Error();
  if(plan.witness.ignore_after.changed?(ignore===null||!file(ignore)||ignore.sha256!==hash('')||ignore.size!==0||ignore.identity===root.identity):ignore!==null)throw Error();
  return structuredClone(preparation);
 }catch{throw Error('git_initialization_preparation_invalid');}
}
export function gitInitializationEvidence(value:unknown):GitInitializationEvidence{
 try{
  const evidence=value as GitInitializationEvidence;
  if(!shape(evidence,['protocol','preparation','directories','files','ignore'])||evidence.protocol!==1)throw Error();
  const preparation=gitInitializationPreparation(evidence.preparation),{witness}=preparation.plan;
  if(!Array.isArray(evidence.directories)||evidence.directories.length!==initializationDirectories.length||!Array.isArray(evidence.files)||evidence.files.length!==2)throw Error();
  const identities=new Set([preparation.allocation.identity,preparation.root_lock.identity,...(preparation.ignore_lock?[preparation.ignore_lock.identity]:[])]);
  for(const [index,directory] of evidence.directories.entries()){
   if(!shape(directory,['path','identity','mode'])||directory.path!==initializationDirectories[index]||!identity(directory.identity)||!mode(directory.mode,0o7777)||identities.has(directory.identity))throw Error();
   identities.add(directory.identity);
  }
  for(const [index,item] of evidence.files.entries()){
   if(!shape(item,['path','identity','sha256','size','mode'])||item.path!==['config','HEAD'][index])throw Error();
   const {path,...fact}=item;
   if(!file(fact)||identities.has(fact.identity)||fact.size<1)throw Error();
   identities.add(fact.identity);
   if(path==='HEAD'&&(fact.sha256!==hash('ref: refs/heads/'+witness.initial_branch+'\n')||fact.size!==Buffer.byteLength('ref: refs/heads/'+witness.initial_branch+'\n','utf8')))throw Error();
  }
  const ignore=evidence.ignore;
  if(witness.ignore_after.changed?(ignore===null||!file(ignore)||ignore.sha256!==witness.ignore_after.sha256||ignore.size!==witness.ignore_after.size||identities.has(ignore.identity)):ignore!==null)throw Error();
  return structuredClone(evidence);
 }catch{throw Error('git_initialization_evidence_invalid');}
}
