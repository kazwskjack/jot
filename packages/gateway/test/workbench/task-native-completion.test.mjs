import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {currentTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';
import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';
import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';
import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

const proof=(session,parent='session-fixture')=>({protocol:1,session_ref:session,parent_session_ref:parent,seq_exclusive:10,turn_end_seq:9,log_sha256:'a'.repeat(64),driver_nonresident:true,inbox_pending:0});
function native(f,mode='closed'){
 const parentSession=f.identity?.session_ref??'session-fixture';
 const context=f.workbench.contextForRun(f.runId),role=f.workbench.createAgent('alice',{name:'Native reviewer',workspace_id:'ws',project_id:context.project_id});
 const team=f.workbench.createTeam('alice',{name:'Native review',workspace_id:'ws',project_id:context.project_id,member_ids:[context.agent_id,role.agent_id]});
 const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));
 collaboration.save('alice',f.task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[role.agent_id],max_delegations:2,max_active:1});
 const lease=f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(f.runId),reservation=new NativeChildReservations(f.db,collaboration).reserve({run_id:f.runId,session_ref:parentSession,child_session_ref:'native-review-'+f.runId,role_ref:role.agent_id,request_id:'native-review',expected_policy_version:1,execution_lease:lease});
 if(mode==='reserved')return {reservation};
 const child=f.workbench.prepareNativeChild('alice',reservation.reservation_id);
 if(mode==='prepared')return {reservation,child};
 const spend=(run,id)=>{f.modelBudgets.reserve('alice',run,{attempt_id:id,provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',run,id);f.modelBudgets.settle('alice',run,id,{inputTokens:5,outputTokens:5,totalTokens:10});};
 spend(child.run_id,'native-spent');f.workbench.closeNativeChild('alice',child.run_id,proof(child.session_ref,parentSession));
 if(mode==='closed')return {reservation,child};
 const activation=f.workbench.prepareNativeActivation('alice',{run_id:f.runId,session_ref:parentSession,child_session_ref:child.session_ref,previous_run_id:child.run_id,previous_log_sha256:proof(child.session_ref).log_sha256,previous_seq_exclusive:10,execution_lease:lease});
 if(mode==='reactivated-closed'){spend(activation.run_id,'activation-spent');f.workbench.closeNativeChild('alice',activation.run_id,proof(activation.session_ref,parentSession));}
 return {reservation,child,activation};
}

test('a native reservation with no child publication prevents root completion',async t=>{
 let observed;await assert.rejects(completionFixture(t,{prepare:f=>{observed=f;native(f,'reserved');}}),/task_auxiliary_pending/);
 for(const table of ['wb_task_completion_candidates','ga_interactions','wb_task_business_certificates'])assert.equal(observed.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 assert.equal(observed.runs.get(observed.runId,'alice').status,'running');assert.ok(observed.db.prepare('SELECT 1 FROM ga_worker_leases WHERE resource_id=?').get(observed.runId));
});

test('a closed original child cannot hide an unclosed activation when the root completes',async t=>{
 await assert.rejects(completionFixture(t,{prepare:f=>native(f,'reactivated')}),/task_auxiliary_pending/);
});

test('closed native child and activation costs are frozen exactly once in the same owner review',async t=>{
 let runs;const f=await completionFixture(t,{prepare:f=>runs=native(f,'reactivated-closed')});
 const candidate=currentTaskCompletionCandidate(f.db,'alice',f.runId),attempts=candidate.snapshot.budget_attempts;
 for(const [run,id] of [[runs.child.run_id,'native-spent'],[runs.activation.run_id,'activation-spent']]){
  const selected=attempts.filter(a=>a.run_id===run&&a.attempt_id===id);assert.equal(selected.length,1);assert.equal(selected[0].state,'settled');assert.equal(selected[0].actual_tokens,'10');
 }
 assert.equal(attempts.filter(a=>a.state==='settled').length,3);assert.ok(attempts.every(a=>['settled','released'].includes(a.state)));assert.equal(new Set(attempts.map(a=>a.run_id+':'+a.attempt_id)).size,attempts.length);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
 // Adversarial duplicate bookkeeping must not double-count a real execution.
 const s=candidate.snapshot;f.db.prepare('INSERT INTO wb_mailbox_task_roots VALUES(?,?,?,?,?,?,?,?)').run('duplicate-native-ledger','alice',s.task_id,s.occurrence_id,s.root_run_id,f.runId,s.generation,new Date().toISOString());
 f.db.prepare('INSERT INTO wb_task_auxiliary_runs VALUES(?,?,?,?,?,?,?)').run(runs.child.run_id,'duplicate-native-ledger','alice',s.task_id,s.occurrence_id,s.root_run_id,new Date().toISOString());
 assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId),candidate);
});

test('uncertain or exceeded native spend independently invalidates an already closed review',async t=>{
 for(const state of ['reserved','in_flight','unknown','bound_exceeded']){
  let runs;const f=await completionFixture(t,{prepare:f=>runs=native(f)});
  // Deliberate database fault injection after genuine closure isolates the
  // accounting fence: an open-child guard must not mask a missing cost join.
  const original=f.db.prepare('SELECT * FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runs.child.run_id,'native-spent');
  const injected={...original,attempt_id:'injected-after-closure',state:state==='bound_exceeded'?'settled':state,bound_exceeded:state==='bound_exceeded'?1:0};
  f.db.prepare(`INSERT INTO wb_model_budget_attempts (${Object.keys(injected).join(',')}) VALUES(${Object.keys(injected).map(()=>'?').join(',')})`).run(...Object.values(injected));
  assert.throws(()=>currentTaskCompletionCandidate(f.db,'alice',f.runId),/budget_usage_unknown/,state);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_execution_closures WHERE run_id=?').get(runs.child.run_id).n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
 }
});

test('another occurrence can retain an open native child and unknown spend without contaminating this review',async t=>{
 let sibling;const f=await completionFixture(t,{prepare:f=>{
  const agent=f.workbench.contextForRun(f.runId).agent_id,task=f.persistentTasks.create('alice',{title:'Independent task',agent_id:agent,objective:'Separate evidence',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}}),occurrence=f.persistentTasks.runNow('alice',task.task_id,'independent');
  const coordinator=new HarnessCoordinator(f.db,f.runs,f.events,Date.now,{maxBackgroundRuns:2,allowBackgroundRuns:true}),lease=coordinator.claimNext('sibling-worker',30000);
  // prepare() receives the live service, while the root worker already owns its
  // lease; only the newly queued sibling is eligible for this claim.
  assert.equal(lease.run_id,occurrence.run_id);coordinator.start(lease);
  const now=new Date().toISOString();f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'alice','sibling-session',now,now);
  sibling=native({...f,task,runId:occurrence.run_id,identity:{session_ref:'sibling-session'}},'prepared');
  f.modelBudgets.reserve('alice',sibling.child.run_id,{attempt_id:'sibling-unknown',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',sibling.child.run_id,'sibling-unknown');f.modelBudgets.markUnknown('alice',sibling.child.run_id,'sibling-unknown','stream_incomplete');
 }});
 const candidate=currentTaskCompletionCandidate(f.db,'alice',f.runId);assert.ok(candidate.snapshot.budget_attempts.every(a=>a.run_id!==sibling.child.run_id));
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_execution_closures WHERE run_id=?').get(sibling.child.run_id).n,0);
});

test('a frozen review cannot admit a new reservation or reactivate its closed native child',async t=>{
 let runs;const f=await completionFixture(t,{prepare:f=>runs=native(f)}),before=currentTaskCompletionCandidate(f.db,'alice',f.runId);
 const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks)),lease={owner:f.lease.owner,generation:f.lease.generation};
 assert.throws(()=>new NativeChildReservations(f.db,collaboration).reserve({run_id:f.runId,session_ref:'session-fixture',child_session_ref:'late-child',role_ref:runs.reservation.role_id,request_id:'late-child',expected_policy_version:1,execution_lease:lease}),/workbench_execution_lease_revoked/);
 assert.throws(()=>f.workbench.prepareNativeActivation('alice',{run_id:f.runId,session_ref:'session-fixture',child_session_ref:runs.child.session_ref,previous_run_id:runs.child.run_id,previous_log_sha256:'a'.repeat(64),previous_seq_exclusive:10,execution_lease:lease}),/workbench_execution_lease_revoked/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_activations').get().n,0);assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId),before);
});
