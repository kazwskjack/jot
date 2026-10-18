import {nativeGoalsFor} from './workbench-goal.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const phases=new Set(['active','paused','blocked','complete']);
function invalid(){throw Error('native_idle_observation_unconfirmed');}
function goalFact(goal,cold=false){
 if(goal===null||goal===undefined)return null;
 if(!goal||typeof goal!=='object'||typeof goal.id!=='string'||!ID.test(goal.id)||!Number.isSafeInteger(goal.revision)||goal.revision<1||!phases.has(goal.phase))invalid();
 const activation=cold&&goal.activation===undefined?'disarmed':goal.activation;
 if(!['armed','disarmed'].includes(activation))invalid();
 return {id:goal.id,revision:goal.revision,phase:goal.phase,activation};
}
function liveFact(agent,sessionId){
 if(agent.id!==sessionId||agent.session?.id!==sessionId||!['idle','running'].includes(agent.status))invalid();
 if(agent.status==='running')return {running:true};
 if(!agent.inbox||!Array.isArray(agent.inbox.nextTurn)||!Array.isArray(agent.inbox.nextStep))invalid();
 const service=nativeGoalsFor(agent);if(typeof service?.get!=='function')invalid();
 return {running:false,nextTurn:agent.inbox.nextTurn.length,nextStep:agent.inbox.nextStep.length,goal:goalFact(service.get(agent))};
}
function coldFact(projection,allowedPresets){
 // Deferred-migration values are cache hints, never an authoritative current baseline.
 if(projection?.kind!==undefined&&projection.kind!=='sequenced')invalid();
 if(projection===null)return null;
 const values=projection?.values;
 if(!values||typeof values!=='object'||!allowedPresets?.has(values.agentPreset)||!Object.hasOwn(values,'goal')
  ||!values.inbox||Object.keys(values.inbox).sort().join(',')!=='next-step,next-turn'
  ||!Array.isArray(values.inbox['next-step'])||!Array.isArray(values.inbox['next-turn']))invalid();
 if(values.goal!==null&&(!values.goal||typeof values.goal!=='object'||!values.goal.goal))invalid();
 return {preset:values.agentPreset,nextTurn:values.inbox['next-turn'].length,nextStep:values.inbox['next-step'].length,goal:values.goal===null?null:goalFact(values.goal.goal,true)};
}
/** Current Host quiescence only. Never resolve/create an Agent, follow, flush,
 * prompt, repair input, resume Goal, certify completion or settle provider cost.
 * Cold quiescence is not proof of successful historical execution. */
export async function readNativeIdleObservation({agents,controller,sessionId,signal,allowedPresets}){
 if(typeof sessionId!=='string'||!ID.test(sessionId))invalid();signal?.throwIfAborted();
 let basis='unavailable';
 const result=(native_idle,reason=null)=>Object.freeze({protocol:1,session_id:sessionId,basis,native_idle,reason,observed_at:Date.now(),execution_authorized:false});
 try{
  if(typeof agents?.get!=='function')return result('unknown','STATE_UNAVAILABLE');
  const agent=agents.get(sessionId);
  if(agent){
   basis='live';const first=liveFact(agent,sessionId),second=liveFact(agent,sessionId);signal?.throwIfAborted();
   if(agents.get(sessionId)!==agent||JSON.stringify(first)!==JSON.stringify(second))return result('unknown','STATE_CHANGED');
   if(first.running)return result('busy','AGENT_RUNNING');
   if(first.nextTurn||first.nextStep)return result('busy','INPUT_PENDING');
   if(first.goal?.activation==='armed')return result('busy','GOAL_ARMED');
   return result('idle');
  }
  basis='cold';if(typeof controller?.projections!=='function')return result('unknown','STATE_UNAVAILABLE');
  const first=coldFact(await controller.projections({sessionId},signal),allowedPresets);signal?.throwIfAborted();
  if(first===null){basis='absent';return result('unknown','SESSION_MISSING');}
  const second=coldFact(await controller.projections({sessionId},signal),allowedPresets);signal?.throwIfAborted();
  if(agents.get(sessionId)!=null||JSON.stringify(first)!==JSON.stringify(second))return result('unknown','STATE_CHANGED');
  if(first.nextTurn||first.nextStep)return result('busy','INPUT_PENDING');
  if(first.goal?.activation==='armed')return result('busy','GOAL_ARMED');
  if(first.goal?.phase==='active')return result('busy','PERSISTED_GOAL_ACTIVE');
  return result('idle');
 }catch(error){if(signal?.aborted)throw error;return result('unknown','STATE_UNAVAILABLE');}
}
