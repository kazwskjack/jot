import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
export type SessionCheckpoint={session_ref:string;seq_exclusive:number;turn_end_seq:number;goal_id:string;goal_revision:number;log_sha256:string};
const keys=['session_ref','seq_exclusive','turn_end_seq','goal_id','goal_revision','log_sha256'];
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function installSessionCheckpoints(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS ga_session_checkpoints(
 checkpoint_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id),conversation_id TEXT NOT NULL REFERENCES ga_conversations(id),
 session_ref TEXT NOT NULL,seq_exclusive INTEGER NOT NULL,turn_end_seq INTEGER NOT NULL,goal_id TEXT NOT NULL,goal_revision INTEGER NOT NULL,
 log_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,seq_exclusive,goal_revision));
 CREATE TRIGGER IF NOT EXISTS ga_checkpoint_no_update BEFORE UPDATE ON ga_session_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoint_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_checkpoint_no_delete BEFORE DELETE ON ga_session_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoint_immutable'); END;`);}
export function validateCheckpoint(value:unknown):SessionCheckpoint{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('checkpoint_invalid');
 const r=value as SessionCheckpoint;
 if(typeof r.session_ref!=='string'||!id.test(r.session_ref)||typeof r.goal_id!=='string'||!id.test(r.goal_id)||!Number.isSafeInteger(r.seq_exclusive)||r.seq_exclusive<1
  ||!Number.isSafeInteger(r.turn_end_seq)||r.turn_end_seq<0||r.turn_end_seq>=r.seq_exclusive||!Number.isSafeInteger(r.goal_revision)||r.goal_revision<1||typeof r.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.log_sha256))throw new Error('checkpoint_invalid');
 return r;
}
export function savedSessionCheckpoint(db:DatabaseSync,runId:string,sessionRef?:string):SessionCheckpoint|null{
 const row=db.prepare(`SELECT cp.* FROM ga_runs r JOIN ga_session_checkpoints cp ON cp.checkpoint_id=r.checkpoint_id
   AND cp.conversation_id=r.conversation_id JOIN wb_task_run_occurrences current ON current.run_id=r.id
   JOIN wb_task_run_occurrences source ON source.run_id=cp.run_id AND source.occurrence_id=current.occurrence_id
   WHERE r.id=?`).get(runId) as (SessionCheckpoint&{run_id:string})|undefined;
 if(!row|| (sessionRef!==undefined&&row.session_ref!==sessionRef))return null;
 return Object.fromEntries(keys.map(k=>[k,row[k as keyof SessionCheckpoint]])) as SessionCheckpoint;
}
/** Caller owns the existing worker lease and Immediate transaction. */
export function recordSessionCheckpoint(db:DatabaseSync,runId:string,conversationId:string,sessionRef:string,input:unknown):string{
 const receipt=validateCheckpoint(input);
 if(receipt.session_ref!==sessionRef)throw new Error('checkpoint_invalid');
 const owned=db.prepare(`SELECT g.goal_id,g.goal_revision,t.generation AS current_generation,o.generation,t.status AS task_status,r.status
  FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
  JOIN ga_harness_session_bindings s ON s.conversation_id=c.id AND s.owner_id=c.owner_id
  JOIN wb_run_bindings w ON w.run_id=r.id AND w.owner_id=c.owner_id
  JOIN wb_agents a ON a.agent_id=w.agent_id AND a.owner_id=w.owner_id AND a.status='active' AND a.capability_epoch=w.epoch
  JOIN wb_task_run_occurrences o ON o.run_id=r.id JOIN wb_persistent_tasks t ON t.task_id=o.task_id AND t.owner_id=c.owner_id
  JOIN wb_native_goal_bindings g ON g.run_id=o.root_run_id AND g.occurrence_id=o.occurrence_id
  WHERE r.id=? AND c.id=? AND s.session_id=?`).get(runId,conversationId,sessionRef) as {goal_id:string;goal_revision:number;current_generation:number;generation:number;task_status:string;status:string}|undefined;
 if(!owned || owned.goal_id!==receipt.goal_id || owned.goal_revision!==receipt.goal_revision || owned.status!=='running'
  ||owned.current_generation!==owned.generation ||!['active','budget_exhausted'].includes(owned.task_status))throw new Error('checkpoint_invalid');
 if(db.prepare(`SELECT 1 FROM wb_model_budget_attempts b
  JOIN wb_task_run_occurrences source ON source.run_id=b.run_id
  JOIN wb_task_run_occurrences current ON current.occurrence_id=source.occurrence_id
  WHERE current.run_id=? AND b.state IN ('unknown','in_flight')`).get(runId))throw new Error('budget_usage_unknown');
 const previous=savedSessionCheckpoint(db,runId,sessionRef);
 if(previous&&(receipt.seq_exclusive<previous.seq_exclusive||receipt.goal_revision<previous.goal_revision))throw new Error('checkpoint_invalid');
 const prior=db.prepare('SELECT checkpoint_id,log_sha256,turn_end_seq,session_ref,goal_id FROM ga_session_checkpoints WHERE run_id=? AND seq_exclusive=? AND goal_revision=?').get(runId,receipt.seq_exclusive,receipt.goal_revision) as {checkpoint_id:string;log_sha256:string;turn_end_seq:number;session_ref:string;goal_id:string}|undefined;
 if(prior){if(prior.log_sha256!==receipt.log_sha256||prior.turn_end_seq!==receipt.turn_end_seq||prior.session_ref!==sessionRef||prior.goal_id!==receipt.goal_id)throw new Error('checkpoint_invalid');return prior.checkpoint_id;}
 const checkpointId=`checkpoint-${randomUUID()}`;
 db.prepare('INSERT INTO ga_session_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)').run(checkpointId,runId,conversationId,sessionRef,receipt.seq_exclusive,receipt.turn_end_seq,receipt.goal_id,receipt.goal_revision,receipt.log_sha256,new Date().toISOString());
 db.prepare('UPDATE ga_runs SET checkpoint_id=?,version=version+1 WHERE id=?').run(checkpointId,runId);
 return checkpointId;
}
