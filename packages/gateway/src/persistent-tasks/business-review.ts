import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {currentTaskCompletionCandidate} from './completion-candidates.ts';
import {taskOutputsDeliverable} from './output-delivery.ts';

export function installTaskBusinessReviews(db:DatabaseSync):void {
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_business_reviews (
  interaction_id TEXT PRIMARY KEY REFERENCES wb_task_wait_interactions(interaction_id),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES wb_task_completion_candidates(candidate_id),owner_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('accepted','rejected')),evaluations_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wb_task_business_certificates (
  certificate_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES wb_task_completion_candidates(candidate_id),
  interaction_id TEXT NOT NULL UNIQUE REFERENCES wb_task_business_reviews(interaction_id),run_id TEXT NOT NULL REFERENCES ga_runs(id),
  occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),snapshot_hash TEXT NOT NULL,candidate_hash TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_task_business_reviews_no_update BEFORE UPDATE ON wb_task_business_reviews
   BEGIN SELECT RAISE(ABORT,'task_business_review_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_business_reviews_no_delete BEFORE DELETE ON wb_task_business_reviews
   BEGIN SELECT RAISE(ABORT,'task_business_review_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_business_certificates_no_update BEFORE UPDATE ON wb_task_business_certificates
   BEGIN SELECT RAISE(ABORT,'task_business_certificate_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_business_certificates_no_delete BEFORE DELETE ON wb_task_business_certificates
   BEGIN SELECT RAISE(ABORT,'task_business_certificate_immutable'); END;`);
}

/** Called only by the owned interaction response transaction, never by model
 * tools. Human judgments attest the frozen criteria, not delivery or a native
 * lifecycle transition. A separate finalization controller must consume them. */
export function recordTaskBusinessReview(db:DatabaseSync,owner:string,interactionId:string,runId:string,answers:unknown):void {
 if(!db.isTransaction)throw new Error('task_completion_state_conflict');
 const binding=db.prepare(`SELECT w.* FROM wb_task_wait_interactions w JOIN ga_interactions i ON i.id=w.interaction_id
  JOIN ga_conversations c ON c.id=i.conversation_id WHERE w.interaction_id=? AND w.run_id=? AND c.owner_id=?
   AND w.purpose='task_acceptance_review' AND i.kind='question' AND i.status='answered'`).get(interactionId,runId,owner);
 if(!binding)throw new Error('task_completion_state_conflict');
 const frozen=currentTaskCompletionCandidate(db,owner,runId),steps=frozen.snapshot.steps;
 if(!Array.isArray(answers)||answers.length!==steps.length)throw new Error('interaction_answer_invalid');
 const byId=new Map<string,Record<string,unknown>>();
 for(const value of answers){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('interaction_answer_invalid');
  const answer=value as Record<string,unknown>,id=String(answer.question_id);
  if(byId.has(id)||!steps.some(step=>step.subtask_id===id)||!Array.isArray(answer.selected_option_ids)
   ||answer.selected_option_ids.length!==1||!['accept','reject'].includes(String(answer.selected_option_ids[0]))
   ||(answer.custom_text!==undefined&&(typeof answer.custom_text!=='string'||answer.custom_text.length>10000)))throw new Error('interaction_answer_invalid');
  byId.set(id,answer);
 }
 const evaluations=steps.map(step=>{const answer=byId.get(step.subtask_id)!;return {subtask_id:step.subtask_id,subtask_version:step.version,
  acceptance:step.acceptance,evidence:step.evidence,method:'owner_confirmation',verdict:(answer.selected_option_ids as string[])[0]==='accept'?'accepted':'rejected',note:String(answer.custom_text??'')};});
 const accepted=evaluations.every(item=>item.verdict==='accepted');
 // References with no verified output-content version cannot be certified by
 // this first review path. Rejected judgments can still be saved truthfully.
 if(accepted&&!taskOutputsDeliverable(db,frozen))throw new Error('task_acceptance_outputs_unverified');
 const now=new Date().toISOString();
 db.prepare('INSERT INTO wb_task_business_reviews VALUES(?,?,?,?,?,?)').run(interactionId,frozen.candidate_id,owner,accepted?'accepted':'rejected',canonicalJson(evaluations),now);
 if(accepted)db.prepare('INSERT INTO wb_task_business_certificates VALUES(?,?,?,?,?,?,?,?)').run(`task-certificate-${randomUUID()}`,frozen.candidate_id,interactionId,runId,frozen.snapshot.occurrence_id,
  createHash('sha256').update(canonicalJson(frozen.snapshot)).digest('hex'),createHash('sha256').update(canonicalJson(frozen.candidate)).digest('hex'),now);
 db.prepare('UPDATE wb_task_occurrences SET business_state=?,updated_at=? WHERE occurrence_id=?').run(accepted?'acceptance_confirmed':'acceptance_rejected',now,frozen.snapshot.occurrence_id);
 db.prepare('UPDATE wb_persistent_tasks SET projection_pending=1 WHERE task_id=?').run(frozen.snapshot.task_id);
}

/** Internal pre-finalization guard. Call inside the eventual publication/CAS
 * transaction and consume the returned certificate there, never outside it.
 * This read does not complete a Goal or authorize an external delivery. */
export function currentTaskBusinessCertificate(db:DatabaseSync,owner:string,runId:string) {
 if(!db.isTransaction)throw new Error('task_business_certificate_transaction_required');
 const proof=db.prepare(`SELECT cert.*,v.evaluations_json,v.verdict,i.status AS interaction_status,
  w.purpose,o.business_state FROM wb_task_business_certificates cert
  JOIN wb_task_business_reviews v ON v.interaction_id=cert.interaction_id AND v.candidate_id=cert.candidate_id
  JOIN ga_interactions i ON i.id=cert.interaction_id AND i.run_id=cert.run_id
  JOIN ga_conversations c ON c.id=i.conversation_id AND c.owner_id=v.owner_id
  JOIN wb_task_wait_interactions w ON w.interaction_id=i.id AND w.run_id=cert.run_id
  JOIN wb_task_occurrences o ON o.occurrence_id=cert.occurrence_id
  WHERE cert.run_id=? AND c.owner_id=?`).get(runId,owner) as Record<string,string>|undefined;
 if(!proof)throw new Error('task_business_certificate_not_found');
 const frozen=currentTaskCompletionCandidate(db,owner,runId);
 if(proof.verdict!=='accepted'||proof.interaction_status!=='answered'||proof.purpose!=='task_acceptance_review'
  ||proof.business_state!=='acceptance_confirmed'||proof.candidate_id!==frozen.candidate_id
  ||proof.occurrence_id!==frozen.snapshot.occurrence_id
  ||proof.snapshot_hash!==createHash('sha256').update(canonicalJson(frozen.snapshot)).digest('hex')
  ||proof.candidate_hash!==createHash('sha256').update(canonicalJson(frozen.candidate)).digest('hex')
  ||!taskOutputsDeliverable(db,frozen))throw new Error('task_business_certificate_state_conflict');
 const evaluations:unknown=JSON.parse(proof.evaluations_json!);
 if(!Array.isArray(evaluations)||evaluations.length!==frozen.snapshot.steps.length)throw new Error('task_business_certificate_state_conflict');
 for(const [index,step] of frozen.snapshot.steps.entries()){
  const judgment=evaluations[index] as Record<string,unknown>|undefined;
  if(!judgment||judgment.subtask_id!==step.subtask_id||judgment.subtask_version!==step.version
   ||judgment.acceptance!==step.acceptance||canonicalJson(judgment.evidence)!==canonicalJson(step.evidence)
   ||judgment.method!=='owner_confirmation'||judgment.verdict!=='accepted'
   ||typeof judgment.note!=='string'||judgment.note.length>10000)throw new Error('task_business_certificate_state_conflict');
 }
 return {...frozen,certificate_id:proof.certificate_id!,evaluations};
}
