import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
import {normalizeHostExecutionLease} from './workbench.js';
import {createTrustedModelMetadataConsumer,createTrustedModelMetadataProducer,observePreparedModelMetadata} from './trusted-model-metadata.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const fail=()=>{throw Error('ordinary_model_policy_unconfirmed');};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
async function assertSessionFitsRoute({session,tokenMeter,llm,route,callConfig,signal}){
 const seq=session?.seq;
 if(!integer(seq)||typeof tokenMeter?.measure!=='function'||typeof llm?.resolveModelInfo!=='function')fail();
 let first,info,second;
 try{first=tokenMeter.measure(session);info=await llm.resolveModelInfo(route.provider,route.model,signal);signal?.throwIfAborted();second=tokenMeter.measure(session);}
 catch{signal?.throwIfAborted();fail();}
 const contextWindow=info?.context?.contextWindow,outputBudget=callConfig?.maxTokens??info?.defaultMaxTokens;
 if(session.seq!==seq||!plain(first)||!integer(first.totalTokens)||!integer(first.logRevision)||!isDeepStrictEqual(first,second)
  ||info?.provider!==route.provider||info?.id!==route.model||!integer(contextWindow)||contextWindow===0||!integer(outputBudget)||outputBudget===0
  ||!Number.isSafeInteger(first.totalTokens+outputBudget)||first.totalTokens+outputBudget>contextWindow)fail();
}
function routeSelection(value){
 if(!plain(value)||!['model,provider','model,provider,reasoning_effort'].includes(Object.keys(value).sort().join(','))
  ||typeof value.provider!=='string'||!ID.test(value.provider)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value.model)
  ||value.reasoning_effort!==undefined&&(typeof value.reasoning_effort!=='string'||!ID.test(value.reasoning_effort)))fail();
 return structuredClone(value);
}
function selection(value){
 if(!plain(value)||!['model,provider','model,provider,reasoning_effort','fallbacks,model,provider','fallbacks,model,provider,reasoning_effort'].includes(Object.keys(value).sort().join(',')))fail();
 const{fallbacks,...base}=value,primary=routeSelection(base);
 if(fallbacks!==undefined){
  if(!Array.isArray(fallbacks)||fallbacks.length>3)fail();
  const seen=new Set([JSON.stringify([primary.provider,primary.model])]);
  for(const item of fallbacks){const candidate=routeSelection(item),key=JSON.stringify([candidate.provider,candidate.model]);if(seen.has(key))fail();seen.add(key);}
  primary.fallbacks=structuredClone(fallbacks);
 }
 return primary;
}
function metadataBindings(value,selected){
 const routes=[{provider:selected.provider,model:selected.model},...(selected.fallbacks??[])];
 if(!Array.isArray(value)||value.length!==routes.length)fail();
 const seen=new Set();return value.map((item,index)=>{
  const route=routes[index];if(!plain(item)||Object.keys(item).sort().join(',')!=='digest_revision,metadata_digest,model,provider,source_config_revision,upstream_revision'
   ||item.provider!==route.provider||item.model!==route.model||item.digest_revision!=='jot-model-metadata-v1'||typeof item.metadata_digest!=='string'||!/^[a-f0-9]{64}$/.test(item.metadata_digest)
   ||item.source_config_revision!==null&&(typeof item.source_config_revision!=='string'||!item.source_config_revision.trim()||item.source_config_revision.length>256||/[\u0000-\u001f\u007f]/.test(item.source_config_revision))
   ||item.upstream_revision!==null&&(typeof item.upstream_revision!=='string'||!item.upstream_revision.trim()||item.upstream_revision.length>256||/[\u0000-\u001f\u007f]/.test(item.upstream_revision)))fail();
  const key=JSON.stringify([route.provider,route.model]);if(seen.has(key))fail();seen.add(key);
  return{provider:route.provider,model:route.model,digest_revision:item.digest_revision,metadata_digest:item.metadata_digest,
   source_config_revision:item.source_config_revision,upstream_revision:item.upstream_revision};
 });
}
/** Only original run authority selects the native route. No default setting is saved. */
export function createOrdinaryModelSelector({bridge,llm,agents,registry,executionPolicyReader,routeHealth,readTrustedModelMetadata,ordinaryPresets}){
 if(typeof bridge?.request!=='function'||typeof llm?.resolveCallConfig!=='function'||typeof agents?.selectForNextRequest!=='function'||typeof agents?.selectionFor!=='function'||typeof registry?.get!=='function'||executionPolicyReader!==undefined&&typeof executionPolicyReader!=='function'||routeHealth!==undefined&&typeof routeHealth?.select!=='function')fail();
 if(readTrustedModelMetadata!==undefined&&typeof readTrustedModelMetadata!=='function')fail();
 const readMetadata=createTrustedModelMetadataConsumer({enabled:true,
  readTrustedModelMetadata:readTrustedModelMetadata??createTrustedModelMetadataProducer({llm,enabled:true})});
 const dispatchPolicies=new WeakMap();
 const select=async({agent,binding,check,signal,tokenMeter,inputMessages=[]})=>{
  if(agent?.session)dispatchPolicies.delete(agent.session);
  if(!Array.isArray(inputMessages))fail();
  const requiredInput=()=>{
   if(typeof agent?.session?.deriveMessages!=='function')fail();
   const history=agent.session.deriveMessages();
   if(!Array.isArray(history))fail();
   const messages=[...history,...inputMessages];
   const has=type=>messages.some(message=>Array.isArray(message?.content)&&message.content.some(block=>block?.type===type));
   return {image:has('image'),text:has('text')};
  };
  const inputRequired=requiredInput();
  const observedMetadata=new Map();
  if(typeof check!=='function'||!binding||!ID.test(binding.runId??'')||!ID.test(binding.sessionRef??'')||agent?.id!==binding.sessionRef||agent.session?.id!==binding.sessionRef)fail();
  const owned=Object.freeze({runId:binding.runId,sessionRef:binding.sessionRef,executionLease:normalizeHostExecutionLease(binding.executionLease)}),session=agent.session;
  const active=()=>{signal?.throwIfAborted();if(registry.get(agent.id)!==agent||agent.session!==session||!isDeepStrictEqual(requiredInput(),inputRequired))fail();};
  const fence=async()=>{active();await check();active();};
  const read=async(payload={})=>{
   await fence();const authority=await readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive:active});
   const result=await bridge.request('ordinary-model-policy',owned,payload,signal);await fence();
   if(!plain(result)||Object.keys(result).join(',')!=='policy'||!plain(result.policy))fail();
   const {model,metadata_bindings,conversation_version,policy_sha256,resolved_model,...base}=result.policy;
   if(!isDeepStrictEqual(base,authority)||!Number.isSafeInteger(conversation_version)||conversation_version<1||typeof policy_sha256!=='string'||!/^[a-f0-9]{64}$/.test(policy_sha256))fail();
   const selected=selection(model),acceptedMetadata=metadata_bindings===undefined?undefined:metadataBindings(metadata_bindings,selected),resolved=resolved_model===null?null:routeSelection(resolved_model);
   if(resolved&&((resolved.provider!==selected.provider||resolved.model!==selected.model)
    &&!(selected.fallbacks??[]).some(route=>route.provider===resolved.provider&&route.model===resolved.model)
    ||selected.reasoning_effort!==undefined&&resolved.reasoning_effort!==selected.reasoning_effort))fail();
   if(createHash('sha256').update(canonical({protocol:1,conversation_version,model:selected,...(acceptedMetadata===undefined?{}:{metadata_bindings:acceptedMetadata})})).digest('hex')!==policy_sha256
    ||resolved&&(resolved.provider!==selected.provider||resolved.model!==selected.model)&&!(selected.fallbacks??[]).some(route=>route.provider===resolved.provider&&route.model===resolved.model))fail();
   return structuredClone({...base,model:selected,...(acceptedMetadata===undefined?{}:{metadata_bindings:acceptedMetadata}),conversation_version,policy_sha256,resolved_model:resolved});
  };
  const assertMetadata=async(route,policy,requireInput=true)=>{
   const current=await readMetadata({provider:route.provider,model:route.model},signal);
   await fence();
   if(current.state!=='ready')fail();
   const accepted=policy.metadata_bindings?.find(item=>item.provider===route.provider&&item.model===route.model);
   if(policy.metadata_bindings&&!accepted)fail();
   if(accepted&&(current.digest_revision!==accepted.digest_revision||current.metadata_digest!==accepted.metadata_digest
    ||current.source_config_revision!==accepted.source_config_revision||current.upstream_revision!==accepted.upstream_revision))fail();
   const key=JSON.stringify([route.provider,route.model]),previous=observedMetadata.get(key);
   if(previous&&!isDeepStrictEqual(previous,current))fail();
   observedMetadata.set(key,current);
   if(requireInput&&inputRequired.image&&!current.metadata.inputModalities?.includes('image'))fail();
   if(requireInput&&inputRequired.text&&current.metadata.inputModalities&&!current.metadata.inputModalities.includes('text'))fail();
   if(route.reasoning_effort!==undefined&&!current.metadata.reasoning?.efforts.some(effort=>effort.id===route.reasoning_effort))fail();
   return current;
  };
  const original=await read();
  if(agent.session.header?.agentPreset==='jot-chat'&&!executionPolicyReader)fail();
  const modePolicy=executionPolicyReader?await executionPolicyReader({agent,binding:owned,modelPolicy:original,signal,check:fence}):undefined;
  await fence();
  if(agent.session.header?.agentPreset==='jot-chat'&&modePolicy?.mode!=='chat'||modePolicy&&(!['chat','work'].includes(modePolicy.mode)||modePolicy.thinking!==(modePolicy.mode==='chat'?'disabled':'provider')))fail();
  if(modePolicy?.mode==='chat'&&original.model.fallbacks?.length)fail();
  const primary=routeSelection({provider:original.model.provider,model:original.model.model,...(original.model.reasoning_effort===undefined?{}:{reasoning_effort:original.model.reasoning_effort})});
  let requested=original.resolved_model,primaryResolved,primaryCallConfig;
  if(!requested){
   const primaryEffort=modePolicy?.mode==='chat'?'off':primary.reasoning_effort;
   const primaryConfig={provider:primary.provider,model:primary.model,...(primaryEffort===undefined?{}:{reasoningEffort:primaryEffort})};
   await assertMetadata({...primary,...(primaryEffort===undefined?{}:{reasoning_effort:primaryEffort})},original,false);
   const resolvedPrimary=await llm.resolveCallConfig(primaryConfig,signal);await fence();primaryCallConfig=resolvedPrimary;
   primaryResolved=routeSelection({provider:resolvedPrimary?.provider,model:resolvedPrimary?.model,...(resolvedPrimary?.reasoningEffort===undefined?{}:{reasoning_effort:resolvedPrimary.reasoningEffort})});
   if(primaryResolved.provider!==primary.provider||primaryResolved.model!==primary.model
    ||primaryEffort!==undefined&&primaryResolved.reasoning_effort!==primaryEffort)fail();
   const pick=modePolicy?.mode==='chat'?primary:routeHealth?routeHealth.select({provider:primary.provider,model:primary.model},original.model.fallbacks??[]):primary;
   if(!pick)throw Error('ordinary_model_route_unavailable');
   const candidate=routeSelection(pick),allowed=(candidate.provider===primary.provider&&candidate.model===primary.model)
    ||(original.model.fallbacks??[]).some(route=>route.provider===candidate.provider&&route.model===candidate.model);
   if(!allowed)fail();
   const effort=primaryResolved.reasoning_effort;
   if((candidate.provider!==primary.provider||candidate.model!==primary.model)&&effort===undefined)fail();
   requested={...candidate,...(effort===undefined?{}:{reasoning_effort:effort})};
  }
  await fence();
  const effort=modePolicy?.mode==='chat'?'off':requested.reasoning_effort;
  if(modePolicy?.mode==='chat'&&requested.reasoning_effort!==undefined&&requested.reasoning_effort!=='off')fail();
  const config={provider:requested.provider,model:requested.model,...(effort===undefined?{}:{reasoningEffort:effort})};
  await assertMetadata({...requested,...(effort===undefined?{}:{reasoning_effort:effort})},original);
  const resolved=primaryResolved&&modePolicy?.mode!=='chat'&&requested.provider===primaryResolved.provider&&requested.model===primaryResolved.model
   ?primaryCallConfig
   :await llm.resolveCallConfig(config,signal);await fence();
  const chosen=selection({provider:resolved?.provider,model:resolved?.model,...(resolved?.reasoningEffort===undefined?{}:{reasoning_effort:resolved.reasoningEffort})});
  if(chosen.provider!==requested.provider||chosen.model!==requested.model||effort!==undefined&&chosen.reasoning_effort!==effort
   ||original.resolved_model&&!isDeepStrictEqual(chosen,original.resolved_model))fail();
  await assertMetadata(chosen,original);
  const bound=original.resolved_model?await read():await read({action:'bind',policy_sha256:original.policy_sha256,model:chosen});
  const {resolved_model:oldResolution,...oldPolicy}=original,{resolved_model:newResolution,...newPolicy}=bound;
  if(!isDeepStrictEqual(oldPolicy,newPolicy)||!isDeepStrictEqual(newResolution,chosen))fail();
  if(executionPolicyReader&&!isDeepStrictEqual(await executionPolicyReader({agent,binding:owned,modelPolicy:bound,signal,check:fence}),modePolicy))fail();
  await fence();
  const native={provider:chosen.provider,model:chosen.model,...(chosen.reasoning_effort===undefined?{}:{reasoningEffort:chosen.reasoning_effort})};
  await assertSessionFitsRoute({session:agent.session,tokenMeter,llm,route:chosen,callConfig:resolved,signal});await fence();
  await assertMetadata(chosen,bound);
  if(typeof agents.selectionFor!=='function'||!isDeepStrictEqual(agents.selectionFor(agent).current,native))agents.selectForNextRequest(agent,native);
  dispatchPolicies.set(session,{agent,signal,route:structuredClone(chosen),metadata:observedMetadata.get(JSON.stringify([chosen.provider,chosen.model])),tokenMeter});
 };
 const prepareDispatch=originalOptions=>{
  if(typeof originalOptions?.sessionId!=='string')return;
  const agent=registry.get(originalOptions?.sessionId),session=agent?.session;
  // Auxiliary calls have their own admission and metadata integration work item.
  if(!session||!ordinaryPresets?.has(session.header?.agentPreset)||originalOptions.purpose!==undefined)return;
  const policy=dispatchPolicies.get(session);
  return ({options,modelInfo,stopped})=>{
   originalOptions.signal?.throwIfAborted();policy?.signal?.throwIfAborted();
   if(stopped||!policy||dispatchPolicies.get(session)!==policy||registry.get(agent.id)!==agent||agent.session!==session
    ||policy.agent!==agent||agent.id!==session.id||options.sessionId!==session.id
    ||options.provider!==policy.route.provider||options.model!==policy.route.model
    ||options.reasoningEffort!==policy.route.reasoning_effort)fail();
   const observed=observePreparedModelMetadata(modelInfo,{provider:options.provider,model:options.model});
   if(observed.state!=='ready'||observed.metadata_digest!==policy.metadata?.metadata_digest
    ||observed.digest_revision!==policy.metadata?.digest_revision)fail();
   if(!Array.isArray(originalOptions.messages))fail();
   const has=type=>originalOptions.messages.some(message=>Array.isArray(message?.content)&&message.content.some(block=>block?.type===type));
   if(has('image')&&!observed.metadata.inputModalities?.includes('image')
    ||has('text')&&observed.metadata.inputModalities&&!observed.metadata.inputModalities.includes('text'))fail();
   const measured=policy.tokenMeter.measure(session),limit=observed.metadata.context?.contextWindow;
   const output=options.maxTokens??observed.metadata.defaultMaxTokens;
   if(!integer(measured?.totalTokens)||!integer(limit)||limit===0||!integer(output)||output===0
    ||!Number.isSafeInteger(measured.totalTokens+output)||measured.totalTokens+output>limit)fail();
  };
 };
 return Object.assign(select,{prepareDispatch,prepareAgent(agent){if(registry.get(agent?.id)!==agent)fail();agents.selectionFor(agent);}});
}
