import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {GitCheckoutReviewIntent,GitCheckoutReviewControl} from '../../contracts/types.ts';
import type {ProjectRepository} from '../projects/repository.ts';
import {withImmediateTransaction} from '../db/database.ts';
import type {GitWorkbench} from './service.ts';
import type {GitBranchIntentRecord as Row} from './branch-records.ts';
import {checkoutDigest,normalizeGitCheckoutReview,readGitCheckoutIntentSource} from './checkout-records.ts';

type Event={version:number;state:'prepared'|'cancelled';created_at:string;request_sha256:string|null};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
/** Checkout source preparation and cancellation in the original immutable review ledger. */
export class GitCheckoutIntents{
 private readonly db:DatabaseSync;private readonly projects:ProjectRepository;private readonly git:GitWorkbench;private readonly validate:(value:unknown)=>boolean;
 constructor(db:DatabaseSync,projects:ProjectRepository,git:GitWorkbench,validate:(value:unknown)=>boolean){this.db=db;this.projects=projects;this.git=git;this.validate=validate;}
 private row(owner:string,project:string,id:string){
  this.projects.assertOwned(project,owner);if(typeof id!=='string'||!ID.test(id))throw Error('git_checkout_invalid');
  const row=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND intent_id=?').get(owner,project,id) as Row|undefined;
  if(!row||row.action!=='checkout-branch')throw Error('git_intent_not_found');return row;
 }
 private latest(id:string){
  const value=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? ORDER BY version DESC LIMIT 1').get(id) as Event|undefined;
  if(!value)throw Error('git_intent_unavailable');return value;
 }
 private view(row:Row,event:Event):GitCheckoutReviewIntent{
  const {input,witness}=readGitCheckoutIntentSource(row,this.validate);
  if(!Number.isSafeInteger(event.version)||event.version<1||!['prepared','cancelled'].includes(event.state))throw Error('git_checkout_evidence_invalid');
  return{intent_id:row.intent_id,project_id:row.project_id,action:input.action,snapshot_id:input.snapshot_id,target_ref:input.target_ref,witness,
   review_sha256:row.review_sha256,version:event.version,state:event.state,created_at:row.created_at,updated_at:event.created_at,execution_authorized:false};
 }
 get(owner:string,project:string,id:string){const row=this.row(owner,project,id);return this.view(row,this.latest(id));}
 async prepareChange(owner:string,project:string,value:unknown,signal?:AbortSignal){
  this.projects.assertOwned(project,owner);const input=normalizeGitCheckoutReview(value),requestHash=checkoutDigest(input);
  const replay=(row:Row)=>{
   if(row.action!==input.action||row.request_sha256!==requestHash)throw Error('idempotency_conflict');
   const event=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND version=1').get(row.intent_id) as Event|undefined;
   if(!event)throw Error('git_intent_unavailable');return this.view(row,event);
  };
  const prior=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  if(prior){replay(prior);return()=>{signal?.throwIfAborted();return replay(this.row(owner,project,prior.intent_id));};}
  const witness=await this.git.freezeCheckout(owner,project,input.snapshot_id,input.target_ref,signal);
  if(!this.validate(witness))throw Error('git_checkout_evidence_invalid');
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.projects.assertOwned(project,owner);
   const existing=this.db.prepare('SELECT * FROM wb_git_mutation_intents WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
   if(existing)return replay(existing);
   const id='git-intent-'+randomUUID(),at=new Date().toISOString(),review=checkoutDigest({action:input.action,target_ref:input.target_ref,witness});
   this.db.prepare('INSERT INTO wb_git_mutation_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,owner,project,input.request_id,requestHash,input.action,JSON.stringify(input),JSON.stringify(witness),review,at);
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,1,'prepared',null,null,at);
   return this.get(owner,project,id);
  });
 }
 prepareControl(owner:string,project:string,id:string,value:unknown,signal?:AbortSignal){
  const raw=value as GitCheckoutReviewControl;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='action,expected_version,request_id,review_sha256'
   ||typeof raw.request_id!=='string'||!ID.test(raw.request_id)||!Number.isSafeInteger(raw.expected_version)||raw.expected_version<1||raw.action!=='cancel'
   ||typeof raw.review_sha256!=='string'||!SHA.test(raw.review_sha256))throw Error('git_checkout_invalid');
  const input={request_id:raw.request_id,expected_version:raw.expected_version,action:raw.action,review_sha256:raw.review_sha256};
  const row=this.row(owner,project,id),requestHash=checkoutDigest(input);readGitCheckoutIntentSource(row,this.validate);
  const replay=()=>{
   const event=this.db.prepare('SELECT * FROM wb_git_mutation_events WHERE intent_id=? AND request_id=?').get(id,input.request_id) as Event|undefined;
   if(event&&event.request_sha256!==requestHash)throw Error('idempotency_conflict');return event?this.view(row,event):undefined;
  };
  const current=()=>{
   this.row(owner,project,id);const event=this.latest(id);
   if(event.version!==input.expected_version)throw Error('version_conflict');if(row.review_sha256!==input.review_sha256)throw Error('git_review_changed');
   if(event.state!=='prepared')throw Error('git_intent_closed');return event;
  };
  const cached=replay();if(cached)return()=>{signal?.throwIfAborted();this.row(owner,project,id);return cached;};current();
  return()=>withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.row(owner,project,id);const cached=replay();if(cached)return cached;const event=current();
   this.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(id,event.version+1,'cancelled',input.request_id,requestHash,new Date().toISOString());
   return this.get(owner,project,id);
  });
 }
}
