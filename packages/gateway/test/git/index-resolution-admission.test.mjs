import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {withImmediateTransaction} from '../../src/db/database.ts';import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';
import {publicationNativeHostFixture} from '../support/publication-native-host-fixture.mjs';import {inspectNativeWorkspaceSource,assertNativeWorkspaceSourceAdmission} from '../../../session-adapter/native-workspace-source.js';
const input=(f,id,request_id='resolve-original')=>({request_id,expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true});
const count=(db,table)=>db.prepare('SELECT count(*) n FROM '+table).get().n;

test('resolution admission is original UI-only, synchronous and rolled back with its caller transaction',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),before=await readFile(join(f.repository,'.git/index')),command=input(f,accepted.execution_id),e=f.current.executions;
 assert.throws(()=>e.admitResolution('owner','project',accepted.execution_id,command),/git_admission_transaction_required/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>{const receipt=e.admitResolution('owner','project',accepted.execution_id,command);assert.equal(typeof receipt?.then,'undefined');throw Error('test_rollback')}),/test_rollback/);
 assert.equal(count(f.db,'wb_git_index_controls'),0);assert.equal(count(f.db,'ga_worker_leases'),0);assert.equal(count(f.db,'wb_git_index_producers'),0);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);
});

test('admission history remains read-only after completion and cannot adopt an internal execution',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),command=input(f,accepted.execution_id),receipt=withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,command));
 const completed=await f.current.executions.abandon('owner','project',accepted.execution_id,command);assert.equal(completed.result.state,'not_dispatched');
 const changes=f.db.prepare('SELECT total_changes() n').get().n;f.db.exec('PRAGMA query_only=ON');try{assert.deepEqual(f.current.executions.getResolutionAdmission('owner','project',accepted.execution_id,command.request_id),receipt);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes)}finally{f.db.exec('PRAGMA query_only=OFF')}
 const next=await f.admit();assert.throws(()=>withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',next.accepted.execution_id,{...input(f,next.accepted.execution_id),request_id:command.request_id})),/idempotency_conflict/);
});

test('trusted internal executions and a transferred project never become UI resolution authority',async t=>{
 const f=await indexResolutionFixture(t),{approved,input:execute}=await f.review(),internal=await f.current.executions.execute('owner','project',approved.intent_id,execute);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',internal.execution_id,input(f,internal.execution_id))),/git_admission_not_found/);assert.equal(count(f.db,'wb_git_index_controls'),0);
 const other=await indexResolutionFixture(t),{accepted}=await other.admit(),command=input(other,accepted.execution_id);withImmediateTransaction(other.db,()=>other.current.executions.admitResolution('owner','project',accepted.execution_id,command));other.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('new-owner','project');
 assert.throws(()=>other.current.executions.getResolutionAdmission('owner','project',accepted.execution_id,command.request_id),/project_not_found/);assert.throws(()=>withImmediateTransaction(other.db,()=>other.current.executions.admitResolution('owner','project',accepted.execution_id,command)),/project_not_found/);
});

test('a changed original control request cannot be projected as an accepted confirmation',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),command=input(f,accepted.execution_id);withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,command));
 f.db.exec('SAVEPOINT synthetic_control_drift');try{f.db.exec('DROP TRIGGER wb_git_index_controls_no_update');f.db.prepare('UPDATE wb_git_index_controls SET expected_state_sha256=?').run('0'.repeat(64));assert.throws(()=>f.current.executions.getResolutionAdmission('owner','project',accepted.execution_id,command.request_id),/git_execution_evidence_corrupt/)}finally{f.db.exec('ROLLBACK TO synthetic_control_drift; RELEASE synthetic_control_drift')}
});

test('a genuinely applied original index with lost native acknowledgement admits confirmation without settling or writing again',{skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:60000},async t=>{
 const f=await publicationNativeHostFixture(t),projects=new ProjectRepository(f.db),intents=new GitMutationIntents(f.db,projects,f.workbench),executions=new GitIndexExecutions(f.db,projects,f.workbench,intents,{nativeWorkspaceHost:{async withReservedFamily(...args){await f.host.withReservedFamily(...args);throw Error('test_lost_native_ack')},inspect:inspectNativeWorkspaceSource,assertAdmission:assertNativeWorkspaceSourceAdmission}});
 const {writeFile}=await import('node:fs/promises');await writeFile(join(f.rootTarget,'source.md'),'Synthetic reviewed target edit');const snapshot=await f.workbench.inspect('owner',f.scope.project_id),review=await intents.prepare('owner',f.scope.project_id,{request_id:'native-stage-review',action:'stage',paths:['source.md'],snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner',f.scope.project_id,review.intent_id,{request_id:'native-stage-approve',action:'approve',expected_version:1,review_sha256:review.review_sha256}),accepted=withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:'native-stage',expected_version:approved.version,review_sha256:approved.review_sha256}));
 await assert.rejects(executions.performReserved('owner',f.scope.project_id,accepted.execution_id),/test_lost_native_ack/);assert.equal(executions.getAdmitted('owner',f.scope.project_id,accepted.execution_id).state,'applied');const before=await readFile(join(f.rootTarget,'.git/index'));
 const command={request_id:'confirm-native-applied',expected_state_sha256:executions.inspect('owner',f.scope.project_id,accepted.execution_id).state_sha256,acknowledge_unknown:true},receipt=withImmediateTransaction(f.db,()=>executions.admitResolution('owner',f.scope.project_id,accepted.execution_id,command));assert.equal(receipt.accepted,true);assert.equal(receipt.execution_authorized,false);assert.equal(count(f.db,'wb_workspace_reservation_settlements'),0);assert.equal(count(f.db,'ga_worker_leases'),0);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),before);assert.equal(f.calls,0);
});

test('one immutable original confirmation survives response loss, reopen and approval cancellation without effects',async t=>{
 const f=await indexResolutionFixture(t),{accepted,approved}=await f.admit(),command=input(f,accepted.execution_id),before=await readFile(join(f.repository,'.git/index'));
 const receipt=withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,command));assert.equal(receipt.accepted,true);assert.equal(receipt.execution_authorized,false);assert.equal(receipt.expected_state_sha256,command.expected_state_sha256);
 f.reopen();await f.current.intents.control('owner','project',approved.intent_id,{request_id:'revoke-after-resolution',action:'cancel',expected_version:approved.version,review_sha256:approved.review_sha256});
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,command)),receipt);assert.deepEqual(f.current.executions.getResolutionAdmission('owner','project',accepted.execution_id,command.request_id),receipt);
 assert.equal(f.current.executions.getControl('owner','project',accepted.execution_id,command.request_id).state,'pending');assert.equal(count(f.db,'wb_git_index_controls'),1);assert.equal(count(f.db,'ga_worker_leases'),0);assert.equal(count(f.db,'wb_git_index_producers'),0);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);
});

test('malformed, stale, foreign and replacement confirmation requests cannot replace the original decision',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),command=input(f,accepted.execution_id),admit=value=>withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,value));
 for(const value of [{...command,acknowledge_unknown:false},{...command,expected_state_sha256:'0'.repeat(64)},{...command,root:f.repository}])assert.throws(()=>admit(value),/git_execution_control_invalid|version_conflict/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('foreign','project',accepted.execution_id,command)),/project_not_found/);assert.equal(count(f.db,'wb_git_index_controls'),0);
 const original=admit(command);assert.throws(()=>admit({...command,request_id:'replacement'}),/git_execution_control_exists/);assert.throws(()=>admit({...command,expected_state_sha256:'0'.repeat(64)}),/idempotency_conflict/);assert.equal(count(f.db,'wb_git_index_controls'),1);assert.deepEqual(f.current.executions.getResolutionAdmission('owner','project',accepted.execution_id,command.request_id),original);
});

test('accepted confirmation fences both original direct and reserved dispatch without another producer or index write',async t=>{
 const f=await indexResolutionFixture(t),{accepted,input:execute,approved}=await f.admit(),before=await readFile(join(f.repository,'.git/index'));
 withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,input(f,accepted.execution_id)));
 await assert.rejects(f.current.executions.perform('owner','project',accepted.execution_id),/git_execution_control_pending/);await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,execute),/git_execution_control_pending/);assert.throws(()=>f.current.executions.reserveWorkspace('owner','project',accepted.execution_id),/git_execution_control_pending/);
 assert.equal(count(f.db,'wb_git_index_producers'),0);assert.equal(count(f.db,'ga_worker_leases'),0);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);
});

test('confirmation admitted during asynchronous preparation revokes the original effect fence but not its receipt',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),kernel=f.current.workbench.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel),before=await readFile(join(f.repository,'.git/index'));let release,ready;
 const held=new Promise(done=>{release=done}),entered=new Promise(done=>{ready=done});kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);ready();await held;return plan};
 const running=f.current.executions.perform('owner','project',accepted.execution_id);running.catch(()=>{});await entered;
 let receipt,command;try{command=input(f,accepted.execution_id);receipt=withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,command))}finally{release()}
 await assert.rejects(running,/git_execution_control_pending/);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);assert.equal(count(f.db,'wb_git_index_dispatches'),0);assert.equal(count(f.db,'ga_worker_leases'),0);
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',accepted.execution_id,command)),receipt);
});
