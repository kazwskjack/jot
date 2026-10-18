import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinaryRunHistory} from './ordinary-run-history.ts';
import {canonicalModelJson} from './model-policy.ts';
import {executionPolicy,policyHash} from './mode-policy.ts';
import {chatContextHash,validateChatContext} from './chat-context.ts';
import {decodeStoredContent} from '../messages/content.ts';
import {ordinaryRunCompletionSource} from '../harness/ordinary-run-completion.ts';
type Scope={owner_id:string;conversation_id:string;run_id:string;session_ref:string;expected_run_version:number};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const digest=(v:unknown)=>sha(canonicalModelJson(v));
const fail=():never=>{throw Error('chat_compaction_source_unconfirmed');};
const validHash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const validId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
/** A completed original source only. It grants no inference, maintenance,
 * model-budget, foreground lease, Session wake or answer publication. */
export function inspectChatCompactionSource(db:DatabaseSync,scope:Scope){
 return withImmediateTransaction(db,()=>{
  const history=inspectOrdinaryRunHistory(db,scope),run=db.prepare('SELECT * FROM ga_runs WHERE id=?').get(scope.run_id)!,conversation=db.prepare('SELECT mode FROM ga_conversations WHERE id=?').get(scope.conversation_id);
  if(run.native_session_ref!==scope.session_ref||run.native_owner_id!==scope.owner_id||run.native_conversation_id!==scope.conversation_id)return fail();
  if(conversation?.mode!=='chat'||history.canonical?.status!=='complete'||history.commands.some(c=>c.command_status==='pending')||typeof run.execution_policy_json!=='string'||typeof run.model_policy_json!=='string'||typeof run.model_resolution_json!=='string'||typeof run.chat_context_json!=='string'||typeof run.chat_context_sha256!=='string')return fail();
  // The original history reader already refuses live or malformed leases.
  // A retained expired row is source evidence only, never an execution grant.
  const policy=executionPolicy(JSON.parse(run.execution_policy_json),run.model_policy_json),context=validateChatContext(JSON.parse(run.chat_context_json));
  if(policy.mode!=='chat'||canonicalModelJson(policy)!==run.execution_policy_json||chatContextHash(run.chat_context_json)!==run.chat_context_sha256||canonicalModelJson(context)!==run.chat_context_json||context.conversation_id!==scope.conversation_id||context.conversation_version!==policy.conversation_version||context.context_revision!==policy.context_revision||context.messages.some(m=>m.message_id===history.input_message_id))return fail();
  const model=JSON.parse(run.model_resolution_json),requested=JSON.parse(run.model_policy_json).model;
  if(!model||typeof model!=='object'||Array.isArray(model)||Object.keys(model).sort().join(',')!=='model,provider,reasoning_effort'||model.provider!==requested.provider||model.model!==requested.model||model.reasoning_effort!=='off'||canonicalModelJson(model)!==run.model_resolution_json)return fail();
  const answer=db.prepare('SELECT content_json FROM ga_messages WHERE id=? AND run_id=? AND conversation_id=?').get(history.canonical.message_id,scope.run_id,scope.conversation_id);
  if(typeof answer?.content_json!=='string'||sha(answer.content_json)!==history.canonical.content_sha256)return fail();
  const content=decodeStoredContent(answer.content_json),events=db.prepare("SELECT event_id,payload_json FROM ga_events WHERE run_id=? AND conversation_id=? AND type='message.created' ORDER BY seq DESC").all(scope.run_id,scope.conversation_id);
  const publication=events.map(e=>({row:e,value:JSON.parse(String(e.payload_json))})).find(e=>e.value.message_id===history.canonical!.message_id);
  if(!publication||publication.value.role!=='assistant'||publication.value.status!=='complete'||publication.value.run_id!==scope.run_id||canonicalModelJson(publication.value.blocks)!==canonicalModelJson(content.blocks)||canonicalModelJson(publication.value.attachments??[])!==canonicalModelJson(content.attachments))return fail();
  const receipt=db.prepare('SELECT * FROM ga_ordinary_final_publications WHERE run_id=?').get(scope.run_id);let receiptHash:string|null=null;
  if(receipt){
   const before=JSON.parse(String(receipt.source_json)),post=JSON.parse(String(receipt.post_source_json)),proof=JSON.parse(String(receipt.proof_json));
   const expected=ordinaryRunCompletionSource(scope.session_ref,{owner_id:scope.owner_id,conversation_id:scope.conversation_id,run_id:scope.run_id,expected_run_version:Number(before.run_version)},before);
   if(receipt.owner_id!==scope.owner_id||receipt.conversation_id!==scope.conversation_id||receipt.session_id!==scope.session_ref||receipt.message_id!==history.canonical.message_id||digest(before)!==receipt.source_sha256||digest(post)!==receipt.post_source_sha256||digest(proof)!==receipt.proof_sha256||digest(history)!==receipt.post_source_sha256
    ||Object.keys(proof).sort().join(',')!=='answer_event_sha256,answer_seq,answer_sha256,command_ids,execution_authorized,kind,native_message_ids,output_events_sha256,profile_fingerprint,protocol,raw_event_count,raw_sha256,run_id,run_version,session_id,source_sha256,turn_end_seq'
    ||proof.protocol!==1||proof.kind!=='ordinary_run_completion'||proof.run_id!==scope.run_id||proof.session_id!==scope.session_ref||proof.run_version!==expected.scope.expected_run_version||proof.source_sha256!==expected.source_sha256||proof.execution_authorized!==false
    ||!['answer_event_sha256','answer_sha256','output_events_sha256','profile_fingerprint','raw_sha256'].every(k=>validHash(proof[k]))||!Number.isSafeInteger(proof.raw_event_count)||proof.raw_event_count<1||!Number.isSafeInteger(proof.answer_seq)||proof.answer_seq<0||!Number.isSafeInteger(proof.turn_end_seq)||!(proof.answer_seq<proof.turn_end_seq&&proof.turn_end_seq<proof.raw_event_count)
    ||canonicalModelJson(proof.command_ids)!==canonicalModelJson(expected.command_ids)||!Array.isArray(proof.native_message_ids)||proof.native_message_ids.length!==expected.command_ids.length+1||proof.native_message_ids.some((id:unknown)=>!validId(id))||new Set(proof.native_message_ids).size!==proof.native_message_ids.length
    ||sha(content.blocks.filter(b=>b.kind==='text').map(b=>b.text).join('').trim())!==proof.answer_sha256)return fail();
   receiptHash=digest(receipt);
  }else if(history.run_status!=='succeeded')return fail();
  return Object.freeze({protocol:1,kind:'chat_compaction_source',owner_id:scope.owner_id,conversation_id:scope.conversation_id,run_id:scope.run_id,run_version:scope.expected_run_version,session_id:scope.session_ref,input_message_id:history.input_message_id,input_sha256:history.input_sha256,answer_message_id:history.canonical.message_id,answer_content_sha256:history.canonical.content_sha256,publication_event_id:publication.row.event_id,publication_event_sha256:digest(publication.row),historical_publication_sha256:receiptHash,history_sha256:digest(history),policy,policy_sha256:policyHash(run.execution_policy_json),model,model_sha256:sha(run.model_resolution_json),context_sha256:run.chat_context_sha256,execution_authorized:false});
 });
}
function intentValue(row:Record<string,unknown>,source:ReturnType<typeof inspectChatCompactionSource>){
 if(!validId(row.intent_id)||row.run_id!==source.run_id||row.owner_id!==source.owner_id||row.conversation_id!==source.conversation_id||row.session_id!==source.session_id||typeof row.source_json!=='string'||typeof row.source_sha256!=='string'||sha(row.source_json)!==row.source_sha256||canonicalModelJson(source)!==row.source_json)fail();
 return{protocol:1,intent_id:row.intent_id,run_id:row.run_id,source_sha256:row.source_sha256,source:structuredClone(source),execution_authorized:false};
}
export function prepareChatCompactionIntent(db:DatabaseSync,scope:Scope){
 return withImmediateTransaction(db,()=>{
  const source=inspectChatCompactionSource(db,scope),prior=db.prepare('SELECT * FROM ga_chat_compaction_intents WHERE run_id=?').get(scope.run_id);
  if(prior)return intentValue(prior,source);
  const json=canonicalModelJson(source),id='compact-intent-'+randomUUID();
  db.prepare('INSERT INTO ga_chat_compaction_intents(intent_id,run_id,owner_id,conversation_id,session_id,source_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,scope.run_id,scope.owner_id,scope.conversation_id,scope.session_ref,json,sha(json),new Date().toISOString());
  return intentValue(db.prepare('SELECT * FROM ga_chat_compaction_intents WHERE intent_id=?').get(id)!,source);
 });
}
export function readChatCompactionIntent(db:DatabaseSync,scope:Scope,id:string){
 return withImmediateTransaction(db,()=>{
  const source=inspectChatCompactionSource(db,scope),row=db.prepare('SELECT * FROM ga_chat_compaction_intents WHERE intent_id=? AND run_id=? AND owner_id=? AND conversation_id=? AND session_id=?').get(id,scope.run_id,scope.owner_id,scope.conversation_id,scope.session_ref);
  if(!row)return fail();return intentValue(row,source);
 });
}
