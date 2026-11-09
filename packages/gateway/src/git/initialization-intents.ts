import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitInitializationReviewPrepare,GitInitializationReviewIntent,GitReviewControl} from '../../contracts/types.ts';
import type {ProjectRepository} from '../projects/repository.ts';
import {withImmediateTransaction} from '../db/database.ts';
import type {GitWorkbench} from './service.ts';
import {normalizeGitInitializationReview,readGitInitializationIntentSource} from './initialization-records.ts';
import type {GitBranchIntentRecord as Row} from './branch-records.ts';

type Event={version:number;state:'prepared'|'approved'|'cancelled';request_id:string|null;request_sha256:string|null;created_at:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Initialization shares the original immutable owner review/event ledger.
 * Construction grants no effect authority and installs no additional tables. */
export class GitInitializationIntents{
 private readonly db:DatabaseSync;
 private readonly projects:ProjectRepository;
 private readonly git:GitWorkbench;
 constructor(db:DatabaseSync,projects:ProjectRepository,git:GitWorkbench){this.db=db;this.projects=projects;this.git=git;}
 private row(owner:string,project:string,id:string){
  this.projects.assertOwned(project,owner);
  if(typeof id!=='string'||!ID.test(id))throw Error('git_initialization_invalid');
  const row=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND intent_id=?').get(owner,project,id) as Row|undefined;
  if(!row||row.action!=='init')throw Error('git_intent_not_found');return row;
 }
 private latest(id:string){
  const event=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? ORDER BY version DESC LIMIT 1').get(id) as Event|undefined;
  if(!event)throw Error('git_intent_unavailable');return event;
 }
 private view(row:Row,event:Event):GitInitializationReviewIntent{
  const {input,witness}=readGitInitializationIntentSource(row);
  return{intent_id:row.intent_id,project_id:row.project_id,action:'init',snapshot_id:input.snapshot_id,
   initial_branch:input.initial_branch,object_format:input.object_format,
   internal_ignore:{path:'.pilotdeck/.gitignore',before_sha256:witness.internal_ignore?.sha256??null,
    after_sha256:witness.ignore_after.sha256,size:witness.ignore_after.size,changed:witness.ignore_after.changed},
   review_sha256:row.review_sha256,version:event.version,state:event.state,created_at:row.created_at,updated_at:event.created_at,execution_authorized:false};
 }
 get(owner:string,project:string,id:string){const row=this.row(owner,project,id);return this.view(row,this.latest(id));}
 async prepareChange(owner:string,project:string,value:GitInitializationReviewPrepare,signal?:AbortSignal){
  this.projects.assertOwned(project,owner);const input=normalizeGitInitializationReview(value),requestHash=digest(input);
  const prior=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  const replay=(row:Row)=>{
   if(row.action!=='init'||row.request_sha256!==requestHash)throw Error('idempotency_conflict');
   return this.view(row,this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND version=1').get(row.intent_id) as Event);
  };
  if(prior){replay(prior);return()=>{signal?.throwIfAborted();return replay(this.row(owner,project,prior.intent_id));};}
  const witness=await this.git.freezeInitialization(owner,project,input.snapshot_id,input.initial_branch,input.object_format,signal);
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.projects.assertOwned(project,owner);
   const existing=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
   if(existing)return replay(existing);
   const id='git-intent-'+randomUUID(),at=new Date().toISOString(),review=digest({action:'init',witness});
   this.db.prepare('INSERT INTO wb_git_mutation_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,owner,project,input.request_id,requestHash,'init',JSON.stringify(input),JSON.stringify(witness),review,at);
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,1,'prepared',null,null,at);
   return this.get(owner,project,id);
  });
 }
 async prepareControl(owner:string,project:string,id:string,raw:GitReviewControl,signal?:AbortSignal){
  const input=raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw}:raw;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='action,expected_version,request_id,review_sha256'
   ||typeof input.request_id!=='string'||!ID.test(input.request_id)||!Number.isSafeInteger(input.expected_version)||input.expected_version<1
   ||!['approve','cancel'].includes(input.action)||typeof input.review_sha256!=='string'||!SHA.test(input.review_sha256))throw Error('git_initialization_invalid');
  const row=this.row(owner,project,id),source=readGitInitializationIntentSource(row);
  const requestHash=digest({request_id:input.request_id,expected_version:input.expected_version,action:input.action,review_sha256:input.review_sha256});
  const replay=()=>{
   const event=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND request_id=?').get(id,input.request_id) as Event|undefined;
   if(event&&event.request_sha256!==requestHash)throw Error('idempotency_conflict');
   return event?this.view(row,event):undefined;
  };
  const assertCurrent=()=>{
   this.row(owner,project,id);const event=this.latest(id);
   if(event.version!==input.expected_version)throw Error('version_conflict');
   if(row.review_sha256!==input.review_sha256)throw Error('git_review_changed');
   if(event.state==='cancelled'||input.action==='approve'&&event.state!=='prepared')throw Error('git_intent_closed');
   return event;
  };
  const cached=replay();
  if(cached)return()=>{signal?.throwIfAborted();this.row(owner,project,id);return cached;};
  assertCurrent();
  if(input.action==='approve'){
   const witness=await this.git.freezeInitialization(owner,project,source.input.snapshot_id,source.input.initial_branch,source.input.object_format,signal);
   if(JSON.stringify(witness)!==row.witness_json)throw Error('git_review_changed');
  }
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.row(owner,project,id);
   const cached=replay();if(cached)return cached;const event=assertCurrent();
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,event.version+1,input.action==='approve'?'approved':'cancelled',input.request_id,requestHash,new Date().toISOString());
   return this.get(owner,project,id);
  });
 }
}
