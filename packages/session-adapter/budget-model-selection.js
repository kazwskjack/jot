/** Trusted host configuration only. Select within one Session without saving the default. */
export function createBudgetModelSelector({route,llm,agents}={}){
 if(route===undefined)return undefined;
 if(!route||typeof route!=='object'||Array.isArray(route)||Object.keys(route).some(key=>!['provider','model'].includes(key))
   ||typeof route.provider!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(route.provider)
   ||typeof route.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(route.model))throw new Error('workbench_model_config_invalid');
 const original=Object.freeze({provider:route.provider,model:route.model});
 return async(agent,check,signal)=>{
  if(!agent||typeof check!=='function'||typeof llm?.resolveCallConfig!=='function'||typeof agents?.selectForNextRequest!=='function')throw new Error('workbench_model_host_incompatible');
  signal?.throwIfAborted();await check();signal?.throwIfAborted();
  const resolved=await llm.resolveCallConfig({...original});signal?.throwIfAborted();
  if(resolved?.provider!==original.provider||resolved?.model!==original.model)throw new Error('workbench_model_route_changed');
  await check();signal?.throwIfAborted();
  agents.selectForNextRequest(agent,{...original});
 };
}
