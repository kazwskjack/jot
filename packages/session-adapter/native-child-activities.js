import {createHash} from 'node:crypto';
import {nativeToolResultObservation,nativeToolCallObservation,sessionToolCallId} from './native-tool-result.js';
import {nativeChildLogJson as json,updateNativeChildLogHash} from './native-child-closure.js';

function projectionRevision(source){
 if(!source||typeof source!=='object'||Array.isArray(source))throw Error('native_activity_source_invalid');
 const revision=source.projection_revision===undefined?1:source.projection_revision;
 if(![1,2,3,4].includes(revision))throw Error('native_activity_source_invalid');
 return revision;
}

function preferredRevision(source){
 const current=projectionRevision(source),supported=source.supported_projection_revision===undefined?current:source.supported_projection_revision;
 if(![1,2,3,4].includes(supported))throw Error('native_activity_source_invalid');
 const available=source.available_projection_revisions;
 if(available===undefined)return supported;
 if(!Array.isArray(available)||!available.length||available.length>4||new Set(available).size!==available.length
  ||available.some(value=>![1,2,3,4].includes(value))||!available.includes(current)||!available.includes(supported))throw Error('native_activity_source_invalid');
 if(source.native_todo_projection_revision!==undefined&&source.native_todo_projection_revision!==4)throw Error('native_activity_source_invalid');
 return source.native_todo_projection_revision===4?4:Math.max(...available);
}

async function sendNativeChildActivity({binding,event,bridge,metadata,signal,observationRevision=1}){
 const sha=updateNativeChildLogHash(createHash('sha256'),event).digest('hex');
 const call=event.type==='tool/call'?nativeToolCallObservation(event,observationRevision):null;
 const observation=event.type==='tool/result'?nativeToolResultObservation(event,observationRevision):call??{event};
 const revisionFields=observationRevision>=3?{projection_revision:observationRevision}:{};
 if(event.type==='tool/result'&&observationRevision<2)delete observation.public_result.artifact_receipts;
 const format=event.type==='tool/result'?'public-result-v1':call?'public-call-v1':undefined;
 const evidence=format?{event_format:format,source_event_sha256:sha}:{};
 const encoded=format?json(observation):undefined;
 const transportSha=format?createHash('sha256').update(encoded).digest('hex'):sha;
 let receipt;
 if(format&&encoded.length>65_536){
  const count=Math.ceil(encoded.length/65_536);
  for(let index=0;index<count;index++){
   signal?.throwIfAborted();
   const chunk=encoded.slice(index*65_536,(index+1)*65_536);
   const chunkSha=createHash('sha256').update(json(chunk)).digest('hex');
   receipt=await bridge.request('native-child-activities',binding,{...metadata,...revisionFields,
    action:metadata.action==='live-append'?'live-append-chunk':'append-chunk',
    ...(observationRevision>=2?{observation_format:format}:{}),event_seq:event.seq,source_event_sha256:sha,event_sha256:transportSha,
    chunk_index:index,chunk_count:count,chunk_data:chunk,chunk_sha256:chunkSha},signal);
   if(receipt?.accepted===true)break;
   if(!receipt||receipt.accepted!==false||receipt.staged!==true||receipt.execution_authorized!==false
    ||receipt.run_id!==binding.runId||receipt.session_ref!==binding.sessionRef||receipt.event_seq!==event.seq
    ||receipt.event_sha256!==sha||receipt.chunk_index!==index||receipt.chunk_sha256!==chunkSha)throw Error('native_activity_chunk_receipt_invalid');
  }
 }else{
  receipt=await bridge.request('native-child-activities',binding,{...metadata,...revisionFields,
   ...observation,...evidence,event_sha256:transportSha},signal);
 }
 if(!receipt||receipt.accepted!==true||receipt.execution_authorized!==false||receipt.run_id!==binding.runId||receipt.session_ref!==binding.sessionRef
  ||receipt.event_seq!==event.seq||receipt.event_sha256!==sha||typeof receipt.activity_id!=='string')throw Error('native_activity_receipt_invalid');
 return receipt;
}

/** Replay a verified closed prefix without loading or retaining an Agent. */
export async function replayNativeChildActivities({binding,bridge,persistence,signal}){
 let source=await bridge.request('native-child-activities',binding,{action:'source'},signal);
 const preferred=preferredRevision(source);
 if(preferred>projectionRevision(source)){
  source=await bridge.request('native-child-activities',binding,{action:'source',projection_revision:preferred},signal);
  if(projectionRevision(source)!==preferred)throw Error('native_activity_source_invalid');
 }
 if(!source||source.protocol!==1||source.execution_authorized!==false||source.run_id!==binding.runId||source.session_ref!==binding.sessionRef
  ||typeof persistence?.open!=='function'||!Number.isSafeInteger(source.source_start)||source.source_start<0
  ||!Number.isSafeInteger(source.source_end)||source.source_end<source.source_start
  ||typeof source.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.log_sha256)
  ||source.last_event_seq!==null&&(!Number.isSafeInteger(source.last_event_seq)||source.last_event_seq<source.source_start||source.last_event_seq>=source.source_end)
  ||typeof source.complete!=='boolean')throw Error('native_activity_source_invalid');
 const revision=projectionRevision(source);
 if(revision>=2&&(typeof source.refresh_tool_results!=='boolean'||typeof source.replay_complete!=='boolean'
  ||source.complete&&(!source.replay_complete||source.refresh_tool_results)))throw Error('native_activity_source_invalid');
 if(revision===4&&(typeof source.refresh_tool_calls!=='boolean'||source.complete&&source.refresh_tool_calls))throw Error('native_activity_source_invalid');
 if(source.complete)return source;
 const settled=source.settled_web_call_ids;
 if(settled!==undefined&&(!Array.isArray(settled)||settled.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id))
  ||new Set(settled).size!==settled.length))throw Error('native_activity_source_invalid');
 const refreshResults=source.refresh_tool_results===true||settled===undefined?null:new Set(settled);
 signal?.throwIfAborted();const handle=await persistence.open(binding.sessionRef,'read',{signal});
 try{
  if(handle.id!==binding.sessionRef||handle.access!=='read'||handle.header?.parentSession!==source.parent_session_ref)throw Error('native_activity_prefix_changed');
  const hash=updateNativeChildLogHash(createHash('sha256'),{...handle.header,delegationDepth:handle.header?.delegationDepth??0}).update('\n');
  for(let seq=0;seq<source.source_end;seq++){
   signal?.throwIfAborted();const result=await handle.read(seq,1,{signal}),event=result?.events?.[0];
   if(result?.events?.length!==1||event?.seq!==seq)throw Error('native_activity_prefix_changed');
   updateNativeChildLogHash(hash,event).update('\n');
  }
  if(hash.digest('hex')!==source.log_sha256)throw Error('native_activity_prefix_changed');
  let last=source.last_event_seq;
  for(let seq=source.source_start;seq<source.source_end;seq++){
   signal?.throwIfAborted();
   const result=await handle.read(seq,1,{signal}),event=result?.events?.[0];
   if(result?.events?.length!==1||event?.seq!==seq)throw Error('native_activity_prefix_changed');
   if(!['tool/call','tool/result'].includes(event.type)
    ||event.type==='tool/result'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')continue;
   if(seq<=Number(source.last_event_seq??-1)&&!(event.type==='tool/call'&&revision===4&&source.refresh_tool_calls)
     &&(event.type!=='tool/result'||refreshResults!==null&&!refreshResults.has(sessionToolCallId(event.data))))continue;
   await sendNativeChildActivity({binding,event,bridge,metadata:{action:'append',source_log_sha256:source.log_sha256},signal,observationRevision:revision});
   last=Math.max(last??-1,seq);
  }
  signal?.throwIfAborted();const completed=await bridge.request('native-child-activities',binding,{action:'complete',source_log_sha256:source.log_sha256,expected_last_event_seq:last,...(revision>=2?{expected_projection_revision:revision}:{})},signal);
  if(!completed||completed.complete!==true||completed.execution_authorized!==false||completed.run_id!==binding.runId||completed.session_ref!==binding.sessionRef
   ||completed.log_sha256!==source.log_sha256||completed.source_start!==source.source_start||completed.source_end!==source.source_end
   ||completed.last_event_seq!==last||revision>=2&&(completed.projection_revision!==revision||completed.refresh_tool_results!==false)||revision===4&&completed.refresh_tool_calls!==false)throw Error('native_activity_receipt_invalid');
  return completed;
 }finally{await handle.close();}
}

/** Coalesce original SDK append notifications into one acknowledged cursor. */
export function createNativeChildActivityObserver({ctx,bridge,accepted,bindingFor,signal}){
 const states=new Map(),running=new Set(),stopped=new Set();let disposed=false;
 const stop=runId=>{
  stopped.add(runId);
  const state=states.get(runId);if(!state)return;
  states.delete(runId);clearTimeout(state.timer);state.abort.abort();
 };
 const current=state=>{
  const entry=accepted.get(state.session.id);
  return !disposed&&!stopped.has(state.binding.runId)&&!state.signal.aborted&&entry?.binding===state.binding
   &&entry.agent.session===state.session&&ctx.agents.get(entry.agent.id)===entry.agent&&bindingFor(entry.agent)===state.binding;
 };
 const kick=state=>{
  if(state.running||!current(state)){if(!current(state))stop(state.binding.runId);return;}
  clearTimeout(state.timer);
  const operation=Promise.resolve().then(async()=>{
   let failed=false;
   try{
    if(!state.source){
     let source=await bridge.request('native-child-activities',state.binding,{action:'live-source'},state.signal);
     const preferred=preferredRevision(source);
     if(preferred>projectionRevision(source)){
      source=await bridge.request('native-child-activities',state.binding,{action:'live-source',projection_revision:preferred},state.signal);
      if(projectionRevision(source)!==preferred)throw Error('native_activity_source_invalid');
     }
     if(!source||source.protocol!==1||source.kind!=='native_child_live_observation'||source.execution_authorized!==false
      ||source.run_id!==state.binding.runId||source.session_ref!==state.binding.sessionRef||source.parent_session_ref!==state.session.header?.parentSession
      ||!Number.isSafeInteger(source.source_start)||source.source_start<0||source.source_start>state.session.seq
      ||typeof source.snapshot_sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.snapshot_sha256))throw Error('native_activity_source_invalid');
     projectionRevision(source);state.source=source;state.cursor=source.source_start;
    }
    while(current(state)&&state.source&&state.cursor<state.session.seq){
     const seq=state.cursor,event=state.session.eventAt(seq);
     if(event?.seq!==seq)throw Error('native_activity_prefix_changed');
     if(['tool/call','tool/result'].includes(event.type)
      &&!(event.type==='tool/result'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')){
      const receipt=await sendNativeChildActivity({binding:state.binding,event,bridge,metadata:{action:'live-append',
       source_snapshot_sha256:state.source.snapshot_sha256},signal:state.signal,observationRevision:projectionRevision(state.source)});
      if(preferredRevision(receipt)>projectionRevision(state.source))state.source=null;
     }
     state.cursor=seq+1;state.reported=false;
     if(state.cursor%256===0)await new Promise(resolve=>setImmediate(resolve));
    }
   }catch{
    failed=true;
    state.source=null;
    if(current(state)&&!state.reported){
     state.reported=true;console.warn('[jot-native-public-activities]',JSON.stringify({runId:state.binding.runId,status:'live_replay_pending'}));
    }
   }finally{
    state.running=null;
    if(!current(state)){stop(state.binding.runId);return;}
    if(failed){
     state.timer=setTimeout(()=>kick(state),2000);state.timer.unref?.();
    }else if(!state.source||state.cursor<state.session.seq){
     state.timer=setTimeout(()=>kick(state),0);state.timer.unref?.();
    }
   }
  });
  state.running=operation;running.add(operation);operation.finally(()=>running.delete(operation)).catch(()=>{});
 };
 const observe=entry=>{
  if(disposed||signal?.aborted||!entry?.binding||stopped.has(entry.binding.runId)
   ||ctx.agents.get(entry.agent.id)!==entry.agent||bindingFor(entry.agent)!==entry.binding)return;
  const key=entry.binding.runId;let state=states.get(key);
  if(!state){
   const abort=new AbortController();
   state={binding:entry.binding,session:entry.agent.session,abort,signal:signal?AbortSignal.any([signal,abort.signal]):abort.signal,
    source:null,cursor:0,running:null,timer:undefined,reported:false};states.set(key,state);
  }
  kick(state);
 };
 const remove=ctx.on('session/event',session=>{
  const entry=accepted.get(session?.id);
  if(entry?.agent.session===session)observe(entry);
 });
 return {observe,stop,async dispose(){
  if(disposed)return;disposed=true;remove();for(const key of states.keys())stop(key);
  await Promise.allSettled([...running]);stopped.clear();
 }};
}

/** Recover closed observations through metadata and local read-only storage. */
export async function recoverPendingNativeChildActivities({bridge,persistence,replay,signal}){
 const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
 let warned=false,revision;
 while(!signal.aborted){
  try{
   let cursor;
   while(!signal.aborted){
    const page=await bridge.request('native-child-activities',undefined,{action:'pending',limit:25,...(cursor?{cursor}:{}),...(revision?{projection_revision:revision}:{})},signal);
    if(!page||page.protocol!==1||page.kind!=='native_closed_activity_pending'||page.execution_authorized!==false
     ||!Array.isArray(page.items)||page.items.length>25||page.next_cursor!==undefined&&(!id(page.next_cursor)||!page.items.length))throw Error('native_activity_pending_source_invalid');
    const preferred=preferredRevision(page);
    if(revision!==undefined&&page.supported_projection_revision!==undefined&&page.supported_projection_revision<revision)throw Error('native_activity_pending_source_invalid');
    if(preferred>(revision??1)){revision=preferred;cursor=undefined;continue;}
    let previous=cursor;
    for(const item of page.items){
     if(!item||!id(item.run_id)||!id(item.session_ref)||previous!==undefined&&item.run_id<=previous)throw Error('native_activity_pending_source_invalid');
     previous=item.run_id;
    }
    if(page.next_cursor!==undefined&&page.next_cursor!==previous)throw Error('native_activity_pending_source_invalid');
    warned=false;
    for(const item of page.items){
     signal.throwIfAborted();
     try{
      const local=await persistence.stat(item.session_ref,{signal});
      if(local?.header?.id!==item.session_ref||typeof local.revision!=='string'||!local.revision
       ||local.formatStatus!==undefined&&local.formatStatus!=='current')continue;
      await replay(Object.freeze({runId:item.run_id,sessionRef:item.session_ref}));
     }catch{signal.throwIfAborted();}
    }
    cursor=page.next_cursor;
    if(cursor===undefined)break;
   }
  }catch{
   if(signal.aborted)return;
   revision=undefined;
   if(!warned){console.warn('[jot-native-public-activities]',JSON.stringify({status:'closed_discovery_pending'}));warned=true;}
  }
  if(signal.aborted)return;
  await new Promise(resolve=>{
   const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
   const timer=setTimeout(done,30000);timer.unref?.();signal.addEventListener('abort',done,{once:true});
  });
 }
}
