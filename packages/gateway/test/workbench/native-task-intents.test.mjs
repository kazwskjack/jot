import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';
import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
import {NativeTaskIntents} from '../../src/workbench/native-task-intents.ts';
async function setup(t){
 const f=await fixture(t),member=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:f.a.project_id});
 const team=f.workbench.createTeam('alice',{name:'Team',workspace_id:'ws',project_id:f.a.project_id,member_ids:[f.a.agent_id,member.agent_id]});
 const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));
 const policy=collaboration.save('alice',f.task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:2,max_active:1});
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Inspect sources',acceptance:'Return source links and limitations'},f.runId);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.runId);
 f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at').run(f.runId,f.lease.owner,f.lease.generation,String(Date.now()+60000),'now');
 const input={request_id:'call-1',subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id};
 return {...f,member,collaboration,step,input,policy,intents:new NativeTaskIntents(f.db,f.workbench,f.persistentTasks,collaboration)};
}
test('native task intent freezes authorized assignment without enqueuing mailbox or executing a step',async t=>{
 const f=await setup(t),runs=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 const plan=f.intents.prepare('alice',f.runId,f.input);
 assert.equal(plan.role_ref,f.member.agent_id);assert.equal(plan.expected_policy_version,f.policy.version);
 assert.equal(plan.subtask_id,f.step.subtask_id);assert.equal(plan.execution_authorized,false);
 assert.match(plan.text,/Inspect sources/);assert.match(plan.text,/Return source links/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,runs);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_delegations').get().n,0);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'pending');
 assert.deepEqual(f.intents.prepare('alice',f.runId,f.input),plan);
 assert.deepEqual(new NativeTaskIntents(f.db,f.workbench,f.persistentTasks,f.collaboration).prepare('alice',f.runId,f.input),plan);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_task_intents').get().n,1);
});
test('changed request arguments, stale steps and foreign identity never allocate another intent',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 assert.throws(()=>f.intents.prepare('alice',f.runId,{...f.input,expected_subtask_version:2}),/idempotency_conflict/);
 assert.throws(()=>f.intents.prepare('bob',f.runId,f.input));
 assert.throws(()=>f.intents.prepare('alice',f.runId,{...f.input,owner_id:'bob'}),/native_task_intent_invalid/);
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:f.step.subtask_id,expected_version:f.step.version,title:'Changed source task'},f.runId);
 assert.throws(()=>f.intents.prepare('alice',f.runId,f.input),/task_assignment_revoked/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_task_intents').get().n,1);
});
test('current policy revocation rejects replay as well as new planning',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 f.collaboration.save('alice',f.task.task_id,{expected_version:f.policy.version,enabled:false});
 assert.throws(()=>f.intents.prepare('alice',f.runId,f.input),/task_collaboration_revoked/);
 assert.throws(()=>f.intents.prepare('alice',f.runId,{...f.input,request_id:'next'}));
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_task_intents').get().n,1);
});
test('immutable intent journal cannot be rewritten or removed',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 assert.throws(()=>f.db.exec("UPDATE wb_native_task_intents SET input_hash='changed'"),/native_task_intent_immutable/);
 assert.throws(()=>f.db.exec('DELETE FROM wb_native_task_intents'),/native_task_intent_immutable/);
});

test('planning endpoint authenticates before allocation and binds the original worker fence',async t=>{
 const f=await setup(t),url='/internal/v1/workbench/native-task-intent';
 const payload={...f.input,run_id:f.runId,session_ref:'session-fixture',execution_lease:{owner:f.lease.owner,generation:f.lease.generation}};
 assert.equal((await f.app.inject({method:'POST',url,payload})).statusCode,401);
 const headers={authorization:'Bearer '+f.fixtureConfig.internalChannelToken};
 const wrong=await f.app.inject({method:'POST',url,headers,payload:{...payload,execution_lease:{owner:'foreign',generation:999}}});
 assert.notEqual(wrong.statusCode,200);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_task_intents').get().n,0);
 const response=await f.app.inject({method:'POST',url,headers,payload});
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().plan.execution_authorized,false);
 assert.deepEqual((await f.app.inject({method:'POST',url,headers,payload})).json(),response.json());
 f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run(f.runId);
 assert.notEqual((await f.app.inject({method:'POST',url,headers,payload})).statusCode,200);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_task_intents').get().n,1);
});
