import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {withImmediateTransaction} from '../db/database.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import {inspectOrdinaryExecutionPolicy} from './execution-policy.ts';
import {chatContextHash,validateChatContext} from './chat-context.ts';
import {canonicalModelJson} from './model-policy.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function inspectOrdinaryChatContext(db:DatabaseSync,run:string,session:string,lease:unknown){
 return withImmediateTransaction(db,()=>{
  const proof=inspectOrdinaryExecutionPolicy(db,run,session,lease),row=db.prepare('SELECT chat_context_json,chat_context_sha256 FROM ga_runs WHERE id=?').get(run);
  if(proof.policy.mode!=='chat'||typeof row?.chat_context_json!=='string'||typeof row.chat_context_sha256!=='string'||chatContextHash(row.chat_context_json)!==row.chat_context_sha256)throw Error('chat_context_unconfirmed');
  const snapshot=validateChatContext(JSON.parse(row.chat_context_json));
  if(canonicalModelJson(snapshot)!==row.chat_context_json||snapshot.conversation_id!==proof.conversation_id||snapshot.conversation_version!==proof.policy.conversation_version||snapshot.context_revision!==proof.policy.context_revision||snapshot.messages.some(item=>item.message_id===proof.input_message_id))throw Error('chat_context_unconfirmed');
  return{...proof,snapshot,context_sha256:row.chat_context_sha256};
 });
}
export function registerOrdinaryChatContext(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-chat-context',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const b=request.body as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='execution_lease,run_id,session_ref'||typeof b.run_id!=='string'||!ID.test(b.run_id)||typeof b.session_ref!=='string'||!ID.test(b.session_ref))return reply.code(422).send({error:{code:'CHAT_CONTEXT_INVALID'}});
  try{return{context:inspectOrdinaryChatContext(db,b.run_id,b.session_ref,normalizeExecutionLease(b.execution_lease))};}
  catch{return reply.code(409).send({error:{code:'CHAT_CONTEXT_UNCONFIRMED'}});}
 });
}
