import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {EventStore} from '../events/event-store.ts';
import type {RunRepository} from '../runs/repository.ts';
import {assertExecutionLease,normalizeExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';
import {validateConversationGoalView} from '../harness/conversation-goal-view.ts';

type ResumeRequest={ownerId:string;conversationId:string;sessionId:string;idempotencyKey:string;ref:{id:string;revision:number}};
type Accepted={accepted:true;control_id:string;run_id:string;conversation_id:string};
type ControlRow={control_id:string;owner_id:string;conversation_id:string;session_id:string;source_run_id:string;run_id:string;goal_id:string;goal_revision:number;idempotency_key:string;request_sha256:string;state:'queued'|'dispatching'|'applied'|'rejected';native_cursor:number|null;dispatch_lease_owner:string|null;dispatch_lease_generation:number|null;dispatch_observer_id:string|null;receipt_json:string|null};
const active="'queued','starting','running','waiting_user','waiting_approval','cancelling'";
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
export function validateGoalControlRejection(value:unknown):{rejected:true;mutation:'not_called';reason_code:string}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('goal_control_rejection_invalid');
 const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='mutation,reason_code,rejected'||row.rejected!==true||row.mutation!=='not_called'||typeof row.reason_code!=='string'||!['GOAL_CONTEXT_RECOVERY_REQUIRED','GOAL_REVISION_CHANGED','GOAL_NOT_RESUMABLE','GOAL_RESUME_NOT_APPLIED'].includes(row.reason_code))throw Error('goal_control_rejection_invalid');
 return structuredClone(value) as {rejected:true;mutation:'not_called';reason_code:string};
}

/** Durable human command intent, not another Goal state machine or scheduler.
 * Only a Worker with an attached native follower may call begin. No method
 * here activates an Agent, supplies a model prompt, or grants tool permission.
 */
export class ConversationGoalControls {
 private readonly db:DatabaseSync;
 private readonly events:EventStore;
 private readonly runs:RunRepository;
 constructor(db:DatabaseSync,events:EventStore,runs:RunRepository){this.db=db;this.events=events;this.runs=runs;}
 private static scope(db:DatabaseSync,ownerId:string,conversationId:string,sessionId:string,sourceRunId?:string){
  const c=db.prepare('SELECT owner_id,archived_at,mode FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId);
  if(!c)throw Error('conversation_not_found');
  if(c.archived_at)throw Error('goal_control_run_revoked');
  if(sourceRunId===undefined&&c.mode!=='work')throw Error('goal_control_scope_invalid');
  const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if((table('wb_agents')&&db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(conversationId,ownerId))
   ||(table('wb_run_bindings')&&db.prepare('SELECT 1 FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id WHERE r.conversation_id=? AND b.owner_id=? LIMIT 1').get(conversationId,ownerId)))throw Error('goal_control_scope_invalid');
  const binding=sourceRunId===undefined
   ?(db.prepare("SELECT session_id FROM ga_conversation_mode_sessions WHERE conversation_id=? AND owner_id=? AND mode='work'").get(conversationId,ownerId)
     ??db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?').get(conversationId,ownerId))
   :db.prepare('SELECT session_id FROM ga_run_native_sessions WHERE run_id=? AND conversation_id=? AND owner_id=?').get(sourceRunId,conversationId,ownerId);
  if(!binding||binding.session_id!==sessionId)throw Error('goal_control_session_changed');
 }
 private accepted(row:ControlRow):Accepted{return {accepted:true,control_id:row.control_id,run_id:row.run_id,conversation_id:row.conversation_id};}
 acceptedFor(input:ResumeRequest):Accepted|undefined{
  const prior=this.db.prepare('SELECT * FROM ga_conversation_goal_controls WHERE owner_id=? AND conversation_id=? AND idempotency_key=?').get(input.ownerId,input.conversationId,input.idempotencyKey) as ControlRow|undefined;
  ConversationGoalControls.scope(this.db,input.ownerId,input.conversationId,input.sessionId,prior?.source_run_id);
  if(!prior)return undefined;
  const digest=createHash('sha256').update(JSON.stringify({action:'resume',id:input.ref.id,revision:input.ref.revision,session_id:input.sessionId})).digest('hex');
  if(prior.request_sha256!==digest)throw Error('goal_control_idempotency_conflict');
  return this.accepted(prior);
 }
 enqueue(input:ResumeRequest,nativeView:unknown):Accepted{
  if(!input||!identifier(input.ownerId)||!identifier(input.conversationId)||!identifier(input.sessionId)
    ||!identifier(input.ref?.id)||!Number.isSafeInteger(input.ref?.revision)||input.ref.revision<1||input.ref.revision===Number.MAX_SAFE_INTEGER
    ||typeof input.idempotencyKey!=='string'||!/^[\x21-\x7e]{8,128}$/.test(input.idempotencyKey))throw Error('goal_control_input_invalid');
  const digest=createHash('sha256').update(JSON.stringify({action:'resume',id:input.ref.id,revision:input.ref.revision,session_id:input.sessionId})).digest('hex');
  return withImmediateTransaction(this.db,()=>{
   const prior=this.db.prepare('SELECT * FROM ga_conversation_goal_controls WHERE owner_id=? AND conversation_id=? AND idempotency_key=?').get(input.ownerId,input.conversationId,input.idempotencyKey) as ControlRow|undefined;
   ConversationGoalControls.scope(this.db,input.ownerId,input.conversationId,input.sessionId,prior?.source_run_id);
   if(prior){if(prior.request_sha256!==digest)throw Error('goal_control_idempotency_conflict');return this.accepted(prior);}
   if(this.db.prepare("SELECT 1 FROM ga_conversation_goal_controls WHERE conversation_id=? AND state='dispatching'").get(input.conversationId))throw Error('goal_control_dispatch_unknown');
   if(this.db.prepare(`SELECT 1 FROM ga_runs WHERE conversation_id=? AND status IN (${active}) LIMIT 1`).get(input.conversationId))throw Error('goal_control_run_busy');
   const {goal}=validateConversationGoalView(nativeView);
   if(!goal||goal.id!==input.ref.id||goal.revision!==input.ref.revision)throw Error('goal_control_revision_changed');
   if(goal.phase==='complete'||goal.activation==='armed'||(goal.maxGoalRounds!==undefined&&goal.roundsStarted!==undefined&&goal.roundsStarted>=goal.maxGoalRounds))throw Error('goal_control_not_resumable');
   const source=this.db.prepare("SELECT r.id,r.input_message_id FROM ga_runs r JOIN ga_run_native_sessions s ON s.run_id=r.id WHERE r.conversation_id=? AND s.session_id=? AND r.input_message_id IS NOT NULL ORDER BY r.created_at DESC,r.id DESC LIMIT 1").get(input.conversationId,input.sessionId) as {id:string;input_message_id:string}|undefined;
   if(!source)throw Error('goal_control_source_missing');
   const controlId=`goal-control-${randomUUID()}`,runId=`run-${randomUUID()}`,now=new Date().toISOString();
   // Keep lineage through the original run, with no replayable input message.
   // A legacy input join must not recover the original human prompt.
   this.db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,continuation_of,version,created_at,updated_at,native_session_ref,native_owner_id,native_conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(runId,input.conversationId,null,'queued',source.id,1,now,now,input.sessionId,input.ownerId,input.conversationId);
   this.db.prepare("INSERT INTO ga_conversation_goal_controls(control_id,owner_id,conversation_id,session_id,source_run_id,run_id,goal_id,goal_revision,idempotency_key,request_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)").run(controlId,input.ownerId,input.conversationId,input.sessionId,source.id,runId,input.ref.id,input.ref.revision,input.idempotencyKey,digest,now,now);
   this.events.append(input.conversationId,runId,'run.state',this.runs.get(runId,input.ownerId));
   this.db.prepare('INSERT INTO ga_outbox(conversation_id,aggregate_type,aggregate_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(input.conversationId,'run',runId,'run.queued',JSON.stringify({run_id:runId}),now);
   return {accepted:true,control_id:controlId,run_id:runId,conversation_id:input.conversationId};
  });
 }
 static assertExecution(db:DatabaseSync,controlId:string,lease:unknown):ControlRow{
  const row=db.prepare('SELECT * FROM ga_conversation_goal_controls WHERE control_id=?').get(controlId) as ControlRow|undefined;
  if(!row)throw Error('goal_control_not_found');
  const execution=assertExecutionLease(db,row.run_id,lease);ConversationGoalControls.scope(db,row.owner_id,row.conversation_id,row.session_id,row.source_run_id);
  const run=db.prepare('SELECT status,conversation_id,input_message_id,continuation_of FROM ga_runs WHERE id=?').get(row.run_id);
  const source=db.prepare('SELECT conversation_id,input_message_id FROM ga_runs WHERE id=?').get(row.source_run_id);
  if(!run||run.status!=='running'||run.conversation_id!==row.conversation_id||run.continuation_of!==row.source_run_id||!source||source.conversation_id!==row.conversation_id||typeof source.input_message_id!=='string'||run.input_message_id!==null)throw Error('goal_control_run_revoked');
  if(row.state!=='queued'&&(row.dispatch_lease_owner!==execution.owner||row.dispatch_lease_generation!==execution.generation))throw Error('goal_control_dispatch_unknown');
  return row;
 }
 inspect(controlId:string,lease:unknown){
  const row=ConversationGoalControls.assertExecution(this.db,controlId,lease);
  return {control_id:row.control_id,run_id:row.run_id,conversation_id:row.conversation_id,session_id:row.session_id,ref:{id:row.goal_id,revision:row.goal_revision},state:row.state,native_cursor:row.native_cursor,observer_id:row.dispatch_observer_id,receipt:row.receipt_json?JSON.parse(row.receipt_json) as Record<string,unknown>:null};
 }
 begin(controlId:string,lease:unknown,cursor:number,observerId:string){
  if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('goal_control_cursor_invalid');
  if(!identifier(observerId))throw Error('goal_control_observer_invalid');
  return withImmediateTransaction(this.db,()=>{
   const row=ConversationGoalControls.assertExecution(this.db,controlId,lease);
   if(row.state!=='queued'){
    if(row.dispatch_observer_id!==observerId)throw Error('goal_control_observer_changed');
    if(row.native_cursor!==cursor)throw Error('goal_control_dispatch_unknown');
    return {acquired:false as const,state:row.state};
   }
   const execution=normalizeExecutionLease(lease);
   this.db.prepare("UPDATE ga_conversation_goal_controls SET state='dispatching',native_cursor=?,dispatch_lease_owner=?,dispatch_lease_generation=?,dispatch_observer_id=?,updated_at=? WHERE control_id=? AND state='queued'").run(cursor,execution.owner,execution.generation,observerId,new Date().toISOString(),controlId);
   return {acquired:true as const,state:'dispatching' as const};
  });
 }
 applied(controlId:string,lease:ExecutionLease,value:unknown,observerId:string){
  const receipt=validateConversationGoalView(value);
  return withImmediateTransaction(this.db,()=>{
   const row=ConversationGoalControls.assertExecution(this.db,controlId,lease);
   if(!identifier(observerId)||row.dispatch_observer_id!==observerId)throw Error('goal_control_observer_changed');
   if(row.state==='applied'){
    const previous=JSON.parse(row.receipt_json!);
    if(JSON.stringify(previous)!==JSON.stringify(receipt))throw Error('goal_control_receipt_conflict');
    return previous as typeof receipt;
   }
   if(row.state!=='dispatching'||!receipt.goal||receipt.goal.id!==row.goal_id||receipt.goal.revision!==row.goal_revision+1||receipt.goal.phase!=='active'||receipt.goal.activation!=='armed')throw Error('goal_control_receipt_invalid');
   this.db.prepare("UPDATE ga_conversation_goal_controls SET state='applied',receipt_json=?,updated_at=? WHERE control_id=? AND state='dispatching'").run(JSON.stringify(receipt),new Date().toISOString(),controlId);
   return receipt;
  });
 }
 /** Trusted Host attestation made only before invoking the native mutation.
  * A timeout, matching current Goal or failed flush is never such proof.
  */
 rejectBeforeNative(controlId:string,lease:unknown,reasonCode:string,observerId:string){
  const receipt=validateGoalControlRejection({rejected:true,mutation:'not_called',reason_code:reasonCode});
  if(!identifier(observerId))throw Error('goal_control_observer_invalid');
  return withImmediateTransaction(this.db,()=>{
   const row=ConversationGoalControls.assertExecution(this.db,controlId,lease);
   if(row.state!=='queued'&&row.dispatch_observer_id!==observerId)throw Error('goal_control_observer_changed');
   if(row.state==='rejected'){
    const previous=validateGoalControlRejection(JSON.parse(row.receipt_json!));
    if(JSON.stringify(previous)!==JSON.stringify(receipt))throw Error('goal_control_receipt_conflict');
    return previous;
   }
   if(!['queued','dispatching'].includes(row.state))throw Error('goal_control_receipt_conflict');
   const execution=normalizeExecutionLease(lease);
   this.db.prepare("UPDATE ga_conversation_goal_controls SET state='rejected',receipt_json=?,dispatch_lease_owner=?,dispatch_lease_generation=?,dispatch_observer_id=?,updated_at=? WHERE control_id=?").run(JSON.stringify(receipt),execution.owner,execution.generation,observerId,new Date().toISOString(),controlId);
   return receipt;
  });
 }
}
