import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {RunRepository} from '../runs/repository.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {ChannelDeliveryService} from '../channels/delivery.ts';
import {currentTaskBusinessCertificate} from './business-review.ts';
import {preparedTaskCompletion,confirmTaskCompletion} from './completion-handshake.ts';
import {publishTaskOutputs} from './output-delivery.ts';
import {TaskNotifications} from './notifications.ts';

export function installTaskFinalizations(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_finalizations (
  occurrence_id TEXT PRIMARY KEY REFERENCES wb_task_occurrences(occurrence_id),owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ga_runs(id),intent_id TEXT NOT NULL UNIQUE REFERENCES wb_task_native_completions(intent_id),
  certificate_id TEXT NOT NULL UNIQUE REFERENCES wb_task_business_certificates(certificate_id),
  message_id TEXT NOT NULL UNIQUE REFERENCES ga_messages(id),receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_task_finalizations_no_update BEFORE UPDATE ON wb_task_finalizations
   BEGIN SELECT RAISE(ABORT,'task_finalization_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_finalizations_no_delete BEFORE DELETE ON wb_task_finalizations
   BEGIN SELECT RAISE(ABORT,'task_finalization_immutable'); END;`);
}
type Receipt={occurrence_id:string;run_id:string;message_id:string;certificate_id:string;intent_id:string;status:'succeeded';delivery_effect_ids:string[]};
/** Invoked only by Coordinator's Immediate transaction after the native
 * completion handshake. No model/tool or browser supplied text is accepted. */
export function finalizeReviewedTask(db:DatabaseSync,runs:RunRepository,owner:string,runId:string,intentId:string):Receipt{
 if(!db.isTransaction)throw new Error('task_finalization_transaction_required');
 const prior=db.prepare(`SELECT f.* FROM wb_task_finalizations f JOIN ga_runs r ON r.id=f.run_id
  JOIN ga_conversations c ON c.id=r.conversation_id WHERE f.run_id=? AND f.owner_id=? AND c.owner_id=?`).get(runId,owner,owner) as Record<string,string>|undefined;
 if(prior){
  if(prior.intent_id!==intentId)throw new Error('task_finalization_conflict');
  // Historical receipt recovery is read-only; it does not grant a new effect
  // or renew authority after a later role/task change.
  return JSON.parse(prior.receipt_json!) as Receipt;
 }
 const frozen=currentTaskBusinessCertificate(db,owner,runId),intent=preparedTaskCompletion(db,owner,runId);
 if(intent.intent_id!==intentId)throw new Error('task_finalization_conflict');
 const stored=db.prepare('SELECT proof_json FROM wb_task_native_completions WHERE intent_id=?').get(intentId) as {proof_json:string}|undefined;
 if(!stored)throw new Error('task_finalization_unconfirmed');
 const native=confirmTaskCompletion(db,owner,runId,intentId,JSON.parse(stored.proof_json)).proof;
 const scope=frozen.snapshot,run=runs.get(runId,owner);
 if(!run||db.prepare('SELECT 1 FROM wb_task_finalizations WHERE occurrence_id=?').get(scope.occurrence_id)
  ||db.prepare(`SELECT 1 FROM ga_worker_leases l JOIN wb_task_run_occurrences o ON o.run_id=l.resource_id WHERE o.occurrence_id=?`).get(scope.occurrence_id)
  ||db.prepare(`SELECT 1 FROM ga_messages m JOIN wb_task_run_occurrences o ON o.run_id=m.run_id
   WHERE o.occurrence_id=? AND m.role='assistant'`).get(scope.occurrence_id))throw new Error('task_finalization_conflict');
 const notifications=new TaskNotifications(db),configuredTargets=notifications.targets(owner,scope.task_id);
 const channels=configuredTargets??db.prepare(`SELECT b.principal,'wecom' AS channel FROM ga_channel_bindings b JOIN ga_conversations c ON c.id=b.conversation_id
  WHERE b.channel='wecom' AND b.conversation_id=? AND c.owner_id=?`).all(String(run.conversation_id),owner) as {principal:string;channel:string}[];
 if(configuredTargets===undefined&&channels.length>1)throw new Error('task_channel_binding_ambiguous');
 const now=new Date().toISOString(),checkpointId=`checkpoint-${randomUUID()}`,cp=native.checkpoint;
 const changed=db.prepare('UPDATE wb_native_goal_bindings SET goal_revision=?,updated_at=? WHERE run_id=? AND goal_id=? AND goal_revision=?')
  .run(native.goal.goal_revision,now,scope.root_run_id,scope.goal_id,scope.goal_revision).changes;
 if(changed!==1)throw new Error('task_finalization_conflict');
 // The regular checkpoint writer requires an executing lease. This stopped
 // completion path instead binds its immutable controller receipt and updates
 // mapping/checkpoint/publication atomically, without broadening that writer.
 db.prepare('INSERT INTO ga_session_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)').run(checkpointId,runId,String(run.conversation_id),cp.session_ref,
  cp.seq_exclusive,cp.turn_end_seq,cp.goal_id,cp.goal_revision,cp.log_sha256,now);
 db.prepare('UPDATE ga_runs SET checkpoint_id=? WHERE id=?').run(checkpointId,runId);
 const answer=runs.saveCandidate(runId,frozen.candidate.text,1,'task-business-accepted','1');
 if(answer.text!==frozen.candidate.text||answer.status!=='pending')throw new Error('task_finalization_conflict');
 db.prepare("UPDATE ga_candidate_answers SET status='verified',evidence_refs_json=?,updated_at=? WHERE id=? AND status='pending'")
  .run(canonicalJson([frozen.certificate_id,intentId]),now,String(answer.id));
 // Only the text shown in the owner review card is published. Provider
 // reasoning/unreviewed alternative blocks do not become a final answer.
 const attachmentIds=publishTaskOutputs(db,frozen,runId,String(run.conversation_id));
 const message=runs.appendAssistant(runId,frozen.candidate.text,undefined,attachmentIds);
 if(canonicalJson(message.attachments??[])!==canonicalJson(attachmentIds))throw new Error('task_output_attachment_conflict');
 runs.finalizePublication(runId,'succeeded',null);
 const delivery_effect_ids:string[]=[];
 for(const channel of channels){
  if(channel.channel!=='wecom'&&channel.channel!=='email')throw new Error('task_delivery_channel_invalid');
  const store=new ChannelDeliveryService(db),delivery=store.enqueueText({runId,messageId:String(message.message_id),destination:channel.channel,recipient:channel.principal,text:frozen.candidate.text});
  if(!delivery)throw new Error('task_delivery_enqueue_failed');delivery_effect_ids.push(String(delivery.effect_id));
  store.bindTaskAuthorization(String(delivery.effect_id),scope,String(run.conversation_id),channel.principal);
  if(configuredTargets)notifications.grant(String(delivery.effect_id),owner,scope.task_id,channel as typeof configuredTargets[number]);
 }
 const evidence=JSON.parse(String((db.prepare('SELECT evidence_json FROM wb_task_occurrences WHERE occurrence_id=?').get(scope.occurrence_id) as {evidence_json:string}).evidence_json));
 evidence.push({kind:'business_certificate',reference:frozen.certificate_id},{kind:'native_completion',reference:intentId},{kind:'final_message',reference:String(message.message_id)});
 db.prepare("UPDATE wb_task_occurrences SET status='succeeded',business_state='completed',evidence_json=?,updated_at=? WHERE occurrence_id=?").run(canonicalJson(evidence),now,scope.occurrence_id);
 db.prepare('UPDATE wb_persistent_tasks SET projection_pending=1 WHERE task_id=?').run(scope.task_id);
 const receipt:Receipt={occurrence_id:scope.occurrence_id,run_id:runId,message_id:String(message.message_id),certificate_id:frozen.certificate_id,intent_id:intentId,status:'succeeded',delivery_effect_ids};
 db.prepare('INSERT INTO wb_task_finalizations VALUES(?,?,?,?,?,?,?,?)').run(scope.occurrence_id,owner,runId,intentId,frozen.certificate_id,String(message.message_id),canonicalJson(receipt),now);
 return receipt;
}
