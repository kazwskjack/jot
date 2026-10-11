import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {currentTaskBusinessCertificate,installTaskBusinessReviews} from '../persistent-tasks/business-review.ts';
import {installTaskCompletionCandidates} from '../persistent-tasks/completion-candidates.ts';
import {installTaskCompletionHandshake,prepareTaskCompletion,preparedTaskCompletion} from '../persistent-tasks/completion-handshake.ts';
import {installTaskFinalizations} from '../persistent-tasks/finalization.ts';
import {savedSessionCheckpoint} from './session-checkpoints.ts';
import type {HarnessCoordinator} from './coordinator.ts';

interface CompletionClient {
 goalStatus(session:string):Promise<unknown>;
 goalComplete(session:string,intent:string):Promise<unknown>;
 goalRestore?(session:string,run:string,intent?:string):Promise<unknown>;
}
type Claim={owner_id:string;run_id:string;token:string};
/** The existing Worker consumes business certificates, never native phase or
 * model text alone. A durable fenced claim grants no execution/model budget. */
export class TaskCompletionPump {
 private readonly now:()=>number;
 private readonly leaseMs:number;
 private db:DatabaseSync;
 private coordinator:HarnessCoordinator;
 private client:CompletionClient;
 private options:{workerId:string;now?:()=>number;leaseMs?:number};
 constructor(db:DatabaseSync,coordinator:HarnessCoordinator,client:CompletionClient,
  options:{workerId:string;now?:()=>number;leaseMs?:number}){
  this.db=db;this.coordinator=coordinator;this.client=client;this.options=options;
  this.now=options.now??Date.now;this.leaseMs=options.leaseMs??60_000;
  if(!options.workerId||!Number.isSafeInteger(this.leaseMs)||this.leaseMs<30_000)throw new Error('completion_pump_config_invalid');
  installTaskCompletionCandidates(db);installTaskBusinessReviews(db);installTaskCompletionHandshake(db);installTaskFinalizations(db);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_completion_claims (
   run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),worker_id TEXT NOT NULL,token TEXT NOT NULL,
   lease_until INTEGER NOT NULL,retry_after INTEGER NOT NULL,last_error TEXT);`);
 }
 private fence(claim:Claim){
  const row=this.db.prepare('SELECT 1 FROM wb_task_completion_claims WHERE run_id=? AND worker_id=? AND token=? AND lease_until>?')
   .get(claim.run_id,this.options.workerId,claim.token,this.now());
  if(!row)throw new Error('completion_claim_expired');
 }
 private claim():Claim|null{
  return withImmediateTransaction(this.db,()=>{
   const rows=this.db.prepare(`SELECT c.owner_id,b.run_id FROM wb_task_business_certificates b
    JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN wb_task_business_reviews v ON v.interaction_id=b.interaction_id AND v.owner_id=c.owner_id
    LEFT JOIN wb_task_finalizations f ON f.run_id=b.run_id LEFT JOIN wb_task_completion_claims l ON l.run_id=b.run_id
    WHERE f.run_id IS NULL AND r.status='waiting_approval'
     AND (l.run_id IS NULL OR (l.lease_until<=? AND l.retry_after<=?)) ORDER BY b.created_at`).all(this.now(),this.now()) as {owner_id:string;run_id:string}[];
   for(const row of rows){
    try{currentTaskBusinessCertificate(this.db,row.owner_id,row.run_id);}catch{continue;}
    const token=randomUUID();
    this.db.prepare(`INSERT INTO wb_task_completion_claims VALUES(?,?,?,?,?,NULL)
     ON CONFLICT(run_id) DO UPDATE SET worker_id=excluded.worker_id,token=excluded.token,lease_until=excluded.lease_until,retry_after=excluded.retry_after,last_error=NULL`)
     .run(row.run_id,this.options.workerId,token,this.now()+this.leaseMs,0);
    return {...row,token};
   }return null;
  });
 }
 async processNext():Promise<{run_id:string;status:'succeeded'|'pending'}|null>{
  const claim=this.claim();if(!claim)return null;
  const renewal=setInterval(()=>{
   try{this.db.prepare('UPDATE wb_task_completion_claims SET lease_until=? WHERE run_id=? AND token=? AND worker_id=? AND lease_until>?')
    .run(this.now()+this.leaseMs,claim.run_id,claim.token,this.options.workerId,this.now());
   }catch{ /* A lost renewal never grants publication: the transaction fence still applies. */ }
  },Math.floor(this.leaseMs/3));renewal.unref();
  try{
   let intent=withImmediateTransaction(this.db,()=>{
    this.fence(claim);currentTaskBusinessCertificate(this.db,claim.owner_id,claim.run_id);
    if(!this.db.prepare('SELECT 1 FROM wb_task_completion_intents WHERE run_id=?').get(claim.run_id))return null;
    return preparedTaskCompletion(this.db,claim.owner_id,claim.run_id);
   });
   if(!intent){
    const checkpoint=savedSessionCheckpoint(this.db,claim.run_id);if(!checkpoint)throw new Error('task_checkpoint_unavailable');
    if(this.client.goalRestore){
     await this.client.goalRestore(checkpoint.session_ref,claim.run_id);
     withImmediateTransaction(this.db,()=>{this.fence(claim);currentTaskBusinessCertificate(this.db,claim.owner_id,claim.run_id);});
    }
    const response=await this.client.goalStatus(checkpoint.session_ref);
    const state=response&&typeof response==='object'&&'state' in response?response.state:undefined;
    if(!state||typeof state!=='object'||!('host_status' in state)||!('goal' in state))throw new Error('completion_host_state_invalid');
    intent=withImmediateTransaction(this.db,()=>{
     this.fence(claim);
     return prepareTaskCompletion(this.db,claim.owner_id,claim.run_id,{host_status:state.host_status,goal:state.goal});
    });
   }
   if(!this.db.prepare('SELECT 1 FROM wb_task_native_completions WHERE intent_id=?').get(intent.intent_id)){
    withImmediateTransaction(this.db,()=>{this.fence(claim);preparedTaskCompletion(this.db,claim.owner_id,claim.run_id);});
    if(this.client.goalRestore){
     await this.client.goalRestore(intent.session_ref,claim.run_id,intent.intent_id);
     withImmediateTransaction(this.db,()=>{this.fence(claim);preparedTaskCompletion(this.db,claim.owner_id,claim.run_id);});
    }
    await this.client.goalComplete(intent.session_ref,intent.intent_id);
   }
   withImmediateTransaction(this.db,()=>{
    this.fence(claim);
    // The finalizer requires the authenticated persisted proof; a response
    // shaped like success is never a substitute for its durable journal.
    this.coordinator.finalizeReviewedTask(claim.owner_id,claim.run_id,intent.intent_id);
    this.db.prepare('DELETE FROM wb_task_completion_claims WHERE run_id=? AND token=?').run(claim.run_id,claim.token);
   });
   return {run_id:claim.run_id,status:'succeeded'};
  }catch{
   // Host timeout/CAS uncertainty is parked with the original immutable intent.
   // Never reset the Goal, regenerate a candidate or guess that it completed.
   this.db.prepare("UPDATE wb_task_completion_claims SET lease_until=0,retry_after=?,last_error='completion_reconciliation_pending' WHERE run_id=? AND token=? AND worker_id=?")
    .run(this.now()+5000,claim.run_id,claim.token,this.options.workerId);
   return {run_id:claim.run_id,status:'pending'};
  }finally{clearInterval(renewal);}
 }
}
