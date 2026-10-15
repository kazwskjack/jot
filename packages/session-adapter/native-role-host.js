import {createNativeOperationObserver} from './native-operation-observer.js';
import {NativeChildAdmission} from './native-child-admission.js';
import {NativeRoleProvider} from './native-role-provider.js';
import {captureNativeChildClosure,verifyNativeChildPrefix,recoverNativePublication} from './native-child-closure.js';
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** Explicit candidate composition. Does not alter default Host configuration.
 * Native Team and Subagent services retain their original runtime ownership.
 */
export function createNativeRoleHost({ctx,bridge,selectModel,sessions,persistence,providerName='jot-native-role',automaticClosures=false,nativeRecovery=false,durableSpawns=false,handoffAdmission,onMemberClosed,reconcileOperations,nativeOperationOrigin}){
 if(!ctx?.agents||typeof ctx?.subagents?.registerProvider!=='function'||typeof ctx?.subagents?.drainContinuableChildren!=='function'||typeof ctx?.agentTeams?.spawnTeammate!=='function'
  ||typeof bridge?.bindingFor!=='function'||typeof bridge?.guardBudget!=='function'||typeof bridge?.attach!=='function'||typeof selectModel!=='function')throw new Error('native_role_host_incompatible');
 if(typeof automaticClosures!=='boolean'||automaticClosures&&(typeof persistence?.flush!=='function'||typeof persistence?.open!=='function'||typeof ctx.sessionProjections?.stateOf!=='function'))throw new Error('native_role_closure_host_incompatible');
 if(typeof nativeRecovery!=='boolean'||nativeRecovery&&!automaticClosures)throw new Error('native_role_recovery_host_incompatible');
 if(typeof durableSpawns!=='boolean')throw new Error('native_role_host_incompatible');
 if(handoffAdmission!==undefined&&typeof handoffAdmission!=='function')throw new Error('native_role_host_incompatible');
 if(onMemberClosed!==undefined&&typeof onMemberClosed!=='function')throw new Error('native_role_host_incompatible');
 if(reconcileOperations!==undefined&&typeof reconcileOperations!=='function')throw new Error('native_role_host_incompatible');
 if(nativeOperationOrigin!==undefined){if(reconcileOperations!==undefined||typeof bridge.guard!=='function')throw Error('native_role_host_incompatible');createNativeOperationObserver({origin:nativeOperationOrigin,authorize:async()=>{}});}
 const spawnRequests=new Map(),notifying=new Map(),notified=new Set(),spawnScope=new AsyncLocalStorage();
 const prepared=new Map(),pending=new Map(),published=new Map(),closing=new Map(),closed=new Map(),observations=new Set(),closureFailures=new Set(),shutdown=new AbortController();let disposed=false,disposal;
 const admission=new NativeChildAdmission({registry:ctx.agents,bindingFor:agent=>disposed?undefined:bridge.bindingFor(agent),
  authorize:async({parent,child,roleRef,parentBinding,signal})=>{
   const entry=prepared.get(child.id);
   if(!entry||entry.parent!==parent||entry.parentBinding!==parentBinding||entry.roleRef!==roleRef)throw new Error('native_role_binding_missing');
   await bridge.guardBudget(parent,signal);prepared.delete(child.id);return entry.binding;
  },
  recover:nativeRecovery?async({parent,child,parentBinding,signal})=>{
   await bridge.guardBudget(parent,signal);
   const {source}=await bridge.request('native-child-source',parentBinding,{child_session_ref:child.id},signal);
   const proof=source?.proof;
   if(typeof source?.previous_run_id!=='string'||typeof source.role_ref!=='string'||!proof||closing.has(source.previous_run_id))throw new Error('native_role_recovery_source_pending');
   await verifyNativeChildPrefix({agent:child,parentSessionRef:parent.id,persistence,proof,signal});
   const response=await bridge.request('native-child-activate',parentBinding,{child_session_ref:child.id,previous_run_id:source.previous_run_id,previous_log_sha256:proof.log_sha256,previous_seq_exclusive:proof.seq_exclusive},signal);
   if(response?.binding?.sessionRef!==child.id||response.binding.runId===source.previous_run_id)throw new Error('native_role_recovery_invalid');
   return {roleRef:source.role_ref,binding:response.binding};
  }:undefined,
  attach:async(child,binding,{signal,parent,roleRef})=>{
   await bridge.attach(child,binding,{sessions,persistence,signal,parentGuard:checkSignal=>bridge.guardBudget(parent,checkSignal)});
   if(handoffAdmission){
    const parentBinding=bridge.bindingFor(parent);
    const frozen=Object.freeze({...binding,...(binding.executionLease?{executionLease:Object.freeze({...binding.executionLease})}:{})});
    const receipt=await handoffAdmission({parent,child,roleRef,binding:frozen,parentBinding,signal});
    signal?.throwIfAborted();
    if(bridge.bindingFor(parent)!==parentBinding||receipt?.state?.phase!=='active'||receipt.state.controller!==roleRef
      ||!Number.isSafeInteger(receipt.state.revision)||receipt.state.revision<1
      ||receipt.binding?.revision!==receipt.state.revision||receipt.binding.run_id!==binding.runId||receipt.binding.session_ref!==child.id)
      throw new Error('native_handoff_admission_invalid');
   }
   await selectModel(child,()=>bridge.guardBudget(child,signal),signal);
   let ids=published.get(parent);if(!ids)published.set(parent,ids=new Set());ids.add(child.id);
  }});
 const provider=new NativeRoleProvider({name:providerName,admission,prepare:async({parent,childId,roleRef,policyVersion,requestId,requestHash,signal})=>{
  const scope=spawnScope.getStore();if(!scope||scope.parent!==parent||scope.childId!==undefined)throw Error('native_role_scope_missing');scope.childId=childId;
  const parentBinding=bridge.bindingFor(parent);await bridge.guardBudget(parent,signal);
  const receipt=await bridge.request('native-child-reservation',parentBinding,{child_session_ref:childId,role_ref:roleRef,expected_policy_version:policyVersion,request_id:requestId,...(requestHash===undefined?{}:{spawn_request_hash:requestHash})},signal);
  if(receipt?.reservation?.child_session_ref!==childId||receipt.reservation.role_id!==roleRef||typeof receipt.reservation.reservation_id!=='string')throw new Error('native_role_reservation_invalid');
  const response=await bridge.request('native-child-bind',parentBinding,{reservation_id:receipt.reservation.reservation_id},signal);
  if(response?.binding?.sessionRef!==childId)throw new Error('native_role_binding_invalid');
  if(bridge.bindingFor(parent)!==parentBinding)throw new Error('native_child_parent_changed');
  if(disposed)throw new Error('native_role_host_disposed');
  prepared.set(childId,{parent,parentBinding,roleRef,requestId,binding:response.binding});return {};
 }});
 const removeAdmission=admission.install(ctx),removeProvider=ctx.subagents.registerProvider(provider);
 const notifyClosed=async(parent,accepted,receipt,signal)=>{
  const key=accepted.binding.runId;
  if(disposed||!onMemberClosed||notified.has(key))return receipt;
  if(notifying.has(key)){await notifying.get(key);return receipt;}
  const operation=Promise.resolve().then(()=>onMemberClosed({parent,child:accepted.agent,roleRef:accepted.roleRef,
   parentBinding:accepted.parentBinding,binding:Object.freeze({...accepted.binding}),receipt:Object.freeze({...receipt}),signal:signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal}));
  notifying.set(key,operation);
  try{await operation;notified.add(key);closureFailures.delete(key);return receipt;}
  catch(error){closureFailures.add(key);throw error;}
  finally{notifying.delete(key);}
 };
 const closeMember=async(parent,id,{signal}={},expectedAccepted)=>{
   const accepted=admission.accepted.get(id);
   if(expectedAccepted&&accepted!==expectedAccepted){if(closed.has(expectedAccepted.binding.runId))return closed.get(expectedAccepted.binding.runId);throw new Error('native_role_closure_identity_changed');}
   if(!accepted||accepted.parent!==parent||!published.get(parent)?.has(id))throw new Error('native_role_member_unknown');
   signal?.throwIfAborted();
   const key=accepted.binding.runId;
   if(closed.has(key))return notifyClosed(parent,accepted,closed.get(key),signal);
   if(closing.has(key)){const receipt=await closing.get(key);return notifyClosed(parent,accepted,receipt,signal);}
   const operation=(async()=>{
    // Run outside the child's disposal stack, then drain before reading proof.
    await ctx.subagents.drainContinuableChildren(parent,[id]);
    const observer=nativeOperationOrigin===undefined?reconcileOperations:createNativeOperationObserver({origin:nativeOperationOrigin,authorize:async scope=>{
     if(scope.sessionRef!==accepted.agent.id||bridge.bindingFor(accepted.agent)!==accepted.binding)throw Error('native_role_closure_identity_changed');
     await bridge.guard(accepted.agent,scope.signal);
     if(bridge.bindingFor(accepted.agent)!==accepted.binding)throw Error('native_role_closure_identity_changed');
    }});
    const proof=await captureNativeChildClosure({agent:accepted.agent,parentSessionRef:parent.id,registry:ctx.agents,persistence,projections:ctx.sessionProjections,signal,reconcileOperations:observer});
    const receipt=await bridge.request('native-child-close',accepted.binding,{proof},signal);
    if(receipt?.closed!==true||receipt.run_id!==accepted.binding.runId)throw new Error('native_role_closure_invalid');
    closed.set(key,Object.freeze({...receipt}));closureFailures.delete(key);return closed.get(key);
   })();closing.set(key,operation);
   try{return await notifyClosed(parent,accepted,await operation,signal);}finally{closing.delete(key);}
 };
 const removeObservation=automaticClosures?ctx.on('session/disposed',session=>{
  const accepted=admission.accepted.get(session?.id);if(!accepted||accepted.agent.session!==session)return;
  // The observer returns synchronously. Teardown must leave this hook before
  // drain can be awaited, and Team spawn may still be publishing its roster.
  const observation=(async()=>{await new Promise(resolve=>setImmediate(resolve));await Promise.allSettled([...pending].filter(([,scope])=>scope.parent===accepted.parent&&scope.childId===session.id).map(([operation])=>operation));if(disposed)return;
   try{await closeMember(accepted.parent,session.id,{},accepted);}catch{closureFailures.add(accepted.binding.runId);}
  })();observations.add(observation);observation.finally(()=>observations.delete(observation)).catch(()=>{});
 }):()=>{};
 return {provider,admission,
  async closeMember(parent,id,options){if(disposed)throw new Error('native_role_host_disposed');return closeMember(parent,id,options);},
  async flushClosures(){await Promise.allSettled([...observations]);await Promise.allSettled([...closing.values()]);await Promise.allSettled([...notifying.values()]);if(closureFailures.size)throw new Error('native_role_closure_pending');},
  spawn(parent,intent,request){
   let requestHash,requestKey,parentBinding,snapshot;
   if(durableSpawns){
    try{
     if(disposed)throw new Error('native_role_host_disposed');
     if(request?.context!=='fresh'||typeof request.signal?.throwIfAborted!=='function'||Object.keys(request).some(key=>!['name','description','prompt','context','signal'].includes(key)))throw new Error('native_role_spawn_invalid');
     if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).some(key=>!['roleRef','policyVersion','requestId'].includes(key))
      ||['roleRef','requestId'].some(key=>typeof intent[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(intent[key]))
      ||!Number.isSafeInteger(intent.policyVersion)||intent.policyVersion<1)throw new Error('native_role_intent_invalid');
     intent=Object.freeze({...intent});
     parentBinding=bridge.bindingFor(parent);if(!parentBinding)throw new Error('native_role_binding_missing');
     // Snapshot before any await: callers cannot change the request after its
     // digest has been stored. The cancellation signal is not semantic input.
     const {signal,...content}=request;snapshot=JSON.parse(canonical(content));
     requestHash=createHash('sha256').update(canonical({intent,request:snapshot})).digest('hex');
     requestKey=canonical([parentBinding.runId,intent.requestId]);
     const existing=spawnRequests.get(requestKey);
     if(existing){if(existing.parent!==parent||existing.hash!==requestHash)throw new Error('idempotency_conflict');return existing.operation;}
    }catch(error){return Promise.reject(error);}
   }
   const scope={parent,childId:undefined};const operation=spawnScope.run(scope,async()=>{
   if(disposed)throw new Error('native_role_host_disposed');
   if(request?.context!=='fresh'||typeof request.signal?.throwIfAborted!=='function'||Object.keys(request).some(key=>!['name','description','prompt','context','signal'].includes(key)))throw new Error('native_role_spawn_invalid');
   const signal=AbortSignal.any([request.signal,shutdown.signal]);
   try{
    if(durableSpawns){
     await bridge.guardBudget(parent,signal);
     const response=await bridge.request('native-child-request',parentBinding,{request_id:intent.requestId,spawn_request_hash:requestHash},signal);
     if(bridge.bindingFor(parent)!==parentBinding)throw new Error('native_child_parent_changed');
     signal.throwIfAborted();
     if(response?.reservation){
      const saved=response.reservation;
      if(typeof saved.child_session_ref!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(saved.child_session_ref))throw Error('native_role_publication_invalid');
      if(saved.publication?.member?.id===saved.child_session_ref)return saved.publication;
      scope.childId=saved.child_session_ref;
      const publication=await recoverNativePublication({parent,childId:saved.child_session_ref,request:snapshot,providerName,persistence,teams:ctx.agentTeams,signal});
      if(bridge.bindingFor(parent)!==parentBinding)throw new Error('native_child_parent_changed');
      const receipt=await bridge.request('native-child-published',parentBinding,{request_id:intent.requestId,spawn_request_hash:requestHash,publication},signal);
      if(canonical(receipt?.publication)!==canonical(publication))throw new Error('native_role_publication_invalid');
      return receipt.publication;
     }
     if(response?.reservation!==null)throw new Error('native_role_publication_invalid');
    }
    const result=await provider.withRole(parent,intent,()=>ctx.agentTeams.spawnTeammate(parent,{...(snapshot??request),signal,provider:providerName}),durableSpawns?{requestHash}:{});
    const id=result?.member?.id,accepted=admission.accepted.get(id);
    // A continuable child can finish and become nonresident before Team spawn
    // returns. Validate the completed admission, never infer execution rights
    // from a roster name or require the native runtime to keep an idle handle.
    if(!accepted||accepted.parent!==parent||accepted.roleRef!==intent.roleRef||accepted.binding.sessionRef!==id)throw new Error('native_role_publication_invalid');
    let ids=published.get(parent);if(!ids)published.set(parent,ids=new Set());ids.add(id);
    if(durableSpawns){
     if(bridge.bindingFor(parent)!==parentBinding)throw new Error('native_child_parent_changed');
     const receipt=await bridge.request('native-child-published',parentBinding,{request_id:intent.requestId,spawn_request_hash:requestHash,publication:result},signal);
     if(canonical(receipt?.publication)!==canonical(result))throw new Error('native_role_publication_invalid');
     return receipt.publication;
    }
    return result;
   }
   finally{for(const [id,entry] of prepared)if(entry.parent===parent&&entry.requestId===intent.requestId)prepared.delete(id);}
   });pending.set(operation,scope);
   if(durableSpawns)spawnRequests.set(requestKey,{parent,hash:requestHash,operation});
   operation.finally(()=>{pending.delete(operation);if(durableSpawns&&spawnRequests.get(requestKey)?.operation===operation)spawnRequests.delete(requestKey);}).catch(()=>{});return operation;
  },
  dispose(){
   if(disposal)return disposal;disposed=true;shutdown.abort(new Error('native_role_host_disposed'));
   return disposal=(async()=>{
    await Promise.allSettled([...pending.keys()]);
    await Promise.allSettled([...observations]);
    await Promise.allSettled([...notifying.values()]);
    const closures=await Promise.allSettled([...closing.values()]);
    if(closures.some(result=>result.status==='rejected'))throw new Error('native_role_closure_failed');
    // Keep admission installed while creation drains. Removing it immediately
    // would let a prepared child publish without the role/model barrier.
    const results=await Promise.allSettled([...published].map(([parent,ids])=>ctx.subagents.drainContinuableChildren(parent,[...ids])));
    if(results.some(result=>result.status==='rejected'))throw new Error('native_role_drain_failed');
    if(automaticClosures){
     const finalClosures=await Promise.allSettled([...published].flatMap(([parent,ids])=>[...ids].map(id=>closeMember(parent,id))));
     if(finalClosures.some(result=>result.status==='rejected'))throw new Error('native_role_closure_failed');
    }
    await Promise.allSettled([...observations]);removeObservation();
    removeProvider();removeAdmission();prepared.clear();published.clear();closed.clear();notified.clear();admission.accepted.clear();
   })();
  }
 };
}
