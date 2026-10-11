import test from 'node:test';
import assert from 'node:assert/strict';
import * as reviews from '../../src/persistent-tasks/business-review.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {completionFixture,candidate} from './task-completion-fixture.mjs';
import {fixture} from './task-wait-fixture.mjs';
import {prepare} from './task-completion-fixture.mjs';

const inspect=f=>withImmediateTransaction(f.db,()=>reviews.currentTaskBusinessCertificate(f.db,'alice',f.runId));
async function accept(f,option='accept'){
 const card=(await f.list())[0];
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,
  answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:[option],custom_text:''}))});
 assert.equal(response.statusCode,202,response.body);
 return card;
}

test('the internal certificate guard requires a transaction and returns the current owner-reviewed frozen result without side effects',async t=>{
 const f=await completionFixture(t);await accept(f);
 const before={runs:f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,events:f.db.prepare('SELECT count(*) n FROM ga_events').get().n,
  budget:f.modelBudgets.balancesForRun('alice',f.runId)};
 assert.throws(()=>reviews.currentTaskBusinessCertificate(f.db,'alice',f.runId),/task_business_certificate_transaction_required/);
 const value=inspect(f);assert.equal(value.candidate.text,candidate.text);assert.equal(value.snapshot.occurrence_id,f.occurrence.occurrence_id);
 assert.equal(value.snapshot.budget_attempts.find(a=>a.attempt_id==='spent').actual_nano_usd,'60');assert.equal(value.evaluations.length,2);
 assert.equal(value.certificate_id,f.db.prepare('SELECT certificate_id FROM wb_task_business_certificates').get().certificate_id);
 assert.deepEqual(inspect(f),value);
 assert.deepEqual({runs:f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,events:f.db.prepare('SELECT count(*) n FROM ga_events').get().n,
  budget:f.modelBudgets.balancesForRun('alice',f.runId)},before);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});

test('missing, rejected or foreign certificates cannot authorize finalization',async t=>{
 for(const kind of ['missing','rejected','foreign-owner','foreign-run']){
  const f=await completionFixture(t);
  if(kind!=='missing')await accept(f,kind==='rejected'?'reject':'accept');
  assert.throws(()=>withImmediateTransaction(f.db,()=>reviews.currentTaskBusinessCertificate(f.db,
   kind==='foreign-owner'?'mallory':'alice',kind==='foreign-run'?'another-run':f.runId)),/task_business_certificate_not_found/);
 }
});

test('an outstanding reserved call prevents freezing a business candidate until its hold is released or settled',async t=>{
 let observed;
 await assert.rejects(fixture(t,'complete',{prepare,candidate,afterProposal:async f=>{
  observed=f;f.modelBudgets.reserve('alice',f.runId,{attempt_id:'unfinished-auxiliary',provider:'fixture',model:'bounded',purpose:'session-title'});
 }}),/budget_usage_unknown/);
 assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_completion_candidates').get().n,0);
 assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_wait_interactions').get().n,0);
 assert.equal(observed.runs.get(observed.runId,'alice').status,'running');
});

test('a historical certificate becomes unusable when criteria, evidence, authority, Goal, checkpoint or settled occurrence fees change',async t=>{
 for(const kind of ['criteria','evidence','task','role','goal','checkpoint','late-fees','business-state']){
  const f=await completionFixture(t);await accept(f);const certificate=inspect(f);
  const step=f.persistentTasks.subtasks('alice',f.task.task_id).items[0];
  if(kind==='criteria')f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,acceptance:'New condition'},f.runId);
  if(kind==='evidence')f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,evidence:[{kind:'tool_receipt',reference:'unobserved'}]},f.runId);
  if(kind==='task')f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  if(kind==='role')f.workbench.updateAgent('alice',f.a.agent_id,{expected_version:f.a.version,status:'disabled'});
  if(kind==='goal')f.db.prepare('UPDATE wb_native_goal_bindings SET goal_revision=goal_revision+1 WHERE run_id=?').run(f.runId);
  if(kind==='checkpoint')f.db.prepare('UPDATE ga_runs SET version=version+1 WHERE id=?').run(f.runId);
  // An explicit storage fixture simulates a newly reconciled auxiliary receipt.
  // Existing settled receipts remain immutable; no production mutation path is added.
  if(kind==='late-fees')f.db.prepare(`INSERT INTO wb_model_budget_attempts SELECT run_id,'late-auxiliary',request_json,route_json,state,
   held_tokens,held_nano_usd,usage_json,actual_tokens,actual_nano_usd,bound_exceeded,reason,created_at,updated_at
   FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='spent'`).run(f.runId);
  if(kind==='business-state')f.db.prepare("UPDATE wb_task_occurrences SET business_state='acceptance_rejected' WHERE occurrence_id=?").run(f.occurrence.occurrence_id);
  assert.throws(()=>inspect(f),/task_completion_state_conflict|task_completion_evidence_required|task_business_certificate_state_conflict/,kind);
  assert.equal(f.db.prepare('SELECT certificate_id FROM wb_task_business_certificates').get().certificate_id,certificate.certificate_id);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 }
});

test('another task using shared budget scopes does not invalidate this occurrence certificate',async t=>{
 const f=await completionFixture(t);await accept(f);const before=inspect(f);
 const other=f.persistentTasks.create('alice',{title:'Another independent task',agent_id:f.a.agent_id,objective:'Read another source',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 const next=f.persistentTasks.runNow('alice',other.task_id,'independent');assert.notEqual(next.run_id,f.runId);
 assert.deepEqual(inspect(f),before);
});

test('storage corruption of a certificate hash or its judgment cannot pass the finalization guard',async t=>{
 for(const corrupt of ['snapshot-hash','candidate-hash','judgment']){
  const f=await completionFixture(t);await accept(f);
  // Fault injection into a fresh isolated database only. Production immutable
  // triggers remain installed and no mutation endpoint is introduced.
  if(corrupt==='judgment'){
   f.db.exec('DROP TRIGGER wb_task_business_reviews_no_update');
   f.db.prepare("UPDATE wb_task_business_reviews SET evaluations_json='[]'").run();
  }else{
   f.db.exec('DROP TRIGGER wb_task_business_certificates_no_update');
   f.db.prepare(`UPDATE wb_task_business_certificates SET ${corrupt==='snapshot-hash'?'snapshot_hash':'candidate_hash'}=?`).run('b'.repeat(64));
  }
  assert.throws(()=>inspect(f),/task_business_certificate_state_conflict/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 }
});
