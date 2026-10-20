import {withNativeHandoffBarrier} from './native-handoff-barrier.js';
import {nativeGoalsFor} from './workbench-goal.js';
import {withColdWorkspaceSession} from './native-child-closure.js';
import {claimNativeWorkspaceFactory,assertNativeWorkspaceFactoryHold} from './native-workspace-factory.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function goalStamp(agent){
 const service=nativeGoalsFor(agent);
 if(typeof service?.get!=='function')throw Error('native_workspace_goal_unavailable');
 const goal=service.get(agent);
 // The official Goal service returns undefined before the first Goal.
 if(goal===null||goal===undefined)return null;
 if(!goal||typeof goal!=='object'||typeof goal.id!=='string'||!ID.test(goal.id)||!Number.isSafeInteger(goal.revision)||goal.revision<1
  ||!['active','paused','blocked','complete'].includes(goal.phase)||!['armed','disarmed'].includes(goal.activation))throw Error('native_workspace_goal_invalid');
 if(goal.activation==='armed')throw Error('native_workspace_goal_armed');
 return JSON.stringify([goal.id,goal.revision,goal.phase,goal.activation]);
}

/** Host-only family barrier, not a route, idle observation or execution grant.
 * The owning workspace reservation must already fence new member admission,
 * shared writers and restore. Its synchronous check revalidates original
 * ownership, membership and cancellation; this helper never creates that grant.
 * Keep every native maintenance handle held through the awaited operation.
 * A changed/aborted post-dispatch result is NOT evidence of no physical effect.
 */
export async function withNativeWorkspaceBarrier(input,operation){
 if(typeof input?.assertReservation!=='function')throw Error('native_workspace_reservation_invalid');
 if(typeof operation!=='function'||!Array.isArray(input.members)||input.members.length>256)throw Error('native_workspace_members_invalid');
 const ids=new Set(),members=input.members.map(member=>{
  const id=member?.agent?.id??member?.sessionRef;
  if(typeof id!=='string'||!ID.test(id)||ids.has(id))throw Error('native_workspace_members_invalid');
  ids.add(id);return {...member,sessionRef:id};
 }).sort((a,b)=>a.sessionRef.localeCompare(b.sessionRef,'en'));
 const reservation=input.assertReservation,requestSignal=input.signal,held=[],proofs=[],signals=[];let factoryLease;
 const checkReservation=()=>{
  requestSignal?.throwIfAborted();
  factoryLease?.signal.throwIfAborted();
  if(factoryLease)for(const member of members)assertNativeWorkspaceFactoryHold(factoryLease.token,member);
  const value=reservation();
  if(value!==undefined){
   // Observe a mistakenly asynchronous check without an unhandled rejection;
   // never await it or treat its eventual result as an admission fence.
   if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});
   throw Error('native_workspace_reservation_invalid');
  }
 };
 const check=()=>{
  checkReservation();
  for(const signal of signals)signal.throwIfAborted();
  for(const item of held){item.check();if(item.agent&&goalStamp(item.agent)!==item.goal)throw Error('native_workspace_goal_changed');}
 };
 const recheck=async()=>{check();for(const item of held)if(item.recheck){await item.recheck();check();}};
 const enter=async index=>{
  check();
  if(index===members.length){
   const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),...(factoryLease?[factoryLease.signal]:[]),...signals]);
   const snapshots=Object.freeze(proofs.map(proof=>Object.freeze(structuredClone(proof))));
   await recheck();const result=await operation(snapshots,check,signal,recheck);await recheck();return result;
  }
  const member=members[index];
  const captureSignal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),...(factoryLease?[factoryLease.signal]:[]),...signals]);
  if(!member.agent)return withColdWorkspaceSession({...member,factoryHold:factoryLease?.token,assertReservation:checkReservation,signal:captureSignal},async cold=>{
   held.push({check:cold.check,recheck:cold.recheck});proofs.push(cold.proof);signals.push(captureSignal);
   try{check();return await enter(index+1);}
   finally{held.pop();proofs.pop();signals.pop();}
  });
  const goal=goalStamp(member.agent);
  return withNativeHandoffBarrier({...member,signal:captureSignal},async(proof,memberCheck,signal)=>{
   held.push({agent:member.agent,check:memberCheck,goal});proofs.push(proof);signals.push(signal);
   try{check();return await enter(index+1);}
   finally{held.pop();proofs.pop();signals.pop();}
  });
 };
 checkReservation();
 if(input.factoryGate!==undefined)factoryLease=claimNativeWorkspaceFactory(input.factoryGate,members.map(member=>member.sessionRef));
 try{return await enter(0);}finally{factoryLease?.release();}
}
