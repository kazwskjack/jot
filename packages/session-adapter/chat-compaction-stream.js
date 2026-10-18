import {createHash} from 'node:crypto';
const allowed=new Set(['provider','model','reasoningEffort','messages','system','tools','toolHistory','temperature','maxTokens','stop','signal','sessionId','purpose']);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const fail=()=>{throw Error('chat_compaction_stream_unconfirmed');};
/** Hash the pinned SDK's assembled request fields; never store or send bodies.
 * Runtime AbortSignal is excluded. Non-data values refuse before dispatch. */
export function chatCompactionCallHash(options){
 if(!options||Object.keys(options).some(k=>!allowed.has(k))||!Array.isArray(options.messages))fail();
 const {signal,...body}=options,copy=structuredClone(body);
 const json=JSON.stringify(copy,(_key,v)=>{if(v&&typeof v==='object'){if(Array.isArray(v))return v;const proto=Object.getPrototypeOf(v);if(proto!==Object.prototype&&proto!==null)fail();return Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]]));}if(typeof v==='number'&&!Number.isFinite(v)||['bigint','symbol','function'].includes(typeof v))fail();return v;});
 return createHash('sha256').update(json).digest('hex');
}
/** Opt-in auxiliary stream decorator. The caller must already own the official
 * native maintenance boundary and supply its independent cancellation guard.
 * Nothing registers this on foreground, Work or role streams automatically. */
export async function* accountedChatCompactionStream({attempt,options,next,request,check}){
 if(!attempt?.scope||!['intent_id','attempt_id','observer_id'].every(k=>id(attempt[k]))||typeof next!=='function'||typeof request!=='function'||typeof check!=='function'||options?.sessionId!==attempt.scope.session_ref||options.purpose!=='compaction'||options.reasoningEffort!=='off'||!(options.signal instanceof AbortSignal))fail();
 const signal=options.signal;signal.throwIfAborted();const callHash=chatCompactionCallHash(options),scope=structuredClone(attempt.scope),base=Object.freeze({...scope,intent_id:attempt.intent_id,attempt_id:attempt.attempt_id,observer_id:attempt.observer_id}),witness=structuredClone(attempt.witness),binding={runId:scope.run_id,sessionRef:scope.session_ref};
 let fence,reserved=false,dispatchAttempted=false,otherDispatch=false,settled=false,settlementAttempted=false,usage,finish,reason='stream_incomplete';
 const call=async(action,payload={})=>{
  // Inference cancellation never cancels settlement/unknown/release transport.
  const response=await request('chat-compaction-attempt',binding,{...base,action,...(fence?{fence_id:fence}:{}),...payload});const r=response?.receipt;
  if(r?.protocol!==1||r.kind!=='chat_compaction_attempt'||r.attempt_id!==base.attempt_id||r.intent_id!==base.intent_id||r.observer_id!==base.observer_id||r.run_id!==scope.run_id||r.session_id!==scope.session_ref||!id(r.fence_id)||fence&&r.fence_id!==fence||r.execution_authorized!==false||r.request?.provider!==options.provider||r.request?.model!==options.model||r.request?.reasoning_effort!=='off'||r.request?.purpose!=='compaction'||r.request?.call_sha256!==callHash)fail();return r;
 };
 const guard=async()=>{signal.throwIfAborted();await check(signal);signal.throwIfAborted();if(chatCompactionCallHash(options)!==callHash)fail();};
 try{
  await guard();const r=await call('reserve',{request:{provider:options.provider,model:options.model,reasoning_effort:'off',purpose:'compaction',session_id:options.sessionId,call_sha256:callHash},witness});fence=r.fence_id;if(r.state!=='reserved')fail();reserved=true;
  await guard();dispatchAttempted=true;const dispatched=await call('dispatch');if(dispatched.state!=='dispatched'||dispatched.dispatch_allowed!==true){otherDispatch=true;fail();}
  await guard();
  for await(const chunk of next()){
   if(finish)fail();if(chunk?.type==='usage')usage=structuredClone(chunk.usage);if(chunk?.type==='finish'){finish=chunk;signal.throwIfAborted();continue;}signal.throwIfAborted();yield chunk;
  }
  if(!finish||usage===undefined)fail();reason='settlement_unavailable';settlementAttempted=true;const done=await call('settle',{usage});if(done.state!=='settled')fail();settled=true;signal.throwIfAborted();yield finish;
 }finally{
  if(!settled&&dispatchAttempted&&!otherDispatch&&!settlementAttempted&&finish&&usage!==undefined){try{settlementAttempted=true;const done=await call('settle',{usage});settled=done.state==='settled';}catch{/* The final unknown receipt below retains any unconfirmed usage. */}}
  if(!settled&&dispatchAttempted&&!otherDispatch){try{await call('unknown',{reason,...(usage===undefined?{}:{usage})});}catch{if(usage!==undefined){try{await call('unknown',{reason:'usage_incomplete'});}catch{/* A persistent dispatched/unknown record stays unresolved, never zeroed. */}}}}
  else if(!dispatchAttempted&&reserved){try{await call('release');}catch{/* The unexpired original fence is never silently renewed. */}}
 }
}
