import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {normalizeChatExecutionPolicy} from './ordinary-execution-policy.js';
import {readOrdinaryInputAuthority} from './ordinary-input-resume.js';
import {normalizeHostExecutionLease} from './workbench.js';
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=v=>JSON.stringify(v,(_k,x)=>plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const fail=()=>{throw Error('chat_web_unconfirmed');};
function wait(promise,signal){const pending=Promise.resolve(promise);return new Promise((resolve,reject)=>{const cleanup=()=>signal.removeEventListener('abort',abort),abort=()=>{cleanup();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});pending.then(v=>{cleanup();signal.aborted?reject(signal.reason):resolve(v);},e=>{cleanup();reject(e);});if(signal.aborted)abort();});}
const parse=raw=>{try{return JSON.parse(raw);}catch{return fail();}};
/** Derive a complete group from the original committed assistant step, never
 * from a caller-supplied step number, page content or mutable current-run ID. */
function nativeGroup(exec,state){
 const events=state.session.snapshotEvents(0),markers=events.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='jot-chat-context'),marker=markers.at(-1);
 if(!marker||marker.data.source.run_id!==state.binding.runId||marker.data.source.execution_policy_sha256!==state.policyHash)fail();
 const calls=events.filter(e=>e.seq>marker.seq&&e.type==='tool/call'&&e.data?.callId===exec.callId);
 if(calls.length!==1)fail();const call=calls[0];
 if(call.data.name!==exec.name||!isDeepStrictEqual(parse(call.data.arguments),exec.arguments))fail();
 const assistants=events.filter(e=>e.seq>marker.seq&&e.seq<call.seq&&e.type==='assistant/message'&&e.data?.turn===call.data.turn&&e.data?.step===call.data.step&&e.data.message?.content?.some(b=>b.type==='tool-call'&&b.id===exec.callId));
 if(assistants.length!==1)fail();const assistant=assistants[0];
 const original=events.filter(e=>e.seq>marker.seq&&e.seq<assistant.seq&&e.type==='user/message'&&e.data?.source?.kind==='user'&&e.data.source.rpcId===state.binding.runId);
 if(original.length!==1||assistant.data.message.role!=='assistant')fail();
 const members=assistant.data.message.content.filter(b=>b.type==='tool-call'&&b.name===exec.name).map(b=>({call_id:b.id,name:b.name,arguments:parse(b.arguments)}));
 if(members.filter(c=>c.call_id===exec.callId).length!==1||!isDeepStrictEqual(members.find(c=>c.call_id===exec.callId).arguments,exec.arguments))fail();
 return{protocol:1,kind:exec.name==='web_search'?'search':'fetch',native_turn:call.data.turn,native_step:call.data.step,assistant_seq:assistant.seq,assistant_message_id:assistant.data.message.id,calls:members};
}
export function createChatWebSelector({bridge,sessions,chatPolicy}){
 const expected=normalizeChatExecutionPolicy(chatPolicy),states=new WeakMap(),removers=new Map();let disposed=false;
 if(typeof bridge?.request!=='function'||typeof sessions?.flush!=='function')fail();
 const prepare=async({agent,binding,signal,check})=>{
  if(agent?.session?.header?.agentPreset!=='jot-chat')return;
  if(disposed)fail();
  prepare.prepareAgent(agent);
  if(typeof check!=='function'||!(signal instanceof AbortSignal)||agent.id!==binding?.sessionRef||agent.session.id!==binding.sessionRef)fail();
  const session=agent.session,guard=removers.get(agent),owned=Object.freeze({runId:binding.runId,sessionRef:binding.sessionRef,executionLease:normalizeHostExecutionLease(binding.executionLease)});
  const active=()=>{signal.throwIfAborted();if(disposed||removers.get(agent)!==guard||agent.session!==session||agent.id!==owned.sessionRef)fail();};
  await check();active();const authority=await wait(readOrdinaryInputAuthority({bridge,binding:owned,signal,assertActive:active}),signal),result=await wait(bridge.request('ordinary-execution-policy',owned,{},signal),signal);await check();active();
  if(!plain(result)||Object.keys(result).join(',')!=='execution'||!plain(result.execution))fail();
  const {policy,policy_sha256,...scope}=result.execution;
  if(!isDeepStrictEqual(scope,authority)||!plain(policy)||hash(policy)!==policy_sha256||policy.protocol!==1||!Number.isSafeInteger(policy.conversation_version)||policy.conversation_version<1||typeof policy.model_policy_sha256!=='string'||!/^[a-f0-9]{64}$/.test(policy.model_policy_sha256))fail();
  const {conversation_version,model_policy_sha256,...base}=policy;
  if(!isDeepStrictEqual(normalizeChatExecutionPolicy(base),expected))fail();
  states.set(agent,{binding:owned,session,authority:structuredClone(authority),policyHash:policy_sha256});
 };
 prepare.prepareAgent=agent=>{
  if(agent?.session?.header?.agentPreset!=='jot-chat')return;
  if(disposed)fail();if(removers.has(agent))return;
  if(typeof agent.ctx?.on!=='function')fail();
  const remove=agent.ctx.on('tools/execute',async(exec,next)=>{
   if(!['web_search','web_fetch'].includes(exec?.name))fail();
   const state=states.get(agent),signal=exec.signal;
   if(!state||exec.agent!==agent||!(signal instanceof AbortSignal)||typeof exec.token!=='symbol'||Symbol.keyFor(exec.token)!==undefined||exec.parent!==undefined||exec.rootCallId!==undefined&&exec.rootCallId!==exec.callId)fail();
   const active=()=>{signal.throwIfAborted();if(disposed||states.get(agent)!==state||agent.session!==state.session||agent.id!==state.binding.sessionRef)fail();};
   const fence=async()=>{active();if(!isDeepStrictEqual(await wait(readOrdinaryInputAuthority({bridge,binding:state.binding,signal,assertActive:active}),signal),state.authority))fail();active();};
   await fence();const group=nativeGroup(exec,state);
   if(await wait(sessions.flush(state.session),signal)!==true)fail();await fence();
   const result=await wait(bridge.request('ordinary-chat-web',state.binding,{group,call_id:exec.callId},signal),signal);active();
   if(!plain(result)||Object.keys(result).join(',')!=='reservation'||!plain(result.reservation))fail();
   const r=result.reservation;
   if(Object.keys(r).sort().join(',')!=='call_id,first_dispatch,group_sha256,kind,policy_sha256,protocol,reason,request_sha256,run_id,session_id'||r.protocol!==1||r.run_id!==state.binding.runId||r.session_id!==state.binding.sessionRef||r.kind!==group.kind||r.call_id!==exec.callId||r.group_sha256!==hash(group)||r.request_sha256!==hash(exec.arguments)||r.policy_sha256!==state.policyHash||typeof r.first_dispatch!=='boolean'||!['first_dispatch','already_consumed','duplicate_url'].includes(r.reason)||r.first_dispatch!==(r.reason==='first_dispatch'))fail();
   if(!r.first_dispatch)throw Error('CHAT_WEB_ALLOWANCE_CONSUMED');
   await fence();if(!isDeepStrictEqual(nativeGroup(exec,state),group))fail();active();
   return next();
  });
  if(typeof remove!=='function')fail();removers.set(agent,remove);
 };
 prepare.disposeAgent=agent=>{removers.get(agent)?.();removers.delete(agent);states.delete(agent);};
 prepare.dispose=()=>{disposed=true;for(const agent of [...removers.keys()])prepare.disposeAgent(agent);};
 return prepare;
}
