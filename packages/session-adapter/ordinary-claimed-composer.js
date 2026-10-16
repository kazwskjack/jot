import {verifyNativeInputAttachments} from './native-input-attachments.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';
import {normalizeHostExecutionLease} from './workbench.js';
import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
import {createOrdinaryClaimedInputRecoverySetup} from './ordinary-claimed-input.js';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const fail=()=>{throw Error('ordinary_claimed_factory_unconfirmed');};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function wait(operation,signal){
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}
/** Cold ordinary-input restoration inside the original unpublished factory.
 * No prompt, driver wake, Goal activation or admission creation is performed. */
export function createOrdinaryClaimedSessionComposer({ctx,bridge,Session,agents,sessions,query,projections,validateLog,profile,admissions,ordinaryPresets}){
 const loop=typeof ctx?.get==='function'?ctx.get('agentLoop'):ctx?.agentLoop;
 if(loop?.jotPreSetupHookProtocol!==2||typeof ctx?.on!=='function'||typeof bridge?.request!=='function'||typeof Session?.create!=='function'||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof query?.readSession!=='function'||typeof projections?.snapshot!=='function'||typeof validateLog!=='function'||typeof profile?.read!=='function'||admissions?.entryReservationProtocol!==1||typeof admissions.readReplayCandidate!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)fail();
 const storage=new AsyncLocalStorage(),shutdown=new AbortController(),operations=new Set(),pending=new Set(),busy=new Set();let disposed=false,cleaned=false,disposal;
 const authority=async record=>{record.signal.throwIfAborted();if(disposed||record.closed)fail();const current=await wait(()=>readOrdinaryInputAuthority({bridge,binding:record.binding,signal:record.signal}),record.signal);if(!isDeepStrictEqual(current,record.authority))fail();};
 const check=(record,agent)=>{record.signal.throwIfAborted();if(disposed||record.closed||agent?.id!==record.binding.sessionRef||agent.session?.id!==agent.id||agent.status!=='idle'||agents.get(agent.id)!==undefined||sessions.get(agent.id)!==undefined||!ordinaryPresets.has(agent.session.header?.agentPreset)||agent.session.header.parentSession!==undefined||agent.session.header.origin==='subagent')fail();if(record.session&&(agent.session!==record.session||!isDeepStrictEqual(agent.session.header,record.header)))fail();const goal=projections.snapshot(agent.session,['goal'])?.values?.goal;if(goal!=null&&(!valid(goal.goal?.id)||!['active','complete'].includes(goal.goal.phase)))fail();};
 const verifyAttachments=(record,messages)=>wait(()=>verifyNativeInputAttachments(messages,{attachments:typeof ctx.get==='function'?ctx.get('attachments'):ctx.attachments,signal:record.signal}),record.signal);
 const inbox=agent=>({'next-step':structuredClone(agent.inbox.nextStep),'next-turn':structuredClone(agent.inbox.nextTurn)});
 const removers=[];
 removers.push(ctx.on('agent/before-setup',async({agent,source,signal:nativeSignal,bindAbortSignal})=>{
  const record=storage.getStore();if(!record)return;if(record.observed||source!=='resume'||typeof bindAbortSignal!=='function')fail();bindAbortSignal(record.signal);record.signal=AbortSignal.any([record.signal,nativeSignal]);check(record,agent);record.session=agent.session;record.header=freeze(structuredClone(agent.session.header));await authority(record);check(record,agent);
  record.profile=freeze(structuredClone(await wait(()=>profile.read({agent,presetId:agent.session.header.agentPreset,phase:'prepared',signal:record.signal}),record.signal)));check(record,agent);
  const setup=createOrdinaryClaimedInputRecoverySetup({binding:record.binding,bridge,Session,agents,sessions,query,projections,validateLog,admissions,ordinaryPresets,signal:record.signal,profile:{read:async request=>{const current=await wait(()=>profile.read(request),record.signal);if(!isDeepStrictEqual(current,record.profile))fail();return current;}}});
  await wait(()=>setup(agent.ctx,agent),record.signal);check(record,agent);const report=setup.resultFor(agent),items=inbox(agent),messages=[...items['next-step'],...items['next-turn']];
  if(report?.execution_authorized!==false||!(report.state==='restored'&&report.restored>0||record.allowPending&&report.state==='none'&&report.restored===0)||report.goal_owned!==0||!messages.length||messages.some(m=>m?.role!=='user'||m.source?.kind!=='user'||!valid(m.source.rpcId))||new Set(messages.map(m=>m.id)).size!==messages.length)fail();
  record.recheckClaims=()=>setup.recheckFor(agent);await record.recheckClaims();
  await verifyAttachments(record,messages);check(record,agent);record.agent=agent;record.pending=freeze(items);record.report=report;record.seq=agent.session.seq;record.prefix=freeze(structuredClone(agent.session.snapshotEvents(0)));record.observed=true;
 },{prepend:true}));
 removers.push(ctx.on('agent/after-setup',async({agent,source,signal:nativeSignal})=>{
  const record=storage.getStore();if(!record)return;if(!record.observed||record.finalized||record.agent!==agent||source!=='resume')fail();record.signal=AbortSignal.any([record.signal,nativeSignal]);check(record,agent);await authority(record);check(record,agent);
  const current=await wait(()=>profile.read({agent,presetId:agent.session.header.agentPreset,phase:'bound',signal:record.signal}),record.signal);check(record,agent);
  const events=agent.session.snapshotEvents(0);if(!isDeepStrictEqual(current,record.profile)||!isDeepStrictEqual(inbox(agent),record.pending)||!isDeepStrictEqual(events.slice(0,record.seq),record.prefix)||events.slice(record.seq).some(e=>['turn/start','step/start','user/message','request/header','tool/call'].includes(e.type)))fail();await verifyAttachments(record,[...record.pending['next-step'],...record.pending['next-turn']]);await authority(record);await record.recheckClaims();check(record,agent);record.finalized=true;
 },{prepend:true}));
 const cleanup=()=>{if(disposed&&!operations.size&&!cleaned){cleaned=true;removers.forEach(remove=>remove());storage.disable();}};
 return {
  withResolution({binding,signal=new AbortController().signal,allowPending=false},operation){
   const task=(async()=>{if(typeof allowPending!=='boolean'||disposed||!binding||Object.keys(binding).sort().join(',')!=='executionLease,runId,sessionRef'||!valid(binding.runId)||!valid(binding.sessionRef)||typeof operation!=='function'||busy.has(binding.sessionRef)||agents.get(binding.sessionRef)!==undefined||sessions.get(binding.sessionRef)!==undefined)fail();
    const owned=freeze({runId:binding.runId,sessionRef:binding.sessionRef,executionLease:normalizeHostExecutionLease(binding.executionLease)}),combined=AbortSignal.any([signal,shutdown.signal]);combined.throwIfAborted();busy.add(owned.sessionRef);const record={binding:owned,signal:combined,allowPending,closed:false};
    try{record.authority=await wait(()=>readOrdinaryInputAuthority({bridge,binding:owned,signal:combined}),combined);return await storage.run(record,async()=>{
     const value=await wait(()=>{const operationPromise=Promise.resolve().then(()=>{combined.throwIfAborted();return operation();});operations.add(operationPromise);operationPromise.finally(()=>{operations.delete(operationPromise);cleanup();}).catch(()=>{});return operationPromise;},combined);
     combined.throwIfAborted();if(disposed||!record.observed||!record.finalized||value?.agent!==record.agent||agents.get(owned.sessionRef)!==record.agent||sessions.get(owned.sessionRef)!==record.agent.session)fail();await authority(record);if(record.agent.session!==record.session||!isDeepStrictEqual(record.session.header,record.header))fail();return {value,recovery:record.report,pending:record.pending};
    });}finally{record.closed=true;busy.delete(owned.sessionRef);}
   })();pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  },
  dispose(){if(disposal)return disposal;disposed=true;shutdown.abort(Error('ordinary_claimed_factory_disposed'));return disposal=(async()=>{await Promise.allSettled([...pending]);cleanup();})();}
 };
}
