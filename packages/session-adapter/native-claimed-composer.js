import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {createNativeClaimedInputRecoverySetup} from './native-claimed-input.js';
import {verifyNativeTaskResumeGoal} from './workbench-goal.js';
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
function validateProfile(value,presetId){if(value?.protocol!==1||!valid(value.profile_id)||!valid(value.audit_id)||value.preset_id!==presetId||!/^[a-f0-9]{64}$/.test(value.fingerprint??''))throw Error('native_claim_composer_profile_invalid');return value;}
function waitFor(operation,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}


/** Request-scoped subscriber for the explicit rc2 compatibility hook. The
 * original Controller and its original preset/model setup remain in control. */
export function createNativeClaimedSessionComposer({ctx,bridge,Session,agents,sessions,query,projections,validateLog,profile,provenance}){
 const loop=typeof ctx?.get==='function'?ctx.get('agentLoop'):ctx?.agentLoop;
 if(loop?.jotPreSetupHookProtocol!==2||typeof ctx?.on!=='function'||typeof ctx?.effect!=='function'||typeof bridge?.authorizeNativeResume!=='function'||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof projections?.snapshot!=='function'||typeof Session?.create!=='function'||typeof query?.readSession!=='function'||typeof provenance?.read!=='function'||typeof provenance?.create!=='function'||typeof profile?.read!=='function'||typeof validateLog!=='function')throw Error('native_claim_composer_unavailable');
 const storage=new AsyncLocalStorage(),pending=new Set(),operations=new Set(),shutdown=new AbortController();let disposed=false,disposal,cleaned=false;
 const remove=ctx.on('agent/before-setup',async({agent,source,signal:nativeSignal,bindAbortSignal})=>{
  const record=storage.getStore();if(!record)return;if(record.closed||record.observed)throw Error('native_claim_composer_scope_changed');
  // Couple the original factory's setup wait/rollback to caller cancellation.
  if(typeof bindAbortSignal!=='function')throw Error('native_claim_composer_abort_binding_missing');
  bindAbortSignal(record.signal);
  const signal=AbortSignal.any([record.signal,nativeSignal,shutdown.signal]);
  const check=()=>{signal.throwIfAborted();if(record.closed||disposed||agent?.id!==record.sessionId||agent.session?.id!==record.sessionId||agent.session.header.cwd!==record.cwd||(agent.session.header.agentPreset??null)!==record.presetId||agent.session.header.parentSession!==undefined||agent.session.header.origin==='subagent'||agents.get(agent.id)!==undefined||sessions.get(agent.id)!==undefined)throw Error('native_claim_composer_scope_changed');};
  check();if(!['startup','resume'].includes(source))throw Error('native_claim_composer_scope_changed');
  const authorize=async()=>{check();const current=await waitFor(()=>bridge.authorizeNativeResume(record.binding,signal),signal);check();if(canonical(current)!==record.authority)throw Error('native_claim_composer_authority_changed');if(source==='resume')verifyNativeTaskResumeGoal(agent,current.scope,current.mapping,projections);return {authorized:true};};
  const readProfile=()=>waitFor(()=>profile.read({presetId:record.presetId,signal,agent,phase:'prepared'}),signal);
  await authorize();const currentProfile=await readProfile();check();
  validateProfile(currentProfile,record.presetId);
  const stamp=Object.freeze({...currentProfile,binding_sha256:record.bindingHash});
  if(source==='startup'){
   if(record.original.mapping!==null||agent.session.seq!==0)throw Error('native_claim_composer_history_missing');
   await authorize();const finalProfile=await readProfile();check();if(canonical(finalProfile)!==canonical(currentProfile))throw Error('native_claim_composer_profile_changed');await waitFor(()=>provenance.create(agent.session,stamp,{signal}),signal);check();record.report=Object.freeze({state:'fresh',execution_authorized:false});
  }else{
   const saved=await waitFor(()=>provenance.read(agent.session,{signal}),signal);check();
   if(canonical(saved)!==canonical(stamp))throw Error('native_claim_composer_profile_changed');
   const setup=createNativeClaimedInputRecoverySetup({Session,agents,sessions,query,projections,validateLog,signal,
    authorize,
    confirmReplaySafety:async()=>{await authorize();const latest=await readProfile();check();return {safe:canonical(latest)===canonical(currentProfile)};}});
   await waitFor(()=>setup(agent.ctx,agent),signal);check();record.report=setup.resultFor(agent);
  }
  record.observed=true;record.agent=agent;record.source=source;record.recheck=authorize;record.profile=currentProfile;
 },{prepend:true});
 const removeAfter=ctx.on('agent/after-setup',async({agent,source,signal:nativeSignal})=>{
  const record=storage.getStore();if(!record)return;
  if(record.closed||!record.observed||record.finalized||record.agent!==agent||record.source!==source)throw Error('native_claim_composer_scope_changed');
  const signal=AbortSignal.any([record.signal,nativeSignal,shutdown.signal]);await record.recheck();
  const bound=await waitFor(()=>profile.read({presetId:record.presetId,signal,agent,phase:'bound'}),signal);signal.throwIfAborted();
  if(canonical(bound)!==canonical(record.profile))throw Error('native_claim_composer_profile_changed');
  await record.recheck();record.finalized=true;
 },{prepend:true});
 const cleanup=()=>{if(!cleaned&&disposed&&!operations.size){cleaned=true;removeAfter();remove();storage.disable();}};
 const api={
  withCreation({sessionId,cwd,presetId=null,binding,signal=new AbortController().signal},operation){
   const task=(async()=>{
    if(disposed||!valid(sessionId)||typeof cwd!=='string'||!isAbsolute(cwd)||presetId!==null&&!valid(presetId)||typeof operation!=='function'||binding?.sessionRef!==sessionId)throw Error('native_claim_composer_request_invalid');
    // Startup/recovery deadline only; no limit is imposed on subsequent turns.
    const combined=AbortSignal.any([signal,shutdown.signal,AbortSignal.timeout(30000)]);combined.throwIfAborted();
    // This occurs before the original Controller may inspect a stored Session.
    const original=await waitFor(()=>bridge.authorizeNativeResume(binding,combined),combined);combined.throwIfAborted();
    const record={sessionId,cwd,presetId,binding:original.binding,original,authority:canonical(original),bindingHash:digest({scope:original.scope,lease:original.binding.executionLease}),signal:combined,closed:false,observed:false,report:undefined};
    const resident=agents.get(sessionId);
    if(resident){
     const check=()=>{combined.throwIfAborted();if(disposed||agents.get(sessionId)!==resident||sessions.get(sessionId)!==resident.session||resident.id!==sessionId||resident.session?.id!==sessionId||resident.session.header.cwd!==cwd||(resident.session.header.agentPreset??null)!==presetId||resident.session.header.parentSession!==undefined||resident.session.header.origin==='subagent')throw Error('native_claim_composer_scope_changed');};
     check();const bound=validateProfile(await waitFor(()=>profile.read({presetId,signal:combined,agent:resident,phase:'bound'}),combined),presetId);check();
     const saved=await waitFor(()=>provenance.read(resident.session,{signal:combined}),combined);check();
     if(canonical(saved)!==canonical({...bound,binding_sha256:record.bindingHash}))throw Error('native_claim_composer_profile_changed');
     const current=await waitFor(()=>bridge.authorizeNativeResume(record.binding,combined),combined);check();if(canonical(current)!==record.authority)throw Error('native_claim_composer_authority_changed');
    }
    try{return await storage.run(record,async()=>{
     const originalOperation=()=>{const promise=Promise.resolve().then(operation);operations.add(promise);promise.finally(()=>{operations.delete(promise);cleanup();}).catch(()=>{});return promise;};
     const value=await waitFor(originalOperation,combined);combined.throwIfAborted();if(!resident&&(!record.observed||!record.finalized))throw Error('native_claim_composer_hook_missing');return {value,...(record.report?{recovery:record.report}:{})};
    });}
    finally{record.closed=true;}
   })();pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  },
  dispose(){if(disposal)return disposal;disposed=true;shutdown.abort(Error('native_claim_composer_disposed'));return disposal=(async()=>{await Promise.allSettled([...pending]);cleanup();})();}
 };
 ctx.effect(()=>()=>api.dispose());return api;
}
