import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {workGrantFixture} from './work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {TrustedWorkRunWorkspaceResolver,selectedWorkObjective} from '../../src/always-on/work-run-workspace.ts';
import {installIsolatedWorkFiles} from '../../src/always-on/isolated-work-file-schema.ts';
import {IsolatedWorkFiles} from '../../src/always-on/isolated-work-files.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

async function fixture(t){
 const f=await workGrantFixture(t);installIsolatedWorkFiles(f.db);const grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'select-work');
 const now=Date.now(),admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:now}));
 const claimed=f.coordinator.claimNext('workspace-worker',60000);assert.equal(claimed.run_id,admission.run_id);f.coordinator.start(claimed);const lease={owner:claimed.owner,generation:claimed.generation};
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner','work-test-session',new Date(now).toISOString(),new Date(now).toISOString());
 const resolver=new TrustedWorkRunWorkspaceResolver({db:f.db,workbench:f.workbench,policies:f.policies,workspace:f.manager});
 return {...f,grant,admission,claimed,lease,resolver};
}

test('one full selected objective drives sync context and physically verified worker binding',async t=>{
 const f=await fixture(t),context=f.resolver.context(f.admission.run_id,f.lease),trusted=await f.resolver.resolve(f.admission.run_id,f.lease);
 assert.equal(trusted.cwd,f.prepared.snapshot.isolated_root);assert.equal(context.native_workspace.cwd,trusted.cwd);assert.equal(context.objective,trusted.objective);assert.equal(trusted.sessionRef,'work-test-session');
 const plans=f.history.detail('owner',f.scope,f.grant.admission_id).plans;
 assert.equal(trusted.objective,selectedWorkObjective(f.grant.plans.map(p=>plans.find(full=>full.plan_id===p.plan_id))));
 const objective=JSON.parse(trusted.objective);assert.equal(objective.protocol,1);assert.equal(objective.plans[0].rationale,'Observed source');assert.deepEqual(objective.plans[0].changes[0].steps,['Review']);assert.deepEqual(objective.plans[0].changes[0].verification,['Compare']);assert.ok(objective.plans[0].evidence.length);
 const dbObjective=f.db.prepare('SELECT objective FROM wb_persistent_tasks WHERE task_id=?').get(f.admission.task_id).objective;assert.notEqual(dbObjective,trusted.objective);
 f.db.exec('BEGIN IMMEDIATE');try{assert.equal(f.resolver.context(f.admission.run_id,f.lease).objective,trusted.objective);await assert.rejects(()=>f.resolver.resolve(f.admission.run_id,f.lease),/outer_transaction/);}finally{f.db.exec('ROLLBACK');}
 assert.throws(()=>selectedWorkObjective([{summary:'x'.repeat(65536)}]),/objective_limit/);
});

test('genuine isolated versions survive resolver recovery while arbitrary planned and context drift refuse',async t=>{
 const f=await fixture(t),identity={owner_id:'owner',...f.scope,cycle_id:f.admission.cycle_id,snapshot_id:f.admission.snapshot_id,run_id:f.admission.run_id,occurrence_id:f.admission.occurrence_id,call_id:'native-write'};
 const service=new IsolatedWorkFiles({db:f.db,resolve:id=>f.resolver.resolveFiles(id,f.lease),commitReceipt:()=>{}});
 const receipt=await service.execute(identity,{operation:'files.write',path:'source.md',content:'approved native bytes',expected_version:0});assert.equal(receipt.version,1);
 assert.ok(await f.resolver.resolve(identity.run_id,f.lease));assert.equal(service.version(receipt.receipt_id).content,'approved native bytes');
 await writeFile(join(f.prepared.snapshot.isolated_root,'source.md'),'external replacement');await assert.rejects(()=>f.resolver.resolve(identity.run_id,f.lease),/isolated_changed/);
 assert.equal(await readFile(join(f.prepared.snapshot.isolated_root,'source.md'),'utf8'),'external replacement');
});

test('unselected context injection refuses; own inflight budget remains valid',async t=>{
 const f=await fixture(t);f.budget.ledger.reserve('owner',f.admission.run_id,{attempt_id:'own-call',provider:'fixture',model:'bounded'});f.budget.ledger.dispatch('owner',f.admission.run_id,'own-call');
 assert.ok(await f.resolver.resolve(f.admission.run_id,f.lease));
 await writeFile(join(f.prepared.snapshot.isolated_root,'injected-context.txt'),'not selected');await assert.rejects(()=>f.resolver.resolve(f.admission.run_id,f.lease),/scope_changed/);
});

test('original task cumulative unknown accounting refuses instead of creating a new allowance',async t=>{
 const f=await fixture(t);f.budget.ledger.reserve('owner',f.admission.run_id,{attempt_id:'unknown-call',provider:'fixture',model:'bounded'});f.budget.ledger.dispatch('owner',f.admission.run_id,'unknown-call');f.budget.ledger.markUnknown('owner',f.admission.run_id,'unknown-call','stream_incomplete');
 await assert.rejects(()=>f.resolver.resolve(f.admission.run_id,f.lease),/budget_usage_unknown/);
});

test('unknown isolated replacement remains pending and cannot become worker authority',async t=>{
 const f=await fixture(t),identity={owner_id:'owner',...f.scope,cycle_id:f.admission.cycle_id,snapshot_id:f.admission.snapshot_id,run_id:f.admission.run_id,occurrence_id:f.admission.occurrence_id,call_id:'uncertain-write'};
 const service=new IsolatedWorkFiles({db:f.db,resolve:id=>f.resolver.resolveFiles(id,f.lease),commitReceipt:()=>{throw Error('lost-commit');}});
 await assert.rejects(()=>service.execute(identity,{operation:'files.write',path:'source.md',content:'uncertain bytes',expected_version:0}),/lost-commit/);
 await assert.rejects(()=>f.resolver.resolve(identity.run_id,f.lease),/pending/);
});

test('new original owner input during physical inspection revokes live entry',async t=>{
 const f=await fixture(t);const resolver=new TrustedWorkRunWorkspaceResolver({db:f.db,workbench:f.workbench,policies:f.policies,workspace:{inspect:async(...args)=>{const value=await f.manager.inspect(...args);const run=f.runs.enqueue(f.agent.conversation_id,'owner',{client_message_id:'new-owner-requirement',content:[{type:'text',text:'The required project change is different.'}]});f.workbench.bindRun('owner',f.agent.agent_id,run.run_id,'chat');f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(run.run_id);return value;}}});
 await assert.rejects(()=>resolver.resolve(f.admission.run_id,f.lease),/authority_revoked/);
});

test('wrong lease, saved session substitution after await, stale source and substituted root fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.resolver.resolve(f.admission.run_id,{...f.lease,generation:f.lease.generation+1}),/lease_revoked/);
 const resolver=new TrustedWorkRunWorkspaceResolver({db:f.db,workbench:f.workbench,policies:f.policies,workspace:{inspect:async(...args)=>{const value=await f.manager.inspect(...args);f.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('substituted-session',f.admission.conversation_id);return value;}}});
 await assert.rejects(()=>resolver.resolve(f.admission.run_id,f.lease),/binding_changed/);
 f.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('work-test-session',f.admission.conversation_id);
 const root=f.prepared.snapshot.isolated_root;await rename(root,root+'-moved');await assert.rejects(()=>f.resolver.resolve(f.admission.run_id,f.lease),/workspace_/);await rename(root+'-moved',root);
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'new source',expected_version:1});await assert.rejects(()=>f.resolver.resolve(f.admission.run_id,f.lease),/source_changed|authority_revoked/);
});

test('original checkpoint continuation keeps objective, saved session and workspace with same admission',async t=>{
 const f=await fixture(t),initial=await f.resolver.resolve(f.admission.run_id,f.lease),counts=f.counts();
 const now=new Date().toISOString();f.db.prepare('INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?)').run(f.admission.run_id,f.admission.occurrence_id,'synthetic-work-goal',3,now,now);
 const checkpoint=f.coordinator.recordCheckpoint(f.claimed,'work-test-session',{session_ref:'work-test-session',seq_exclusive:5,turn_end_seq:4,goal_id:'synthetic-work-goal',goal_revision:3,log_sha256:'a'.repeat(64)});f.coordinator.interruptWithoutRuntime(f.claimed,'SESSION_TURN_INTERRUPTED');
 const commands=new RunCommandService(f.db,f.events),next=withImmediateTransaction(f.db,()=>{const resumed=commands.resume(f.admission.run_id,'owner',{expected_run_version:f.runs.get(f.admission.run_id,'owner').version,checkpoint_id:checkpoint},'resume-work-binding');f.workbench.inheritCheckpointRun('owner',f.admission.run_id,resumed.run_id);return resumed.run_id;});
 const claimed=f.coordinator.claimNext('workspace-worker-next',60000);assert.equal(claimed.run_id,next);f.coordinator.start(claimed);const lease={owner:claimed.owner,generation:claimed.generation},resolved=await f.resolver.resolve(next,lease);
 assert.equal(resolved.objective,initial.objective);assert.equal(resolved.cwd,initial.cwd);assert.equal(resolved.sessionRef,initial.sessionRef);assert.equal(resolved.originalRunId,f.admission.run_id);assert.equal(resolved.runId,next);assert.equal(f.counts()[1],counts[1]);
 assert.throws(()=>f.resolver.context(f.admission.run_id),/revoked/);
});
