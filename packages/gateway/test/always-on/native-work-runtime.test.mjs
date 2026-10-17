import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {workGrantFixture} from './work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {createNativeWorkRuntime} from '../../src/always-on/native-work-runtime.ts';
import {buildServer} from '../../src/server.ts';

test('unconfigured work integration remains closed and does not create its inspection store',async t=>{
 const f=await workGrantFixture(t);
 assert.equal(createNativeWorkRuntime({db:f.db,workbench:f.workbench,executionReady:false}),undefined);
 assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_discovery_work_inspections'").get(),undefined);
 for(const config of [{root:''},{root:join(f.root,'grant-snapshots')},{root:join(f.root,'grant-snapshots'),executionReady:true}])
  assert.throws(()=>createNativeWorkRuntime({db:f.db,workbench:f.workbench,executionReady:false,...config}),/native_work_configuration_unavailable/);
});

test('configured runtime derives actual admitted authority and limits its operations',async t=>{
 const f=await workGrantFixture(t),grant=new WorkGrants(f.db,f.budget).authorize('owner',f.scope,f.cycle.cycle_id,f.input,'runtime-work');
 const now=Date.now(),admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:now}));
 const claimed=f.coordinator.claimNext('runtime-worker',60000);f.coordinator.start(claimed);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner','runtime-work-session','now','now');
 const runtime=createNativeWorkRuntime({db:f.db,workbench:f.workbench,root:join(f.root,'grant-snapshots'),executionReady:true,budgetPolicy:f.budget});
 runtime.assertOperation(admission.run_id,'files.write');runtime.assertOperation(admission.run_id,'tasks.upsert');
 assert.throws(()=>runtime.assertOperation(admission.run_id,'memory.upsert'),/work_operation_denied/);
 assert.throws(()=>runtime.assertOperation(admission.run_id,'web.read'),/work_operation_denied/);
 assert.equal(runtime.resolver.context(admission.run_id).native_workspace.cwd,f.prepared.snapshot.isolated_root);
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-runtime');
 assert.throws(()=>runtime.assertOperation(admission.run_id,'files.write'),/revoked/);
});

test('real BFF opt-in constructs the same trusted internal runtime without changing defaults',async t=>{
 const f=await workGrantFixture(t),policy=JSON.parse(f.db.prepare('SELECT policy_json FROM wb_model_budget_policy_history ORDER BY revision DESC LIMIT 1').get().policy_json);
 const server=await buildServer({databasePath:join(f.root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(f.root,'workspace'),uploadRoot:join(f.root,'uploads'),templateRoot:new URL('../../file-engine/templates/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),workbenchExecutionReady:true,modelBudgetPolicy:policy,nativeWorkRoot:join(f.root,'grant-snapshots')});
 try{
  assert.ok(server.nativeWorkResolver);assert.ok(server.nativeWorkInspections);
  assert.equal(server.nativeWorkResolver.context(f.run),null);
 }finally{await server.app.close();server.db.close();}
});
