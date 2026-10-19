import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('chat_post_answer_unconfirmed');};
function waitIdle(agent,signal){return new Promise((resolve,reject)=>{
 signal.throwIfAborted();const cleanup=()=>signal.removeEventListener('abort',abort),abort=()=>{cleanup();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
 Promise.resolve().then(()=>{signal.throwIfAborted();return agent.whenIdle();}).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
});}
/** A notification for an already committed answer, not a queue or model grant.
 * Original source/attempt/recovery and the original manager retain authority.
 * There is no scan, timer, Agent creation, foreground lease or inference retry. */
export function createChatPostAnswer({bridge,agents,manager,recover,onSettled}){
 if(typeof bridge?.request!=='function'||typeof agents?.get!=='function'||typeof manager?.run!=='function'||typeof recover!=='function'||onSettled!==undefined&&typeof onSettled!=='function')fail();
 const jobs=new Map();let disposed=false;
 return Object.freeze({notify({scope:raw,signal}={}){
  if(disposed||!raw||Object.keys(raw).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref'].every(k=>id(raw[k]))||!Number.isSafeInteger(raw.expected_run_version)||raw.expected_run_version<1||signal!==undefined&&!(signal instanceof AbortSignal))fail();signal?.throwIfAborted();
  const scope=structuredClone(raw),prior=jobs.get(scope.session_ref);if(prior){if(!equal(prior.scope,scope))fail();return prior.accepted;}
  const controller=new AbortController(),active=controller.signal,binding={runId:scope.run_id,sessionRef:scope.session_ref},job={scope,controller,accepted:null};jobs.set(scope.session_ref,job);
  const observe=result=>{if(!onSettled)return;const status=['compacted','skipped','recovered','already_published','unavailable'].includes(result?.status)?result.status:'unconfirmed',reason=typeof result?.reason==='string'&&/^[A-Z_]{1,64}$/.test(result.reason)?result.reason:null;try{Promise.resolve(onSettled(Object.freeze({protocol:1,kind:'chat_post_answer_settled',run_id:scope.run_id,session_id:scope.session_ref,run_version:scope.expected_run_version,status,reason,execution_authorized:false}))).catch(()=>{});}catch{}};
  const task=Promise.resolve().then(async()=>{
   active.throwIfAborted();const prepared=await bridge.request('chat-compaction-source',binding,{action:'prepare',...scope},active);active.throwIfAborted();const intent=prepared?.intent,source=intent?.source;
   if(intent?.protocol!==1||!id(intent.intent_id)||intent.run_id!==scope.run_id||intent.execution_authorized!==false||!hash(intent.source_sha256)||digest(source)!==intent.source_sha256||source?.protocol!==1||source.kind!=='chat_compaction_source'||source.owner_id!==scope.owner_id||source.conversation_id!==scope.conversation_id||source.run_id!==scope.run_id||source.session_id!==scope.session_ref||source.run_version!==scope.expected_run_version||source.execution_authorized!==false||source.policy?.mode!=='chat'||source.policy.thinking!=='disabled'||source.policy.context_revision!=='checkpoint-text-v2'||source.model?.reasoning_effort!=='off')fail();
   const inspected=await bridge.request('chat-compaction-attempt',binding,{action:'inspect',...scope,intent_id:intent.intent_id},active);active.throwIfAborted();const original=inspected?.attempt;
   if(original?.protocol!==1||original.kind!=='chat_compaction_attempt_inspection'||original.intent_id!==intent.intent_id||original.owner_id!==scope.owner_id||original.conversation_id!==scope.conversation_id||original.run_id!==scope.run_id||original.session_id!==scope.session_ref||original.run_version!==scope.expected_run_version||original.source_sha256!==intent.source_sha256||!equal(original.source,source)||original.execution_authorized!==false||!Object.hasOwn(original,'receipt'))fail();
   // Any prior attempt is recovery work, never permission to allocate a new one.
   if(original.receipt!==null)return recover({scope,intent_id:intent.intent_id,signal:active});
   if(original.native_witness!==null)fail();const agent=agents.get(scope.session_ref),session=agent?.session;
   const check=()=>{active.throwIfAborted();if(disposed||!agent||agents.get(scope.session_ref)!==agent||agent.id!==scope.session_ref||agent.session!==session||session?.id!==scope.session_ref||session.header?.agentPreset!=='jot-chat'||agent.status!=='idle'||typeof agent.whenIdle!=='function'||!Array.isArray(agent.inbox?.nextStep)||!Array.isArray(agent.inbox?.nextTurn)||agent.inbox.nextStep.length||agent.inbox.nextTurn.length)fail();};
   check();await waitIdle(agent,active);check();return manager.run({scope,intent_id:intent.intent_id,source_sha256:intent.source_sha256,signal:active});
  });
  const done=task.then(result=>{observe(result);return result;},error=>{observe(null);throw error;}).finally(()=>{if(jobs.get(scope.session_ref)===job)jobs.delete(scope.session_ref);});
  // Detached work must never become an unhandled rejection after HTTP 202.
  done.catch(()=>{});job.accepted=Object.freeze({receipt:Object.freeze({protocol:1,kind:'chat_post_answer',status:'accepted',run_id:scope.run_id,session_id:scope.session_ref,run_version:scope.expected_run_version,execution_authorized:false}),done});return job.accepted;
 },async dispose(){disposed=true;const pending=[...jobs.values()];for(const job of pending)job.controller.abort(Error('chat_post_answer_shutdown'));await Promise.allSettled(pending.map(job=>job.accepted.done));}});
}
