import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const fail=()=>{throw Error('ordinary_execution_policy_unconfirmed');};
export function normalizeChatExecutionPolicy(value){
 if(!plain(value)||Object.keys(value).sort().join(',')!=='context_revision,mode,model,preset_id,preset_revision,protocol,thinking'
  ||value.protocol!==1||value.mode!=='chat'||value.thinking!=='disabled'||value.preset_id!=='jot-chat'
  ||!['preset_revision','context_revision'].every(key=>typeof value[key]==='string'&&ID.test(value[key]))
  ||!plain(value.model)||Object.keys(value.model).sort().join(',')!=='model,provider'
  ||typeof value.model.provider!=='string'||!ID.test(value.model.provider)||typeof value.model.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value.model.model))fail();
 return structuredClone(value);
}
/** The bearer bridge observes an existing original input and live lease only.
 * It neither changes policy nor supplies authority to execute an Agent. */
export function createOrdinaryExecutionPolicyReader({bridge,chatPolicy}){
 if(typeof bridge?.request!=='function')fail();
 const expected=normalizeChatExecutionPolicy(chatPolicy);
 return async({agent,binding,modelPolicy,signal,check})=>{
  if(typeof check!=='function'||!plain(modelPolicy)||!binding||agent?.id!==binding.sessionRef||agent.session?.id!==binding.sessionRef)fail();
  const fence=async()=>{signal?.throwIfAborted();await check();signal?.throwIfAborted();if(agent.id!==binding.sessionRef||agent.session?.id!==binding.sessionRef)fail();};
  await fence();const result=await bridge.request('ordinary-execution-policy',binding,{},signal);await fence();
  if(!plain(result)||Object.keys(result).join(',')!=='execution'||!plain(result.execution))fail();
  const {policy,policy_sha256,...authority}=result.execution;
  const {model,conversation_version,policy_sha256:modelHash,resolved_model,...original}=modelPolicy;
  if(!isDeepStrictEqual(authority,original)||!plain(policy)||policy.protocol!==1||policy.conversation_version!==conversation_version
   ||!Number.isSafeInteger(conversation_version)||conversation_version<1||policy.model_policy_sha256!==modelHash
   ||modelHash!==hash({protocol:1,conversation_version,model})||policy_sha256!==hash(policy)
   ||agent.session.header?.agentPreset!==policy.preset_id)fail();
  const {conversation_version:_version,model_policy_sha256:_modelHash,...base}=policy;
  if(policy.mode==='chat'){
   if(!isDeepStrictEqual(normalizeChatExecutionPolicy(base),expected)||!isDeepStrictEqual(base.model,model))fail();
  }else if(policy.mode!=='work'||Object.keys(base).sort().join(',')!=='context_revision,mode,preset_id,preset_revision,protocol,thinking'
   ||base.thinking!=='provider'||!['preset_id','preset_revision','context_revision'].every(key=>typeof base[key]==='string'&&ID.test(base[key])))fail();
  return structuredClone(policy);
 };
}
