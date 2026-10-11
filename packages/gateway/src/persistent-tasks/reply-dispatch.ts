import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {EventStore} from '../events/event-store.ts';
import {TaskReplyDrafts} from './reply-drafts.ts';
import {TaskReplySendGate} from './reply-send-gate.ts';
import {TaskReplyDelivery} from './reply-delivery.ts';
import {TaskReplyProjection} from './reply-projection.ts';
type Row=Record<string,any>;
export function taskReplyDispatchEnabled(env:Record<string,string|undefined>):boolean{
 const value=env.GENERAL_AGENT_TASK_REPLY_EXECUTION?.trim()??'';if(['','0'].includes(value))return false;if(value==='1')return true;throw new Error('reply_execution_configuration_invalid');
}
/** Host scans committed review/assessment facts, never page reads. This ledger records
 * terminal dispatch outcomes and deferrals, not a second execution/provider
 * queue. Provider I/O remains in the existing delivery worker. */
export class TaskReplyDispatch{
 private readonly db:DatabaseSync;private readonly enabled:boolean;private readonly now:()=>number;private readonly drafts:TaskReplyDrafts;private readonly gate:TaskReplySendGate;private readonly delivery:TaskReplyDelivery;private readonly projection:TaskReplyProjection;
 constructor(db:DatabaseSync,events=new EventStore(db),options:{enabled?:boolean;now?:()=>number}={}){
  this.db=db;this.enabled=options.enabled===true;this.now=options.now??(()=>Math.floor(Date.now()/1000));this.drafts=new TaskReplyDrafts(db,events);this.gate=new TaskReplySendGate(db,{now:this.now});this.delivery=new TaskReplyDelivery(db,{now:this.now});this.projection=new TaskReplyProjection(db,events,{now:this.now});
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_dispatch_outcomes(draft_id TEXT PRIMARY KEY REFERENCES wb_task_reply_drafts(draft_id),owner_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,status TEXT NOT NULL,reason_code TEXT,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_task_reply_dispatch_deferrals(draft_id TEXT PRIMARY KEY REFERENCES wb_task_reply_drafts(draft_id),not_before INTEGER NOT NULL,reason_code TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_dispatch_no_update BEFORE UPDATE ON wb_task_reply_dispatch_outcomes BEGIN SELECT RAISE(ABORT,'reply_dispatch_outcome_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_dispatch_no_delete BEFORE DELETE ON wb_task_reply_dispatch_outcomes BEGIN SELECT RAISE(ABORT,'reply_dispatch_outcome_immutable'); END;`);
 }
 processNext():boolean{
  if(!this.enabled)return false;
  return withImmediateTransaction(this.db,()=>{
   const current=this.now();if(!Number.isSafeInteger(current)||current<0)throw new Error('reply_send_clock_invalid');
   const candidate=this.db.prepare(`SELECT d.draft_id,d.owner_id FROM wb_task_reply_drafts d
    LEFT JOIN wb_task_reply_reviews r ON r.draft_id=d.draft_id LEFT JOIN wb_task_reply_semantic_checks s ON s.draft_id=d.draft_id AND s.owner_id=d.owner_id
    LEFT JOIN wb_task_reply_dispatch_outcomes o ON o.draft_id=d.draft_id LEFT JOIN wb_task_reply_dispatch_deferrals wait ON wait.draft_id=d.draft_id
    WHERE ((json_extract(d.draft_json,'$.mode')='review' AND r.decision='approve') OR (json_extract(d.draft_json,'$.mode')='bounded_auto_reply' AND s.verdict='eligible')) AND o.draft_id IS NULL AND (wait.not_before IS NULL OR wait.not_before<=?) ORDER BY COALESCE(r.created_at,s.created_at),d.draft_id LIMIT 1`).get(current) as Row|undefined;
   if(!candidate)return false;
   const draft=this.drafts.get(candidate.owner_id,candidate.draft_id);let check;
   try{check=this.gate.check(candidate.owner_id,candidate.draft_id);}catch(error){if(error instanceof Error&&['task_not_found','task_reply_scope_not_found','channel_binding_not_found','channel_binding_not_verified'].includes(error.message))check={allowed:false,reason:'REPLY_AUTHORITY_MISSING',not_before:null};else throw error;}
   if(!check.allowed&&check.not_before!==null){this.db.prepare('INSERT INTO wb_task_reply_dispatch_deferrals VALUES(?,?,?) ON CONFLICT(draft_id) DO UPDATE SET not_before=excluded.not_before,reason_code=excluded.reason_code').run(draft.draft_id,check.not_before,check.reason!);return true;}
   let status='cancelled',reason=check.reason,receipt:Row={};
   if(check.allowed){
    if(draft.target.kind==='conversation'){receipt=this.projection.project(candidate.owner_id,draft.draft_id);if(receipt.status!=='delivered')throw new Error('reply_dispatch_projection_conflict');status='delivered';}
    else{const effect=this.delivery.enqueue(candidate.owner_id,draft.draft_id);receipt={effect_id:effect.effect_id,status:effect.status};status='queued';}
    reason=null;
   }
   this.db.prepare('INSERT INTO wb_task_reply_dispatch_outcomes VALUES(?,?,?,?,?,?,?)').run(draft.draft_id,candidate.owner_id,draft.payload_sha256,status,reason,JSON.stringify(receipt),new Date(current*1000).toISOString());
   this.db.prepare('DELETE FROM wb_task_reply_dispatch_deferrals WHERE draft_id=?').run(draft.draft_id);return true;
  });
 }
}
