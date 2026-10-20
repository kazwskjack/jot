import test from 'node:test';import assert from 'node:assert/strict';import {readFile,stat} from 'node:fs/promises';import {join} from 'node:path';
import {nativeIndexResolutionFixture as fixture} from '../support/index-resolution-native-fixture.mjs';import {ProjectRepository} from '../../src/projects/repository.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';
const enabled=!!process.env.JOT_DSH_RUNTIME_MODULES;
const rows=(f,table)=>f.db.prepare('SELECT * FROM '+table).all();

test('fresh original recovery retains Worker custody through native postchecks and lost acknowledgement; retry never repeats effects',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t),kernel=f.workbench.indexEffects('owner',f.project),prepare=kernel.prepareIndex;kernel.prepareIndex=async()=>{throw Error('synthetic_prepare_failure')};await assert.rejects(f.executions.performReserved('owner',f.project,f.id),/synthetic_prepare_failure/);kernel.prepareIndex=prepare;
 await f.cancel();const command=f.confirm(),before=await readFile(join(f.rootTarget,'.git/index')),producer=rows(f,'wb_git_index_producers'),finish=rows(f,'wb_git_index_producer_finishes');let calls=0;
 f.afterCallback(scope=>{if(scope.control_request_id){calls++;assert.equal(rows(f,'ga_worker_leases').length,1,'same recovery lease must remain through native drain');if(calls===1)throw Error('synthetic_lost_recovery_ack')}});
 await assert.rejects(f.executions.resolveReserved('owner',f.project,f.id,command),/synthetic_lost_recovery_ack/);assert.equal(f.executions.getControl('owner',f.project,f.id,command.request_id).state,'completed');assert.equal(rows(f,'ga_worker_leases').length,0);assert.equal(rows(f,'wb_workspace_reservation_settlements').length,0);
 const receipt=await f.executions.resolveReserved('owner',f.project,f.id,command);assert.equal(receipt.result.state,'not_dispatched');assert.equal(receipt.cleanup,'not_recorded');assert.equal(calls,2);assert.deepEqual(rows(f,'wb_git_index_producers'),producer);assert.deepEqual(rows(f,'wb_git_index_producer_finishes'),finish);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),before);assert.equal(rows(f,'ga_worker_leases').length,0);assert.equal(rows(f,'wb_workspace_reservation_releases').length,1);assert.equal(f.calls,0);
});

test('a control admitted during native preparation remains the same command after the original producer finishes',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t),kernel=f.workbench.indexEffects('owner',f.project),prepare=kernel.prepareIndex.bind(kernel);let enter,release;const ready=new Promise(done=>enter=done),held=new Promise(done=>release=done);kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);enter();await held;return plan};
 const before=await readFile(join(f.rootTarget,'.git/index')),running=f.executions.performReserved('owner',f.project,f.id);running.catch(()=>{});await ready;let command;try{command=f.confirm()}finally{release()}
 await assert.rejects(running,/git_execution_control_pending/);assert.notEqual(f.executions.inspect('owner',f.project,f.id).state_sha256,command.expected_state_sha256,'real original producer appended its own finish');
 const receipt=await f.executions.resolveReserved('owner',f.project,f.id,command);assert.equal(receipt.result.state,'not_dispatched');assert.equal(receipt.request_id,command.request_id);assert.equal(rows(f,'wb_git_index_controls').length,1);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),before);assert.equal(f.calls,0);
});

test('recovery observes genuine applied bytes after outcome loss and never forges an interrupted producer finish',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER synthetic_outcome_loss BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'synthetic_outcome_loss'); END");await assert.rejects(f.executions.performReserved('owner',f.project,f.id),/synthetic_outcome_loss/);f.db.exec('DROP TRIGGER synthetic_outcome_loss');assert.equal(f.executions.getAdmitted('owner',f.project,f.id).state,'unknown');
 await f.cancel();const command=f.confirm(),path=join(f.rootTarget,'.git/index'),before=await readFile(path),identity=await stat(path,{bigint:true}),finish=rows(f,'wb_git_index_producer_finishes');assert.equal(JSON.parse(finish[0].record_json).state,'unknown');
 const receipt=await f.executions.resolveReserved('owner',f.project,f.id,command);assert.equal(receipt.result.state,'applied');assert.equal(receipt.cleanup,'verified');assert.deepEqual(await readFile(path),before);const after=await stat(path,{bigint:true});assert.equal(after.ino,identity.ino);assert.equal(after.mtimeNs,identity.mtimeNs);assert.deepEqual(rows(f,'wb_git_index_producer_finishes'),finish);assert.equal(rows(f,'wb_workspace_reservation_settlements').length,1);assert.equal(rows(f,'wb_git_index_dispatches').length,1);assert.equal(f.calls,0);
});

test('a replaced recovery Worker cannot clean or publish a control receipt and cannot delete its successor lease',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER synthetic_outcome_loss BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'synthetic_outcome_loss'); END");await assert.rejects(f.executions.performReserved('owner',f.project,f.id),/synthetic_outcome_loss/);f.db.exec('DROP TRIGGER synthetic_outcome_loss');await f.cancel();const command=f.confirm(),before=await readFile(join(f.rootTarget,'.git/index')),kernel=f.workbench.indexEffects('owner',f.project),cleanup=kernel.cleanupEvidence.bind(kernel);let successor;
 kernel.cleanupEvidence=async(...args)=>{const old=rows(f,'ga_worker_leases');assert.equal(old.length,1);successor={...old[0],owner:'synthetic-successor',generation:old[0].generation+1};f.db.prepare('UPDATE ga_worker_leases SET owner=?,generation=? WHERE resource_id=?').run(successor.owner,successor.generation,successor.resource_id);return cleanup(...args)};
 await assert.rejects(f.executions.resolveReserved('owner',f.project,f.id,command),/workbench_execution_lease_revoked/);assert.deepEqual(rows(f,'ga_worker_leases').map(row=>({...row})),[successor]);assert.equal(f.executions.getControl('owner',f.project,f.id,command.request_id).state,'pending');assert.equal(rows(f,'wb_workspace_reservation_releases').length,0);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),before);assert.equal(f.calls,0);
});

test('cancellation after physical control completion retains its receipt and reservation without reporting native drain',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t),kernel=f.workbench.indexEffects('owner',f.project),prepare=kernel.prepareIndex;kernel.prepareIndex=async()=>{throw Error('synthetic_prepare_failure')};await assert.rejects(f.executions.performReserved('owner',f.project,f.id),/synthetic_prepare_failure/);kernel.prepareIndex=prepare;await f.cancel();const command=f.confirm(),abort=new AbortController();
 f.afterCallback(scope=>{if(scope.control_request_id)abort.abort(new Error('synthetic_owner_cancel'))});await assert.rejects(f.executions.resolveReserved('owner',f.project,f.id,command,abort.signal),/synthetic_owner_cancel/);assert.equal(f.executions.getControl('owner',f.project,f.id,command.request_id).state,'completed');assert.equal(rows(f,'ga_worker_leases').length,0);assert.equal(rows(f,'wb_workspace_reservation_releases').length,0);assert.equal(rows(f,'wb_workspace_reservation_settlements').length,0);assert.equal(f.calls,0);
});

test('a host response without the original callback cannot manufacture a completed control',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t);f.executions.reserveWorkspace('owner',f.project,f.id);const command=f.confirm();await f.cancel();const projects=new ProjectRepository(f.db),fake=new GitIndexExecutions(f.db,projects,f.workbench,f.intents,{nativeWorkspaceHost:{withReservedFamily:async()=>({state:'completed',cleanup:'verified',execution_authorized:false}),inspect:()=>assert.fail('no original callback'),assertAdmission:()=>assert.fail('no original callback')}});
 await assert.rejects(fake.resolveReserved('owner',f.project,f.id,command),/git_native_workspace_host_unavailable/);assert.equal(f.executions.getControl('owner',f.project,f.id,command.request_id).state,'pending');assert.equal(rows(f,'ga_worker_leases').length,0);assert.equal(rows(f,'wb_workspace_reservation_releases').length,0);assert.equal(f.calls,0);
});

test('a changed native response cannot replace the actual original database control receipt',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t);f.executions.reserveWorkspace('owner',f.project,f.id);const command=f.confirm();await f.cancel();f.afterCallback((scope,result)=>{if(scope.control_request_id)result.cleanup='verified'});
 await assert.rejects(f.executions.resolveReserved('owner',f.project,f.id,command),/git_execution_outcome_corrupt/);assert.equal(f.executions.getControl('owner',f.project,f.id,command.request_id).cleanup,'not_recorded');assert.equal(rows(f,'ga_worker_leases').length,0);assert.equal(rows(f,'wb_workspace_reservation_releases').length,0);assert.equal(f.calls,0);
});
