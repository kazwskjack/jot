import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {runMemoryPluginExtraction} from './memory-plugin-runtime.js';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
/** Host-local extraction port. The existing Session and Bridge supply identity,
 * the model stream and all receipts. No caller-supplied source text or ownership.
 * Dispatch readiness and durable recovery remain the worker's responsibility.
 */
export function createMemoryExtractionHost({runtime,root,bridge,llm,route}){
 if(typeof root!=='string'||!isAbsolute(root)||typeof bridge?.bindingFor!=='function'||typeof bridge.guardBudget!=='function'||typeof bridge.request!=='function'||typeof llm?.stream!=='function'
  ||typeof runtime?.Context!=='function'||typeof runtime?.BlockAssembler!=='function'||typeof runtime?.createUserMessage!=='function'||runtime.plugin?.name!=='dsh-memory'||typeof runtime.plugin.apply!=='function'
  ||!route||typeof route.provider!=='string'||!route.provider||typeof route.model!=='string'||!route.model||!Number.isSafeInteger(route.max_output_tokens)||route.max_output_tokens<1)throw Error('memory_extraction_host_invalid');
 const original=Object.freeze({...route}),active=new Map(),shutdown=new AbortController();let disposed=false;
 async function perform(agent,binding,signal){
  let checking=false;
  const revoked=new AbortController(),combined=AbortSignal.any([signal,revoked.signal]);
  const authorize=async()=>{combined.throwIfAborted();if(agent.status!=='idle'||bridge.bindingFor(agent)!==binding)throw Error('memory_extraction_binding_changed');await bridge.guardBudget(agent,combined);combined.throwIfAborted();};
  await authorize();
  const response=await bridge.request('guard',binding,{},combined),context=response?.context,source=context?.memory_capture;
  if(context?.kind!=='memory_capture'||context.run_id!==binding.runId||context.model_budget?.enforced!==true||!Array.isArray(context.allowed_tools)||context.allowed_tools.length||!Array.isArray(context.memories)||context.memories.length
   ||!source||!id(source.capture_id)||!id(source.source_run_id)||!Number.isSafeInteger(source.source_version)||source.source_version<1||!Number.isSafeInteger(source.policy_version)||source.policy_version<1)throw Error('memory_extraction_binding_invalid');
  const key=createHash('sha256').update(binding.runId).digest('hex');
  const packet=await bridge.request('tool',binding,{operation:'memory.capture.read',arguments:{capture_id:source.capture_id},call_id:`memory-read-${key}`},combined);
  if(packet?.capture_id!==source.capture_id||packet.source_run_id!==source.source_run_id||packet.version!==source.source_version||packet.policy_version!==source.policy_version
   ||packet.agent_id!==context.agent_id||packet.workspace_id!==context.workspace_id||packet.project_id!==context.project_id)throw Error('memory_extraction_source_changed');
  // One bounded poll at a time. Cancellation reaches the auxiliary stream even
  // though no AgentLoop is running; Gateway rechecks authority on each effect.
  const poll=setInterval(()=>{
   if(checking||combined.aborted)return;checking=true;
   authorize().catch(error=>revoked.abort(error)).finally(()=>{checking=false;});
  },250);poll.unref();
  try{return await runMemoryPluginExtraction({runtime,root:join(root,key),binding,packet,route:original,signal:combined,authorize,
   stream:options=>llm.stream(options),propose:input=>bridge.request('tool',binding,{operation:'memory.capture.propose',arguments:{capture_id:source.capture_id,...input},call_id:`memory-propose-${key}`},combined)});
  }finally{clearInterval(poll);revoked.abort();}
 }
 return {
  run(agent,{signal}={}){
   if(disposed)return Promise.reject(Error('memory_extraction_host_disposed'));
   const binding=bridge.bindingFor(agent);
   if(!binding||!id(binding.runId)||!id(binding.sessionRef)||!binding.executionLease)return Promise.reject(Error('memory_extraction_binding_invalid'));
   if(active.has(binding.runId))return Promise.reject(Error('memory_extraction_busy'));
   const combined=signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal;
   const pending=perform(agent,binding,combined);active.set(binding.runId,pending);
   return pending.finally(()=>{active.delete(binding.runId);});
  },
  async dispose(){disposed=true;shutdown.abort(Error('memory_extraction_host_disposed'));await Promise.allSettled([...active.values()]);},
 };
}
