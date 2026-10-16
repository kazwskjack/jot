import {conversationGoal,prepareConversationGoalResume} from './conversation-goal.js';
import {nativeGoalsFor} from './workbench-goal.js';
import {normalizeHostExecutionLease} from './workbench.js';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function binding(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='control_id,execution_lease,run_id'||typeof value.control_id!=='string'||!ID.test(value.control_id)||typeof value.run_id!=='string'||!ID.test(value.run_id))throw Error('goal_control_input_invalid');
 return Object.freeze({controlId:value.control_id,runId:value.run_id,executionLease:normalizeHostExecutionLease(value.execution_lease)});
}
const same=(a,b)=>a.controlId===b.controlId&&a.runId===b.runId&&a.executionLease.owner===b.executionLease.owner&&a.executionLease.generation===b.executionLease.generation;
/** One real follow stream owns one human resume. No planner or Goal state is
 * duplicated here. Process-local handles never authorize recovery after restart.
 */
export function createConversationGoalRunHost({controller,agents,persistence,bridge,ordinaryPresets}){
 if(typeof bridge?.request!=='function'||!['follow','inspect','projections','resolveAgent'].every(name=>typeof controller?.[name]==='function')||typeof agents?.get!=='function'||typeof persistence?.flush!=='function'||!(ordinaryPresets instanceof Set)||!ordinaryPresets.size)throw Error('goal_control_unavailable');
 const observers=new Map(),boundAgents=new Map();let disposed=false;
 const request=(record,operation,payload={},signal=record.signal)=>bridge.request('conversation-goal-control',{runId:record.binding.runId,sessionRef:record.sessionId,executionLease:record.binding.executionLease},{operation,control_id:record.binding.controlId,...(operation==='inspect'?{}:{observer_id:record.observerId}),...payload},signal);
 const identity=(record,control)=>{
  if(!control||control.control_id!==record.binding.controlId||control.run_id!==record.binding.runId||control.session_id!==record.sessionId||typeof control.conversation_id!=='string'||!ID.test(control.conversation_id)||typeof control.ref?.id!=='string'||!ID.test(control.ref.id)||!Number.isSafeInteger(control.ref.revision)||control.ref.revision<1||!['queued','dispatching','applied','rejected'].includes(control.state))throw Error('goal_control_identity_invalid');
  if(record.conversationId&&record.conversationId!==control.conversation_id||record.expectedRef&&(record.expectedRef.id!==control.ref.id||record.expectedRef.revision!==control.ref.revision))throw Error('goal_control_identity_invalid');
  if(record.observerBound&&control.state!=='queued'&&control.observer_id!==record.observerId)throw Error('goal_control_identity_invalid');
  record.conversationId??=control.conversation_id;record.expectedRef??=Object.freeze({...control.ref});
  return control;
 };
 const live=record=>{
  if(disposed||record.closed||record.signal.aborted||observers.get(record.sessionId)!==record)throw Error('goal_observer_required');
 };
 const inspect=async record=>{live(record);const result=await request(record,'inspect');live(record);return identity(record,result?.control);};
 const clean=record=>{for(const remove of record.removers.splice(0))try{remove();}catch{}if(boundAgents.get(record.agent)===record)boundAgents.delete(record.agent);};
 const preserveClaimed=record=>{
  const context=record.claimedContext,agent=record.agent;
  // Do this synchronously before our own cancel. A prior explicit user cancel
  // must not be undone; a later one can still discard these restored inputs.
  if(!context||context.signal?.aborted||agents.get(record.sessionId)!==agent)return;
  const messages=context.messages.filter(message=>message?.role==='user'&&message.source?.kind==='user');if(!messages.length)return;
  if(typeof agent.session.snapshotEvents!=='function'||typeof agent.inbox?.prepend!=='function')throw Error('goal_input_recovery_unconfirmed');
  const events=agent.session.snapshotEvents(0);if(!Array.isArray(events))throw Error('goal_input_recovery_unconfirmed');
  const entered=new Set(events.filter(event=>event.type==='user/message').map(event=>event.data?.id)),seen=new Set(),restore=[];
  for(const message of messages){
   if(!ID.test(message.id??'')||seen.has(message.id))throw Error('goal_input_recovery_unconfirmed');seen.add(message.id);if(entered.has(message.id))continue;
   const pending=[...agent.inbox.nextTurn,...agent.inbox.nextStep].filter(value=>value.id===message.id);
   if(pending.length){if(pending.length!==1||!isDeepStrictEqual(pending[0],message))throw Error('goal_input_recovery_unconfirmed');continue;}
   restore.push(message);
  }
  // Match the official Goal driver's restoreOtherClaimed convention: retain
  // original step context at next-step, without a send, prompt or wake call.
  for(const message of restore.toReversed())agent.inbox.prepend('next-step',message);
 };
 // Revoking this observer stops its in-flight work, including a closing
 // answer, without durably cancelling another original input in the inbox.
 const revoke=record=>{
  if(record.revoked)return;record.revoked=true;
  if(record.agent&&record.nativeAttempted){try{const goals=nativeGoalsFor(record.agent),current=goals.get(record.agent);if(current?.id===record.ref?.id){try{preserveClaimed(record);}catch{record.inputRecoveryError=true;}goals.disarm(record.agent);if(record.agent.status==='running')record.agent.cancel({kind:'parent'},{keepInbox:true});}}catch{}}
  if(!record.agent||record.agent.status==='idle')clean(record);
 };
 const guard=async(record,signal)=>{
  try{signal?.throwIfAborted();if(record.revoked||!record.applied||agents.get(record.sessionId)!==record.agent||boundAgents.get(record.agent)!==record)throw Error('goal_control_execution_revoked');const control=await inspect(record);if(control.state!=='applied'||control.ref.id!==record.ref.id||control.ref.revision!==record.ref.revision||nativeGoalsFor(record.agent).get(record.agent)?.id!==record.ref.id)throw Error('goal_control_execution_revoked');}
  catch{revoke(record);throw Error('goal_control_execution_revoked');}
 };
 const install=record=>{
  if(boundAgents.has(record.agent))throw Error('goal_observer_conflict');boundAgents.set(record.agent,record);
  const on=(name,fn)=>record.removers.push(record.agent.ctx.on(name,fn,{prepend:true}));
  on('agent/status',({agent,status})=>{if(agent===record.agent&&status==='idle'&&record.revoked)clean(record);});
  on('agent/pre-step',async(payload,next)=>{
   if(payload.agent!==record.agent)return next();
   const context={signal:payload.signal,messages:Array.isArray(payload.messages)?[...payload.messages]:[]};record.claimedContext=context;
   try{await guard(record,payload.signal);const value=await next();await guard(record,payload.signal);return value;}
   catch{if(record.inputRecoveryError)throw Error('goal_input_recovery_unconfirmed');return {kind:'reject'};}
   finally{if(record.claimedContext===context)record.claimedContext=null;}
  });
  on('tools/execute',async(payload,next)=>{await guard(record,payload.signal);return next();});
  // The SDK waterfall returns an AsyncIterable synchronously, not a Promise.
  on('llm/stream',(payload,next)=>{
   if(payload?.sessionId!==record.sessionId)return next();
   return (async function*(){await guard(record,payload.signal);yield* next();})();
  });
 };
 const resumeOne=async record=>{
  const control=await inspect(record);if(control.state!=='queued')throw Error('goal_control_dispatch_unknown');record.ref=Object.freeze({...control.ref});
  try{
   const prepared=await prepareConversationGoalResume({controller,agents,persistence,sessionId:record.sessionId,ref:record.ref,signal:record.signal,ordinaryPresets});live(record);
   record.agent=prepared.agent;install(record);
   return await record.agent.runMaintenance(async nativeSignal=>{
   const signal=AbortSignal.any([record.signal,nativeSignal]);signal.throwIfAborted();prepared.check();live(record);
   // Official follow promotes a prepared Session when advanced past its first
   // snapshot. Its subscriptions already buffer events; release that iterator
   // only after preflight, exact Agent resolution and maintenance admission.
   record.releaseFollow();
   const latest=await inspect(record);if(latest.state!=='queued'||latest.ref.id!==record.ref.id||latest.ref.revision!==record.ref.revision)throw Error('goal_control_dispatch_unknown');
   record.observerBound=true;
   const begun=await request(record,'begin',{cursor:record.cursor},signal);live(record);prepared.check();
   if(begun?.acquired!==true||identity(record,begun.control).state!=='dispatching')throw Error('goal_control_dispatch_unknown');
   // Once invoked, even a synchronous failure could have followed a committed
   // native append. Never attest "not called" after crossing this boundary.
   record.nativeAttempted=true;
   const result=conversationGoal(record.agent,{action:'resume',...record.ref});
   await persistence.flush(record.agent.session);signal.throwIfAborted();live(record);
   let committed;
   try{committed=await request(record,'applied',{receipt:result},signal);}
   catch(error){
    // Only reconcile the original persisted receipt, never repeat native resume.
    const recovered=await inspect(record);if(recovered.state!=='applied'||JSON.stringify(recovered.receipt)!==JSON.stringify(result))throw error;
    committed={control:recovered};
   }
   const stored=identity(record,committed?.control);if(stored.state!=='applied'||JSON.stringify(stored.receipt)!==JSON.stringify(result))throw Error('goal_control_receipt_invalid');
   signal.throwIfAborted();live(record);record.applied=true;return result;
   });
  }catch(error){
   if(!record.nativeAttempted){
    const reason=({goal_revision_changed:'GOAL_REVISION_CHANGED',goal_cold_input_pending:'GOAL_CONTEXT_RECOVERY_REQUIRED',goal_not_resumable:'GOAL_NOT_RESUMABLE'}[error?.message])??'GOAL_RESUME_NOT_APPLIED';
    // Only this original live attempt can attest it never invoked resume. A
    // failed/lost attestation stays queued/unknown; native state is not proof.
    try{await request(record,'rejected',{reason_code:reason});}catch{}
   }
   revoke(record);throw error;
  }
 };
 return {
  async *follow(sessionId,value,requestBody,signal){
   const execution=binding(value);if(disposed||typeof sessionId!=='string'||!ID.test(sessionId)||!signal||observers.has(sessionId))throw Error('goal_observer_conflict');
   if(requestBody?.address?.kind!=='session'||requestBody.address.sessionId!==sessionId)throw Error('goal_control_input_invalid');
   const local=new AbortController();signal=AbortSignal.any([signal,local.signal]);
   let releaseFollow;const followAdmitted=new Promise(resolve=>releaseFollow=resolve);
   const record={sessionId,binding:execution,observerId:randomUUID(),observerBound:false,signal,local,releaseFollow,closed:false,revoked:false,applied:false,nativeAttempted:false,removers:[],cursor:null};observers.set(sessionId,record);
   const abort=()=>{record.closed=true;record.releaseFollow();revoke(record);};signal.addEventListener('abort',abort,{once:true});
   let stream;
   try{
    const control=await inspect(record);if(control.state!=='queued')throw Error('goal_control_dispatch_unknown');
    stream=controller.follow(requestBody,signal)[Symbol.asyncIterator]();const opening=await stream.next();live(record);
    if(opening.done||opening.value?.type!=='snapshot'||!Number.isSafeInteger(opening.value.cursor)||opening.value.cursor<0)throw Error('goal_observer_snapshot_invalid');record.cursor=opening.value.cursor;
    yield opening.value;
    await followAdmitted;if(signal.aborted)return;live(record);
    while(true){const next=await stream.next();if(next.done)break;live(record);yield next.value;}
   }finally{
    record.closed=true;signal.removeEventListener('abort',abort);revoke(record);if(observers.get(sessionId)===record)observers.delete(sessionId);await stream?.return?.();
   }
  },
  async resume(sessionId,value){
   const expected=binding(value),record=observers.get(sessionId);if(!record||!same(record.binding,expected)||record.cursor===null)throw Error('goal_observer_required');live(record);
   // Keep the same promise even if the HTTP acknowledgement is lost. A new
   // follower or Host process cannot reuse this as activation authority.
   record.promise??=resumeOne(record);return await record.promise;
  },
  async dispose(){disposed=true;for(const record of observers.values()){record.closed=true;revoke(record);record.local.abort();}observers.clear();}
 };
}
