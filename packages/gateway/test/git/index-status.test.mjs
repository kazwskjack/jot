import test from 'node:test';import assert from 'node:assert/strict';import {withImmediateTransaction} from '../../src/db/database.ts';
import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';import {nativeIndexResolutionFixture} from '../support/index-resolution-native-fixture.mjs';
test('original UI status reads acceptance, producer, control and workspace drain separately without writes',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),id=accepted.execution_id,e=f.current.executions;
 const status=e.status('owner','project',id);assert.equal(status.execution.state,'pending');assert.equal(status.producer.state,'not_started');assert.equal(status.workspace_state,'not_reserved');assert.equal(status.control,null);assert.equal(status.control_receipt,null);assert.equal(status.execution_authorized,false);
 assert.equal(status.state_sha256,e.inspect('owner','project',id).state_sha256);
 const before=f.db.prepare('SELECT total_changes() n').get().n;f.db.exec('PRAGMA query_only=ON');try{assert.deepEqual(e.status('owner','project',id),status)}finally{f.db.exec('PRAGMA query_only=OFF')}assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 e.reserveWorkspace('owner','project',id);const command={request_id:'status-control',expected_state_sha256:status.state_sha256,acknowledge_unknown:true};withImmediateTransaction(f.db,()=>e.admitResolution('owner','project',id,command));
 const held=e.status('owner','project',id);assert.equal(held.workspace_state,'reserved');assert.equal(held.producer.state,'not_started');assert.equal(held.control.request_id,command.request_id);assert.equal(held.control_receipt.state,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
});
test('status cannot adopt internal executions or transfer old UI identity to another owner',async t=>{
 const f=await indexResolutionFixture(t),{approved,input}=await f.review(),kernel=f.current.workbench.indexEffects('owner','project');kernel.prepareIndex=async()=>{throw Error('synthetic_before_prepare')};
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/synthetic_before_prepare/);const internal=f.db.prepare('SELECT execution_id FROM wb_git_index_executions').get().execution_id;assert.throws(()=>f.current.executions.status('owner','project',internal),/git_admission_not_found/);
 const other=await indexResolutionFixture(t),{accepted}=await other.admit();other.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement','project');assert.throws(()=>other.current.executions.status('owner','project',accepted.execution_id),/project_not_found/);assert.throws(()=>other.current.executions.status('replacement','project',accepted.execution_id),/git_execution_not_found/);
});
test('a completed physical control remains visibly held until original native drain settles',{skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:60000},async t=>{
 const f=await nativeIndexResolutionFixture(t),kernel=f.workbench.indexEffects('owner',f.project),prepare=kernel.prepareIndex;kernel.prepareIndex=async()=>{throw Error('synthetic_prepare_failure')};await assert.rejects(f.executions.performReserved('owner',f.project,f.id),/synthetic_prepare_failure/);kernel.prepareIndex=prepare;await f.cancel();const command=f.confirm();
 f.afterCallback(source=>{if(source.control_request_id)throw Error('synthetic_native_drain_loss')});await assert.rejects(f.executions.resolveReserved('owner',f.project,f.id,command),/synthetic_native_drain_loss/);
 const held=f.executions.status('owner',f.project,f.id);assert.equal(held.execution.state,'not_dispatched');assert.equal(held.control_receipt.state,'completed');assert.equal(held.workspace_state,'reserved');assert.equal(held.execution_authorized,false);
 f.afterCallback(()=>{});const receipt=await f.executions.resolveReserved('owner',f.project,f.id,command),settled=f.executions.status('owner',f.project,f.id);assert.equal(settled.workspace_state,'released_settled');assert.deepEqual(settled.control_receipt,receipt);assert.equal(f.calls,0);
});
