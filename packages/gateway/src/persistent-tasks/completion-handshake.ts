import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {savedSessionCheckpoint,validateCheckpoint} from '../harness/session-checkpoints.ts';
import {currentTaskBusinessCertificate} from './business-review.ts';

type NativeBoundary={host_status:'idle';goal:{goal_id:string;goal_revision:number;phase:'paused'|'blocked'|'complete';
 activation:'disarmed';rounds_started:number;max_goal_rounds:number}};
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function boundary(value:unknown):NativeBoundary{
 if(!exact(value,['host_status','goal'])||value.host_status!=='idle'||!exact(value.goal,['goal_id','goal_revision','phase','activation','rounds_started','max_goal_rounds']))throw new Error('task_completion_handshake_invalid');
 const g=value.goal;
 if(typeof g.goal_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(g.goal_id)
  ||!Number.isSafeInteger(g.goal_revision)||Number(g.goal_revision)<1||g.activation!=='disarmed'
  ||!['paused','blocked','complete'].includes(String(g.phase))||!Number.isSafeInteger(g.rounds_started)||Number(g.rounds_started)<0
  ||!Number.isSafeInteger(g.max_goal_rounds)||Number(g.max_goal_rounds)<1||Number(g.rounds_started)>Number(g.max_goal_rounds))throw new Error('task_completion_handshake_invalid');
 return structuredClone(value) as NativeBoundary;
}
// Pure historical parsing only; this export grants no completion or execution.
export {boundary as validateTaskCompletionBoundary};
export function installTaskCompletionHandshake(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_completion_intents (
  intent_id TEXT PRIMARY KEY,certificate_id TEXT NOT NULL UNIQUE REFERENCES wb_task_business_certificates(certificate_id),
  owner_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES ga_runs(id),occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),
  session_ref TEXT NOT NULL,before_json TEXT NOT NULL,checkpoint_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,candidate_hash TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wb_task_native_completions (
  intent_id TEXT PRIMARY KEY REFERENCES wb_task_completion_intents(intent_id),proof_json TEXT NOT NULL,proof_hash TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_task_completion_intents_no_update BEFORE UPDATE ON wb_task_completion_intents
   BEGIN SELECT RAISE(ABORT,'task_completion_intent_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_completion_intents_no_delete BEFORE DELETE ON wb_task_completion_intents
   BEGIN SELECT RAISE(ABORT,'task_completion_intent_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_native_completions_no_update BEFORE UPDATE ON wb_task_native_completions
   BEGIN SELECT RAISE(ABORT,'task_native_completion_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_native_completions_no_delete BEFORE DELETE ON wb_task_native_completions
   BEGIN SELECT RAISE(ABORT,'task_native_completion_immutable'); END;`);
}
function transaction(db:DatabaseSync){if(!db.isTransaction)throw new Error('task_completion_handshake_transaction_required');}
/** Trusted host preparation, never a model tool. The native boundary must be
 * observed from the authenticated controller before its CAS; it is not a claim
 * supplied by a browser. This durable intent alone grants no publication. */
export function prepareTaskCompletion(db:DatabaseSync,owner:string,runId:string,observed:unknown){
 transaction(db);const frozen=currentTaskBusinessCertificate(db,owner,runId),before=boundary(observed);
 const checkpoint=savedSessionCheckpoint(db,runId);
 if(!checkpoint||before.goal.phase==='complete'||before.goal.goal_id!==frozen.snapshot.goal_id
  ||before.goal.goal_revision!==frozen.snapshot.goal_revision)throw new Error('task_completion_handshake_conflict');
 const snapshotHash=hash(frozen.snapshot),candidateHash=hash(frozen.candidate);
 let row=db.prepare('SELECT * FROM wb_task_completion_intents WHERE certificate_id=?').get(frozen.certificate_id) as Record<string,string>|undefined;
 if(row){
  if(row.owner_id!==owner||row.run_id!==runId||row.before_json!==canonicalJson(before)||row.checkpoint_json!==canonicalJson(checkpoint)
   ||row.snapshot_hash!==snapshotHash||row.candidate_hash!==candidateHash)throw new Error('task_completion_handshake_conflict');
 }else{
  const id=`task-completion-${randomUUID()}`;
  db.prepare('INSERT INTO wb_task_completion_intents VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,frozen.certificate_id,owner,runId,
   frozen.snapshot.occurrence_id,checkpoint.session_ref,canonicalJson(before),canonicalJson(checkpoint),snapshotHash,candidateHash,new Date().toISOString());
  row=db.prepare('SELECT * FROM wb_task_completion_intents WHERE intent_id=?').get(id) as Record<string,string>;
 }
 return {intent_id:row.intent_id!,session_ref:row.session_ref!,before,checkpoint};
}
/** Recover the pinned pre-CAS intent after a host/process restart. The caller
 * must observe native state first: if already complete, capture and confirm;
 * if unchanged, it may perform the exact original CAS. Never create a Goal. */
export function preparedTaskCompletion(db:DatabaseSync,owner:string,runId:string){
 transaction(db);const frozen=currentTaskBusinessCertificate(db,owner,runId);
 const row=db.prepare('SELECT * FROM wb_task_completion_intents WHERE certificate_id=? AND owner_id=? AND run_id=?')
  .get(frozen.certificate_id,owner,runId) as Record<string,string>|undefined;
 if(!row)throw new Error('task_completion_handshake_not_found');
 const before=boundary(JSON.parse(row.before_json!)),checkpoint=validateCheckpoint(JSON.parse(row.checkpoint_json!));
 if(row.snapshot_hash!==hash(frozen.snapshot)||row.candidate_hash!==hash(frozen.candidate)
  ||before.goal.goal_id!==frozen.snapshot.goal_id||before.goal.goal_revision!==frozen.snapshot.goal_revision
  ||checkpoint.session_ref!==row.session_ref||checkpoint.goal_id!==before.goal.goal_id||checkpoint.goal_revision!==before.goal.goal_revision)
  throw new Error('task_completion_handshake_conflict');
 return {intent_id:row.intent_id!,session_ref:row.session_ref!,before,checkpoint};
}
/** Record a controller-observed CAS result plus a flushed, re-read checkpoint.
 * Exact committed retries recover historical facts only. A future publication
 * transaction must revalidate authority and consume the intent once. */
export function confirmTaskCompletion(db:DatabaseSync,owner:string,runId:string,intentId:string,input:unknown){
 transaction(db);
 const intent=db.prepare(`SELECT p.* FROM wb_task_completion_intents p JOIN ga_runs r ON r.id=p.run_id
  JOIN ga_conversations c ON c.id=r.conversation_id WHERE p.intent_id=? AND p.run_id=? AND p.owner_id=? AND c.owner_id=?`).get(intentId,runId,owner,owner) as Record<string,string>|undefined;
 if(!intent)throw new Error('task_completion_handshake_not_found');
 if(!exact(input,['host_status','goal','checkpoint']))throw new Error('task_completion_handshake_invalid');
 const after=boundary({host_status:input.host_status,goal:input.goal}),checkpoint=validateCheckpoint(input.checkpoint);
 const proof={...after,checkpoint},proofJson=canonicalJson(proof),proofHash=hash(proof);
 const existing=db.prepare('SELECT * FROM wb_task_native_completions WHERE intent_id=?').get(intentId) as Record<string,string>|undefined;
 if(existing){
  if(existing.proof_json!==proofJson||existing.proof_hash!==proofHash)throw new Error('task_completion_handshake_conflict');
  return {intent_id:intentId,confirmed:true as const,proof};
 }
 const frozen=currentTaskBusinessCertificate(db,owner,runId);
 const before=boundary(JSON.parse(intent.before_json!)),original=validateCheckpoint(JSON.parse(intent.checkpoint_json!));
 if(frozen.certificate_id!==intent.certificate_id||hash(frozen.snapshot)!==intent.snapshot_hash||hash(frozen.candidate)!==intent.candidate_hash
  ||after.goal.phase!=='complete'||after.goal.goal_id!==before.goal.goal_id||after.goal.goal_revision!==before.goal.goal_revision+1
  ||after.goal.rounds_started!==before.goal.rounds_started||after.goal.max_goal_rounds!==before.goal.max_goal_rounds
  ||checkpoint.session_ref!==intent.session_ref||checkpoint.goal_id!==after.goal.goal_id||checkpoint.goal_revision!==after.goal.goal_revision
  ||checkpoint.turn_end_seq!==original.turn_end_seq||checkpoint.seq_exclusive<=original.seq_exclusive)throw new Error('task_completion_handshake_conflict');
 db.prepare('INSERT INTO wb_task_native_completions VALUES(?,?,?,?)').run(intentId,proofJson,proofHash,new Date().toISOString());
 return {intent_id:intentId,confirmed:true as const,proof};
}
