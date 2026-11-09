import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {GitInitializationReviewPrepare,GitInitializationWitness} from '../../contracts/types.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {workspaceRelativePath} from '../always-on/workspace-provider.ts';
import {validGitReference} from './references.ts';
import type {GitBranchIntentRecord} from './branch-records.ts';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/,IDENTITY=/^[0-9]+:[0-9]+$/;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const shape=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
export function normalizeGitInitializationReview(value:GitInitializationReviewPrepare):GitInitializationReviewPrepare{
 try{
  if(!shape(value,['request_id','action','snapshot_id','initial_branch','object_format'])||typeof value.request_id!=='string'||!ID.test(value.request_id)
   ||value.action!=='init'||typeof value.snapshot_id!=='string'||!SHA.test(value.snapshot_id)
   ||typeof value.initial_branch!=='string'||value.initial_branch.startsWith('-')||!validGitReference('refs/heads/'+value.initial_branch)
   ||workspaceRelativePath('refs/heads/'+value.initial_branch)!=='refs/heads/'+value.initial_branch||!['sha1','sha256'].includes(value.object_format))throw Error();
  return{request_id:value.request_id,action:'init',snapshot_id:value.snapshot_id,initial_branch:value.initial_branch,object_format:value.object_format};
 }catch{throw Error('git_initialization_invalid');}
}
/** Adapted from PilotDeck 783499ff src/pilot/paths.ts under AGPL-3.0.
 * Full license: packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
 * Jot preserves original bytes and bounds the resulting internal-ignore file. */
export function initializationInternalIgnore(before:Buffer|null){
 const body=before??Buffer.alloc(0),last=body.toString('utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).at(-1);
 if(last==='*')return{body,changed:false};
 const after=Buffer.concat([body,Buffer.from((body.length&&body[body.length-1]!==10?'\n':'')+'# PilotDeck internal files\n*\n','utf8')]);
 if(after.length>1024*1024)throw Error('git_initialization_ignore_limit');
 return{body:after,changed:true};
}
export function initializationSnapshotId(source:Pick<GitInitializationWitness,'repository_sha256'|'root_identity'|'internal_directory_identity'|'internal_ignore'>){
 return hash(canonicalJson({protocol:1,kind:'uninitialized_repository',repository_sha256:source.repository_sha256,root_identity:source.root_identity,
  internal_directory_identity:source.internal_directory_identity,internal_ignore:source.internal_ignore}));
}
/** Strict persisted facts only. A decoded witness cannot authorize a write. */
export function gitInitializationWitness(value:unknown):GitInitializationWitness{
 try{
  const witness=value as GitInitializationWitness;
  if(!shape(witness,['protocol','kind','snapshot_id','repository_sha256','root_identity','internal_directory_identity','internal_ignore','initial_branch','object_format','ignore_after','execution_authorized',...(witness?.protocol===2?['existing']:[])])
   ||![1,2].includes(witness.protocol)||witness.kind!=='initialize_repository'||witness.execution_authorized!==false
   ||typeof witness.repository_sha256!=='string'||!SHA.test(witness.repository_sha256)||typeof witness.root_identity!=='string'||!IDENTITY.test(witness.root_identity)
   ||witness.internal_directory_identity!==null&&(typeof witness.internal_directory_identity!=='string'||!IDENTITY.test(witness.internal_directory_identity)))throw Error();
  normalizeGitInitializationReview({request_id:'initialization-witness',action:'init',snapshot_id:witness.snapshot_id,initial_branch:witness.initial_branch,object_format:witness.object_format});
  const file=witness.internal_ignore;
  if(file!==null&&(!shape(file,['identity','sha256','size','mode'])||typeof file.identity!=='string'||!IDENTITY.test(file.identity)
   ||typeof file.sha256!=='string'||!SHA.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0||file.size>1024*1024
   ||!Number.isSafeInteger(file.mode)||file.mode<0||file.mode>0o777||witness.internal_directory_identity===null))throw Error();
  const after=witness.ignore_after;
  if(!shape(after,['sha256','size','changed'])||typeof after.sha256!=='string'||!SHA.test(after.sha256)||!Number.isSafeInteger(after.size)||after.size<1||after.size>1024*1024
   ||typeof after.changed!=='boolean'||after.changed!==((file?.sha256??null)!==after.sha256)||!after.changed&&after.size!==file?.size
   ||witness.protocol===1&&initializationSnapshotId(witness)!==witness.snapshot_id)throw Error();
  if(witness.protocol===2){
   const existing=witness.existing,oid=(value:unknown)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+(witness.object_format==='sha1'?40:64)+'}$').test(value);
   if(!shape(existing,['source_metadata_sha256','git_directory_identity','common_directory_identity','dot_file','head','common_config','worktree_config','worktree_config_enabled',...(existing?.configuration===undefined?[]:['configuration']),...(existing?.layout===undefined?[]:['layout'])])
    ||typeof existing.source_metadata_sha256!=='string'||!SHA.test(existing.source_metadata_sha256)
    ||typeof existing.git_directory_identity!=='string'||!IDENTITY.test(existing.git_directory_identity)
    ||typeof existing.common_directory_identity!=='string'||!IDENTITY.test(existing.common_directory_identity)
    ||typeof existing.worktree_config_enabled!=='boolean')throw Error();
   for(const entry of [existing.dot_file,existing.common_config,existing.worktree_config])if(entry!==null){
    if(!shape(entry,['identity','sha256','size','mode'])||typeof entry.identity!=='string'||!IDENTITY.test(entry.identity)
     ||typeof entry.sha256!=='string'||!SHA.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>1024*1024
     ||!Number.isSafeInteger(entry.mode)||entry.mode<0||entry.mode>0o777)throw Error();
   }
   const layout=existing.layout;
   if(layout!==undefined){
    const directory=(value:any)=>shape(value,['identity','mode','uid','gid'])&&typeof value.identity==='string'&&IDENTITY.test(value.identity)
     &&typeof value.uid==='string'&&/^[0-9]+$/.test(value.uid)&&typeof value.gid==='string'&&/^[0-9]+$/.test(value.gid)
     &&Number.isSafeInteger(value.mode)&&value.mode>=0&&value.mode<=0o7777;
    if(!shape(layout,['protocol','root','git','common','directories'])||layout.protocol!==1
     ||!directory(layout.root)||layout.root.identity!==witness.root_identity
     ||!directory(layout.git)||layout.git.identity!==existing.git_directory_identity
     ||!directory(layout.common)||layout.common.identity!==existing.common_directory_identity
     ||!Array.isArray(layout.directories)||layout.directories.length!==6)throw Error();
    const paths=['objects','objects/info','objects/pack','refs','refs/heads','refs/tags'];
    const identities=new Set([layout.root.identity,layout.git.identity,layout.common.identity]);
    for(const [index,item] of layout.directories.entries()){
     if(!shape(item,['path','before'])||item.path!==paths[index])throw Error();
     if(item.before!==null){
      if(!directory(item.before)||identities.has(item.before.identity))throw Error();identities.add(item.before.identity);
      const parent=item.path.split('/')[0];
      if(item.path.includes('/')&&layout.directories.find(value=>value.path===parent)!.before===null)throw Error();
     }
    }
   }
   const configuration=existing.configuration;
   if(configuration!==undefined){
    if(!shape(configuration,['protocol','before_sha256','filemode_false_sha256','filemode_true_sha256','worktree_sha256'])||configuration.protocol!==1
     ||configuration.before_sha256!==(existing.common_config?.sha256??null)||configuration.worktree_sha256!==(existing.worktree_config?.sha256??null)
     ||typeof configuration.filemode_false_sha256!=='string'||!SHA.test(configuration.filemode_false_sha256)
     ||typeof configuration.filemode_true_sha256!=='string'||!SHA.test(configuration.filemode_true_sha256)
     ||configuration.filemode_false_sha256===configuration.filemode_true_sha256)throw Error();
   }
   const head=existing.head;
   if(!shape(head,['oid','branch','detached'])||head.oid!==null&&!oid(head.oid)||typeof head.detached!=='boolean'
    ||(head.detached?(head.branch!==null||head.oid===null):typeof head.branch!=='string'||!validGitReference('refs/heads/'+head.branch)))throw Error();
  }
  return structuredClone(witness);
 }catch{throw Error('git_initialization_evidence_invalid');}
}
export function readGitInitializationIntentSource(row:GitBranchIntentRecord){
 try{
  const input=normalizeGitInitializationReview(JSON.parse(row.selection_json)),witness=gitInitializationWitness(JSON.parse(row.witness_json));
  if(row.action!=='init'||row.request_id!==input.request_id||hash(JSON.stringify(input))!==row.request_sha256
   ||witness.initial_branch!==input.initial_branch||witness.object_format!==input.object_format||witness.snapshot_id!==input.snapshot_id
   ||hash(JSON.stringify({action:'init',witness}))!==row.review_sha256)throw Error();
  return{input,witness};
 }catch{throw Error('git_initialization_evidence_invalid');}
}

/** Original immutable approval facts only. Current owner and latest decision
 * fences stay with the owning service. This read grants no filesystem authority. */
export function readGitInitializationReviewSource(db:DatabaseSync,owner:string,project:string,intent:string,version:number,review:string){
 const row=db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND intent_id=?').get(owner,project,intent) as GitBranchIntentRecord|undefined;
 const approved=db.prepare("SELECT 1 FROM wb_git_mutation_events WHERE intent_id=? AND version=? AND state='approved'").get(intent,version);
 if(!row||row.action!=='init'||!approved||row.review_sha256!==review)throw Error('git_initialization_evidence_invalid');
 const {input,witness}=readGitInitializationIntentSource(row);
 return{action:input.action,witness};
}
export function readGitInitializationExecutionSource(db:DatabaseSync,row:{owner_id:string;project_id:string;intent_id:string;review_version:number;review_sha256:string;witness_sha256:string;repository_sha256:string;protocol:number}){
 const source=readGitInitializationReviewSource(db,row.owner_id,row.project_id,row.intent_id,row.review_version,row.review_sha256);
 if(![7,8].includes(row.protocol)||(source.witness.protocol===2)!==(row.protocol===8)
  ||source.witness.protocol===2&&(!source.witness.existing.configuration||!source.witness.existing.layout)||hash(JSON.stringify(source.witness))!==row.witness_sha256||source.witness.repository_sha256!==row.repository_sha256)throw Error('git_initialization_evidence_invalid');
 return source;
}
