import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeTaskDispatcher} from '../native-task-dispatch.js';
function fixture(){
 const agent={id:'parent'},binding=Object.freeze({runId:'root',sessionRef:'parent',executionLease:{owner:'worker',generation:1}}),calls=[];let current=binding,mutate;
 const bridge={bindingFor:()=>current,guardBudget:async()=>calls.push('guard'),request:async(path,b,args)=>{
  assert.equal(b,binding);assert.equal(path,'native-task-intent');calls.push('plan');
  const plan={protocol:1,request_id:args.request_id,role_ref:args.recipient_agent_id,expected_policy_version:2,subtask_id:args.subtask_id,expected_subtask_version:args.expected_subtask_version,name:'Reviewer',description:'Inspect sources',text:'Return materials to lead',execution_authorized:false};
  return {plan:mutate?mutate(plan):plan};
 }};
 const host={spawn:async(a,intent,request)=>{assert.equal(a,agent);calls.push({intent,request});return {member:{id:'child'}};}};
 return {agent,binding,calls,bridge,host,args:{subtask_id:'step',expected_subtask_version:1,recipient_agent_id:'role'},changeBinding:()=>current={...binding},mutatePlan:fn=>mutate=fn};
}

test('deferred dispatch returns only the stored pending receipt without invoking immediate spawn',async()=>{
 const f=fixture(),scheduler={submit:async(a,b,plan,signal)=>{assert.equal(a,f.agent);assert.equal(b,f.binding);assert.equal(plan.execution_authorized,false);return {runtime:'native_team',state:'pending',request_id:plan.request_id,execution_authorized:false};}};
 const result=await createNativeTaskDispatcher({...f,scheduler})(f.agent,f.binding,'call',f.args,new AbortController().signal);assert.equal(result.state,'pending');assert.equal(f.calls.some(x=>typeof x==='object'),false);
});
test('native dispatcher carries only server-frozen intent to original Host and stable call identity',async()=>{
 const f=fixture(),dispatch=createNativeTaskDispatcher(f);const result=await dispatch(f.agent,f.binding,'call-1',f.args,new AbortController().signal);
 assert.equal(result.runtime,'native_team');assert.equal(result.subtask_id,'step');assert.equal(result.member.id,'child');
 const spawn=f.calls.find(x=>typeof x==='object');assert.equal(spawn.request.context,'fresh');assert.equal(spawn.request.prompt[0].text,'Return materials to lead');
 const other=fixture();await createNativeTaskDispatcher(other)(other.agent,other.binding,'call-1',other.args);
 assert.equal(spawn.intent.requestId,other.calls.find(x=>typeof x==='object').intent.requestId);
});
test('malformed or changed trusted plan cannot cause native publication',async()=>{
 for(const fn of [p=>({...p,role_ref:'other'}),p=>({...p,subtask_id:'other'}),p=>({...p,execution_authorized:true}),p=>({...p,expected_subtask_version:2})]){
  const f=fixture();f.mutatePlan(fn);await assert.rejects(createNativeTaskDispatcher(f)(f.agent,f.binding,'call-1',f.args),/native_task_plan_invalid/);
  assert.equal(f.calls.some(x=>typeof x==='object'),false);
 }
});
test('changed parent binding and cancellation reject before creating a native member',async()=>{
 const f=fixture();f.changeBinding();await assert.rejects(createNativeTaskDispatcher(f)(f.agent,f.binding,'call-1',f.args),/workbench_binding_changed/);assert.deepEqual(f.calls,[]);
 const other=fixture(),cancel=new AbortController();cancel.abort();await assert.rejects(createNativeTaskDispatcher(other)(other.agent,other.binding,'call-1',other.args,cancel.signal));assert.deepEqual(other.calls,[]);
});

test('human role names become stable lower-kebab native handles without changing role identity',async()=>{
 const f=fixture();f.mutatePlan(p=>({...p,name:'搜索助手 角色一'}));
 await createNativeTaskDispatcher(f)(f.agent,f.binding,'call-1',f.args);
 const spawn=f.calls.find(x=>typeof x==='object');assert.match(spawn.request.name,/^[a-z][a-z0-9-]{0,63}$/);assert.notEqual(spawn.request.name,'lead');assert.equal(spawn.intent.roleRef,'role');
 const other=fixture();await createNativeTaskDispatcher(other)(other.agent,other.binding,'call-2',other.args);
 assert.notEqual(spawn.request.name,other.calls.find(x=>typeof x==='object').request.name);
});
