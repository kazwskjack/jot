import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {inspectChatCompactionPressure} from './chat-compaction-pressure.js';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('chat_maintenance_observation_unconfirmed');};
/** Project only after the owned native completion reader has verified the log.
 * This bounded attestation is not independently an execution grant. */
export function chatMaintenanceNativeWitness(proof){return{protocol:1,kind:'chat_compaction_native_witness',run_id:proof.run_id,run_version:proof.run_version,session_id:proof.session_id,history_sha256:proof.source_sha256,proof_sha256:digest(proof),raw_sha256:proof.raw_sha256,raw_event_count:proof.raw_event_count,profile_fingerprint:proof.profile_fingerprint,command_ids_sha256:digest(proof.command_ids),native_message_ids_sha256:digest(proof.native_message_ids),native_message_count:proof.native_message_ids.length,answer_sha256:proof.answer_sha256,answer_seq:proof.answer_seq,turn_end_seq:proof.turn_end_seq,execution_authorized:false};}
/** Source-backed facts, never a maintenance reservation, inference or receipt.
 * The registered Agent stays under the original DSH scheduler. */
export function createChatMaintenanceObserver({bridge,agents,completionReader,tokenMeter,llm,pressurePolicy}){
 if(typeof bridge?.request!=='function'||typeof agents?.get!=='function'||typeof completionReader!=='function'||typeof tokenMeter?.measure!=='function'||typeof llm?.resolveModelInfo!=='function')fail();
 const policy=structuredClone(pressurePolicy);
 return async({scope,expectedSourceSha256,signal})=>{
  if(!scope||Object.keys(scope).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref'].every(k=>valid(scope[k]))||!Number.isSafeInteger(scope.expected_run_version)||scope.expected_run_version<1||!hash(expectedSourceSha256)||!(signal instanceof AbortSignal))fail();
  signal.throwIfAborted();scope=structuredClone(scope);const binding={runId:scope.run_id,sessionRef:scope.session_ref};
  const response=await bridge.request('chat-compaction-source',binding,{action:'inspect',...scope},signal),source=response?.source;
  if(!source||source.protocol!==1||source.kind!=='chat_compaction_source'||source.execution_authorized!==false||digest(source)!==expectedSourceSha256
   ||source.owner_id!==scope.owner_id||source.conversation_id!==scope.conversation_id||source.run_id!==scope.run_id||source.run_version!==scope.expected_run_version||source.session_id!==scope.session_ref||!hash(source.history_sha256)
   ||source.policy?.mode!=='chat'||source.policy?.thinking!=='disabled'||source.model?.reasoning_effort!=='off')fail();
  const agent=agents.get(scope.session_ref),session=agent?.session;
  const check=()=>{signal.throwIfAborted();if(!agent||agents.get(scope.session_ref)!==agent||agent.id!==scope.session_ref||agent.session!==session||session?.id!==scope.session_ref||session.header?.agentPreset!=='jot-chat'||agent.status!=='idle'||!Array.isArray(agent.inbox?.nextStep)||!Array.isArray(agent.inbox?.nextTurn)||agent.inbox.nextStep.length||agent.inbox.nextTurn.length||session.requestHeader()?.config?.reasoningEffort!=='off')fail();};
  check();const nativeRequest={scope,expectedSourceSha256:source.history_sha256,signal};
  const proof=await completionReader(nativeRequest);check();if(session.seq!==proof.raw_event_count)fail();
  const pressure=await inspectChatCompactionPressure({session,expectedModel:source.model,policy,tokenMeter,llm,signal});check();
  if(pressure.reason==='STATE_CHANGED'||pressure.reason==='ROUTE_UNCONFIRMED'||!isDeepStrictEqual(await completionReader(nativeRequest),proof))fail();check();
  // Full native tool/answer bodies remain local. The authenticated Host attests
  // its shared parser's complete proof via a fixed-size metadata witness.
  const witness=chatMaintenanceNativeWitness(proof);
  const verified=await bridge.request('chat-compaction-source',binding,{action:'verify-native',...scope,source_sha256:expectedSourceSha256,witness},signal);check();if(session.seq!==proof.raw_event_count)fail();
  const expected={protocol:1,kind:'chat_compaction_native',run_id:scope.run_id,session_id:scope.session_ref,source_sha256:expectedSourceSha256,proof_sha256:digest(proof),witness_sha256:digest(witness),raw_sha256:proof.raw_sha256,raw_event_count:proof.raw_event_count,answer_sha256:proof.answer_sha256,answer_seq:proof.answer_seq,turn_end_seq:proof.turn_end_seq,profile_fingerprint:proof.profile_fingerprint,execution_authorized:false};
  if(!isDeepStrictEqual(verified?.observation,expected))fail();
  return Object.freeze({protocol:1,kind:'chat_maintenance_observation',run_id:scope.run_id,session_id:scope.session_ref,source_sha256:expectedSourceSha256,native:Object.freeze(expected),pressure,execution_authorized:false});
 };
}
