import {readNativeChatCheckpoint} from './chat-compaction-checkpoint.js';
import {createHash,randomUUID} from 'node:crypto';
import {chatMaintenanceNativeWitness} from './chat-maintenance-observation.js';
import {inspectChatCompactionPressure} from './chat-compaction-pressure.js';
const digest=v=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('chat_compaction_manager_unconfirmed');};
/** Trusted Host operation coordinator, not a new planner, run or model grant.
 * Work is delegated to the original scoped engine. Automatic starts are not
 * installed here: checkpoint consumption must be connected before activation. */
export function createChatCompactionManager({ctx,bridge,agents,presets,runtime,observe,completionReader,tokenMeter,llm}){
 if(typeof presets?.serviceFor!=='function'||typeof presets?.composedPreset!=='function'||typeof bridge?.request!=='function'||typeof agents?.get!=='function'||runtime?.protocol!==1||typeof runtime.withOperation!=='function'||typeof runtime.get!=='function'||typeof observe!=='function'||typeof completionReader!=='function'||typeof tokenMeter?.measure!=='function'||typeof llm?.resolveModelInfo!=='function')fail();
 const jobs=new Map(),observer='chat-host-'+randomUUID();let disposed=false;
 const off=ctx?.on?.('session/event',(session,event)=>{const job=jobs.get(session.id);if(job&&job.session===session&&event.type==='agent/inbox/spliced'&&event.data?.inserted?.length)job.controller.abort(Error('chat_compaction_new_input'));});
 const run=request=>{
  let job;
  const task=(async()=>{
   const {scope:raw,intent_id,source_sha256,signal}=request??{};
   if(disposed||!raw||Object.keys(raw).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref'].every(k=>id(raw[k]))||!Number.isSafeInteger(raw.expected_run_version)||raw.expected_run_version<1||!id(intent_id)||!hash(source_sha256)||signal!==undefined&&!(signal instanceof AbortSignal)||jobs.has(raw.session_ref))fail();
   const scope=structuredClone(raw),agent=agents.get(scope.session_ref),session=agent?.session,controller=new AbortController(),active=signal?AbortSignal.any([signal,controller.signal]):controller.signal,binding={runId:scope.run_id,sessionRef:scope.session_ref};
   job={agent,session,controller,task:null};jobs.set(scope.session_ref,job);
   const identity=()=>{active.throwIfAborted();if(disposed||!agent||agents.get(scope.session_ref)!==agent||agent.id!==scope.session_ref||agent.session!==session||session?.id!==scope.session_ref||session.header?.agentPreset!=='jot-chat'||presets.composedPreset(agent.ctx)!=='jot-chat'||agent.status!=='idle'||!Array.isArray(agent.inbox?.nextStep)||!Array.isArray(agent.inbox?.nextTurn)||agent.inbox.nextStep.length||agent.inbox.nextTurn.length)fail();};
   const read=async()=>{identity();const r=await bridge.request('chat-compaction-source',binding,{action:'read',...scope,intent_id},active);identity();const intent=r?.intent,source=intent?.source;
    if(intent?.protocol!==1||intent.intent_id!==intent_id||intent.run_id!==scope.run_id||intent.execution_authorized!==false||source?.kind!=='chat_compaction_source'||source.owner_id!==scope.owner_id||source.conversation_id!==scope.conversation_id||source.session_id!==scope.session_ref||source.run_id!==scope.run_id||source.run_version!==scope.expected_run_version||source.policy?.mode!=='chat'||source.policy.thinking!=='disabled'||source.model?.reasoning_effort!=='off'||intent.source_sha256!==source_sha256||digest(source)!==source_sha256)fail();return intent;};
   try{
    const intent=await read(),engine=presets.serviceFor(agent,'compaction');if(engine?.jotChatCompactionProtocol!==1||engine.config?.auto!==false||!engine.jotChatCompactionIdentity||typeof engine.compactNow!=='function')fail();
    const engineIdentity=engine.jotChatCompactionIdentity;
    const observed=await observe({scope,expectedSourceSha256:source_sha256,signal:active});identity();
    const pressure=await inspectChatCompactionPressure({session,expectedModel:intent.source.model,policy:{thresholdRatio:engine.config.thresholdRatio,headroomTokens:engine.config.headroomTokens},tokenMeter,llm,signal:active});identity();
    if(pressure.decision!=='needed')return{protocol:1,status:'skipped',reason:pressure.reason,compaction_executed:false,execution_authorized:false};
    const proof=await completionReader({scope,expectedSourceSha256:intent.source.history_sha256,signal:active});identity();if(digest(proof)!==observed.native?.proof_sha256||session.seq!==proof.raw_event_count)fail();
    const publishesCheckpoint=intent.source.policy.context_revision==='checkpoint-text-v2';
    const before=publishesCheckpoint?{header:structuredClone(session.header),inheritedEventCount:session.inheritedEventCount,events:structuredClone(session.snapshotEvents(0)),surface_nodes:[...session.surface.nodes],surface_generation:session.surface.replaceGeneration}:null;
    if(before&&digest({header:before.header,inheritedEventCount:before.inheritedEventCount,events:before.events})!==proof.raw_sha256)fail();
    const attempt=Object.freeze({scope,intent_id,attempt_id:'chat-compact-'+randomUUID(),observer_id:observer,witness:chatMaintenanceNativeWitness(proof)});let entry,settled;
    const check=async scoped=>{scoped.throwIfAborted();identity();if(before){const events=session.snapshotEvents(0),start=events.at(-1);if(events.length!==proof.raw_event_count+1||digest({header:session.header,inheritedEventCount:session.inheritedEventCount,events:events.slice(0,proof.raw_event_count)})!==proof.raw_sha256||start.type!=='compaction/start'||start.data.sourceCommandId!==attempt.attempt_id||start.data.turn!==null)fail();}if(runtime.get(agent)!==entry||presets.serviceFor(agent,'compaction')?.jotChatCompactionIdentity!==engineIdentity)fail();await read();scoped.throwIfAborted();};
    entry=Object.freeze({attempt,model:Object.freeze(structuredClone(intent.source.model)),signal:active,check,request:async(...args)=>{const response=await bridge.request(...args);if(args[2]?.action==='settle'&&response?.receipt?.state==='settled')settled=response.receipt;return response;}});
    await read();const result=await runtime.withOperation(agent,entry,()=>engine.compactNow(agent,active,attempt.attempt_id));await read();let checkpoint;
    if(publishesCheckpoint&&result){
     if(!settled||settled.attempt_id!==attempt.attempt_id||typeof ctx.sessions?.flush!=='function')fail();
     const evidence=readNativeChatCheckpoint({agent,before,proof,result,source:intent.source,attempt_id:attempt.attempt_id});
     if(await ctx.sessions.flush(session)!==true)fail();await read();
     const reply=await bridge.request('chat-compaction-checkpoint',binding,{action:'publish',...scope,intent_id,attempt_id:attempt.attempt_id,observer_id:observer,fence_id:settled.fence_id,source_sha256,...evidence},active);identity();checkpoint=reply?.checkpoint;
     if(checkpoint?.protocol!==1||checkpoint.kind!=='chat_compaction_checkpoint'||!id(checkpoint.checkpoint_id)||!hash(checkpoint.checkpoint_sha256)||checkpoint.run_id!==scope.run_id||checkpoint.session_id!==scope.session_ref||checkpoint.source_sha256!==source_sha256||checkpoint.native_summary_sha256!==evidence.witness.summary_sha256||checkpoint.summary_text_sha256!==evidence.witness.summary_text_sha256||checkpoint.execution_authorized!==false)fail();
    }
    return{protocol:1,status:result?'compacted':'skipped',reason:result?null:'NO_SAFE_RANGE',compaction_executed:!!result,attempt_id:attempt.attempt_id,source_sha256,result,...(checkpoint?{checkpoint}:{}),execution_authorized:false};
   }finally{if(jobs.get(scope.session_ref)===job)jobs.delete(scope.session_ref);}
  })();if(job)job.task=task;return task;
 };
 return Object.freeze({protocol:1,run,async beforeInput({agent,binding}){
  const job=jobs.get(binding?.sessionRef);if(!job)return;if(job.agent!==agent||job.session!==agent?.session)fail();job.controller.abort(Error('chat_compaction_new_input'));await job.task?.catch(()=>{});
 },async dispose(){disposed=true;if(typeof off==='function')off();for(const job of jobs.values())job.controller.abort(Error('chat_compaction_shutdown'));await Promise.allSettled([...jobs.values()].map(job=>job.task));}});
}
