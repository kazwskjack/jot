import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitBranchReviewPrepare,GitBranchReviewIntent,GitCreateBranchWitness,GitReviewControl} from '../../contracts/types.ts';
import type {ProjectRepository} from '../projects/repository.ts';
import {withImmediateTransaction} from '../db/database.ts';
import type {GitWorkbench} from './service.ts';
import {validGitReference} from './references.ts';

type Row={intent_id:string;owner_id:string;project_id:string;request_id:string;request_sha256:string;action:string;selection_json:string;witness_json:string;review_sha256:string;created_at:string};
type Event={version:number;state:'prepared'|'approved'|'cancelled';request_id:string|null;request_sha256:string|null;created_at:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Shares the original immutable review/event ledger. Construction installs no
 * schema, execution journal, workspace reservation or native authority. */
export class GitBranchIntents{
 private readonly db:DatabaseSync;private readonly projects:ProjectRepository;private readonly git:GitWorkbench;
 constructor(db:DatabaseSync,projects:ProjectRepository,git:GitWorkbench){this.db=db;this.projects=projects;this.git=git;}
 private normalize(value:GitBranchReviewPrepare):GitBranchReviewPrepare{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='action,branch,request_id,snapshot_id'
   ||typeof value.request_id!=='string'||!ID.test(value.request_id)||value.action!=='create-branch'
   ||typeof value.snapshot_id!=='string'||!SHA.test(value.snapshot_id)||typeof value.branch!=='string'||value.branch.startsWith('-')||!validGitReference('refs/heads/'+value.branch))throw Error('git_branch_invalid');
  return{request_id:value.request_id,action:value.action,branch:value.branch,snapshot_id:value.snapshot_id};
 }
 private row(owner:string,project:string,id:string){
  this.projects.assertOwned(project,owner);
  if(typeof id!=='string'||!ID.test(id))throw Error('git_branch_invalid');
  const row=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND intent_id=?').get(owner,project,id) as Row|undefined;
  if(!row||row.action!=='create-branch')throw Error('git_intent_not_found');return row;
 }
 private latest(id:string){
  const event=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? ORDER BY version DESC LIMIT 1').get(id) as Event|undefined;
  if(!event)throw Error('git_intent_unavailable');return event;
 }
 private source(row:Row){
  try{
   const input=this.normalize(JSON.parse(row.selection_json)),witness=JSON.parse(row.witness_json) as GitCreateBranchWitness;
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
 private view(row:Row,event:Event):GitBranchReviewIntent{
  const {input,witness}=this.source(row);
  return{intent_id:row.intent_id,project_id:row.project_id,action:input.action,branch:input.branch,
   target_ref:witness.target_ref,target_oid:witness.target_oid,head:witness.head,object_format:witness.object_format,
   snapshot_id:input.snapshot_id,review_sha256:row.review_sha256,version:event.version,state:event.state,
   created_at:row.created_at,updated_at:event.created_at,execution_authorized:false};
 }
 get(owner:string,project:string,id:string){const row=this.row(owner,project,id);return this.view(row,this.latest(id));}
 async prepareChange(owner:string,project:string,value:GitBranchReviewPrepare,signal?:AbortSignal){
  this.projects.assertOwned(project,owner);const input=this.normalize(value),requestHash=digest(input);
  const prior=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  const replay=(row:Row)=>{
   if(row.action!==input.action||row.request_sha256!==requestHash)throw Error('idempotency_conflict');
   return this.view(row,this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND version=1').get(row.intent_id) as Event);
  };
  if(prior){replay(prior);return()=>{signal?.throwIfAborted();return replay(this.row(owner,project,prior.intent_id));};}
  const witness=await this.git.freezeCreateBranch(owner,project,input.snapshot_id,input.branch,signal);
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.projects.assertOwned(project,owner);
   const existing=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
   if(existing)return replay(existing);
   const id='git-intent-'+randomUUID(),at=new Date().toISOString(),review=digest({action:input.action,branch:input.branch,witness});
   this.db.prepare('INSERT INTO wb_git_mutation_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,owner,project,input.request_id,requestHash,input.action,JSON.stringify(input),JSON.stringify(witness),review,at);
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,1,'prepared',null,null,at);
   return this.get(owner,project,id);
  });
 }
 async prepareControl(owner:string,project:string,id:string,raw:GitReviewControl,signal?:AbortSignal){
  const input=raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw}:raw;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='action,expected_version,request_id,review_sha256'
   ||typeof input.request_id!=='string'||!ID.test(input.request_id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1
   ||!['approve','cancel'].includes(input.action)||typeof input.review_sha256!=='string'||!SHA.test(input.review_sha256))throw Error('git_branch_invalid');
  const row=this.row(owner,project,id),source=this.source(row),requestHash=digest({request_id:input.request_id,expected_version:input.expected_version,action:input.action,review_sha256:input.review_sha256});
  const replay=()=>{
   const prior=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND request_id=?').get(id,input.request_id) as Event|undefined;
   if(prior&&prior.request_sha256!==requestHash)throw Error('idempotency_conflict');return prior?this.view(row,prior):undefined;
  };
  const assertCurrent=()=>{
   this.row(owner,project,id);const event=this.latest(id);
   if(event.version!==input.expected_version)throw Error('version_conflict');
   if(row.review_sha256!==input.review_sha256)throw Error('git_review_changed');
   if(event.state==='cancelled'||input.action==='approve'&&event.state!=='prepared')throw Error('git_intent_closed');return event;
  };
  const cached=replay();if(cached)return()=>{signal?.throwIfAborted();this.row(owner,project,id);return cached;};
  assertCurrent();
  if(input.action==='approve'){
   const witness=await this.git.freezeCreateBranch(owner,project,source.input.snapshot_id,source.input.branch,signal);
   if(JSON.stringify(witness)!==row.witness_json)throw Error('git_review_changed');
  }
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.row(owner,project,id);const cached=replay();if(cached)return cached;const event=assertCurrent();
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,event.version+1,input.action==='approve'?'approved':'cancelled',input.request_id,requestHash,new Date().toISOString());
   return this.get(owner,project,id);
  });
 }
}
