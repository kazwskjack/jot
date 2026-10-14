import {createHash} from 'node:crypto';
import {withNativeHandoffBarrier} from './native-handoff-barrier.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const requestId=(kind,scope)=>kind+'-'+createHash('sha256').update(JSON.stringify(scope)).digest('hex');
/** Initial task-to-member handoff. Existing gateway authority remains decisive.
 * This does not queue a busy lead or choose a later member in a multi-hop route. */
export function createNativeHandoffAdmission({bridge,registry,persistence,projections,policyVersion,maxHops,route,reconcileOperations}){
 if(typeof bridge?.request!=='function'||!Number.isSafeInteger(policyVersion)||policyVersion<1||!Number.isSafeInteger(maxHops)||maxHops<1||maxHops>20
  ||!route||Object.keys(route).some(key=>!['provider','model'].includes(key))||typeof route.provider!=='string'||!route.provider.trim()||typeof route.model!=='string'||!route.model.trim()
  ||reconcileOperations!==undefined&&typeof reconcileOperations!=='function')throw Error('native_handoff_config_invalid');
 const model=Object.freeze({...route});
 return async function admit({parent,child,roleRef,binding,parentBinding,signal}){
  if(!valid(parent?.id)||parentBinding?.sessionRef!==parent.id||!valid(parentBinding.runId)||!valid(child?.id)||child.session?.id!==child.id
   ||binding?.sessionRef!==child.id||!valid(binding.runId)||binding.runId===parentBinding.runId||!valid(roleRef))throw Error('native_handoff_identity_invalid');
  const root=Object.freeze({...parentBinding,...(parentBinding.executionLease?{executionLease:Object.freeze({...parentBinding.executionLease})}:{})});
  const target=Object.freeze({runId:binding.runId,sessionRef:binding.sessionRef,roleRef});
  const manage=(action,request)=>bridge.request('handoff',root,{action,request,expected_policy_version:policyVersion,route:model},signal);
  return withNativeHandoffBarrier({agent:parent,registry,persistence,projections,reconcileOperations,signal},async(_proof,check)=>{
   const started=await manage('start',{request_id:requestId('handoff-start',[root.runId,root.sessionRef]),max_hops:maxHops});check();
   if(started?.state?.phase!=='active'||started.state.revision!==1||!valid(started.state.controller)||started.binding?.revision!==1
    ||started.binding.run_id!==root.runId||started.binding.session_ref!==root.sessionRef)throw Error('native_handoff_start_invalid');
   const receipt=await manage('transfer',{request_id:requestId('handoff-transfer',[root.runId,root.sessionRef,target.runId,target.sessionRef]),
    expected_revision:1,from:started.state.controller,to:target.roleRef,execution_run_id:target.runId,execution_session_ref:target.sessionRef});check();
   if(receipt?.state?.phase!=='active'||receipt.state.revision!==2||receipt.state.controller!==target.roleRef||receipt.binding?.revision!==2
    ||receipt.binding.run_id!==target.runId||receipt.binding.session_ref!==target.sessionRef)throw Error('native_handoff_transfer_invalid');
   return receipt;
  });
 };
}
