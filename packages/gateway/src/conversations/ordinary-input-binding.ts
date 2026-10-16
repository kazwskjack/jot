import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {createHash,timingSafeEqual} from 'node:crypto';
import {withImmediateTransaction} from '../db/database.ts';
import {assertExecutionLease,normalizeExecutionLease} from '../workbench/execution-lease.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

/** Read lineage from the original product records. This does not restore an
 * inbox, activate a driver, reserve model cost, or grant tool permission. */
export function inspectOrdinaryInputBinding(db:DatabaseSync,runId:string,sessionId:string,lease:unknown){
 return withImmediateTransaction(db,()=>{
  const execution=assertExecutionLease(db,runId,lease);
  const row=db.prepare(`SELECT r.id,r.status,r.input_message_id,r.conversation_id,
   c.owner_id,c.archived_at,m.run_id AS message_run_id,m.conversation_id AS message_conversation_id,
   m.role,m.content_json,b.session_id FROM ga_runs r
   JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN ga_messages m ON m.id=r.input_message_id
   JOIN ga_harness_session_bindings b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
   WHERE r.id=?`).get(runId);
  if(!row||row.status!=='running'||row.archived_at||row.session_id!==sessionId||row.role!=='user'
   ||row.message_run_id!==runId||row.message_conversation_id!==row.conversation_id
   ||typeof row.input_message_id!=='string'||typeof row.content_json!=='string'
   ||typeof row.conversation_id!=='string'||typeof row.owner_id!=='string')throw Error('ordinary_input_binding_rejected');
  const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if((table('wb_agents')&&db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(row.conversation_id,row.owner_id))
   ||(table('wb_run_bindings')&&db.prepare('SELECT 1 FROM wb_run_bindings WHERE run_id=?').get(runId))
   ||db.prepare('SELECT 1 FROM ga_conversation_goal_controls WHERE run_id=?').get(runId))throw Error('ordinary_input_binding_rejected');
  return {protocol:1,run_id:runId,request_id:runId,input_message_id:row.input_message_id,
   conversation_id:row.conversation_id,owner_id:row.owner_id,session_id:sessionId,
   execution_lease:execution,input_sha256:createHash('sha256').update(row.content_json).digest('hex'),
   execution_authorized:false};
 });
}

export function registerOrdinaryInputBinding(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-input-binding',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const body=request.body as Record<string,unknown>;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='execution_lease,run_id,session_ref'
   ||typeof body.run_id!=='string'||!ID.test(body.run_id)||typeof body.session_ref!=='string'||!ID.test(body.session_ref))return reply.code(422).send({error:{code:'ORDINARY_INPUT_BINDING_INVALID'}});
  let lease;try{lease=normalizeExecutionLease(body.execution_lease);}catch{return reply.code(422).send({error:{code:'ORDINARY_INPUT_BINDING_INVALID'}});}
  try{return {binding:inspectOrdinaryInputBinding(db,body.run_id,body.session_ref,lease)};}
  catch{return reply.code(409).send({error:{code:'ORDINARY_INPUT_BINDING_REJECTED'}});}
 });
}
