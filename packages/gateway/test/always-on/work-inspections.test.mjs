import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {workGrantFixture} from './work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {TrustedWorkRunWorkspaceResolver,selectedWorkObjective} from '../../src/always-on/work-run-workspace.ts';
import {installIsolatedWorkFiles} from '../../src/always-on/isolated-work-file-schema.ts';
import {IsolatedWorkFiles} from '../../src/always-on/isolated-work-files.ts';
import {WorkInspections} from '../../src/always-on/work-inspections.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

async function fixture(t){
 const f=await workGrantFixture(t);installIsolatedWorkFiles(f.db);const grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'select-work');
 const now=Date.now(),admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:now}));
 const claimed=f.coordinator.claimNext('workspace-worker',60000);assert.equal(claimed.run_id,admission.run_id);f.coordinator.start(claimed);const lease={owner:claimed.owner,generation:claimed.generation};f.budget.ledger.releaseUndispatched('owner',admission.run_id,'queue-admission');
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner','work-test-session',new Date(now).toISOString(),new Date(now).toISOString());
 const resolver=new TrustedWorkRunWorkspaceResolver({db:f.db,workbench:f.workbench,policies:f.policies,workspace:f.manager});
 return {...f,grant,admission,claimed,lease,resolver};
}


async function writer(f){
 const proofs=new TaskExecutionEvidence(f.db);
 return new IsolatedWorkFiles({db:f.db,resolve:id=>f.resolver.resolveFiles(id,f.lease),commitReceipt:(db,result)=>{
  const {operation,...args}=JSON.parse(db.prepare('SELECT i.operation_json FROM wb_isolated_file_intents i JOIN wb_isolated_file_results r ON r.call_key=i.call_key WHERE r.receipt_id=?').get(result.receipt_id).operation_json),proof=proofs.record(result.run_id,result.call_id,operation,result);
  db.prepare('INSERT INTO wb_tool_receipts VALUES(?,?,?,?,?)').run(result.run_id,result.call_id,createHash('sha256').update(canonicalJson({operation,args})).digest('hex'),JSON.stringify({...result,execution_receipt:proof}),new Date().toISOString());
 }});
}
function identity(f,call_id){return {owner_id:'owner',...f.scope,cycle_id:f.admission.cycle_id,snapshot_id:f.admission.snapshot_id,run_id:f.admission.run_id,occurrence_id:f.admission.occurrence_id,call_id};}
function scope(f){return {owner_id:'owner',task_id:f.admission.task_id,occurrence_id:f.admission.occurrence_id,root_run_id:f.admission.run_id,frozen_context:JSON.stringify(f.scope),runId:f.admission.run_id};}

test('full physical work inspection freezes original base, full result, diff and exact original write proofs',async t=>{
 const f=await fixture(t),files=await writer(f),written=await files.execute(identity(f,'write-first'),{operation:'files.write',path:'source.md',content:'Inspected isolated result',expected_version:0});
 const service=new WorkInspections({db:f.db,resolver:f.resolver});assert.throws(()=>service.current(scope(f)),/task_completion_work_inspection_required/);
 const evidence=await service.collect(f.admission.run_id,f.lease);
 assert.equal(evidence.selected_objective,f.resolver.context(f.admission.run_id).objective);assert.notEqual(evidence.selected_objective,f.tasks.get('owner',f.admission.task_id).objective);
 assert.equal(evidence.protocol,1);assert.equal(evidence.grant_id,f.grant.grant_id);assert.equal(evidence.work_occurrence_id,f.admission.occurrence_id);
 assert.deepEqual(evidence.base_manifest,f.prepared.snapshot.manifest);assert.equal(evidence.result_manifest.entries.find(e=>e.path==='source.md').sha256,written.sha256);
 assert.equal(evidence.diff.changes.length,1);assert.equal(evidence.diff.changes[0].kind,'modify');
 assert.deepEqual(evidence.write_receipt_ids,[f.db.prepare('SELECT receipt_id FROM wb_task_isolated_file_execution_receipts WHERE isolated_receipt_id=?').get(written.receipt_id).receipt_id]);
 assert.deepEqual(service.current(scope(f)),evidence);assert.ok(Object.isFrozen(evidence));
 const stamp=new Date().toISOString();f.db.prepare('INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?)').run(f.admission.run_id,f.admission.occurrence_id,'inspection-fixture-goal',2,stamp,stamp);
 f.coordinator.recordCheckpoint(f.claimed,'work-test-session',{session_ref:'work-test-session',seq_exclusive:5,turn_end_seq:4,goal_id:'inspection-fixture-goal',goal_revision:2,log_sha256:'a'.repeat(64)});
 assert.deepEqual(service.current(scope(f)),evidence);
 for(const sql of ['UPDATE wb_discovery_work_inspections SET run_id=run_id','DELETE FROM wb_discovery_work_inspections','INSERT OR REPLACE INTO wb_discovery_work_inspections SELECT * FROM wb_discovery_work_inspections'])assert.throws(()=>f.db.exec(sql),/immutable/);
 await files.execute(identity(f,'read-later'),{operation:'files.read',path:'source.md'});assert.throws(()=>service.current(scope(f)),/task_completion_work_inspection_required/);
 const next=await service.collect(f.admission.run_id,f.lease);assert.notEqual(next.inspection_sha256,evidence.inspection_sha256);
});

test('actual full tree corruption and missing original proof cannot create successful inspections',async t=>{
 const f=await fixture(t),service=new WorkInspections({db:f.db,resolver:f.resolver});
 const unproved=new IsolatedWorkFiles({db:f.db,resolve:id=>f.resolver.resolveFiles(id,f.lease),commitReceipt:()=>{}});
 await unproved.execute(identity(f,'unproved-write'),{operation:'files.write',path:'source.md',content:'No original proof',expected_version:0});
 await assert.rejects(()=>service.collect(f.admission.run_id,f.lease),/task_completion_work_inspection_required/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_inspections').get().n,0);
});

test('inspection refuses outer transactions, wrong leases, copied context injection and ordinary runs',async t=>{
 const f=await fixture(t),service=new WorkInspections({db:f.db,resolver:f.resolver});
 f.db.exec('BEGIN');try{await assert.rejects(()=>service.collect(f.admission.run_id,f.lease),/task_completion_work_inspection_required/);}finally{f.db.exec('ROLLBACK');}
 await assert.rejects(()=>service.collect(f.admission.run_id,{...f.lease,generation:f.lease.generation+1}),/task_completion_work_inspection_required/);
 await writeFile(join(f.prepared.snapshot.isolated_root,'injected-context.txt'),'Not an approved change');
 await assert.rejects(()=>service.collect(f.admission.run_id,f.lease),/task_completion_work_inspection_required/);
 assert.equal(service.current({...scope(f),runId:'ordinary-missing-run',occurrence_id:'ordinary-missing-occurrence'}),undefined);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_inspections').get().n,0);
});

test('a later original isolated call during inspection loses the final fence and cannot freeze an old tree',async t=>{
 const f=await fixture(t),files=await writer(f);await files.execute(identity(f,'write-race-base'),{operation:'files.write',path:'source.md',content:'Before racing read',expected_version:0});
 const resolver={context:(...args)=>f.resolver.context(...args),inspectForRun:async(...args)=>{assert.equal(f.db.isTransaction,false);const inspected=await f.resolver.inspectForRun(...args);await files.execute(identity(f,'read-during-inspection'),{operation:'files.read',path:'source.md'});return inspected;}};
 const service=new WorkInspections({db:f.db,resolver});
 await assert.rejects(()=>service.collect(f.admission.run_id,f.lease),/task_completion_work_inspection_required/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_inspections').get().n,0);
});

test('unknown original usage and revoked work authority invalidate a previously real full inspection',async t=>{
 const f=await fixture(t),service=new WorkInspections({db:f.db,resolver:f.resolver});await service.collect(f.admission.run_id,f.lease);
 f.budget.ledger.reserve('owner',f.admission.run_id,{attempt_id:'unfinished-inspection-model',provider:'fixture',model:'bounded'});
 assert.throws(()=>service.current(scope(f)),/task_completion_work_inspection_required/);
 await assert.rejects(()=>service.collect(f.admission.run_id,f.lease),/task_completion_work_inspection_required/);
 f.budget.ledger.releaseUndispatched('owner',f.admission.run_id,'unfinished-inspection-model');assert.ok(service.current(scope(f)));
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-inspected-work');
 assert.throws(()=>service.current(scope(f)),/task_completion_work_inspection_required/);
});

test('unknown pending isolated replacement is never a successful full inspection',async t=>{
 const f=await fixture(t),service=new WorkInspections({db:f.db,resolver:f.resolver});
 const uncertain=new IsolatedWorkFiles({db:f.db,resolve:id=>f.resolver.resolveFiles(id,f.lease),commitReceipt:()=>{throw Error('fixture original commit lost');}});
 await assert.rejects(()=>uncertain.execute(identity(f,'unknown-replacement'),{operation:'files.write',path:'source.md',content:'Pending replacement',expected_version:0}),/commit lost/);
 await assert.rejects(()=>service.collect(f.admission.run_id,f.lease),/task_completion_work_inspection_required/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_inspections').get().n,0);
});

test('new original owner input invalidates synchronous inspection before source ingestion or a new native call',async t=>{
 const f=await fixture(t),service=new WorkInspections({db:f.db,resolver:f.resolver});await service.collect(f.admission.run_id,f.lease);
 const run=f.runs.enqueue(f.agent.conversation_id,'owner',{client_message_id:'owner-after-work-inspection',content:[{type:'text',text:'The required project change is different.'}]});
 f.workbench.bindRun('owner',f.agent.agent_id,run.run_id,'chat');f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(run.run_id);
 assert.throws(()=>service.current(scope(f)),/task_completion_work_inspection_required/);
});

import Fastify from 'fastify';
import {currentTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';
import {configureTaskOutputReader} from '../../src/persistent-tasks/output-content.ts';
import {readIsolatedTaskFileVersion} from '../../src/persistent-tasks/isolated-output-source.ts';
import {createNativeWorkRuntime} from '../../src/always-on/native-work-runtime.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';

test('an original complete proposal cannot silently bind a later successful inspection of the same pinned write',async t=>{
 const f=await fixture(t),runtime=createNativeWorkRuntime({db:f.db,workbench:f.workbench,root:join(f.root,'grant-snapshots'),executionReady:true,budgetPolicy:f.budget});
 configureTaskOutputReader(f.db,input=>readIsolatedTaskFileVersion(f.db,input.source));
 const app=Fastify();t.after(()=>app.close());app.setErrorHandler((error,request,reply)=>reply.status(400).send({error:error.message}));
 const tasks=new PersistentTaskService(f.db,f.workbench,{modelBudgetPolicy:f.budget,discoveryWorkOperations:runtime});
 registerWorkbenchExecution(app,f.db,f.workbench,tasks,'test-inspect-11df6d',f.budget.ledger,undefined,undefined,runtime);
 const originalIdentity={run_id:f.admission.run_id,session_ref:'work-test-session',execution_lease:f.lease};
 const post=(path,payload)=>app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer test-inspect-11df6d'},payload:{...originalIdentity,...payload}});
 const tool=(operation,args,call_id)=>post('tool',{operation,arguments:args,call_id});
 const write=await tool('files.write',{path:'source.md',content:'Reviewed fixed version',expected_version:0},'proposal-pinned-write');assert.equal(write.statusCode,200,write.body);
 for(const step of tasks.subtasks('owner',f.admission.task_id).items){const complete=await tool('tasks.upsert',{subtask_id:step.subtask_id,expected_version:step.version,status:'completed',evidence:[write.json().execution_receipt]},'proposal-complete-'+step.subtask_id);assert.equal(complete.statusCode,200,complete.body);}
 assert.equal((await post('goal-binding',{action:'save',goal_id:'inspection-drift-goal',goal_revision:1})).statusCode,200);
 const proposal=await post('goal-proposal',{call_id:'proposal-before-read',goal_id:'inspection-drift-goal',goal_revision:1,intent:'complete',summary:'Inspect the fixed output',files:[{path:'source.md'}]});assert.equal(proposal.statusCode,200,proposal.body);
 const prior=JSON.parse(f.db.prepare('SELECT snapshot_json FROM wb_task_goal_proposals WHERE run_id=?').get(f.admission.run_id).snapshot_json).isolated_work_evidence;
 const later=await tool('files.read',{path:'source.md'},'proposal-later-read');assert.equal(later.statusCode,200,later.body);
 const recollected=await runtime.inspections.collect(f.admission.run_id,f.lease);assert.notEqual(recollected.inspection_sha256,prior.inspection_sha256);
 assert.equal((await post('goal-binding',{action:'save',goal_id:'inspection-drift-goal',goal_revision:2})).statusCode,200);
 f.coordinator.recordCheckpoint(f.claimed,'work-test-session',{session_ref:'work-test-session',seq_exclusive:5,turn_end_seq:4,goal_id:'inspection-drift-goal',goal_revision:2,log_sha256:'a'.repeat(64)});
 assert.throws(()=>f.coordinator.waitForTask(f.claimed,{goal_id:'inspection-drift-goal',goal_revision:2,phase:'paused',turn_end_seq:4},'SESSION_GOAL_WAITING_APPROVAL',{text:'The pinned output is ready'}),/task_completion_state_conflict/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_candidates WHERE run_id=?').get(f.admission.run_id).n,0);
 // A new actual proposal may explicitly bind the new complete inspection.
 const newProposal=await post('goal-proposal',{call_id:'proposal-after-read',goal_id:'inspection-drift-goal',goal_revision:2,intent:'complete',summary:'Review the newly inspected scope',files:[{path:'source.md'}]});assert.equal(newProposal.statusCode,200,newProposal.body);
 assert.equal((await post('goal-binding',{action:'save',goal_id:'inspection-drift-goal',goal_revision:3})).statusCode,200);
 f.coordinator.recordCheckpoint(f.claimed,'work-test-session',{session_ref:'work-test-session',seq_exclusive:7,turn_end_seq:6,goal_id:'inspection-drift-goal',goal_revision:3,log_sha256:'b'.repeat(64)});
 f.coordinator.waitForTask(f.claimed,{goal_id:'inspection-drift-goal',goal_revision:3,phase:'paused',turn_end_seq:6},'SESSION_GOAL_WAITING_APPROVAL',{text:'The exact new inspection is ready'});
 const frozen=currentTaskCompletionCandidate(f.db,'owner',f.admission.run_id);assert.equal(frozen.snapshot.objective,f.resolver.context(f.admission.run_id).objective);assert.equal(frozen.snapshot.isolated_work_evidence.inspection_sha256,recollected.inspection_sha256);
 const realCurrent=runtime.inspections.current.bind(runtime.inspections);let invoked=0;
 const rejected=Promise.reject(Error('fixture_completion_hook_rejection'));rejected.then=()=>{invoked++;throw Error('overridden_then_must_not_run');};
 runtime.inspections.current=()=>rejected;
 assert.throws(()=>currentTaskCompletionCandidate(f.db,'owner',f.admission.run_id),/task_completion_work_inspection_required/);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(invoked,0);
 for(const value of [{then(){invoked++;}},Object.assign(()=>{},{then(){invoked++;}})]){
  runtime.inspections.current=()=>value;assert.throws(()=>currentTaskCompletionCandidate(f.db,'owner',f.admission.run_id),/task_completion_work_inspection_required/);
 }
 assert.equal(invoked,0);runtime.inspections.current=realCurrent;

 // Simulate storage corruption replacing the proposal's inspection with an
 // earlier genuine inspection; the frozen candidate must reject that linkage.
 const saved=f.db.prepare('SELECT proposal_id,snapshot_json FROM wb_task_goal_proposals WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(f.admission.run_id),snapshot=JSON.parse(saved.snapshot_json);snapshot.isolated_work_evidence=prior;
 f.db.exec('DROP TRIGGER wb_goal_proposal_no_update');f.db.prepare('UPDATE wb_task_goal_proposals SET snapshot_json=? WHERE proposal_id=?').run(JSON.stringify(snapshot),saved.proposal_id);
 assert.throws(()=>currentTaskCompletionCandidate(f.db,'owner',f.admission.run_id),/task_completion_state_conflict/);
});
