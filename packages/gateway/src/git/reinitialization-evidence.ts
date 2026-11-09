import {canonicalJson} from '../db/canonical-json.ts';
import {createHash} from 'node:crypto';
import type {GitInitializationWitness,GitInitializationFile,GitReinitializationDirectory} from '../../contracts/types.ts';
import {gitInitializationWitness} from './initialization-records.ts';
import {isGitInitializationFile,initializationDirectories} from './initialization-evidence.ts';
import {reinitializationAllocation,type GitReinitializationAllocation} from './reinitialization-allocation.ts';

export type GitReinitializationPlan=Readonly<{
 protocol:2;plan_id:string;action:'init';witness:Extract<GitInitializationWitness,{protocol:2}>;
 source_sha256:string;review_sha256:string;execution_authorized:false;
}>;
export type GitReinitializationPreparation={
 protocol:2;plan:GitReinitializationPlan;allocation:GitReinitializationAllocation;
};
export type GitReinitializationRefPreparation={
 protocol:2;preparation:GitReinitializationPreparation;allocation:GitReinitializationAllocation;
 configuration:{filemode:boolean;file:GitInitializationFile};config_lock:GitInitializationFile;
};
export type GitReinitializationEvidence={
 protocol:2;preparation:GitReinitializationPreparation;ref_preparation:GitReinitializationRefPreparation|null;
 configuration:GitReinitializationRefPreparation['configuration'];config_lock:GitInitializationFile;
 ignore:GitInitializationFile|null;ignore_lock:GitInitializationFile|null;directory_modes?:Array<{path:string;mode:number}>;immutable_metadata_sha256?:string;file_groups?:{configuration:string;ignore:string|null};ignore_in_place?:{uid:string;gid:string};
};
export type GitReinitializationReceipt={
 protocol:2;plan_id:string;action:'init';evidence_sha256:string;
 directories:Array<GitReinitializationDirectory&{path:string}>;internal_directory:GitReinitializationDirectory;execution_authorized:false;
};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const shape=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');

/** Persisted facts supply observation and cleanup input, never write authority. */
export function gitReinitializationPlan(value:unknown):GitReinitializationPlan{
 try{
  const plan=value as GitReinitializationPlan;
  if(!shape(plan,['protocol','plan_id','action','witness','source_sha256','review_sha256','execution_authorized'])
   ||plan.protocol!==2||plan.action!=='init'||plan.execution_authorized!==false||typeof plan.plan_id!=='string'
   ||!/^git-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(plan.plan_id))throw Error();
  const witness=gitInitializationWitness(plan.witness);
  if(witness.protocol!==2||!witness.existing.configuration||!witness.existing.layout
   ||plan.source_sha256!==hash(JSON.stringify(witness))||plan.review_sha256!==hash(JSON.stringify({action:'init',witness})))throw Error();
  return structuredClone(plan);
 }catch{throw Error('git_reinitialization_plan_invalid');}
}
/** Original preparation is persisted before any child or process work. */
export function gitReinitializationPreparation(value:unknown):GitReinitializationPreparation{
 try{
  const preparation=value as GitReinitializationPreparation;
  if(!shape(preparation,['protocol','plan','allocation'])||preparation.protocol!==2)throw Error();
  const plan=gitReinitializationPlan(preparation.plan),allocation=reinitializationAllocation(preparation.allocation);
  const {witness}=plan,existing=witness.existing;
  if(allocation.scope!=='common'||allocation.parent_identity!==existing.common_directory_identity
   ||[witness.root_identity,existing.git_directory_identity,witness.internal_directory_identity,
    ...existing.layout!.directories.map(directory=>directory.before?.identity)].includes(allocation.identity))throw Error();
  return structuredClone(preparation);
 }catch{throw Error('git_reinitialization_preparation_invalid');}
}
/** The original ref-preparation slot owns internal-volume allocation before its
 * files exist. Configuration facts are already complete on the common volume. */
export function gitReinitializationRefPreparation(value:unknown):GitReinitializationRefPreparation{
 try{
  const reference=value as GitReinitializationRefPreparation;
  if(!shape(reference,['protocol','preparation','allocation','configuration','config_lock'])||reference.protocol!==2)throw Error();
  const preparation=gitReinitializationPreparation(reference.preparation),allocation=reinitializationAllocation(reference.allocation);
  const {witness}=preparation.plan,{existing}=witness,{configuration,config_lock:lock}=reference;
  if(!witness.ignore_after.changed||allocation.scope!=='internal'
   ||allocation.parent_identity!==(witness.internal_directory_identity??witness.root_identity)
   ||allocation.identity===preparation.allocation.identity
   ||allocation.parent_identity===preparation.allocation.parent_identity&&allocation.name===preparation.allocation.name
   ||!shape(configuration,['filemode','file'])||typeof configuration.filemode!=='boolean'
   ||!isGitInitializationFile(configuration.file)||configuration.file.size<1||!isGitInitializationFile(lock)||lock.sha256!==hash('')||lock.size!==0
   ||configuration.file.sha256!==(configuration.filemode?existing.configuration!.filemode_true_sha256:existing.configuration!.filemode_false_sha256))throw Error();
  const identities=new Set([witness.root_identity,existing.git_directory_identity,existing.common_directory_identity,
   witness.internal_directory_identity,preparation.allocation.identity,witness.internal_ignore?.identity,
   existing.dot_file?.identity,existing.common_config?.identity,existing.worktree_config?.identity,
   ...existing.layout!.directories.map(directory=>directory.before?.identity)]);
  if(identities.has(allocation.identity))throw Error();
  identities.add(allocation.identity);
  for(const fact of [configuration.file,lock]){
   if(identities.has(fact.identity)||fact.identity.split(':')[0]!==preparation.allocation.identity.split(':')[0])throw Error();
   identities.add(fact.identity);
  }
  return structuredClone(reference);
 }catch{throw Error('git_reinitialization_ref_preparation_invalid');}
}

/** Dispatch is durable before canonical locks or publication. It binds both
 * original allocations and the approved pending file contents and identities. */
export function gitReinitializationEvidence(value:unknown):GitReinitializationEvidence{
 try{
  const evidence=value as GitReinitializationEvidence;
  if(!shape(evidence,['protocol','preparation','ref_preparation','configuration','config_lock','ignore','ignore_lock',...(evidence?.directory_modes===undefined?[]:['directory_modes']),...(evidence?.immutable_metadata_sha256===undefined?[]:['immutable_metadata_sha256']),...(evidence?.file_groups===undefined?[]:['file_groups']),...(evidence?.ignore_in_place===undefined?[]:['ignore_in_place'])])||evidence.protocol!==2)throw Error();
  if(evidence.immutable_metadata_sha256!==undefined&&(typeof evidence.immutable_metadata_sha256!=='string'||!/^[a-f0-9]{64}$/.test(evidence.immutable_metadata_sha256)))throw Error();
  if(evidence.directory_modes!==undefined){
   if(!Array.isArray(evidence.directory_modes)||evidence.directory_modes.length!==initializationDirectories.length)throw Error();
   for(const [index,directory] of evidence.directory_modes.entries()){
    if(!shape(directory,['path','mode'])||directory.path!==initializationDirectories[index]
     ||!Number.isSafeInteger(directory.mode)||directory.mode<0||directory.mode>0o7777)throw Error();
   }
  }
  const preparation=gitReinitializationPreparation(evidence.preparation),{witness}=preparation.plan,{existing}=witness;
  const {configuration,config_lock:lock,ignore,ignore_lock:ignoreLock}=evidence;
  if(evidence.file_groups!==undefined){
   const group=(value:unknown)=>typeof value==='string'&&/^[0-9]+$/.test(value)&&Number.isSafeInteger(Number(value))&&String(Number(value))===value;
   if(!shape(evidence.file_groups,['configuration','ignore'])||!group(evidence.file_groups.configuration)
    ||(witness.ignore_after.changed?!group(evidence.file_groups.ignore):evidence.file_groups.ignore!==null))throw Error();
   const mode=evidence.directory_modes?.[0]?.mode;
   if(mode===undefined||evidence.file_groups.configuration!==((mode&0o2000)?existing.layout!.common.gid:preparation.allocation.gid))throw Error();
  }
  if(evidence.ignore_in_place!==undefined){
   const owner=evidence.ignore_in_place,id=(value:unknown)=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);
   if(!shape(owner,['uid','gid'])||!id(owner.uid)||!id(owner.gid)||!witness.ignore_after.changed||!witness.internal_ignore
    ||!evidence.file_groups||evidence.file_groups.ignore!==owner.gid)throw Error();
  }
  if(!shape(configuration,['filemode','file'])||typeof configuration.filemode!=='boolean'||!isGitInitializationFile(configuration.file)
   ||configuration.file.size<1||configuration.file.sha256!==(configuration.filemode?existing.configuration!.filemode_true_sha256:existing.configuration!.filemode_false_sha256)
   ||!isGitInitializationFile(lock)||lock.sha256!==hash('')||lock.size!==0)throw Error();
  const identities=new Set([witness.root_identity,existing.git_directory_identity,existing.common_directory_identity,
   witness.internal_directory_identity,preparation.allocation.identity,witness.internal_ignore?.identity,
   existing.dot_file?.identity,existing.common_config?.identity,existing.worktree_config?.identity,
   ...existing.layout!.directories.map(directory=>directory.before?.identity)]);
  for(const file of [configuration.file,lock]){
   if(identities.has(file.identity)||file.identity.split(':')[0]!==preparation.allocation.identity.split(':')[0])throw Error();
   identities.add(file.identity);
  }
  if(witness.ignore_after.changed){
   const reference=gitReinitializationRefPreparation(evidence.ref_preparation);
   if(canonicalJson(reference.preparation)!==canonicalJson(preparation)||canonicalJson(reference.configuration)!==canonicalJson(configuration)
    ||canonicalJson(reference.config_lock)!==canonicalJson(lock)||identities.has(reference.allocation.identity))throw Error();
   identities.add(reference.allocation.identity);
   if(ignore===null||ignoreLock===null||!isGitInitializationFile(ignore)||!isGitInitializationFile(ignoreLock)
    ||ignore.sha256!==witness.ignore_after.sha256||ignore.size!==witness.ignore_after.size||ignoreLock.sha256!==hash('')||ignoreLock.size!==0)throw Error();
   for(const file of [ignore,ignoreLock]){
    if(identities.has(file.identity)||file.identity.split(':')[0]!==reference.allocation.identity.split(':')[0])throw Error();
    identities.add(file.identity);
   }
  }else if(evidence.ref_preparation!==null||ignore!==null||ignoreLock!==null)throw Error();
  return structuredClone(evidence);
 }catch{throw Error('git_reinitialization_evidence_invalid');}
}

/** Original host-private observed publication proof in the original outcome row. */
export function gitReinitializationReceipt(value:unknown,input:unknown):GitReinitializationReceipt{
 try{
  const evidence=gitReinitializationEvidence(input),receipt=value as GitReinitializationReceipt;
  const {witness}=evidence.preparation.plan,{existing}=witness,layout=existing.layout!;
  if(!evidence.directory_modes||!evidence.immutable_metadata_sha256
   ||!shape(receipt,['protocol','plan_id','action','evidence_sha256','directories','internal_directory','execution_authorized'])
   ||receipt.protocol!==2||receipt.action!=='init'||receipt.execution_authorized!==false||receipt.plan_id!==evidence.preparation.plan.plan_id
   ||receipt.evidence_sha256!==hash(canonicalJson(evidence))||!Array.isArray(receipt.directories)||receipt.directories.length!==initializationDirectories.length)throw Error();
  const directory=(value:GitReinitializationDirectory)=>typeof value.identity==='string'&&/^[0-9]+:[0-9]+$/.test(value.identity)
   &&Number.isSafeInteger(value.mode)&&value.mode>=0&&value.mode<=0o7777
   &&typeof value.uid==='string'&&/^[0-9]+$/.test(value.uid)&&typeof value.gid==='string'&&/^[0-9]+$/.test(value.gid);
  const identities=new Set([witness.root_identity,existing.git_directory_identity,existing.common_directory_identity,
   witness.internal_directory_identity,evidence.preparation.allocation.identity,evidence.ref_preparation?.allocation.identity,
   evidence.configuration.file.identity,evidence.config_lock.identity,evidence.ignore?.identity,evidence.ignore_lock?.identity]);
  for(const [index,item] of receipt.directories.entries()){
   if(!shape(item,['path','identity','mode','uid','gid'])||item.path!==initializationDirectories[index]||!directory(item)
    ||item.mode!==evidence.directory_modes[index]!.mode)throw Error();
   const before=index===0?layout.common:layout.directories[index-1]!.before;
   if(before){
    if(item.identity!==before.identity||item.uid!==before.uid||item.gid!==before.gid)throw Error();
   }else if(identities.has(item.identity)||layout.directories.some(entry=>entry.before?.identity===item.identity)
    ||item.uid!==evidence.preparation.allocation.uid)throw Error();
   if(index!==0&&identities.has(item.identity))throw Error();
   identities.add(item.identity);
  }
  const internal=receipt.internal_directory;
  if(!shape(internal,['identity','mode','uid','gid'])||!directory(internal))throw Error();
  if(witness.internal_directory_identity!==null){if(internal.identity!==witness.internal_directory_identity)throw Error();}
  else if(identities.has(internal.identity)||!evidence.ref_preparation||internal.uid!==evidence.ref_preparation.allocation.uid)throw Error();
  return structuredClone(receipt);
 }catch{throw Error('git_reinitialization_receipt_invalid');}
}

/** Canonical after-facts keep the original inode for an append-only update. */
export function reinitializationIgnoreTarget(evidence:GitReinitializationEvidence):GitInitializationFile|null{
 const {witness}=evidence.preparation.plan;
 if(evidence.ignore_in_place){
  return{...witness.internal_ignore!,sha256:witness.ignore_after.sha256,size:witness.ignore_after.size};
 }
 return witness.ignore_after.changed?evidence.ignore:witness.internal_ignore;
}
