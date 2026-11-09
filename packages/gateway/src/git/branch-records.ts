import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitBranchReviewPrepare,GitCreateBranchWitness} from '../../contracts/types.ts';
import {validGitReference} from './references.ts';

export type GitBranchIntentRecord={intent_id:string;owner_id:string;project_id:string;request_id:string;request_sha256:string;action:string;selection_json:string;witness_json:string;review_sha256:string;created_at:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function normalizeGitBranchReview(value:GitBranchReviewPrepare):GitBranchReviewPrepare{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='action,branch,request_id,snapshot_id'
  ||typeof value.request_id!=='string'||!ID.test(value.request_id)||value.action!=='create-branch'
  ||typeof value.snapshot_id!=='string'||!SHA.test(value.snapshot_id)||typeof value.branch!=='string'||value.branch.startsWith('-')||!validGitReference('refs/heads/'+value.branch))throw Error('git_branch_invalid');
 return{request_id:value.request_id,action:value.action,branch:value.branch,snapshot_id:value.snapshot_id};
}

export function readGitBranchIntentSource(row:GitBranchIntentRecord){
 try{
  const input=normalizeGitBranchReview(JSON.parse(row.selection_json)),witness=JSON.parse(row.witness_json) as GitCreateBranchWitness;
  const oid=(value:unknown)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+(witness.object_format==='sha1'?40:64)+'}$').test(value);
  if(row.action!==input.action||input.request_id!==row.request_id||digest(input)!==row.request_sha256
   ||Object.keys(witness).sort().join(',')!=='branch,execution_authorized,head,index_sha256,kind,object_format,protocol,repository_sha256,snapshot_id,source_metadata_sha256,target_oid,target_ref'
   ||witness.protocol!==1||witness.kind!=='create_branch'||witness.execution_authorized!==false
   ||witness.snapshot_id!==input.snapshot_id||witness.branch!==input.branch||witness.target_ref!=='refs/heads/'+input.branch
   ||!SHA.test(witness.repository_sha256)||!SHA.test(witness.source_metadata_sha256)||witness.index_sha256!==null&&!SHA.test(witness.index_sha256)
   ||!['sha1','sha256'].includes(witness.object_format)||!witness.head||Object.keys(witness.head).sort().join(',')!=='branch,detached,oid'
   ||witness.head.oid!==null&&!oid(witness.head.oid)||witness.target_oid!==witness.head.oid||typeof witness.head.detached!=='boolean'
   ||(witness.head.detached&&(witness.head.branch!==null||witness.head.oid===null)))throw Error('git_branch_evidence_invalid');
  if(!witness.head.detached&&(typeof witness.head.branch!=='string'||!validGitReference('refs/heads/'+witness.head.branch)))throw Error('git_branch_evidence_invalid');
  if(digest({action:input.action,branch:input.branch,witness})!==row.review_sha256)throw Error('git_branch_evidence_invalid');
  return{input,witness};
 }catch{throw Error('git_branch_evidence_invalid');}
}

/** Original immutable approval facts. Current owner, binding and native custody
 * are separately checked by the owning execution service. */
export function readGitCreateBranchReviewSource(db:DatabaseSync,owner:string,project:string,intent:string,version:number,review:string){
 const row=db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND intent_id=?').get(owner,project,intent) as GitBranchIntentRecord|undefined;
 const approved=db.prepare("SELECT 1 FROM wb_git_mutation_events WHERE intent_id=? AND version=? AND state='approved'").get(intent,version);
 if(!row||row.action!=='create-branch'||!approved||row.review_sha256!==review)throw Error('git_branch_evidence_invalid');
 const {input,witness}=readGitBranchIntentSource(row);
 return{action:input.action,branch:input.branch,witness};
}
export function readGitCreateBranchExecutionSource(db:DatabaseSync,row:{owner_id:string;project_id:string;intent_id:string;review_version:number;review_sha256:string;witness_sha256:string;repository_sha256:string}){
 const source=readGitCreateBranchReviewSource(db,row.owner_id,row.project_id,row.intent_id,row.review_version,row.review_sha256);
 if(digest(source.witness)!==row.witness_sha256||source.witness.repository_sha256!==row.repository_sha256)throw Error('git_branch_evidence_invalid');
 return source;
}
