import {isDeepStrictEqual} from 'node:util';
import {normalizeHostExecutionLease} from './workbench.js';
import {prepareOrdinaryInputResume} from './ordinary-input-resume.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function normalizeOrdinaryInputExecution(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_lease,run_id'||typeof value.run_id!=='string'||!ID.test(value.run_id))throw Error('ordinary_input_binding_invalid');
 return Object.freeze({runId:value.run_id,executionLease:normalizeHostExecutionLease(value.execution_lease)});
}
/** One parked original-run observer; no new prompt, Goal or planner. */
export function createOrdinaryInputRunHost({controller,agents,bridge,ordinaryPresets,verifyComposition}){
 if(!['follow','projections','inspect','resolveAgent'].every(key=>typeof controller?.[key]==='function')||typeof agents?.get!=='function'||typeof bridge?.request!=='function'||typeof verifyComposition!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)throw Error('ordinary_input_host_unavailable');
 const observers=new Map(),bound=new Map();let disposed=false;
 const active=record=>{if(disposed||record.closed||record.signal.aborted||observers.get(record.sessionId)!==record)throw Error('ordinary_input_observer_required');};
 const clean=record=>{for(const remove of record.removers.splice(0))try{remove();}catch{}if(bound.get(record.agent)===record)bound.delete(record.agent);};
 const preserve=record=>{
  const context=record.context,agent=record.agent;if(!context||context.signal?.aborted||agents.get(record.sessionId)!==agent)return;
  const messages=context.messages.filter(m=>m?.role==='user'&&m.source?.kind==='user');if(!messages.length)return;
  if(typeof agent.session.snapshotEvents!=='function'||typeof agent.inbox?.prepend!=='function')throw Error('ordinary_input_claim_unconfirmed');
  const events=agent.session.snapshotEvents(0);if(!Array.isArray(events))throw Error('ordinary_input_claim_unconfirmed');const entered=new Set(events.filter(e=>e.type==='user/message').map(e=>e.data?.id)),seen=new Set(),restore=[];
  for(const message of messages){if(!ID.test(message.id??'')||seen.has(message.id))throw Error('ordinary_input_claim_unconfirmed');seen.add(message.id);if(entered.has(message.id))continue;const existing=[...agent.inbox.nextStep,...agent.inbox.nextTurn].filter(m=>m.id===message.id);if(existing.length){if(existing.length!==1||!isDeepStrictEqual(existing[0],message))throw Error('ordinary_input_claim_unconfirmed');}else restore.push(message);}
  for(const message of restore.toReversed())agent.inbox.prepend('next-step',message);
 };
 const revoke=record=>{
  if(record.revoked)return;record.revoked=true;
  if(record.agent&&agents.get(record.sessionId)===record.agent){
   if(record.wakeToken)try{record.agent.jotRevokePendingWake(record.wakeToken);}catch{record.recoveryError=true;}
   if(record.ownsExecution){try{preserve(record);}catch{record.recoveryError=true;}try{const goals=record.agent.ctx.get('goals');goals?.disarm?.(record.agent);}catch{}if(record.maintenance||record.agent.status==='running')record.agent.cancel({kind:'parent'},{keepInbox:true});}
  }
  if(!record.maintenance&&(!record.ownsExecution||record.agent?.status==='idle'))clean(record);
 };
 const close=record=>{record.closed=true;record.release();revoke(record);record.local.abort();};
 const guard=async(record,signal)=>{try{active(record);if(record.revoked||!record.admitted||!record.prepared||bound.get(record.agent)!==record)throw Error();await record.prepared.guardExecution(signal);active(record);}catch{revoke(record);throw Error('ordinary_input_execution_revoked');}};
 const install=record=>{
  if(bound.has(record.agent))throw Error('ordinary_input_observer_conflict');bound.set(record.agent,record);const on=(event,fn)=>record.removers.push(record.agent.ctx.on(event,fn,{prepend:true}));
  on('agent/status',({agent,status})=>{if(agent===record.agent&&status==='idle'){record.ownsExecution=false;if(record.revoked&&!record.maintenance)clean(record);}});
  on('agent/pre-step',async(payload,next)=>{
   if(payload.agent!==record.agent)return next();
   const humans=(payload.messages??[]).filter(m=>m?.role==='user'&&m.source?.kind==='user'),foreign=humans.some(m=>m.source.rpcId!==record.binding.runId||!record.prepared.request.messageIds.includes(m.id));
   if(foreign&&!record.ownsExecution){close(record);clean(record);return next();}
   const context={signal:payload.signal,messages:[...(payload.messages??[])]};record.context=context;
   try{if(foreign)throw Error();await guard(record,payload.signal);record.ownsExecution=true;const value=await next();await guard(record,payload.signal);return value;}
   catch{revoke(record);if(record.recoveryError)throw Error('ordinary_input_claim_unconfirmed');return{kind:'reject'};}
   finally{if(record.context===context)record.context=null;}
  });
  on('tools/execute',async(payload,next)=>{await guard(record,payload.signal);return next();});
  on('llm/stream',(payload,next)=>payload?.sessionId!==record.sessionId?next():(async function*(){await guard(record,payload.signal);yield* next();})());
 };
 return{
  async *follow(sessionId,value,request,signal){
   const owned=normalizeOrdinaryInputExecution(value);if(disposed||!ID.test(sessionId??'')||!signal||observers.has(sessionId)||request?.address?.kind!=='session'||request.address.sessionId!==sessionId)throw Error('ordinary_input_observer_conflict');
   const local=new AbortController();let release;const admitted=new Promise(r=>release=r),record={sessionId,binding:owned,local,signal:AbortSignal.any([signal,local.signal]),release,removers:[],closed:false,revoked:false,ownsExecution:false};observers.set(sessionId,record);const abort=()=>close(record);record.signal.addEventListener('abort',abort,{once:true});let stream;
   try{
    const result=await bridge.request('ordinary-input-binding',{...owned,sessionRef:sessionId},{},record.signal);active(record);if(result?.binding?.run_id!==owned.runId||result.binding.session_id!==sessionId||!isDeepStrictEqual(result.binding.execution_lease,owned.executionLease)||result.binding.execution_authorized!==false)throw Error('ordinary_input_binding_invalid');
    stream=controller.follow(request,record.signal)[Symbol.asyncIterator]();const opening=await stream.next();active(record);if(opening.done||opening.value?.type!=='snapshot'||!Number.isSafeInteger(opening.value.cursor)||opening.value.cursor<0)throw Error('ordinary_input_snapshot_invalid');record.opened=true;yield opening.value;
    await admitted;if(record.signal.aborted)return;active(record);while(true){const item=await stream.next();if(item.done)break;active(record);yield item.value;}
   }finally{record.signal.removeEventListener('abort',abort);close(record);if(observers.get(sessionId)===record)observers.delete(sessionId);await stream?.return?.();}
  },
  async resume(sessionId,value){
   const owned=normalizeOrdinaryInputExecution(value),record=observers.get(sessionId);if(!record?.opened||!isDeepStrictEqual(record.binding,owned))throw Error('ordinary_input_observer_required');active(record);
   record.promise??=(async()=>{try{
    const prepared=await prepareOrdinaryInputResume({binding:{...owned,sessionRef:sessionId},controller,agents,bridge,ordinaryPresets,verifyComposition,observer:{assertActive:()=>active(record)},signal:record.signal});active(record);record.prepared=prepared;record.agent=prepared.agent;install(record);
    record.maintenance=true;try{const result=await record.agent.runMaintenance(async nativeSignal=>{await prepared.recheck();nativeSignal.throwIfAborted();active(record);record.release();await prepared.recheck();nativeSignal.throwIfAborted();active(record);prepared.check();record.ownsExecution=true;const wake=record.agent.jotResumePending(prepared.request);record.wakeToken=wake?.wakeToken;if(wake?.accepted!==true||typeof record.wakeToken!=='symbol'||wake.seq!==prepared.request.seq||!isDeepStrictEqual(wake.messageIds,prepared.request.messageIds))throw Error('ordinary_input_wake_unconfirmed');record.admitted=true;return{accepted:true,run_id:owned.runId,session_id:sessionId,input_message_id:prepared.authority.input_message_id,native_message_ids:[...wake.messageIds]};});active(record);return result;}finally{record.maintenance=false;if(record.revoked&&record.agent.status==='idle')clean(record);}
   }catch(error){revoke(record);throw error;}})();return record.promise;
  },
  async dispose(){disposed=true;for(const record of observers.values())close(record);observers.clear();}
 };
}
