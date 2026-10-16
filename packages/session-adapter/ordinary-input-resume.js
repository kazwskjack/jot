import {isDeepStrictEqual} from 'node:util';
import {normalizeHostExecutionLease} from './workbench.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const fail=()=>{throw Error('ordinary_input_recovery_required');};
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};

/** Read-only original product identity; never grants execution. */
export async function readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive=()=>{}}){
 const active=()=>{try{signal?.throwIfAborted();assertActive();}catch{fail();}};
 active();let result;try{result=await bridge.request('ordinary-input-binding',owned,{},signal);}catch{fail();}active();const row=result?.binding;
 if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='conversation_id,execution_authorized,execution_lease,input_message_id,input_sha256,owner_id,protocol,request_id,run_id,session_id'
  ||row.protocol!==1||row.execution_authorized!==false||row.run_id!==owned.runId||row.request_id!==owned.runId||row.session_id!==owned.sessionRef
  ||!['conversation_id','owner_id','input_message_id'].every(key=>valid(row[key]))||!/^[a-f0-9]{64}$/.test(row.input_sha256??'')||!isDeepStrictEqual(row.execution_lease,owned.executionLease))fail();
 return frozen(structuredClone(row));
}

/** Identity/composition preflight only. The caller must own an actual parked
 * observer; this neither opens a stream, restores claims nor wakes execution. */
export async function prepareOrdinaryInputResume({binding,controller,agents,bridge,ordinaryPresets,verifyComposition,observer,signal}={}){
 if(!binding||Object.keys(binding).sort().join(',')!=='executionLease,runId,sessionRef'||!valid(binding.runId)||!valid(binding.sessionRef)
  ||typeof controller?.projections!=='function'||typeof controller?.inspect!=='function'||typeof controller?.resolveAgent!=='function'||typeof agents?.get!=='function'
  ||typeof bridge?.request!=='function'||typeof verifyComposition!=='function'||typeof observer?.assertActive!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)fail();
 let executionLease;try{executionLease=normalizeHostExecutionLease(binding.executionLease);}catch{fail();}
 const owned=frozen({runId:binding.runId,sessionRef:binding.sessionRef,executionLease});
 const active=()=>{try{signal?.throwIfAborted();observer.assertActive();}catch{fail();}};
 const readAuthority=()=>readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive:active});
 const composition=async(phase,agent,projection,authority)=>{
  active();let result;try{result=await verifyComposition({phase,agent,projection,authority,signal});}catch{fail();}active();
  if(result?.verified!==true||typeof result.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(result.fingerprint))fail();return result.fingerprint;
 };
 const authority=await readAuthority();let projection,history;
 try{projection=frozen(structuredClone(await controller.projections({sessionId:owned.sessionRef},signal)));active();history=frozen(structuredClone(await controller.inspect(owned.sessionRef,signal)));}catch{fail();}active();
 const values=projection?.values,inbox=values?.inbox;
 if(!ordinaryPresets.has(values?.agentPreset)||!inbox||Object.keys(inbox).sort().join(',')!=='next-step,next-turn'||!['next-step','next-turn'].every(key=>Array.isArray(inbox[key])))fail();
 const pending=structuredClone([...inbox['next-step'],...inbox['next-turn']]),ids=pending.map(message=>message?.id);
 if(!ids.length||new Set(ids).size!==ids.length||pending.some(message=>!valid(message?.id)||message.role!=='user'||message.source?.kind!=='user'||message.source.rpcId!==owned.runId))fail();
 const goal=values.goal;if(goal!==null&&(!goal?.goal||!valid(goal.goal.id)||!['active','complete'].includes(goal.goal.phase)))fail();
 if(history?.meta?.id!==owned.sessionRef||!Array.isArray(history.events))fail();let open=null;
 for(const [index,event] of history.events.entries()){
  if(event?.seq!==index||typeof event.type!=='string')fail();
  if(event.type==='turn/start'){if(open!==null||!Number.isSafeInteger(event.data?.turn)||event.data.turn<0)fail();open=event.data.turn;}
  if(event.type==='turn/end'){if(open===null||event.data?.turn!==open)fail();open=null;}
  if(event.type==='user/message'&&(ids.includes(event.data?.id)||event.data?.source?.rpcId===owned.runId))fail();
 }if(open!==null)fail();
 const fingerprint=await composition('cold',undefined,projection,authority);if(!isDeepStrictEqual(await readAuthority(),authority))fail();
 let resolved;try{resolved=await controller.resolveAgent(owned.sessionRef);}catch{fail();}active();const agent=resolved?.agent;
 const seq=agent?.session?.seq;
 const check=()=>{
  active();if(resolved?.error||!agent||agent.id!==owned.sessionRef||agent.session?.id!==owned.sessionRef||agents.get(owned.sessionRef)!==agent||agent.status!=='idle'||!Number.isSafeInteger(seq)||agent.session.seq!==seq
   ||agent.jotPendingInputProtocol!==1||agent.jotPendingWakeRevocationProtocol!==1||typeof agent.jotResumePending!=='function'||typeof agent.jotRevokePendingWake!=='function'||typeof agent.runMaintenance!=='function'||!Array.isArray(agent.inbox?.nextStep)||!Array.isArray(agent.inbox?.nextTurn)
   ||!isDeepStrictEqual(agent.inbox.nextStep,inbox['next-step'])||!isDeepStrictEqual(agent.inbox.nextTurn,inbox['next-turn']))fail();
 };
 const recheck=async()=>{check();if(!isDeepStrictEqual(await readAuthority(),authority)||await composition('bound',agent,projection,authority)!==fingerprint)fail();check();};
 const guardExecution=async nativeSignal=>{active();try{nativeSignal?.throwIfAborted();}catch{fail();}if(agents.get(owned.sessionRef)!==agent||agent.id!==owned.sessionRef||agent.session?.id!==owned.sessionRef||!isDeepStrictEqual(await readAuthority(),authority)||await composition('bound',agent,projection,authority)!==fingerprint)fail();active();if(agents.get(owned.sessionRef)!==agent||agent.id!==owned.sessionRef||agent.session?.id!==owned.sessionRef)fail();try{nativeSignal?.throwIfAborted();}catch{fail();}};
 await recheck();return Object.freeze({agent,authority,request:frozen({requestId:owned.runId,messageIds:ids,seq}),check,recheck,guardExecution});
}
