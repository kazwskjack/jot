import {nativeGoalsFor} from './workbench-goal.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
function wait(promise,signal){
 signal.throwIfAborted();return new Promise((resolve,reject)=>{const clear=()=>signal.removeEventListener('abort',abort),abort=()=>{clear();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{clear();resolve(value);},error=>{clear();reject(error);});if(signal.aborted)abort();});
}
/** Protect the original lead at the official pre-step boundary. This owns no
 * planner or mailbox: messages remain either native claimed input or Inbox. */
export function createNativeHandoffInboxGate({ctx,bridge,registry,persistence}){
 if(typeof ctx?.effect!=='function'||typeof bridge?.bindingFor!=='function'||typeof registry?.get!=='function'||typeof persistence?.flush!=='function')throw Error('native_handoff_inbox_unavailable');
 const records=new Map(),operations=new Set(),shutdown=new AbortController();let disposed=false,disposal;
 const notify=record=>{for(const ready of record.waiters)ready();record.waiters.clear();};
 const identity=(record,allowRevoked=false)=>{if(disposed||record.revoked&&!allowRevoked||records.get(record.parent)!==record||registry.get(record.parent.id)!==record.parent||bridge.bindingFor(record.parent)!==record.binding||record.parent.session!==record.session)throw Error('native_handoff_inbox_changed');};
 const reauthorize=record=>{
  identity(record,true);if(record.tainted)throw Error('native_handoff_inbox_changed');const goal=nativeGoalsFor(record.parent)?.get?.(record.parent);
  if(goal&&goal.phase!=='active')throw Error('native_handoff_inbox_goal_inactive');
  if(!record.revoked)return;
  record.held?.signal.throwIfAborted();
  if(!record.held&&record.parent.status!=='idle')throw Error('native_handoff_inbox_not_idle');
  // Never move the source cut past an unchecked tail. Cancellation ignores
  // an aborted activity signal for this read-only audit, not the old history.
  audit(record);record.revoked=false;
 };
 const audit=record=>{
  identity(record,true);const invalid=()=>{record.tainted=true;throw Error('native_handoff_inbox_changed');};if(record.tainted||record.parent.session.seq<record.cut)invalid();const starts=new Set(),ends=new Set();let goalRevision=record.goal?.revision;
  for(let seq=record.cut;seq<record.session.seq;seq++){const event=record.session.eventAt(seq);if(event?.seq!==seq)invalid();
   if(event.type==='agent/inbox/spliced')continue;
   if(event.type==='subagent/catalog'&&event.data?.version===0&&event.data.childId===record.target.childSessionRef&&event.data.mode==='continuable')continue;
   if(event.type==='team/member'&&event.data?.version===2&&event.data.teamId===record.parent.id&&event.data.member?.id===record.target.childSessionRef&&['provisioning','active','failed'].includes(event.data.member.phase))continue;
   const turn=event.data?.turn;
   if(event.type==='turn/start'&&record.turns.has(turn)&&!starts.has(turn)){starts.add(turn);continue;}
   if(event.type==='turn/end'&&starts.has(turn)&&record.ended.has(turn)&&!ends.has(turn)&&['aborted','error'].includes(event.data?.reason?.kind)){ends.add(turn);continue;}
   if(event.type==='goal/change'&&record.goal){const data=event.data,goal=data?.goal,phase={pause:'paused',resume:'active',block:'blocked'}[data?.operation];if(data?.kind==='goal/change'&&data.version===1&&phase&&goal?.phase===phase&&goal.id===record.goal.id&&goal.revision===goalRevision+1&&goal.objective===record.goal.objective&&goal.maxGoalRounds===record.goal.maxGoalRounds){goalRevision=goal.revision;continue;}}
   invalid();
  }
 };
 const check=record=>{identity(record);record.held?.signal.throwIfAborted();audit(record);};
 const restore=(record,held)=>{
  if(held.restored)return;if(record.parent.session!==record.session||record.parent.inbox!==record.inbox){record.retained=held.messages;held.restored=true;return;}const queued=new Set([...record.inbox.nextTurn,...record.inbox.nextStep].map(message=>message.id));
  // Goal prompts belong to the official Goal driver, including its stale-round
  // rules. Restore only the original non-Goal identities, never a new prompt.
  for(const message of [...held.messages].reverse()){if(message.source?.kind==='goal'||queued.has(message.id))continue;record.parent.inbox.prepend('next-step',message);queued.add(message.id);}
  held.restored=true;
 };
 const clean=record=>{for(const remove of record.removers.reverse())remove();record.removers.length=0;records.delete(record.parent);notify(record);};
 const scopeRecord=scope=>{const record=records.get(scope?.parent),target=record?.target;if(!record||record.binding!==scope.parentBinding||target.childRunId!==scope.childRunId||target.childSessionRef!==scope.childSessionRef||target.roleRef!==scope.roleRef)throw Error('native_handoff_inbox_scope_changed');return record;};
 const api={
  arm(scope){
   const {parent,parentBinding,childRunId,childSessionRef,roleRef,activeRevision}=scope??{};
   if(disposed||!valid(parent?.id)||parentBinding?.sessionRef!==parent.id||!valid(parentBinding.runId)||!valid(childRunId)||!valid(childSessionRef)||!valid(roleRef)||childSessionRef===parent.id||childRunId===parentBinding.runId||!Number.isSafeInteger(activeRevision)||activeRevision<2
    ||registry.get(parent.id)!==parent||bridge.bindingFor(parent)!==parentBinding||typeof parent.ctx?.on!=='function'||typeof parent.ctx?.tools?.guard!=='function'||typeof parent.runMaintenance!=='function'||typeof parent.inbox?.prepend!=='function')throw Error('native_handoff_inbox_scope_changed');
   const existing=records.get(parent),target=Object.freeze({childRunId,childSessionRef,roleRef,activeRevision});
   if(existing){identity(existing,true);if(existing.busy)throw Error('native_handoff_inbox_busy');if(Object.keys(target).some(key=>target[key]!==existing.target[key]))throw Error('native_handoff_inbox_scope_changed');reauthorize(existing);return;}
   if(parent.status!=='idle')throw Error('native_handoff_inbox_not_idle');
   const goal=nativeGoalsFor(parent)?.get?.(parent),record={parent,binding:parentBinding,session:parent.session,inbox:parent.inbox,cut:parent.session.seq,goal:goal?Object.freeze({...goal}):undefined,turns:new Set(),ended:new Set(),target,removers:[],waiters:new Set(),revoked:false,completed:false,busy:false};records.set(parent,record);
   try{
    record.removers.push(parent.ctx.tools.guard(()=> 'NATIVE_HANDOFF_CONTROL_HELD'));
    record.removers.push(parent.ctx.on('llm/stream',(options,next)=>{if(options?.sessionId===parent.id)throw Error('native_handoff_control_held');return next();},{prepend:true}));
    record.removers.push(parent.ctx.on('agent/status',payload=>{if(payload.agent===parent)notify(record);}));
    record.removers.push(parent.ctx.on('agent/pre-step',async(payload,next)=>{
     if(payload.agent!==parent)return next();
     if(record.held)throw Error('native_handoff_inbox_busy');
     let release,done;const local=new AbortController(),held={turn:payload.turn,cut:record.session.seq,messages:Object.freeze([...payload.messages]),signal:AbortSignal.any([payload.signal,local.signal]),abort:reason=>local.abort(reason),promise:new Promise(resolve=>release=resolve),done:new Promise(resolve=>done=resolve),release:()=>release(),restored:false};record.turns.add(payload.turn);record.held=held;notify(record);
     try{if(record.revoked)identity(record,true);else check(record);await wait(held.promise,AbortSignal.any([held.signal,shutdown.signal]));payload.signal.throwIfAborted();
      if(!record.completed||registry.get(parent.id)!==parent||bridge.bindingFor(parent)!==record.binding||parent.session!==record.session)throw Error('native_handoff_inbox_changed');
     }catch(error){record.revoked=true;record.ended.add(payload.turn);try{audit(record);}catch{}restore(record,held);throw error;}
     finally{record.held=undefined;done();notify(record);}
     return next();
    },{prepend:true}));
   }catch(error){clean(record);throw error;}
  },
  transition(scope,operation){
   const task=(async()=>{
    if(typeof operation!=='function')throw Error('native_handoff_inbox_unavailable');const record=scopeRecord(scope);identity(record);if(record.busy)throw Error('native_handoff_inbox_busy');record.busy=true;const target=record.target;
    const external=scope.signal?AbortSignal.any([scope.signal,shutdown.signal]):shutdown.signal;
    try{
     while(record.parent.status!=='idle'&&!record.held){let ready;const changed=new Promise(resolve=>ready=resolve);record.waiters.add(ready);try{await wait(changed,external);}finally{record.waiters.delete(ready);}identity(record);}
     const execute=async nativeSignal=>{const signal=AbortSignal.any([external,nativeSignal]);
      const guard=()=>{signal.throwIfAborted();check(record);if(record.target!==target||record.held&&record.parent.status!=='running'||!record.held&&record.parent.status!=='idle')throw Error('native_handoff_inbox_changed');};
      guard();await persistence.flush();guard();const result=await operation(undefined,guard,signal);guard();return result;
     };
     return record.held?await execute(record.held.signal):await record.parent.runMaintenance(execute);
    }finally{record.busy=false;}
   })();operations.add(task);task.finally(()=>operations.delete(task)).catch(()=>{});return task;
  },
  complete(scope){
   if(!records.has(scope?.parent))return;
   const record=scopeRecord(scope),state=scope.receipt;identity(record,true);
   if(record.busy||state?.phase!=='returned'||state.revision!==record.target.activeRevision+1||!Array.isArray(state.route)||state.route.length<3||state.route.at(-2)!==record.target.roleRef||state.route.at(-1)!==state.route[0]||state.controller!==state.route[0])throw Error('native_handoff_inbox_receipt_invalid');
   reauthorize(record);check(record);
   record.completed=true;const held=record.held;clean(record);held?.release();
  },
  confirmUntransferred({parent,parentBinding}){
   const record=records.get(parent);if(!record)return;if(record.binding!==parentBinding||record.busy)throw Error('native_handoff_inbox_scope_changed');reauthorize(record);check(record);record.completed=true;const held=record.held;clean(record);held?.release();
  },
  fail(scope){
   const record=scopeRecord(scope);record.revoked=true;record.held?.abort(Error('native_handoff_inbox_blocked'));notify(record);
  },
  statusFor(parent,parentBinding){
   const record=records.get(parent);if(!record)return undefined;if(record.binding!==parentBinding)throw Error('native_handoff_inbox_scope_changed');let changed=false;try{identity(record,true);}catch{changed=true;}
   return Object.freeze({state:record.revoked||changed?'blocked':record.held?'held':'armed',...record.target,...(record.retained?{retained_input_count:record.retained.length}:{})});
  },
  dispose(){
   if(disposal)return disposal;disposed=true;shutdown.abort(Error('native_handoff_inbox_disposed'));
   const held=[...records.values()].flatMap(record=>record.held?[record.held.done]:[]);
   return disposal=(async()=>{await Promise.allSettled([...operations,...held]);for(const record of records.values())clean(record);})();
  }
 };
 ctx.effect(()=>()=>api.dispose());return api;
}
