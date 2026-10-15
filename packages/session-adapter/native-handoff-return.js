import {createHash} from 'node:crypto';
import {captureNativeChildClosure,verifyNativeChildPrefix,verifyOfflineNativeClosure} from './native-child-closure.js';
import {withNativeHandoffBarrier} from './native-handoff-barrier.js';
import {nativeGoalsFor} from './workbench-goal.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
async function waitForLead(parent,signal){
 signal?.throwIfAborted();if(!signal)return parent.whenIdle();
 await new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>parent.whenIdle()).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});if(signal.aborted)abort();
 });
}
/** Trusted closure observer, never called from the lead's own tool. */
function validateManagement({bridge,policyVersion,route}){
 if(typeof bridge?.request!=='function'||typeof bridge.bindingFor!=='function'||!Number.isSafeInteger(policyVersion)||policyVersion<1
  ||!route||Object.keys(route).some(k=>!['provider','model'].includes(k))||typeof route.provider!=='string'||!route.provider.trim()||typeof route.model!=='string'||!route.model.trim())throw Error('native_handoff_config_invalid');
}
export function createNativeHandoffReturn({bridge,registry,persistence,projections,policyVersion,route,reconcileOperations}){
 validateManagement({bridge,policyVersion,route});
 const model=Object.freeze({...route});
 return async function returnControl({parent,child,parentBinding,binding,roleRef,receipt,signal}){
  if(!valid(parent?.id)||parentBinding?.sessionRef!==parent.id||bridge.bindingFor(parent)!==parentBinding||!valid(parentBinding.runId)
   ||!valid(child?.id)||child.id===parent.id||child.session?.id!==child.id||binding?.sessionRef!==child.id||!valid(binding.runId)||binding.runId===parentBinding.runId
   ||!valid(roleRef)||receipt?.closed!==true||receipt.run_id!==binding.runId)throw Error('native_handoff_return_invalid');
  const root=Object.freeze({...parentBinding,...(parentBinding.executionLease?{executionLease:Object.freeze({...parentBinding.executionLease})}:{})}),runId=binding.runId,sourceSession=child.session,count=sourceSession.seq;
  const fence=()=>{signal?.throwIfAborted();if(bridge.bindingFor(parent)!==parentBinding||child.session!==sourceSession||sourceSession.seq!==count||child.status!=='idle'||registry.get(child.id)!==undefined||sourceSession.header.parentSession!==parent.id)throw Error('native_handoff_return_changed');};
  fence();await waitForLead(parent,signal);fence();
  return withNativeHandoffBarrier({agent:parent,registry,persistence,projections,reconcileOperations,signal},async(_proof,check,nativeSignal)=>{
   const guard=()=>{check();fence();};
   const {source:saved}=await bridge.request('native-child-source',root,{child_session_ref:child.id,purpose:'handoff'},nativeSignal);guard();
   if(saved?.previous_run_id!==runId||saved.role_ref!==roleRef)throw Error('native_handoff_return_changed');
   await verifyNativeChildPrefix({agent:child,parentSessionRef:parent.id,persistence,proof:saved.proof,signal:nativeSignal});guard();
   const fresh=await captureNativeChildClosure({agent:child,parentSessionRef:parent.id,registry,persistence,projections,signal:nativeSignal,reconcileOperations:async scope=>saved.proof.remote_operations?.find(p=>p.request_id===scope.callId)});guard();
   if(canonical(fresh)!==canonical(saved.proof))throw Error('native_handoff_return_changed');
   const manage=(action,request)=>bridge.request('handoff',root,{action,request,expected_policy_version:policyVersion,route:model},nativeSignal);
   const {state,binding:execution}=await manage('get',{});guard();
   if(!Array.isArray(state?.route)||state.route.length<2||state.route.some(id=>!valid(id)))throw Error('native_handoff_return_changed');
   const lead=state.route[0];let revision;
   if(!valid(lead)||lead===roleRef||!Number.isSafeInteger(state.revision))throw Error('native_handoff_return_changed');
   if(state.phase==='active'&&state.controller===roleRef&&state.route.at(-1)===roleRef&&state.revision>=2&&execution?.revision===state.revision&&execution.run_id===runId&&execution.session_ref===child.id)revision=state.revision;
   else if(state.phase==='returned'&&state.controller===lead&&state.revision>=3&&state.route.at(-2)===roleRef&&state.route.at(-1)===lead)revision=state.revision-1;
   else throw Error('native_handoff_return_changed');
   const request_id='handoff-return-'+createHash('sha256').update(JSON.stringify([root.runId,root.sessionRef,runId,child.id])).digest('hex');
   const result=await manage('transfer',{request_id,expected_revision:revision,from:roleRef,to:lead,execution_run_id:root.runId,execution_session_ref:root.sessionRef});guard();
   if(result?.state?.phase!=='returned'||result.state.controller!==lead||result.state.revision!==revision+1)throw Error('native_handoff_return_invalid');return result;
  });
 };
}

/** Explicit final-return policy only. Reconcile an existing closed execution
 * from authenticated durable evidence; never restart that execution. */
export function createNativeHandoffRecovery(options){
 validateManagement(options);
 const {bridge,registry,sessions,persistence,projections,policyVersion,reconcileOperations,validateLog}=options,model=Object.freeze({...options.route});
 if(typeof validateLog!=='function'||typeof sessions?.get!=='function'||typeof projections?.snapshot!=='function')throw Error('native_handoff_config_invalid');
 return async function recoverControl({parent,parentBinding,signal}){
  if(!valid(parent?.id)||parentBinding?.sessionRef!==parent.id||!valid(parentBinding.runId)||bridge.bindingFor(parent)!==parentBinding)throw Error('native_handoff_recovery_invalid');
  const root=Object.freeze({...parentBinding,...(parentBinding.executionLease?{executionLease:Object.freeze({...parentBinding.executionLease})}:{})});
  const fence=()=>{signal?.throwIfAborted();if(bridge.bindingFor(parent)!==parentBinding||registry.get(parent.id)!==parent)throw Error('native_handoff_recovery_changed');const goal=nativeGoalsFor(parent)?.get?.(parent);if(goal&&goal.phase!=='active')throw Error('native_handoff_recovery_goal_inactive');};
  const manage=(action,request={},ownedSignal=signal)=>bridge.request('handoff',root,{action,request,expected_policy_version:policyVersion,route:model},ownedSignal);
  const validate=recovery=>{
   if(!recovery||recovery.execution_authorized!==false||!['none','blocked','pending','returned'].includes(recovery.state))throw Error('native_handoff_recovery_invalid');
   if(['none','blocked'].includes(recovery.state))return;
   if(!Number.isSafeInteger(recovery.revision)||recovery.revision<(recovery.state==='returned'?3:2)
    ||[recovery.lead_role_ref,recovery.role_ref,recovery.child_run_id,recovery.child_session_ref].some(id=>!valid(id))||recovery.lead_role_ref===recovery.role_ref||recovery.child_run_id===root.runId||recovery.child_session_ref===parent.id
    ||recovery.proof?.session_ref!==recovery.child_session_ref||recovery.proof.parent_session_ref!==parent.id)throw Error('native_handoff_recovery_invalid');
   const requestId='handoff-return-'+createHash('sha256').update(JSON.stringify([root.runId,root.sessionRef,recovery.child_run_id,recovery.child_session_ref])).digest('hex');
   if(recovery.request_id!==requestId)throw Error('native_handoff_recovery_invalid');
   if(recovery.state==='returned'){
    const state=recovery.receipt?.state,route=state?.route;
    if(state?.phase!=='returned'||state.controller!==recovery.lead_role_ref||state.revision!==recovery.revision||!Array.isArray(route)||route.length<3||route.some(id=>!valid(id))||route[0]!==recovery.lead_role_ref||route.at(-2)!==recovery.role_ref||route.at(-1)!==recovery.lead_role_ref)throw Error('native_handoff_recovery_invalid');
   }
  };
  fence();const {recovery}=await manage('recover_return');fence();validate(recovery);
  if(['none','blocked'].includes(recovery.state))return {state:recovery.state};
  const result={state:'returned',request_id:recovery.request_id,revision:recovery.state==='returned'?recovery.revision:recovery.revision+1};
  if(recovery.state==='returned')return result;
  const snapshot=canonical(recovery);await waitForLead(parent,signal);fence();
  return withNativeHandoffBarrier({agent:parent,registry,persistence,projections,reconcileOperations,signal},async(_proof,check,ownedSignal)=>{
   const guard=()=>{check();fence();if(registry.get(recovery.child_session_ref)!==undefined||sessions.get(recovery.child_session_ref)!==undefined)throw Error('native_handoff_recovery_changed');};
   const reread=async()=>{const current=await manage('recover_return',{},ownedSignal);guard();validate(current.recovery);if(canonical(current.recovery)!==snapshot)throw Error('native_handoff_recovery_changed');};
   await reread();await verifyOfflineNativeClosure({parentSessionRef:parent.id,proof:recovery.proof,registry,sessions,projections,persistence,validateLog,signal:ownedSignal});guard();await reread();
   const returned=await manage('transfer',{request_id:recovery.request_id,expected_revision:recovery.revision,from:recovery.role_ref,to:recovery.lead_role_ref,execution_run_id:root.runId,execution_session_ref:root.sessionRef},ownedSignal);guard();
   const state=returned?.state;if(state?.phase!=='returned'||state.controller!==recovery.lead_role_ref||state.revision!==result.revision)throw Error('native_handoff_recovery_invalid');return result;
  });
 };
}
