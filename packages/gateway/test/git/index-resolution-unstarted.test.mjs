import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';import {withImmediateTransaction} from '../../src/db/database.ts';
test('a confirmed original UI acceptance cancelled before any dispatch closes without a native Host or filesystem effect',async t=>{
 const f=await indexResolutionFixture(t),{accepted,approved}=await f.admit(),id=accepted.execution_id,command={request_id:'original-before-dispatch-cancel',expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true};
 withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',id,command));await f.current.intents.control('owner','project',approved.intent_id,{request_id:'revoke-original',action:'cancel',expected_version:approved.version,review_sha256:approved.review_sha256});const before=await readFile(join(f.repository,'.git/index'));
 const receipt=await f.current.executions.resolveReserved('owner','project',id,command);assert.equal(receipt.result.state,'not_dispatched');assert.equal(receipt.execution_authorized,false);
 for(const table of ['wb_git_index_producers','ga_worker_leases','wb_workspace_reservations','wb_workspace_reservation_settlements'])assert.equal(f.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
 assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);assert.deepEqual(f.current.executions.getControl('owner','project',id,command.request_id),receipt);
 f.reopen();const changes=f.db.prepare('SELECT total_changes() n').get().n;
 f.db.exec('PRAGMA query_only=ON');try{assert.deepEqual(await f.current.executions.resolveReserved('owner','project',id,command),receipt)}finally{f.db.exec('PRAGMA query_only=OFF')}
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.deepEqual(await f.current.executions.perform('owner','project',id),receipt.result);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
});

const confirm=(f,id)=>{const command={request_id:'cancel-original',expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true};withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',id,command));return command};
test('unstarted closure requires the exact confirmation, current owner and live cancellation signal',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),id=accepted.execution_id,command=confirm(f,id),e=f.current.executions;
 await assert.rejects(e.resolveReserved('owner','project',id,{...command,expected_state_sha256:'0'.repeat(64)}),/idempotency_conflict/);
 await assert.rejects(e.resolveReserved('owner','project',id,{...command,request_id:'other'}),/git_execution_control_not_found/);
 await assert.rejects(e.resolveReserved('owner','project',id,command,AbortSignal.abort(Error('test_cancelled'))),/test_cancelled/);
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement','project');
 await assert.rejects(e.resolveReserved('owner','project',id,command),/project_not_found/);
 await assert.rejects(e.resolveReserved('replacement','project',id,command),/git_execution_not_found/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_dispositions').get().n,0);
});
test('an original reservation never uses the unstarted database-only closure',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),id=accepted.execution_id,e=f.current.executions;
 e.reserveWorkspace('owner','project',id);const command=confirm(f,id),changes=f.db.prepare('SELECT total_changes() n').get().n;
 await assert.rejects(e.resolveReserved('owner','project',id,command),/git_native_workspace_host_unavailable/);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_dispositions').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,0);
});
test('a producer preparing without a reservation still requires native recovery and retains its original lease',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),id=accepted.execution_id,e=f.current.executions,kernel=f.current.workbench.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel);let release,ready;
 const held=new Promise(done=>{release=done}),entered=new Promise(done=>{ready=done});kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);ready();await held;return plan};
 const running=e.perform('owner','project',id);running.catch(()=>{});await entered;
 try{const command=confirm(f,id),leases=f.db.prepare('SELECT * FROM ga_worker_leases').all();
  await assert.rejects(e.resolveReserved('owner','project',id,command),/git_native_workspace_host_unavailable/);
  assert.deepEqual(f.db.prepare('SELECT * FROM ga_worker_leases').all(),leases);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_dispositions').get().n,0);
 }finally{release()}
 await assert.rejects(running,/git_execution_control_pending/);
});

