import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {fixture} from './task-wait-fixture.mjs';
import {currentTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';
import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';
import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';
import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';

function setup(f){
 const context=f.workbench.contextForRun(f.runId),role=f.workbench.createAgent('alice',{name:'Creation fixture',workspace_id:'ws',project_id:context.project_id});
 const team=f.workbench.createTeam('alice',{name:'Creation team',workspace_id:'ws',project_id:context.project_id,member_ids:[context.agent_id,role.agent_id]});
 const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));collaboration.save('alice',f.task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[role.agent_id],max_delegations:2,max_active:1});
 const lease=f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(f.runId),service=new NativeChildReservations(f.db,collaboration);
 const input={run_id:f.runId,session_ref:'session-fixture',child_session_ref:'creation-child',request_id:'creation-request',execution_lease:lease,role_ref:role.agent_id,expected_policy_version:1,spawn_request_hash:'b'.repeat(64)};
 const reservation=service.reserve(input),{role_ref,expected_policy_version,...identity}=input;
 return {service,reservation,input,abort:{...identity,proof:{protocol:1,phase:'provider_prepare_failed'}}};
}

test('a trusted pre-create failure terminates only its unbound reservation and allows original completion',async t=>{
 let saved;const f=await completionFixture(t,{prepare:f=>{saved=setup(f);const result=saved.service.abortBeforeCreate(saved.abort);assert.equal(result.aborted,true);assert.equal(result.reservation_id,saved.reservation.reservation_id);assert.deepEqual(saved.service.abortBeforeCreate(saved.abort),result);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_runs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_closures').get().n,0);
  assert.throws(()=>f.db.prepare('DELETE FROM wb_native_creation_aborts').run(),/native_creation_abort_immutable/);
 }});
 assert.ok(currentTaskCompletionCandidate(f.db,'alice',f.runId).candidate_id);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
});

test('creation abort rejects changed identities, lease and untrusted phases without changing reservation state',async t=>{
 await completionFixture(t,{prepare:f=>{const s=setup(f);
  for(const change of [{owner_id:'bob'},{session_ref:'foreign'},{child_session_ref:'wrong'},{request_id:'wrong'},{spawn_request_hash:'c'.repeat(64)},{execution_lease:{...s.abort.execution_lease,generation:99}},{proof:{protocol:1,phase:'timeout'}},{proof:{protocol:1,phase:'provider_prepare_failed',not_created:true}}])assert.throws(()=>s.service.abortBeforeCreate({...s.abort,...change}));
  const lease=f.db.prepare('SELECT expires_at FROM ga_worker_leases WHERE resource_id=?').get(f.runId);f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run('0',f.runId);assert.throws(()=>s.service.abortBeforeCreate(s.abort),/workbench_execution_lease_revoked/);f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(lease.expires_at,f.runId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_creation_aborts').get().n,0);s.service.abortBeforeCreate(s.abort);
 }});
});

test('an existing child binding makes creation outcome uncertain and cannot be cancelled by this path',async t=>{
 await fixture(t,'wait_user',{prepare:f=>{const s=setup(f),child=f.workbench.prepareNativeChild('alice',s.reservation.reservation_id);
  assert.throws(()=>s.service.abortBeforeCreate(s.abort),/native_creation_outcome_unknown/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_creation_aborts').get().n,0);assert.equal(f.workbench.contextForRun(child.run_id).kind,'native_team');
 }});
});

test('aborted creation cannot bind or replay; only active capacity is freed while total quota is retained',async t=>{
 await fixture(t,'wait_user',{prepare:f=>{const s=setup(f);s.service.abortBeforeCreate(s.abort);
  assert.throws(()=>f.workbench.prepareNativeChild('alice',s.reservation.reservation_id),/native_creation_aborted/);assert.throws(()=>s.service.reserve(s.input),/native_creation_aborted/);
  const lookup=s.service.lookup({run_id:f.runId,session_ref:'session-fixture',request_id:s.input.request_id,spawn_request_hash:s.input.spawn_request_hash,execution_lease:s.input.execution_lease});assert.equal(lookup.aborted,true);
  const next=s.service.reserve({...s.input,request_id:'next-request',child_session_ref:'next-child'});s.service.abortBeforeCreate({...s.abort,request_id:'next-request',child_session_ref:'next-child'});
  assert.ok(next.reservation_id);assert.throws(()=>s.service.reserve({...s.input,request_id:'third-request',child_session_ref:'third-child'}),/task_collaboration_exhausted/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,2);
 }});
});

test('the internal creation-abort transport authenticates and never exposes a public abort route',async t=>{
 await completionFixture(t,{prepare:async f=>{const s=setup(f),url='/internal/v1/workbench/native-child-abort';
  assert.equal((await f.app.inject({method:'POST',url,payload:s.abort})).statusCode,401);
  assert.equal(f.app.hasRoute({method:'POST',url:'/v1/workbench/native-child-abort'}),false);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/workbench/native-child-abort',headers:{'x-user-id':'alice'},payload:s.abort})).statusCode,403);
  const invalid=await f.internal('native-child-abort',{...s.abort,owner_id:'bob'});assert.notEqual(invalid.statusCode,200);
  const result=await f.internal('native-child-abort',s.abort);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().aborted,true);
 }});
});

test('actual root cancellation still permits original-lease unbound cleanup without resuming execution',async t=>{
 await assert.rejects(fixture(t,'wait_user',{prepare:f=>{const s=setup(f),run=f.runs.get(f.runId,'alice');f.commands.cancel(f.runId,'alice',{expected_run_version:run.version},'cancel-during-prepare');
  assert.equal(f.runs.get(f.runId,'alice').status,'cancelling');assert.equal(s.service.abortBeforeCreate(s.abort).aborted,true);assert.equal(f.runs.get(f.runId,'alice').status,'cancelling');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_runs').get().n,0);assert.throws(()=>f.workbench.prepareNativeChild('alice',s.reservation.reservation_id),/native_creation_aborted/);
  throw Error('fixture_cancel_abort_verified');
 }}),/fixture_cancel_abort_verified/);
});

test('simultaneous HTTP bind and pre-create abort commit exactly one outcome',async t=>{
 for(const abortFirst of [false,true])await fixture(t,'wait_user',{prepare:async f=>{const s=setup(f),address=await f.app.listen({host:'127.0.0.1',port:0});
  const bind={run_id:f.runId,session_ref:'session-fixture',execution_lease:s.input.execution_lease,reservation_id:s.reservation.reservation_id};
  const requests=[['native-child-bind',bind],['native-child-abort',s.abort]];if(abortFirst)requests.reverse();
  const outcomes=await Promise.all(requests.map(async([operation,payload])=>{const response=await fetch(address+'/internal/v1/workbench/'+operation,{method:'POST',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken,'content-type':'application/json'},body:JSON.stringify(payload)});return {operation,status:response.status,body:await response.json()};}));
  assert.deepEqual(outcomes.map(v=>v.status).sort(),[200,409],JSON.stringify(outcomes));const aborted=outcomes.find(v=>v.operation==='native-child-abort').status===200;
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_creation_aborts').get().n,aborted?1:0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_runs').get().n,aborted?0:1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,1);
 }});
});
