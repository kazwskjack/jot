import type {DatabaseSync} from 'node:sqlite';import type {FastifyInstance} from 'fastify';
import {createHash,timingSafeEqual} from 'node:crypto';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinarySteeringHistory} from './ordinary-steering-history.ts';
import {runtimeSessionRefForRun} from '../harness/run-session-identity.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const recordHash=(value:unknown)=>sha(JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v));
type Scope={owner_id:string;conversation_id:string;session_ref:string;run_id:string;expected_run_version:number};
function rejected():never{throw Error('ordinary_run_history_rejected');}
function validScope(value:unknown):value is Scope{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const row=value as Record<string,unknown>;
 return Object.keys(row).sort().join(',')==='conversation_id,expected_run_version,owner_id,run_id,session_ref'&&['owner_id','conversation_id','session_ref','run_id'].every(k=>typeof row[k]==='string'&&ID.test(row[k] as string))&&Number.isSafeInteger(row.expected_run_version)&&Number(row.expected_run_version)>0;
}
/** Complete product-source observation only. No lease/admission, final-answer
 * certification, publication, replay, wake, state repair or fee settlement. */
export function inspectOrdinaryRunHistory(db:DatabaseSync,scope:Scope){
 return withImmediateTransaction(db,()=>{
  if(!validScope(scope))rejected();
  const run=db.prepare('SELECT rowid source_rowid,* FROM ga_runs WHERE id=? AND conversation_id=?').get(scope.run_id,scope.conversation_id);
  const conversation=db.prepare('SELECT * FROM ga_conversations WHERE id=?').get(scope.conversation_id),binding=db.prepare('SELECT * FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?').get(scope.conversation_id,scope.owner_id);
  if(!run||!['succeeded','failed','interrupted','partial'].includes(String(run.status))||run.version!==scope.expected_run_version||typeof run.input_message_id!=='string'||conversation?.owner_id!==scope.owner_id||conversation.archived_at!==null||binding?.session_id!==scope.session_ref||run.continuation_of!==null)rejected();
  if(db.prepare('SELECT 1 FROM ga_runs WHERE conversation_id=? AND rowid>?').get(scope.conversation_id,run.source_rowid!)||db.prepare("SELECT 1 FROM ga_run_commands WHERE run_id=? AND kind<>'steer'").get(scope.run_id))rejected();
  const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if((table('wb_agents')&&db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(scope.conversation_id,scope.owner_id))||(table('wb_run_bindings')&&db.prepare('SELECT 1 FROM wb_run_bindings WHERE run_id=?').get(scope.run_id))||db.prepare('SELECT 1 FROM ga_conversation_goal_controls WHERE run_id=?').get(scope.run_id))rejected();
  const input=db.prepare('SELECT * FROM ga_messages WHERE id=?').get(run.input_message_id);
  if(!input||input.run_id!==scope.run_id||input.conversation_id!==scope.conversation_id||input.role!=='user'||input.status!=='complete'||typeof input.content_json!=='string')rejected();
  const lease=db.prepare('SELECT * FROM ga_worker_leases WHERE resource_id=?').get(scope.run_id);
  if(lease&&(typeof lease.owner!=='string'||!ID.test(lease.owner)||!Number.isSafeInteger(lease.generation)||Number(lease.generation)<1||typeof lease.expires_at!=='string'||!/^\d+$/.test(lease.expires_at)||!Number.isSafeInteger(Number(lease.expires_at))||Number(lease.expires_at)>Date.now()))rejected();
  const runtime=db.prepare('SELECT * FROM ga_runtime_bindings WHERE run_id=?').get(scope.run_id);if(runtime&&runtime.harness_session_ref!==runtimeSessionRefForRun(scope.run_id))rejected();
  const commandRows=db.prepare('SELECT * FROM ga_run_commands WHERE run_id=? ORDER BY created_at,rowid').all(scope.run_id);
  const commands=commandRows.map((row,position)=>{if(typeof row.id!=='string')rejected();return{...inspectOrdinarySteeringHistory(db,{...scope,command_id:row.id}),position,record_sha256:recordHash(row)};});
  const humanIds=new Set([run.input_message_id,...commands.filter(c=>c.product_message_present).map(c=>c.input_message_id)]);
  const messages=db.prepare('SELECT * FROM ga_messages WHERE run_id=?').all(scope.run_id);
  if(messages.some(m=>m.conversation_id!==scope.conversation_id||!['user','assistant'].includes(String(m.role))||m.role==='user'&&(!humanIds.has(String(m.id))||m.status!=='complete'))||messages.filter(m=>m.role==='user').length!==humanIds.size)rejected();
  const answers=messages.filter(m=>m.role==='assistant');if(answers.length>1)rejected();let canonical=null;
  if(answers.length){const answer=answers[0]!;if(typeof answer.id!=='string'||!ID.test(answer.id)||!['complete','streaming','partial','failed'].includes(String(answer.status))||typeof answer.content_json!=='string')rejected();const content=JSON.parse(answer.content_json);if(!content||typeof content!=='object'||Array.isArray(content)||!Array.isArray(content.blocks)||!Array.isArray(content.attachments))rejected();canonical={message_id:answer.id,status:answer.status,content_sha256:sha(answer.content_json),record_sha256:recordHash(answer)};}
  const candidates=db.prepare('SELECT * FROM ga_candidate_answers WHERE run_id=? ORDER BY attempt,created_at,id').all(scope.run_id).map(row=>{
   if(typeof row.id!=='string'||!ID.test(row.id)||row.input_message_id!==run.input_message_id||row.turn_id!==scope.run_id||!Number.isSafeInteger(row.attempt)||Number(row.attempt)<1||typeof row.text!=='string'||typeof row.source!=='string'||typeof row.source_version!=='string'||typeof row.evidence_refs_json!=='string'||!['pending','verified','partial','failed','outcome_unknown'].includes(String(row.status)))rejected();
   return{id:row.id,attempt:row.attempt,source_sha256:sha(row.source),source_version_sha256:sha(row.source_version),status:row.status,text_sha256:sha(row.text),evidence_sha256:sha(row.evidence_refs_json),record_sha256:recordHash(row)};
  });
  return Object.freeze({protocol:1,kind:'ordinary_run_history',run_id:scope.run_id,input_message_id:run.input_message_id,input_sha256:sha(input.content_json),owner_id:scope.owner_id,conversation_id:scope.conversation_id,session_id:scope.session_ref,run_status:run.status,run_version:run.version,run_state_sha256:recordHash(run),conversation_state_sha256:recordHash(conversation),session_binding_sha256:recordHash(binding),runtime_binding_sha256:runtime?recordHash(runtime):null,worker_lease_sha256:lease?recordHash(lease):null,commands,canonical,candidates,execution_authorized:false});
 });
}
export function registerOrdinaryRunHistory(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-run-history',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  if(!validScope(request.body))return reply.code(422).send({error:{code:'ORDINARY_RUN_HISTORY_INVALID'}});
  try{return{history:inspectOrdinaryRunHistory(db,request.body)};}catch{return reply.code(409).send({error:{code:'ORDINARY_RUN_HISTORY_REJECTED'}});}
 });
}
