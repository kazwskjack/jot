import {createHash} from 'node:crypto';
import {captureNativeChildClosure,verifyNativeChildPrefix} from './native-child-closure.js';
import {withNativeHandoffBarrier} from './native-handoff-barrier.js';
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
export function createNativeHandoffReturn({bridge,registry,persistence,projections,policyVersion,route,reconcileOperations}){
 if(typeof bridge?.request!=='function'||typeof bridge.bindingFor!=='function'||!Number.isSafeInteger(policyVersion)||policyVersion<1
  ||!route||Object.keys(route).some(k=>!['provider','model'].includes(k))||typeof route.provider!=='string'||!route.provider.trim()||typeof route.model!=='string'||!route.model.trim())throw Error('native_handoff_config_invalid');
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
