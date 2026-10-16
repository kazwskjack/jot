import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {createHash,timingSafeEqual} from 'node:crypto';
import {withImmediateTransaction} from '../db/database.ts';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function rejected():never{throw Error('ordinary_steering_history_rejected');}
type Scope={owner_id:string;conversation_id:string;session_ref:string;run_id:string;command_id:string;expected_run_version:number};
function scopeValid(value:unknown):value is Scope{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const row=value as Record<string,unknown>;
 return Object.keys(row).sort().join(',')==='command_id,conversation_id,expected_run_version,owner_id,run_id,session_ref'
  &&['owner_id','conversation_id','session_ref','run_id','command_id'].every(k=>typeof row[k]==='string'&&ID.test(row[k] as string))
  &&row.command_id!==row.run_id&&Number.isSafeInteger(row.expected_run_version)&&Number(row.expected_run_version)>0;
}

/** Product-source facts only. No live lease, native acceptance, dispatch,
 * replay, reconciliation write, or permission to resume a terminal parent. */
export function inspectOrdinarySteeringHistory(db:DatabaseSync,scope:Scope){
 return withImmediateTransaction(db,()=>{
  if(!scopeValid(scope))rejected();
  const row=db.prepare(`SELECT r.status,r.version,r.input_message_id,m.content_json,
   m.run_id message_run_id,m.conversation_id message_conversation_id,m.role,m.status message_status
   FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN ga_harness_session_bindings b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
   JOIN ga_messages m ON m.id=r.input_message_id
   WHERE r.id=? AND c.id=? AND c.owner_id=? AND c.archived_at IS NULL AND b.session_id=?`)
   .get(scope.run_id,scope.conversation_id,scope.owner_id,scope.session_ref);
  if(!row||!['succeeded','failed','cancelled','interrupted','partial'].includes(String(row.status))
   ||row.version!==scope.expected_run_version||row.message_run_id!==scope.run_id||row.message_conversation_id!==scope.conversation_id
   ||row.role!=='user'||row.message_status!=='complete'||typeof row.content_json!=='string'
   ||typeof row.input_message_id!=='string'||!ID.test(row.input_message_id))rejected();
  const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if((table('wb_agents')&&db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(scope.conversation_id,scope.owner_id))
   ||(table('wb_run_bindings')&&db.prepare('SELECT 1 FROM wb_run_bindings WHERE run_id=?').get(scope.run_id))
   ||db.prepare('SELECT 1 FROM ga_conversation_goal_controls WHERE run_id=?').get(scope.run_id))rejected();
  const cmd=db.prepare('SELECT kind,status,payload_json FROM ga_run_commands WHERE id=? AND run_id=?').get(scope.command_id,scope.run_id);
  if(!cmd||cmd.kind!=='steer'||!['pending','applied','superseded','rejected'].includes(String(cmd.status))||typeof cmd.payload_json!=='string')rejected();
  const payload=JSON.parse(cmd.payload_json) as Record<string,unknown>;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='client_message_id,expected_run_version,text'
   ||typeof payload.text!=='string'||!payload.text.trim()||typeof payload.client_message_id!=='string'||!ID.test(payload.client_message_id)
   ||!Number.isSafeInteger(payload.expected_run_version)||Number(payload.expected_run_version)<1||Number(payload.expected_run_version)>scope.expected_run_version)rejected();
  const messageId='message-'+scope.command_id,content=JSON.stringify({blocks:[{block_id:messageId+':text',kind:'text',text:payload.text}],attachments:[]});
  const existing=db.prepare(`SELECT id,run_id,conversation_id,role,status,content_json,client_message_id FROM ga_messages
   WHERE id=? OR (conversation_id=? AND client_message_id=?)`).all(messageId,scope.conversation_id,payload.client_message_id);
  if(existing.length>1||cmd.status==='applied'&&existing.length!==1)rejected();
  if(existing.length){const m=existing[0]!;if(m.id!==messageId||m.run_id!==scope.run_id||m.conversation_id!==scope.conversation_id||m.role!=='user'||m.status!=='complete'||m.content_json!==content||m.client_message_id!==payload.client_message_id)rejected();}
  return Object.freeze({protocol:1,kind:'ordinary_steer_history',owner_id:scope.owner_id,conversation_id:scope.conversation_id,session_id:scope.session_ref,
   run_id:scope.run_id,run_version:row.version,run_status:row.status,command_id:scope.command_id,command_status:cmd.status,
   original_input_message_id:row.input_message_id,input_message_id:messageId,original_input_sha256:sha(row.content_json),command_sha256:sha(cmd.payload_json),
   input_sha256:sha(content),native_content_sha256:sha(JSON.stringify([{type:'text',text:payload.text.trim()}])),product_message_present:existing.length===1,
   native_acceptance:'unverified',execution_authorized:false});
 });
}

export function registerOrdinarySteeringHistory(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-steering-history',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  if(!scopeValid(request.body))return reply.code(422).send({error:{code:'ORDINARY_STEERING_HISTORY_INVALID'}});
  try{return{history:inspectOrdinarySteeringHistory(db,request.body)};}
  catch{return reply.code(409).send({error:{code:'ORDINARY_STEERING_HISTORY_REJECTED'}});}
 });
}
