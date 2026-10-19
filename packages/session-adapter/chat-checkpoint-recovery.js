import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {createOrdinaryRunCompletionReader} from './ordinary-run-completion.js';
import {chatMaintenanceNativeWitness} from './chat-maintenance-observation.js';
import {readNativeChatCheckpoint} from './chat-compaction-checkpoint.js';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('chat_checkpoint_recovery_unconfirmed');};
/** Recover only an original durable result. No Agent registration, wake,
 * compaction, provider call, dispatch, new run or automatic scheduling. */
export function createChatCheckpointRecovery(options){
 const {bridge,persistence,agents,sessions,Session,validateLog}=options??{};
 if(typeof bridge?.request!=='function'||typeof persistence?.open!=='function'||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof Session?.create!=='function'||typeof validateLog!=='function')fail();
 return async request=>{
  const {scope:input,intent_id,signal}=request??{};
  if(!input||Object.keys(input).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref'].every(k=>id(input[k]))||!Number.isSafeInteger(input.expected_run_version)||input.expected_run_version<1||!id(intent_id)||!(signal instanceof AbortSignal))fail();
  const scope=structuredClone(input),binding={runId:scope.run_id,sessionRef:scope.session_ref},active=()=>signal.throwIfAborted(),cold=()=>{active();if(agents.get(scope.session_ref)!==undefined||sessions.get(scope.session_ref)!==undefined)fail();};
  active();const inspected=await bridge.request('chat-compaction-attempt',binding,{action:'inspect',...scope,intent_id},signal);active();const lookup=inspected?.attempt,source=lookup?.source;
  if(lookup?.protocol!==1||lookup.kind!=='chat_compaction_attempt_inspection'||lookup.intent_id!==intent_id||lookup.owner_id!==scope.owner_id||lookup.conversation_id!==scope.conversation_id||lookup.run_id!==scope.run_id||lookup.run_version!==scope.expected_run_version||lookup.session_id!==scope.session_ref||lookup.execution_authorized!==false||!hash(lookup.source_sha256)||digest(source)!==lookup.source_sha256||source?.protocol!==1||source.kind!=='chat_compaction_source'||source.execution_authorized!==false||source.owner_id!==scope.owner_id||source.conversation_id!==scope.conversation_id||source.run_id!==scope.run_id||source.run_version!==scope.expected_run_version||source.session_id!==scope.session_ref||source.policy?.mode!=='chat'||source.policy.thinking!=='disabled'||source.model?.reasoning_effort!=='off')fail();
  const unavailable=reason=>({protocol:1,status:'unavailable',reason,checkpoint:null,execution_authorized:false});
  if(lookup.receipt===null){if(lookup.native_witness!==null)fail();return unavailable('NO_ATTEMPT');}
  const original=lookup.receipt,operation={intent_id,attempt_id:original.attempt_id,observer_id:original.observer_id,fence_id:original.fence_id};
  const receipt=r=>{if(r?.protocol!==1||r.kind!=='chat_compaction_attempt'||!Object.values(operation).every(id)||Object.entries(operation).some(([k,v])=>r[k]!==v)||r.run_id!==scope.run_id||r.session_id!==scope.session_ref||r.source_sha256!==lookup.source_sha256||r.execution_authorized!==false||r.dispatch_allowed!==false||r.request?.provider!==source.model.provider||r.request?.model!==source.model.model||r.request?.reasoning_effort!=='off'||r.request?.purpose!=='compaction'||r.request?.session_id!==scope.session_ref||!hash(r.request?.call_sha256))fail();return r;};
  receipt(original);
  const checkpoint=value=>{if(value?.protocol!==1||value.kind!=='chat_compaction_checkpoint'||value.execution_authorized!==false||value.run_id!==scope.run_id||value.session_id!==scope.session_ref||value.source_sha256!==lookup.source_sha256||!id(value.checkpoint_id)||!['checkpoint_sha256','summary_text_sha256','native_summary_sha256'].every(k=>hash(value[k]))||value.parent_checkpoint_id!==null&&!id(value.parent_checkpoint_id))fail();return value;};
  const saved=await bridge.request('chat-compaction-checkpoint',binding,{action:'read',...scope,...operation},signal);active();
  if(!saved||Object.keys(saved).join(',')!=='checkpoint')fail();
  if(saved.checkpoint!==null){if(original.state!=='settled')fail();return{protocol:1,status:'already_published',checkpoint:checkpoint(saved.checkpoint),execution_authorized:false};}
  if(!['settled','dispatched','usage_unknown'].includes(original.state))return unavailable('NO_DISPATCHED_ATTEMPT');
  if(source.policy.context_revision!=='checkpoint-text-v2')return unavailable('UNSUPPORTED_CONTEXT');
  const currentSource=async()=>{cold();const r=await bridge.request('chat-compaction-source',binding,{action:'read',...scope,intent_id},signal);cold();if(r?.intent?.protocol!==1||r.intent.intent_id!==intent_id||r.intent.run_id!==scope.run_id||r.intent.execution_authorized!==false||r.intent.source_sha256!==lookup.source_sha256||!equal(r.intent.source,source))fail();};
  await currentSource();
  const readRaw=async()=>{cold();const h=await persistence.open(scope.session_ref,'read',{signal});try{cold();const r=await h.read(0,undefined,{signal});cold();return structuredClone({header:h.header,inheritedEventCount:h.inheritedEventCount,events:r.events});}finally{await h.close();}};
  const raw=await readRaw(),count=lookup.native_witness?.raw_event_count;
  if(!Number.isSafeInteger(count)||count<1||!Array.isArray(raw.events)||raw.events.length!==count+4||raw.events.some((e,i)=>e?.seq!==i)||raw.header?.id!==scope.session_ref||raw.header.agentPreset!=='jot-chat'||raw.inheritedEventCount!==0)fail();
  let prefix={...raw,events:raw.events.slice(0,count)};
  // The pinned official JSONL codec materializes an omitted root depth as 0.
  // Reconstruct that logical header only if the entire original hash matches;
  // no header field or event is excluded from integrity verification.
  if(digest(prefix)!==lookup.native_witness.raw_sha256&&raw.header.delegationDepth===0){const {delegationDepth,...originalHeader}=raw.header;prefix={...prefix,header:originalHeader};}
  if(digest(prefix)!==lookup.native_witness.raw_sha256)fail();
  const complete=Session.create(scope.session_ref,structuredClone(raw.events),structuredClone(prefix.header),0);
  if((await validateLog(complete,{signal}))?.validated!==true)fail();cold();
  // The official detached constructor appends its in-process end-seed marker.
  // Validate that replay in full, then expose only the exact durable snapshot
  // to the shared evidence reader. No synthetic marker becomes stored proof.
  const replay=complete.snapshotEvents(0),extra=replay.slice(raw.events.length);
  if(!equal(replay.slice(0,raw.events.length),raw.events)||extra.length>1||extra.some(e=>e.type!=='session/end-seed'||e.seq!==raw.events.length||!equal(e.data,{})||Object.keys(e).some(k=>!['type','seq','time','data'].includes(k))))fail();
  const durable={id:complete.id,header:complete.header,inheritedEventCount:complete.inheritedEventCount,surface:complete.surface,seq:raw.events.length,snapshotEvents:()=>structuredClone(raw.events)};
  // Keep original cold proof logic unchanged. Every restricted prefix read
  // also checks the entire persisted log, including its native result tail.
  const prefixPersistence={open:async(sessionId,mode,opts)=>{
   cold();if(sessionId!==scope.session_ref||mode!=='read')fail();const h=await persistence.open(sessionId,mode,opts);
   return{header:structuredClone(prefix.header),inheritedEventCount:h.inheritedEventCount,close:()=>h.close(),read:async(offset,end,readOptions)=>{cold();if(offset!==0||end!==undefined)fail();const r=await h.read(offset,end,readOptions);cold();if(!equal({header:h.header,inheritedEventCount:h.inheritedEventCount,events:r.events},raw))fail();return{...r,events:structuredClone(prefix.events)};}};
  }};
  const proof=await createOrdinaryRunCompletionReader({...options,persistence:prefixPersistence})({scope,expectedSourceSha256:source.history_sha256,signal});cold();
  if(!equal(chatMaintenanceNativeWitness(proof),lookup.native_witness))fail();
  const beforeSession=Session.create(scope.session_ref,structuredClone(prefix.events),structuredClone(prefix.header),0),[start,summary,,end]=raw.events.slice(count);
  const result={compactionId:start.data?.compactionId,sourceCommandId:start.data?.sourceCommandId,startSeq:start.seq,summarySeq:summary.seq,endSeq:end.seq,summary:summary.data?.summary,shadowedRange:summary.data?.shadowedRange,shadowedSeqs:summary.data?.shadowedSeqs,shadowedTokenCount:summary.data?.shadowedTokenCount};
  const evidence=readNativeChatCheckpoint({agent:{id:scope.session_ref,session:durable},before:{...prefix,surface_nodes:[...beforeSession.surface.nodes],surface_generation:beforeSession.surface.replaceGeneration},proof,result,source,attempt_id:operation.attempt_id});
  if(!equal(await readRaw(),raw))fail();await currentSource();
  // Actual usage uses the original journal, including after cancellation of
  // publication transport. No inference or new dispatch can occur here.
  const settled=receipt((await bridge.request('chat-compaction-attempt',binding,{action:'settle',...scope,...operation,usage:evidence.witness.usage}))?.receipt);if(settled.state!=='settled')fail();cold();
  if(!equal(await readRaw(),raw))fail();await currentSource();
  const published=await bridge.request('chat-compaction-checkpoint',binding,{action:'publish',...scope,...operation,source_sha256:lookup.source_sha256,...evidence},signal);cold();const value=checkpoint(published?.checkpoint);
  if(value.summary_text_sha256!==evidence.witness.summary_text_sha256||value.native_summary_sha256!==evidence.witness.summary_sha256)fail();
  return{protocol:1,status:'recovered',checkpoint:value,execution_authorized:false};
 };
}
