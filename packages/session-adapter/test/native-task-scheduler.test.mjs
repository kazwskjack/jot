import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeTaskScheduler} from '../native-task-scheduler.js';
function fixture(){const hooks=new Map(),binding=Object.freeze({runId:'run',sessionRef:'lead'}),agent={id:'lead',status:'running'},rows=[],spawned=[];let current=binding;
 const plan={protocol:1,request_id:'request',role_ref:'reviewer',expected_policy_version:1,subtask_id:'step',expected_subtask_version:1,name:'Reviewer',description:'Review sources',text:'Read the sources',execution_authorized:false};
 rows.push({plan,state:'pending',execution_authorized:false});const ctx={agents:{get:()=>agent},on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);}};
 const bridge={bindingFor:()=>current,guardBudget:async()=>{},request:async(path,b)=>{assert.equal(path,'native-task-intents');assert.equal(b,binding);return {items:structuredClone(rows),next_request_id:null};}};
 const host={spawn:async(a,intent,request)=>{spawned.push({a,intent,request});rows[0].state='reserved';return {member:{id:'member'}};}};
 return {ctx,bridge,host,agent,binding,plan,rows,spawned,hooks,replaceBinding:()=>current={...binding}};
}
test('busy native lead returns a durable pending receipt and dispatches only on actual idle event',async()=>{
 const f=fixture(),scheduler=createNativeTaskScheduler(f),signal=new AbortController().signal;
 const queued=await scheduler.submit(f.agent,f.binding,f.plan,signal);assert.equal(queued.state,'pending');assert.equal(queued.execution_authorized,false);
 await scheduler.flush();assert.equal(f.spawned.length,0);f.agent.status='idle';f.hooks.get('agent/status')({agent:f.agent,status:'idle'});await scheduler.flush();
 assert.equal(f.spawned.length,1);assert.equal(f.spawned[0].intent.requestId,f.plan.request_id);assert.equal(f.spawned[0].request.prompt[0].text,f.plan.text);assert.equal(scheduler.result(f.agent,'request').member.id,'member');await scheduler.dispose();assert.equal(f.hooks.size,0);
});
test('duplicate queue submissions share original identity and cancellation cannot launch a member',async()=>{
 const f=fixture(),scheduler=createNativeTaskScheduler(f),abort=new AbortController();await scheduler.submit(f.agent,f.binding,f.plan,abort.signal);await scheduler.submit(f.agent,f.binding,{...f.plan},abort.signal);
 await assert.rejects(scheduler.submit(f.agent,f.binding,{...f.plan,text:'Different task'},abort.signal),/idempotency_conflict/);
 abort.abort();f.agent.status='idle';f.hooks.get('agent/status')({agent:f.agent,status:'idle'});await scheduler.flush();assert.equal(f.spawned.length,0);await scheduler.dispose();
});
test('changed durable plan, original binding or prior reservation never recreates an execution',async()=>{
 for(const change of [f=>f.rows[0].plan.text='Changed',f=>f.replaceBinding(),f=>f.rows[0].state='reserved']){
  const f=fixture(),scheduler=createNativeTaskScheduler(f);await scheduler.submit(f.agent,f.binding,f.plan,new AbortController().signal);change(f);f.agent.status='idle';f.hooks.get('agent/status')({agent:f.agent,status:'idle'});await scheduler.flush();assert.equal(f.spawned.length,0);assert.equal(scheduler.result(f.agent,'request').state,'blocked');await scheduler.dispose();
 }
});
test('scheduler disposal drains active work and never launches queued work afterwards',async()=>{
 const f=fixture(),scheduler=createNativeTaskScheduler(f);await scheduler.submit(f.agent,f.binding,f.plan,new AbortController().signal);await scheduler.dispose();f.agent.status='idle';assert.equal(f.hooks.has('agent/status'),false);assert.equal(f.spawned.length,0);await assert.rejects(scheduler.submit(f.agent,f.binding,f.plan,new AbortController().signal),/native_task_scheduler_disposed/);
});

test('paged lookup finds only the exact pending intent and rejects revoked authority',async()=>{
 const f=fixture(),scheduler=createNativeTaskScheduler(f);let pages=0;
 f.bridge.request=async(_path,_binding,input)=>{pages++;return input.after_request_id?{items:structuredClone(f.rows),next_request_id:null}:{items:[],next_request_id:'earlier-request'};};
 await scheduler.submit(f.agent,f.binding,f.plan,new AbortController().signal);f.agent.status='idle';f.hooks.get('agent/status')({agent:f.agent,status:'idle'});await scheduler.flush();assert.equal(pages,2);assert.equal(f.spawned.length,1);await scheduler.dispose();
 const g=fixture(),other=createNativeTaskScheduler(g);g.bridge.guardBudget=async()=>{throw Error('revoked');};await other.submit(g.agent,g.binding,g.plan,new AbortController().signal);g.agent.status='idle';g.hooks.get('agent/status')({agent:g.agent,status:'idle'});await other.flush();assert.equal(g.spawned.length,0);assert.equal(other.result(g.agent,'request').state,'blocked');await other.dispose();
});

test('dispose cancels and awaits an active original spawn rather than dropping its promise',async()=>{
 const f=fixture(),scheduler=createNativeTaskScheduler(f);let started,finished=false;const ready=new Promise(done=>started=done);
 f.host.spawn=async(_agent,_intent,request)=>{started();await new Promise(done=>request.signal.addEventListener('abort',done,{once:true}));finished=true;request.signal.throwIfAborted();};
 await scheduler.submit(f.agent,f.binding,f.plan,new AbortController().signal);f.agent.status='idle';f.hooks.get('agent/status')({agent:f.agent,status:'idle'});await ready;await scheduler.dispose();assert.equal(finished,true);assert.equal(f.hooks.size,0);
});
