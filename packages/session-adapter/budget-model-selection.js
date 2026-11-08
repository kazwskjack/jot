/** Trusted host configuration only. Select within one Session without saving the default. */
export function createBudgetModelSelector({route,llm,agents,bridge}={}){
 if(route===undefined)return undefined;
 if(!route||typeof route!=='object'||Array.isArray(route)||Object.keys(route).some(key=>!['provider','model'].includes(key))
   ||typeof route.provider!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(route.provider)
   ||typeof route.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(route.model))throw new Error('workbench_model_config_invalid');
 const original=Object.freeze({provider:route.provider,model:route.model});
 return async(agent,check,signal)=>{
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
  assertBinding();const resolved=await llm.resolveCallConfig({...selected},signal);signal?.throwIfAborted();assertBinding();
  if(resolved?.provider!==selected.provider||resolved?.model!==selected.model)throw new Error('workbench_model_route_changed');
  await check();signal?.throwIfAborted();assertBinding();
  agents.selectForNextRequest(agent,{...selected});
 };
}
