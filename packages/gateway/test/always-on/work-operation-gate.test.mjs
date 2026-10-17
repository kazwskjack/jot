import test from 'node:test';
import assert from 'node:assert/strict';
import {workGrantFixture} from './work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';

async function fixture(t){
 const f=await workGrantFixture(t),grant=new WorkGrants(f.db,f.budget).authorize('owner',f.scope,f.cycle.cycle_id,f.input,'operation-gate');
 const now=Date.now(),admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:now}));
 return {...f,admission};
}

test('work operations stay closed without the host integration gate',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.tasks.assertDiscoveryOperation(f.admission.run_id,'files.write'),/work_admission_execution_unavailable/);
});

test('host gate is called synchronously after the original admission check',async t=>{
 const f=await fixture(t),calls=[];
 const tasks=new PersistentTaskService(f.db,f.workbench,{modelBudgetPolicy:f.budget,discoveryWorkOperations:{assertOperation(run,operation){calls.push([run,operation]);if(operation!=='files.write')throw Error('work_operation_denied');}}});
 tasks.assertDiscoveryOperation(f.admission.run_id,'files.write');
 assert.deepEqual(calls,[[f.admission.run_id,'files.write']]);
 assert.throws(()=>tasks.assertDiscoveryOperation(f.admission.run_id,'memory.upsert'),/work_operation_denied/);
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-work');
 assert.throws(()=>tasks.assertDiscoveryOperation(f.admission.run_id,'files.write'),/revoked/);
 assert.equal(calls.length,2);
});

test('an asynchronous gate cannot grant synchronous task operations',async t=>{
 const f=await fixture(t),tasks=new PersistentTaskService(f.db,f.workbench,{modelBudgetPolicy:f.budget,discoveryWorkOperations:{assertOperation:()=>Promise.resolve()}});
 assert.throws(()=>tasks.assertDiscoveryOperation(f.admission.run_id,'files.write'),/work_admission_execution_unavailable/);
 let invoked=0;
 const invalid=new PersistentTaskService(f.db,f.workbench,{modelBudgetPolicy:f.budget,discoveryWorkOperations:{assertOperation:()=>({then(){invoked++;}})}});
 assert.throws(()=>invalid.assertDiscoveryOperation(f.admission.run_id,'files.write'),/work_admission_execution_unavailable/);
 assert.equal(invoked,0);
});

test('work Session identity survives a changed deployment prefix',async t=>{
 const f=await fixture(t),original=new SessionBindingRepository(f.db,'oldprefix').getOrCreateForConversation(f.admission.conversation_id);
 const restored=new SessionBindingRepository(f.db,'newprefix').getOrCreateForConversation(f.admission.conversation_id);
 assert.equal(restored.session_id,original.session_id);
});

test('missing saved work Session cannot be recreated after its native Goal exists',async t=>{
 const f=await fixture(t),sessions=new SessionBindingRepository(f.db,'original'),original=sessions.getOrCreateForConversation(f.admission.conversation_id);
 f.db.prepare('INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?)').run(f.admission.run_id,f.admission.occurrence_id,'synthetic-existing-goal',1,'now','now');
 f.db.prepare('DELETE FROM ga_harness_session_bindings WHERE conversation_id=?').run(f.admission.conversation_id);
 assert.throws(()=>sessions.getOrCreateForConversation(f.admission.conversation_id),/work_session_recovery_required/);
 assert.equal(f.db.prepare('SELECT 1 FROM ga_harness_session_bindings WHERE session_id=?').get(original.session_id),undefined);
});
