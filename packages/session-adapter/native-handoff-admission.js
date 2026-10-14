import {captureNativeChildClosure,verifyNativeChildPrefix} from './native-child-closure.js';
import {createHash} from 'node:crypto';
import {withNativeHandoffBarrier} from './native-handoff-barrier.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const requestId=(kind,scope)=>kind+'-'+createHash('sha256').update(JSON.stringify(scope)).digest('hex');
/** Task-to-member and closed-member transitions. Gateway authority remains decisive.
 * The trusted host chooses the successor; this does not queue a busy lead. */
export function createNativeHandoffAdmission({bridge,registry,persistence,projections,policyVersion,maxHops,route,reconcileOperations,previousExecutionFor}){
 if(typeof bridge?.request!=='function'||!Number.isSafeInteger(policyVersion)||policyVersion<1||!Number.isSafeInteger(maxHops)||maxHops<1||maxHops>20
  ||!route||Object.keys(route).some(key=>!['provider','model'].includes(key))||typeof route.provider!=='string'||!route.provider.trim()||typeof route.model!=='string'||!route.model.trim()
  ||reconcileOperations!==undefined&&typeof reconcileOperations!=='function'||previousExecutionFor!==undefined&&typeof previousExecutionFor!=='function')throw Error('native_handoff_config_invalid');
 const model=Object.freeze({...route});
 return async function admit({parent,child,roleRef,binding,parentBinding,signal}){
  if(!valid(parent?.id)||parentBinding?.sessionRef!==parent.id||!valid(parentBinding.runId)||!valid(child?.id)||child.session?.id!==child.id
   ||binding?.sessionRef!==child.id||!valid(binding.runId)||binding.runId===parentBinding.runId||!valid(roleRef))throw Error('native_handoff_identity_invalid');
  const root=Object.freeze({...parentBinding,...(parentBinding.executionLease?{executionLease:Object.freeze({...parentBinding.executionLease})}:{})});
  const target=Object.freeze({runId:binding.runId,sessionRef:binding.sessionRef,roleRef});
  const manage=(action,request)=>bridge.request('handoff',root,{action,request,expected_policy_version:policyVersion,route:model},signal);
  return withNativeHandoffBarrier({agent:parent,registry,persistence,projections,reconcileOperations,signal},async(_proof,check)=>{
   const supplied=await previousExecutionFor?.({parent,child,roleRef,binding:target,parentBinding:root,signal});const previous=supplied===undefined?undefined:Object.freeze({agent:supplied?.agent,runId:supplied?.runId,roleRef:supplied?.roleRef});check();
   let revision,from,sourceFence=()=>{};
   if(previous===undefined){
    const started=await manage('start',{request_id:requestId('handoff-start',[root.runId,root.sessionRef]),max_hops:maxHops});check();
    if(started?.state?.phase!=='active'||started.state.revision!==1||!valid(started.state.controller)||started.binding?.revision!==1
     ||started.binding.run_id!==root.runId||started.binding.session_ref!==root.sessionRef)throw Error('native_handoff_start_invalid');
    revision=1;from=started.state.controller;
   }else{
    const source=previous?.agent,sourceSession=source?.session,sourceCount=sourceSession?.seq;
    const sourceCheck=()=>{check();if(!valid(source?.id)||!valid(previous.runId)||!valid(previous.roleRef)||source.id===parent.id||source.id===child.id
     ||sourceSession?.id!==source.id||source.status!=='idle'||registry.get(source.id)!==undefined||source.session!==sourceSession||sourceSession.seq!==sourceCount)throw Error('native_handoff_predecessor_not_closed');};
    sourceFence=sourceCheck;sourceCheck();
    const {source:saved}=await bridge.request('native-child-source',root,{child_session_ref:source.id,purpose:'handoff'},signal);sourceCheck();
    if(saved?.previous_run_id!==previous.runId||saved.role_ref!==previous.roleRef)throw Error('native_handoff_predecessor_changed');
    await verifyNativeChildPrefix({agent:source,parentSessionRef:parent.id,persistence,proof:saved.proof,signal});sourceCheck();
    const fresh=await captureNativeChildClosure({agent:source,parentSessionRef:parent.id,registry,persistence,projections,signal,
     reconcileOperations:async scope=>saved.proof.remote_operations?.find(p=>p.request_id===scope.callId)});sourceCheck();
    const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
    if(canonical(fresh)!==canonical(saved.proof))throw Error('native_handoff_predecessor_changed');
    const {state,binding:execution}=await manage('get',{});sourceCheck();
    if(state?.phase!=='active'||!Number.isSafeInteger(state.revision)||state.revision<2||execution?.revision!==state.revision)throw Error('native_handoff_predecessor_changed');
    if(state.controller===previous.roleRef&&execution.run_id===previous.runId&&execution.session_ref===source.id){revision=state.revision;}
    else if(state.controller===target.roleRef&&execution.run_id===target.runId&&execution.session_ref===target.sessionRef&&state.revision>=3&&Array.isArray(state.route)&&state.route?.at(-2)===previous.roleRef&&state.route?.at(-1)===target.roleRef){revision=state.revision-1;}
    else throw Error('native_handoff_predecessor_changed');
    from=previous.roleRef;
   }
   sourceFence();const receipt=await manage('transfer',{request_id:requestId('handoff-transfer',[root.runId,root.sessionRef,target.runId,target.sessionRef]),
    expected_revision:revision,from,to:target.roleRef,execution_run_id:target.runId,execution_session_ref:target.sessionRef});check();sourceFence();
   if(receipt?.state?.phase!=='active'||receipt.state.revision!==revision+1||receipt.state.controller!==target.roleRef||receipt.binding?.revision!==revision+1
    ||receipt.binding.run_id!==target.runId||receipt.binding.session_ref!==target.sessionRef)throw Error('native_handoff_transfer_invalid');
   return receipt;
  });
 };
}
