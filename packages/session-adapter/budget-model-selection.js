import {isDeepStrictEqual} from 'node:util';
import {createTrustedModelMetadataConsumer,createTrustedModelMetadataProducer} from './trusted-model-metadata.js';
import {assertPreparedModelCompatibility} from './model-compatibility.js';
const fail=()=>{throw Error('workbench_model_metadata_unconfirmed');};
/** Trusted host configuration only. Select within one Session without saving the default. */
export function createBudgetModelSelector({route,llm,agents,bridge,registry,tokenMeter,readTrustedModelMetadata}={}){
 if(route===undefined)return undefined;
 if(!route||typeof route!=='object'||Array.isArray(route)||Object.keys(route).some(key=>!['provider','model'].includes(key))
   ||typeof route.provider!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(route.provider)
   ||typeof route.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(route.model))throw new Error('workbench_model_config_invalid');
 const original=Object.freeze({provider:route.provider,model:route.model});
 if(readTrustedModelMetadata!==undefined&&typeof readTrustedModelMetadata!=='function')fail();
 const readMetadata=createTrustedModelMetadataConsumer({enabled:true,
  readTrustedModelMetadata:readTrustedModelMetadata??createTrustedModelMetadataProducer({llm,enabled:true})});
 const policies=new WeakMap();
 const select=async(agent,check,signal)=>{
  if(agent?.session)policies.delete(agent.session);
  if(!agent||typeof check!=='function'||typeof llm?.resolveCallConfig!=='function'||typeof agents?.selectForNextRequest!=='function')throw new Error('workbench_model_host_incompatible');
  signal?.throwIfAborted();await check();signal?.throwIfAborted();
  let selected=original;const binding=bridge?.bindingFor?.(agent),assertBinding=()=>{if(binding?.executionLease&&bridge.bindingFor(agent)!==binding)throw new Error('workbench_model_binding_changed');};
  if(binding?.executionLease){
   const response=await bridge.request('model-budget',binding,{action:'selection'},signal),route=response?.route;
   assertBinding();
   if(!route||Object.keys(route).sort().join(',')!=='model,provider'||typeof route.provider!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(route.provider)
    ||typeof route.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(route.model))throw new Error('workbench_model_host_incompatible');
   selected=Object.freeze({provider:route.provider,model:route.model});
  }
  signal?.throwIfAborted();await check();signal?.throwIfAborted();
  const session=agent.session;
  if(!session||session.id!==agent.id)fail();
  const metadata=await readMetadata(selected,signal);signal?.throwIfAborted();assertBinding();
  if(metadata.state!=='ready')fail();
  await check();signal?.throwIfAborted();assertBinding();
  const resolved=await llm.resolveCallConfig({...selected},signal);signal?.throwIfAborted();assertBinding();
  if(resolved?.provider!==selected.provider||resolved?.model!==selected.model)throw new Error('workbench_model_route_changed');
  await check();signal?.throwIfAborted();assertBinding();
  const current=await readMetadata(selected,signal);signal?.throwIfAborted();assertBinding();
  if(!isDeepStrictEqual(current,metadata)||resolved.reasoningEffort!==undefined
   &&!metadata.metadata.reasoning?.efforts.some(effort=>effort.id===resolved.reasoningEffort))fail();
  await check();signal?.throwIfAborted();assertBinding();
  if(agent.session!==session)fail();
  agents.selectForNextRequest(agent,{...selected});
  policies.set(session,{agent,binding,metadata,route:{...selected,...(resolved.reasoningEffort===undefined?{}:{reasoning_effort:resolved.reasoningEffort})}});
 };
 const prepareDispatch=originalOptions=>{
  if(typeof originalOptions?.sessionId!=='string'||originalOptions.purpose!==undefined)return;
  const agent=registry?.get(originalOptions.sessionId),session=agent?.session;
  if(!session)return;
  const policy=policies.get(session);
  if(!policy&&session.header?.agentPreset!=='jot-workbench-budgeted')return;
  return ({options,modelInfo,stopped})=>{
   originalOptions.signal?.throwIfAborted();
   if(stopped||!policy||policies.get(session)!==policy||registry.get(agent.id)!==agent||agent.session!==session
    ||policy.agent!==agent||bridge?.bindingFor?.(agent)!==policy.binding)fail();
   assertPreparedModelCompatibility({route:policy.route,metadata:policy.metadata,session,tokenMeter,
    options,originalOptions,modelInfo});
  };
 };
 return Object.assign(select,{prepareDispatch});
}
