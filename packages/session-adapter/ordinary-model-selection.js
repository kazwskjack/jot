import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
import {normalizeHostExecutionLease} from './workbench.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const fail=()=>{throw Error('ordinary_model_policy_unconfirmed');};
function selection(value){
 if(!plain(value)||!['model,provider','model,provider,reasoning_effort'].includes(Object.keys(value).sort().join(','))
  ||typeof value.provider!=='string'||!ID.test(value.provider)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value.model)
  ||value.reasoning_effort!==undefined&&(typeof value.reasoning_effort!=='string'||!ID.test(value.reasoning_effort)))fail();
 return structuredClone(value);
}
/** Only original run authority selects the native route. No default setting is saved. */
export function createOrdinaryModelSelector({bridge,llm,agents,registry,executionPolicyReader}){
 if(typeof bridge?.request!=='function'||typeof llm?.resolveCallConfig!=='function'||typeof agents?.selectForNextRequest!=='function'||typeof agents?.selectionFor!=='function'||typeof registry?.get!=='function'||executionPolicyReader!==undefined&&typeof executionPolicyReader!=='function')fail();
 const select=async({agent,binding,check,signal})=>{
  if(typeof check!=='function'||!binding||!ID.test(binding.runId??'')||!ID.test(binding.sessionRef??'')||agent?.id!==binding.sessionRef||agent.session?.id!==binding.sessionRef)fail();
  const owned=Object.freeze({runId:binding.runId,sessionRef:binding.sessionRef,executionLease:normalizeHostExecutionLease(binding.executionLease)}),session=agent.session;
  const active=()=>{signal?.throwIfAborted();if(registry.get(agent.id)!==agent||agent.session!==session)fail();};
  const fence=async()=>{active();await check();active();};
  const read=async(payload={})=>{
   await fence();const authority=await readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive:active});
   const result=await bridge.request('ordinary-model-policy',owned,payload,signal);await fence();
   if(!plain(result)||Object.keys(result).join(',')!=='policy'||!plain(result.policy))fail();
   const {model,conversation_version,policy_sha256,resolved_model,...base}=result.policy;
   if(!isDeepStrictEqual(base,authority)||!Number.isSafeInteger(conversation_version)||conversation_version<1||typeof policy_sha256!=='string'||!/^[a-f0-9]{64}$/.test(policy_sha256))fail();
   const selected=selection(model),resolved=resolved_model===null?null:selection(resolved_model);
   if(createHash('sha256').update(canonical({protocol:1,conversation_version,model:selected})).digest('hex')!==policy_sha256
    ||resolved&&(resolved.provider!==selected.provider||resolved.model!==selected.model||selected.reasoning_effort!==undefined&&resolved.reasoning_effort!==selected.reasoning_effort))fail();
   return structuredClone({...base,model:selected,conversation_version,policy_sha256,resolved_model:resolved});
  };
  const original=await read(),requested=original.resolved_model??original.model;
  const modePolicy=executionPolicyReader?await executionPolicyReader({agent,binding:owned,modelPolicy:original,signal,check:fence}):undefined;
  await fence();
  if(agent.session.header?.agentPreset==='jot-chat'&&modePolicy?.mode!=='chat'||modePolicy&&(!['chat','work'].includes(modePolicy.mode)||modePolicy.thinking!==(modePolicy.mode==='chat'?'disabled':'provider')))fail();
  const effort=modePolicy?.mode==='chat'?'off':requested.reasoning_effort;
  if(modePolicy?.mode==='chat'&&requested.reasoning_effort!==undefined&&requested.reasoning_effort!=='off')fail();
  const config={provider:requested.provider,model:requested.model,...(effort===undefined?{}:{reasoningEffort:effort})};
  const resolved=await llm.resolveCallConfig(config,signal);await fence();
  const chosen=selection({provider:resolved?.provider,model:resolved?.model,...(resolved?.reasoningEffort===undefined?{}:{reasoning_effort:resolved.reasoningEffort})});
  if(chosen.provider!==requested.provider||chosen.model!==requested.model||effort!==undefined&&chosen.reasoning_effort!==effort
   ||original.resolved_model&&!isDeepStrictEqual(chosen,original.resolved_model))fail();
  const bound=original.resolved_model?await read():await read({action:'bind',policy_sha256:original.policy_sha256,model:chosen});
  const {resolved_model:oldResolution,...oldPolicy}=original,{resolved_model:newResolution,...newPolicy}=bound;
  if(!isDeepStrictEqual(oldPolicy,newPolicy)||!isDeepStrictEqual(newResolution,chosen))fail();
  if(executionPolicyReader&&!isDeepStrictEqual(await executionPolicyReader({agent,binding:owned,modelPolicy:bound,signal,check:fence}),modePolicy))fail();
  await fence();
  const native={provider:chosen.provider,model:chosen.model,...(chosen.reasoning_effort===undefined?{}:{reasoningEffort:chosen.reasoning_effort})};
  if(typeof agents.selectionFor!=='function'||!isDeepStrictEqual(agents.selectionFor(agent).current,native))agents.selectForNextRequest(agent,native);
 };
 return Object.assign(select,{prepareAgent(agent){if(registry.get(agent?.id)!==agent)fail();agents.selectionFor(agent);}});
}
