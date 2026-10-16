import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {createHash,timingSafeEqual} from 'node:crypto';
import {withImmediateTransaction} from '../db/database.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import {inspectOrdinaryInputBinding} from './ordinary-input-binding.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function rejected():never{throw Error('ordinary_steering_binding_rejected');}

/** Original command lineage only: no admission, dispatch, wake or lease acquisition. */
export function inspectOrdinarySteeringBinding(db:DatabaseSync,runId:string,sessionId:string,commandId:string,lease:unknown){
 return withImmediateTransaction(db,()=>{
  if(!ID.test(commandId)||commandId===runId)rejected();
  const parent=inspectOrdinaryInputBinding(db,runId,sessionId,lease);
  const command=db.prepare('SELECT id,run_id,kind,payload_json,status FROM ga_run_commands WHERE id=? AND run_id=?').get(commandId,runId);
  if(!command||command.kind!=='steer'||!['pending','applied'].includes(String(command.status))||typeof command.payload_json!=='string')rejected();
  const payload=JSON.parse(String(command.payload_json)) as Record<string,unknown>;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='client_message_id,expected_run_version,text'
   ||typeof payload.text!=='string'||!payload.text.trim()||typeof payload.client_message_id!=='string'||!ID.test(payload.client_message_id)
   ||!Number.isSafeInteger(payload.expected_run_version)||Number(payload.expected_run_version)<1)rejected();
  const current=db.prepare('SELECT version FROM ga_runs WHERE id=?').get(runId);if(!Number.isSafeInteger(current?.version)||Number(payload.expected_run_version)>Number(current?.version))rejected();
  const messageId='message-'+commandId,content={blocks:[{block_id:messageId+':text',kind:'text',text:payload.text}],attachments:[]};
  const serialized=JSON.stringify(content);
  // The existing dispatcher uses this exact deterministic message identity and
  // representation. A collision must not be turned into a second native input.
  const existing=db.prepare(`SELECT id,run_id,conversation_id,role,status,content_json,client_message_id FROM ga_messages
   WHERE id=? OR (conversation_id=? AND client_message_id=?)`).all(messageId,parent.conversation_id,payload.client_message_id);
  if(existing.length>1||command.status==='applied'&&existing.length!==1)rejected();
  if(existing.length){const row=existing[0]!;if(row.id!==messageId||row.run_id!==runId||row.conversation_id!==parent.conversation_id
   ||row.role!=='user'||row.status!=='complete'||row.client_message_id!==payload.client_message_id||row.content_json!==serialized)rejected();}
  return Object.freeze({protocol:1 as const,kind:'ordinary_steer' as const,run_id:runId,request_id:commandId,command_id:commandId,
   input_message_id:messageId,original_input_message_id:parent.input_message_id,conversation_id:parent.conversation_id,owner_id:parent.owner_id,session_id:sessionId,
   execution_lease:parent.execution_lease,original_input_sha256:parent.input_sha256,command_sha256:sha(String(command.payload_json)),input_sha256:sha(serialized),
   // Keep the existing native wire normalization separate from product text.
   native_content_sha256:sha(JSON.stringify([{type:'text',text:payload.text.trim()}])),execution_authorized:false as const});
 });
}

export function registerOrdinarySteeringBinding(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-steering-binding',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const body=request.body as Record<string,unknown>;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='command_id,execution_lease,run_id,session_ref'
   ||!['run_id','command_id','session_ref'].every(key=>typeof body[key]==='string'&&ID.test(body[key] as string)))return reply.code(422).send({error:{code:'ORDINARY_STEERING_BINDING_INVALID'}});
  let lease;try{lease=normalizeExecutionLease(body.execution_lease);}catch{return reply.code(422).send({error:{code:'ORDINARY_STEERING_BINDING_INVALID'}});}
  try{return {binding:inspectOrdinarySteeringBinding(db,String(body.run_id),String(body.session_ref),String(body.command_id),lease)};}
  catch{return reply.code(409).send({error:{code:'ORDINARY_STEERING_BINDING_REJECTED'}});}
 });
}
