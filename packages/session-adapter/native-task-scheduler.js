import {createHash} from 'node:crypto';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Trusted host only: wake existing durable intents after the original lead turn.
 * No new planner, legacy fallback or automatic replay of uncertain reservations. */
export function createNativeTaskScheduler({ctx,bridge,host}){
 if(typeof ctx?.on!=='function'||typeof ctx.agents?.get!=='function'||typeof bridge?.bindingFor!=='function'||typeof bridge.guardBudget!=='function'||typeof bridge.request!=='function'||typeof host?.spawn!=='function')throw Error('native_task_scheduler_unavailable');
 const queues=new Map(),active=new Map(),restoring=new Map(),shutdown=new AbortController();let disposed=false;
 const report=(agent,entry)=>{try{ctx.emit?.('jot-native-task-scheduler/result',{agent,request_id:entry.plan.request_id,state:entry.state,...(entry.member?{member:structuredClone(entry.member)}:{})});}catch{/* Observers cannot change an execution receipt. */}};
 const check=(agent,entry)=>{entry.signal.throwIfAborted();if(disposed)throw Error('native_task_scheduler_disposed');if(ctx.agents.get(agent.id)!==agent||bridge.bindingFor(agent)!==entry.binding)throw Error('workbench_binding_changed');};
 const read=async(agent,entry)=>{
  let cursor;const seen=new Set();
  do{check(agent,entry);const page=await bridge.request('native-task-intents',entry.binding,{limit:50,...(cursor?{after_request_id:cursor}:{})},entry.signal);check(agent,entry);
   if(!Array.isArray(page?.items)||page.items.length>50)throw Error('native_task_schedule_invalid');
   const row=page.items.find(item=>item?.plan?.request_id===entry.plan.request_id);
   if(row){if(row.execution_authorized!==false||row.state!=='pending'||canonical(row.plan)!==entry.hash)throw Error('native_task_schedule_reconciliation_required');return;}
   cursor=page.next_request_id;if(cursor!==null&&(typeof cursor!=='string'||!ID.test(cursor)||seen.has(cursor)))throw Error('native_task_schedule_invalid');seen.add(cursor);
  }while(cursor!==null);
  throw Error('native_task_schedule_missing');
 };
 const kick=agent=>{
  if(disposed||active.has(agent)||restoring.has(agent))return;
  const operation=(async()=>{await new Promise(done=>setImmediate(done));if(disposed||agent.status!=='idle')return;
   for(const entry of queues.get(agent)?.values()??[]){if(entry.state!=='pending')continue;
    try{check(agent,entry);await bridge.guardBudget(agent,entry.signal);check(agent,entry);await read(agent,entry);if(agent.status!=='idle')return;
     const plan=entry.plan,result=await host.spawn(agent,{roleRef:plan.role_ref,policyVersion:plan.expected_policy_version,requestId:plan.request_id},
       {name:'role-'+createHash('sha256').update(JSON.stringify([plan.role_ref,plan.request_id])).digest('hex').slice(0,20),description:plan.description,prompt:[{type:'text',text:plan.text}],context:'fresh',signal:entry.signal});
     check(agent,entry);if(typeof result?.member?.id!=='string'||!ID.test(result.member.id))throw Error('native_role_publication_invalid');entry.state='published';entry.member=structuredClone(result.member);report(agent,entry);return;
    }catch{entry.state=entry.signal.aborted?'cancelled':'blocked';report(agent,entry);return;}
   }
  })();active.set(agent,operation);operation.finally(()=>active.delete(agent)).catch(()=>{});
 };
 const remove=ctx.on('agent/status',({agent,status})=>{if(status==='idle'&&queues.has(agent))kick(agent);});
 return {
  async restore(agent,binding,signal){
   if(disposed)throw Error('native_task_scheduler_disposed');if(active.has(agent)||restoring.has(agent))throw Error('native_task_schedule_recovery_busy');
   const ownedSignal=signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal,scope={binding,signal:ownedSignal};check(agent,scope);
   const goal=ctx.goals?.get?.(agent);if(goal&&goal.phase!=='active')return {state:'inactive',items:[]};
   let success=false;
   const operation=(async()=>{
    await bridge.guardBudget(agent,ownedSignal);check(agent,scope);let cursor;const cursors=new Set(),staged=new Map();
    do{const page=await bridge.request('native-task-intents',binding,{limit:50,...(cursor?{after_request_id:cursor}:{})},ownedSignal);check(agent,scope);
     if(!Array.isArray(page?.items)||page.items.length>50)throw Error('native_task_schedule_invalid');
     for(const row of page.items){const plan=row?.plan;
      if(!plan||plan.protocol!==1||plan.execution_authorized!==false||row.execution_authorized!==false||!['pending','reserved'].includes(row.state)
       ||[plan.request_id,plan.role_ref,plan.subtask_id].some(id=>typeof id!=='string'||!ID.test(id))
       ||!Number.isSafeInteger(plan.expected_policy_version)||plan.expected_policy_version<1||!Number.isSafeInteger(plan.expected_subtask_version)||plan.expected_subtask_version<1
       ||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>80||typeof plan.description!=='string'||!plan.description.trim()||plan.description.length>2000
       ||typeof plan.text!=='string'||!plan.text.trim()||plan.text.length>32000||staged.has(plan.request_id))throw Error('native_task_schedule_invalid');
      const snapshot=JSON.parse(canonical(plan)),hash=canonical(snapshot),prior=queues.get(agent)?.get(plan.request_id);
      if(prior&&(prior.binding!==binding||prior.hash!==hash))throw Error('idempotency_conflict');
      let state='pending',member;
      if(row.state==='reserved'){
       const intent={roleRef:plan.role_ref,policyVersion:plan.expected_policy_version,requestId:plan.request_id},request={name:'role-'+createHash('sha256').update(JSON.stringify([plan.role_ref,plan.request_id])).digest('hex').slice(0,20),description:plan.description,prompt:[{type:'text',text:plan.text}],context:'fresh'};
       const spawnHash=createHash('sha256').update(canonical({intent,request})).digest('hex');
       const receipt=await bridge.request('native-child-request',binding,{request_id:plan.request_id,spawn_request_hash:spawnHash},ownedSignal);check(agent,scope);
       const saved=receipt?.reservation;if(!saved||saved.execution_authorized!==false||saved.role_ref!==plan.role_ref||typeof saved.child_session_ref!=='string'||!ID.test(saved.child_session_ref))throw Error('native_task_schedule_reconciliation_required');
       if(saved.publication!==undefined){if(saved.publication?.member?.id!==saved.child_session_ref)throw Error('native_task_schedule_reconciliation_required');state='published';member=structuredClone(saved.publication.member);}else state='blocked';
      }
      staged.set(plan.request_id,prior&&prior.state!=='pending'?prior:{binding,plan:snapshot,hash,state,signal:ownedSignal,...(member?{member}:{})});
     }
     cursor=page.next_request_id;if(cursor!==null&&(typeof cursor!=='string'||!ID.test(cursor)||cursors.has(cursor)))throw Error('native_task_schedule_invalid');cursors.add(cursor);
    }while(cursor!==null);
    check(agent,scope);const freshGoal=ctx.goals?.get?.(agent);if(freshGoal&&freshGoal.phase!=='active')throw Error('workbench_goal_stopped');
    let queue=queues.get(agent);for(const [id,entry] of staged){const live=queue?.get(id);if(live&&(live.binding!==binding||live.hash!==entry.hash))throw Error('idempotency_conflict');if(live&&(live.state!=='pending'||live.signal.aborted))staged.set(id,live);}
    if(!queue)queues.set(agent,queue=new Map());for(const [id,entry] of staged)queue.set(id,entry);success=true;
    return {state:'restored',items:[...staged.values()].map(entry=>({request_id:entry.plan.request_id,state:entry.state}))};
   })();restoring.set(agent,operation);
   try{return await operation;}finally{restoring.delete(agent);if(success)kick(agent);}
  },
  async submit(agent,binding,plan,signal){
   if(disposed)throw Error('native_task_scheduler_disposed');signal?.throwIfAborted();
   if(ctx.agents.get(agent?.id)!==agent||bridge.bindingFor(agent)!==binding||binding?.sessionRef!==agent.id)throw Error('workbench_binding_changed');
   if(!plan||plan.protocol!==1||plan.execution_authorized!==false||!ID.test(plan.request_id)||!ID.test(plan.role_ref)||!Number.isSafeInteger(plan.expected_policy_version)||plan.expected_policy_version<1)throw Error('native_task_plan_invalid');
   const snapshot=JSON.parse(canonical(plan)),hash=canonical(snapshot);let queue=queues.get(agent);if(!queue)queues.set(agent,queue=new Map());const prior=queue.get(plan.request_id);
   if(prior&&(prior.binding!==binding||prior.hash!==hash))throw Error('idempotency_conflict');
   if(!prior)queue.set(plan.request_id,{binding,plan:snapshot,hash,state:'pending',signal:signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal});
   kick(agent);return {runtime:'native_team',state:prior?.state??'pending',request_id:plan.request_id,subtask_id:plan.subtask_id,execution_authorized:false};
  },
  result(agent,requestId){const entry=queues.get(agent)?.get(requestId);return entry?{state:entry.state,request_id:requestId,...(entry.member?{member:structuredClone(entry.member)}:{})}:undefined;},
  async flush(){while(active.size)await Promise.allSettled([...active.values()]);},
  async dispose(){if(!disposed){disposed=true;shutdown.abort();remove();}await Promise.allSettled([...restoring.values()]);while(active.size)await Promise.allSettled([...active.values()]);queues.clear();}
 };
}
