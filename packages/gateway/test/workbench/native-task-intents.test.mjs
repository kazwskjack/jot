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

import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';
test('durable intent enumeration survives reopening, pages deterministically and never allocates execution',async t=>{
 const f=await setup(t);const plan=f.intents.prepare('alice',f.runId,f.input);
 const second=f.intents.prepare('alice',f.runId,{...f.input,request_id:'call-2'});
 const runs=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 const reopened=new NativeTaskIntents(f.db,f.workbench,f.persistentTasks,f.collaboration);
 const first=reopened.list('alice',f.runId,{limit:1});
 assert.equal(first.items.length,1);assert.deepEqual(first.items[0],{plan,state:'pending',execution_authorized:false});assert.equal(first.next_request_id,plan.request_id);
 const next=reopened.list('alice',f.runId,{limit:1,after_request_id:first.next_request_id});
 assert.deepEqual(next.items,[{plan:second,state:'pending',execution_authorized:false}]);assert.equal(next.next_request_id,null);
 const service=new NativeChildReservations(f.db,f.collaboration,f.intents);service.reserve(reservationInput(f));
 const page=reopened.list('alice',f.runId,{limit:1});assert.equal(page.items[0].state,'reserved');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,runs);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_delegations').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_task_intents').get().n,2);
});
test('intent enumeration refuses foreign scope, stale assignment and revoked policy',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 assert.throws(()=>f.intents.list('bob',f.runId,{}));
 assert.throws(()=>f.intents.list('alice',f.runId,{limit:0}),/native_task_intent_invalid/);
 assert.throws(()=>f.intents.list('alice',f.runId,{after_request_id:'unknown'}),/native_task_intent_invalid/);
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:f.step.subtask_id,expected_version:f.step.version,title:'Revised work'},f.runId);
 assert.throws(()=>f.intents.list('alice',f.runId,{}),/task_assignment_revoked/);
 f.collaboration.save('alice',f.task.task_id,{expected_version:f.policy.version,enabled:false});
 assert.throws(()=>f.intents.list('alice',f.runId,{}),/task_collaboration_revoked/);
});
test('intent enumeration HTTP endpoint requires original lease, Session and authentication',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 const url='/internal/v1/workbench/native-task-intents',headers={authorization:'Bearer '+f.fixtureConfig.internalChannelToken};
 const payload={run_id:f.runId,session_ref:'session-fixture',execution_lease:{owner:f.lease.owner,generation:f.lease.generation},limit:1};
 assert.equal((await f.app.inject({method:'POST',url,payload})).statusCode,401);
 const ok=await f.app.inject({method:'POST',url,headers,payload});assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().items[0].plan.request_id,f.input.request_id);
 for(const patch of [{session_ref:'foreign-session'},{execution_lease:{owner:'foreign',generation:1}},{limit:51},{owner_id:'bob'}])assert.notEqual((await f.app.inject({method:'POST',url,headers,payload:{...payload,...patch}})).statusCode,200);
 f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run(f.runId);
 assert.notEqual((await f.app.inject({method:'POST',url,headers,payload})).statusCode,200);
});
function reservationInput(f){return {run_id:f.runId,session_ref:'session-fixture',child_session_ref:'native-assignee',role_ref:f.member.agent_id,request_id:f.input.request_id,expected_policy_version:f.policy.version,execution_lease:{owner:f.lease.owner,generation:f.lease.generation}};}
test('reservation assigns a planned step atomically and child guards retain the exact assignment',async t=>{
 const f=await setup(t);const plan=f.intents.prepare('alice',f.runId,f.input);
 const reservations=new NativeChildReservations(f.db,f.collaboration,f.intents),request=reservationInput(f),reserved=reservations.reserve(request);
 assert.equal(reserved.task_assignment.subtask_id,f.step.subtask_id);
 assert.equal(reserved.task_assignment.subtask_version,f.step.version+1);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'running');
 assert.deepEqual(reservations.reserve(request),reserved);
 assert.deepEqual(f.intents.prepare('alice',f.runId,f.input),plan);
 const child=f.workbench.prepareNativeChild('alice',reserved.reservation_id);
 assert.equal(f.workbench.contextForRun(child.run_id).task_assignment.subtask_id,f.step.subtask_id);
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:f.step.subtask_id,expected_version:reserved.task_assignment.subtask_version,status:'blocked'},f.runId);
 assert.throws(()=>f.workbench.contextForRun(child.run_id),/task_assignment_revoked/);
 const denied=await f.app.inject({method:'POST',url:'/internal/v1/workbench/model-budget',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{run_id:child.run_id,session_ref:child.session_ref,execution_lease:request.execution_lease,action:'reserve',request:{attempt_id:'revoked-call',provider:'fixture',model:'bounded'}}});
 assert.equal(denied.statusCode,409,denied.body);assert.equal(denied.json().error.code,'TASK_ASSIGNMENT_REVOKED');
});
test('changed planned step refuses reservation without consuming a member slot or creating a run',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:f.step.subtask_id,expected_version:f.step.version,title:'Different work'},f.runId);
 const count=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 assert.throws(()=>new NativeChildReservations(f.db,f.collaboration,f.intents).reserve(reservationInput(f)),/task_assignment_revoked/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,count);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'pending');
});
test('failed reservation persistence rolls back the step transition and cannot orphan an assignment',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);const service=new NativeChildReservations(f.db,f.collaboration,f.intents);
 f.db.exec("CREATE TRIGGER inject_reservation_failure BEFORE INSERT ON wb_native_child_reservations BEGIN SELECT RAISE(ABORT,'synthetic_write_failure'); END;");
 assert.throws(()=>service.reserve(reservationInput(f)),/synthetic_write_failure/);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].version,f.step.version);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'pending');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,0);
});

import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
test('member execution receipt belongs to the original occurrence without granting parent ledger access',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);const reservation=new NativeChildReservations(f.db,f.collaboration,f.intents).reserve(reservationInput(f));
 const child=f.workbench.prepareNativeChild('alice',reservation.reservation_id),headers={authorization:'Bearer '+f.fixtureConfig.internalChannelToken};
 const payload={run_id:child.run_id,session_ref:child.session_ref,execution_lease:reservationInput(f).execution_lease,call_id:'write-material',operation:'files.write',arguments:{path:'material.txt',content:'Synthetic source materials',expected_version:0}};
 const response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers,payload});
 assert.equal(response.statusCode,200,response.body);const proof=response.json().execution_receipt;
 assert.ok(proof?.reference,'actual member file execution must have a receipt');
 const evidence=new TaskExecutionEvidence(f.db);
 assert.equal(evidence.verified('alice',f.task.task_id,proof,f.occurrence.occurrence_id),true);
 assert.equal(evidence.verified('bob',f.task.task_id,proof,f.occurrence.occurrence_id),false);
 assert.equal(evidence.verified('alice',f.task.task_id,proof,'other-occurrence'),false);
 assert.equal(evidence.verified('alice',f.task.task_id,{...proof,hash:'0'.repeat(64)},f.occurrence.occurrence_id),false);
 const replay=await f.app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers,payload});assert.deepEqual(replay.json(),response.json());
 const forbidden=await f.app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers,payload:{...payload,call_id:'forged-parent-update',operation:'tasks.upsert',arguments:{subtask_id:f.step.subtask_id,expected_version:reservation.task_assignment.subtask_version,status:'completed',evidence:[proof]}}});
 assert.notEqual(forbidden.statusCode,200);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'running');
});

test('planned reservations cannot bypass the assignment service or unverified prerequisites',async t=>{
 const f=await setup(t);f.intents.prepare('alice',f.runId,f.input);
 assert.throws(()=>new NativeChildReservations(f.db,f.collaboration).reserve(reservationInput(f)),/native_assignment_service_unavailable/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,0);
 const dep=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Prerequisite',acceptance:'Verified source'},f.runId);
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:f.step.subtask_id,expected_version:f.step.version,dependencies:[dep.subtask_id]},f.runId);
 const input={...f.input,request_id:'new-plan',expected_subtask_version:step.version};f.intents.prepare('alice',f.runId,input);
 assert.throws(()=>new NativeChildReservations(f.db,f.collaboration,f.intents).reserve({...reservationInput(f),request_id:input.request_id}),/dependency_not_completed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,0);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items.find(s=>s.subtask_id===step.subtask_id).status,'pending');
});
test('generic native role receipts without a bound task assignment are not parent evidence',async t=>{
 const f=await setup(t),reserved=new NativeChildReservations(f.db,f.collaboration).reserve({...reservationInput(f),request_id:'generic-role'});
 const child=f.workbench.prepareNativeChild('alice',reserved.reservation_id),evidence=new TaskExecutionEvidence(f.db);
 const proof=evidence.record(child.run_id,'generic-list','files.list',{items:[]});
 assert.equal(evidence.verified('alice',f.task.task_id,proof,f.occurrence.occurrence_id),false);
});
