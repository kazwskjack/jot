import {createHash} from 'node:crypto';
import {nativeToolResultObservation,sessionToolCallId} from './native-tool-result.js';
import {nativeChildLogJson as json} from './native-child-closure.js';

async function sendNativeChildActivity({binding,event,bridge,metadata,signal}){
 const sha=createHash('sha256').update(json(event)).digest('hex');
 const observation=event.type==='tool/result'?nativeToolResultObservation(event):{event};
 const evidence=event.type==='tool/result'?{event_format:'public-result-v1',source_event_sha256:sha}:{};
 const transportSha=event.type==='tool/result'?createHash('sha256').update(json(observation)).digest('hex'):sha;
 const receipt=await bridge.request('native-child-activities',binding,{...metadata,
  ...observation,...evidence,event_sha256:transportSha},signal);
 if(!receipt||receipt.accepted!==true||receipt.execution_authorized!==false||receipt.run_id!==binding.runId||receipt.session_ref!==binding.sessionRef
  ||receipt.event_seq!==event.seq||receipt.event_sha256!==sha||typeof receipt.activity_id!=='string')throw Error('native_activity_receipt_invalid');
 return receipt;
}

/** Replay a verified closed prefix without loading or retaining an Agent. */
export async function replayNativeChildActivities({binding,bridge,persistence,signal}){
 const source=await bridge.request('native-child-activities',binding,{action:'source'},signal);
 if(!source||source.protocol!==1||source.execution_authorized!==false||source.run_id!==binding.runId||source.session_ref!==binding.sessionRef
  ||typeof persistence?.open!=='function'||!Number.isSafeInteger(source.source_start)||source.source_start<0
  ||!Number.isSafeInteger(source.source_end)||source.source_end<source.source_start
  ||typeof source.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.log_sha256)
  ||source.last_event_seq!==null&&(!Number.isSafeInteger(source.last_event_seq)||source.last_event_seq<source.source_start||source.last_event_seq>=source.source_end)
  ||typeof source.complete!=='boolean')throw Error('native_activity_source_invalid');
 if(source.complete)return source;
 const settled=source.settled_web_call_ids;
 if(settled!==undefined&&(!Array.isArray(settled)||settled.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id))
  ||new Set(settled).size!==settled.length))throw Error('native_activity_source_invalid');
 const refreshResults=settled===undefined?null:new Set(settled);
 signal?.throwIfAborted();const handle=await persistence.open(binding.sessionRef,'read',{signal});
 try{
  if(handle.id!==binding.sessionRef||handle.access!=='read'||handle.header?.parentSession!==source.parent_session_ref)throw Error('native_activity_prefix_changed');
  const hash=createHash('sha256').update(json({...handle.header,delegationDepth:handle.header?.delegationDepth??0})+'\n');
  for(let seq=0;seq<source.source_end;seq++){
   signal?.throwIfAborted();const result=await handle.read(seq,1,{signal}),event=result?.events?.[0];
   if(result?.events?.length!==1||event?.seq!==seq)throw Error('native_activity_prefix_changed');
   hash.update(json(event)+'\n');
  }
  if(hash.digest('hex')!==source.log_sha256)throw Error('native_activity_prefix_changed');
  let last=source.last_event_seq;
  for(let seq=source.source_start;seq<source.source_end;seq++){
   signal?.throwIfAborted();
   const result=await handle.read(seq,1,{signal}),event=result?.events?.[0];
   if(result?.events?.length!==1||event?.seq!==seq)throw Error('native_activity_prefix_changed');
   if(!['tool/call','tool/result'].includes(event.type)
    ||event.type==='tool/result'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')continue;
   if(seq<=Number(source.last_event_seq??-1)&&(event.type!=='tool/result'||refreshResults!==null&&!refreshResults.has(sessionToolCallId(event.data))))continue;
   await sendNativeChildActivity({binding,event,bridge,metadata:{action:'append',source_log_sha256:source.log_sha256},signal});
   last=Math.max(last??-1,seq);
  }
  signal?.throwIfAborted();const completed=await bridge.request('native-child-activities',binding,{action:'complete',source_log_sha256:source.log_sha256,expected_last_event_seq:last},signal);
  if(!completed||completed.complete!==true||completed.execution_authorized!==false||completed.run_id!==binding.runId||completed.session_ref!==binding.sessionRef
   ||completed.log_sha256!==source.log_sha256||completed.source_start!==source.source_start||completed.source_end!==source.source_end
   ||completed.last_event_seq!==last)throw Error('native_activity_receipt_invalid');
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
     const source=await bridge.request('native-child-activities',state.binding,{action:'live-source'},state.signal);
     if(!source||source.protocol!==1||source.kind!=='native_child_live_observation'||source.execution_authorized!==false
      ||source.run_id!==state.binding.runId||source.session_ref!==state.binding.sessionRef||source.parent_session_ref!==state.session.header?.parentSession
      ||!Number.isSafeInteger(source.source_start)||source.source_start<0||source.source_start>state.session.seq
      ||typeof source.snapshot_sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.snapshot_sha256))throw Error('native_activity_source_invalid');
     state.source=source;state.cursor=source.source_start;
    }
    while(current(state)&&state.cursor<state.session.seq){
     const seq=state.cursor,event=state.session.eventAt(seq);
     if(event?.seq!==seq)throw Error('native_activity_prefix_changed');
     if(['tool/call','tool/result'].includes(event.type)
      &&!(event.type==='tool/result'&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')){
      await sendNativeChildActivity({binding:state.binding,event,bridge,metadata:{action:'live-append',
       source_snapshot_sha256:state.source.snapshot_sha256},signal:state.signal});
     }
     state.cursor=seq+1;state.reported=false;
     if(state.cursor%256===0)await new Promise(resolve=>setImmediate(resolve));
    }
   }catch{
    failed=true;
    if(current(state)&&!state.reported){
     state.reported=true;console.warn('[jot-native-public-activities]',JSON.stringify({runId:state.binding.runId,status:'live_replay_pending'}));
    }
   }finally{
    state.running=null;
    if(!current(state)){stop(state.binding.runId);return;}
    if(failed){
     state.timer=setTimeout(()=>kick(state),2000);state.timer.unref?.();
    }else if(state.cursor<state.session.seq){
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
