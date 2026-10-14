import {createHash} from 'node:crypto';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Trusted host only: wake existing durable intents after the original lead turn.
 * No new planner, legacy fallback or automatic replay of uncertain reservations. */
export function createNativeTaskScheduler({ctx,bridge,host}){
 if(typeof ctx?.on!=='function'||typeof ctx.agents?.get!=='function'||typeof bridge?.bindingFor!=='function'||typeof bridge.guardBudget!=='function'||typeof bridge.request!=='function'||typeof host?.spawn!=='function')throw Error('native_task_scheduler_unavailable');
 const queues=new Map(),active=new Map(),shutdown=new AbortController();let disposed=false;
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
  if(disposed||active.has(agent))return;
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
  async dispose(){if(!disposed){disposed=true;shutdown.abort();remove();}while(active.size)await Promise.allSettled([...active.values()]);queues.clear();}
 };
}
