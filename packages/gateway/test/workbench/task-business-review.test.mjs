import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture,candidate} from './task-completion-fixture.mjs';
import {crash} from './task-receipt-fault-fixture.mjs';
import {buildServer} from '../../src/server.ts';
const body=(card,option='accept')=>({expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:[option],custom_text:''}))});
const send=(f,card,input,key='test-business-review-original')=>f.send(`/v1/interactions/${card.interaction_id}/response`,input,{'idempotency-key':key});

test('the owner reviews each frozen criterion and accepted answers create one immutable certificate without running or publishing again',async t=>{
 const f=await completionFixture(t),card=(await f.list())[0];
 assert.equal(card.purpose,'task_acceptance_review');assert.equal(card.kind,'question');assert.equal(card.questions[0].description,candidate.text);
 assert.equal(card.questions.length,2);assert.ok(card.questions.some(q=>q.prompt==='The source supports the report conclusion.'));assert.deepEqual(card.questions[0].options.map(o=>o.option_id),['accept','reject']);
 const before=f.modelBudgets.balancesForRun('alice',f.runId);
 const response=await send(f,card,body(card));assert.equal(response.statusCode,202,response.body);
 const cert=f.db.prepare('SELECT * FROM wb_task_business_certificates WHERE run_id=?').get(f.runId);assert.ok(cert);assert.equal(cert.occurrence_id,f.occurrence.occurrence_id);
 const review=f.db.prepare('SELECT * FROM wb_task_business_reviews WHERE interaction_id=?').get(card.interaction_id);assert.equal(review.owner_id,'alice');assert.equal(review.verdict,'accepted');
 assert.equal(JSON.parse(review.evaluations_json)[0].method,'owner_confirmation');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),before);
 assert.equal((await send(f,card,body(card))).body,response.body);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,1);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_business_reviews WHERE interaction_id=?').run(card.interaction_id),/task_business_review_immutable/);
 assert.throws(()=>f.db.prepare('UPDATE wb_task_business_certificates SET candidate_hash=? WHERE certificate_id=?').run('changed',cert.certificate_id),/task_business_certificate_immutable/);
});

test('a rejected criterion records its actual owner judgment but cannot issue a certificate or resume execution',async t=>{
 const f=await completionFixture(t),card=(await f.list())[0],input=body(card);input.answers[1].selected_option_ids=['reject'];input.answers[1].custom_text='The source does not support this conclusion.';
 const response=await send(f,card,input);assert.equal(response.statusCode,202,response.body);
 const review=f.db.prepare('SELECT * FROM wb_task_business_reviews WHERE interaction_id=?').get(card.interaction_id);assert.equal(review.verdict,'rejected');assert.match(review.evaluations_json,/does not support/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT business_state FROM wb_task_occurrences WHERE occurrence_id=?').get(f.occurrence.occurrence_id).business_state,'acceptance_rejected');
 assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');
});

test('missing, duplicated, foreign or stale judgments cannot resolve the review card',async t=>{
 for(const fault of ['missing','duplicate','foreign','stale','authority']){
  const f=await completionFixture(t),card=(await f.list())[0],input=body(card);
  if(fault==='missing')input.answers.pop();
  if(fault==='duplicate')input.answers[1]={...input.answers[0]};
  if(fault==='foreign')input.answers[0].question_id='foreign-step';
  if(fault==='authority')input.owner_id='mallory';
  if(fault==='stale'){
   const step=f.persistentTasks.subtasks('alice',f.task.task_id).items[0];
   f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,acceptance:'A changed criterion.'},f.runId);
  }
  const response=await send(f,card,input);assert.ok([400,409,422].includes(response.statusCode),response.body);
  assert.equal((await f.list())[0].status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
 }
});

test('an unresolved output reference cannot be certified as verified content; the owner can still reject it',async t=>{
 const f=await completionFixture(t,{candidate:{...candidate,presented_files:[{path:'unverified.docx'}]}}),card=(await f.list())[0];
 const response=await send(f,card,body(card));assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'TASK_ACCEPTANCE_OUTPUTS_UNVERIFIED');
 assert.equal((await f.list())[0].status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_reviews').get().n,0);
 const rejected=await send(f,card,body(card,'reject'),'reject-unverified-output');assert.equal(rejected.statusCode,202,rejected.body);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
});

test('real post-commit process exits recover accepted or rejected review receipts without repeating certification',async t=>{
 for(const option of ['accept','reject']){
  const f=await completionFixture(t),card=(await f.list())[0],input=body(card,option);
  const req={method:'POST',url:`/v1/interactions/${card.interaction_id}/response`,headers:{...f.headers,'idempotency-key':'review-crash-original'},payload:input};
  await crash(f,req,'after_domain');
  const before=f.modelBudgets.balancesForRun('alice',f.runId),events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
  const other=await buildServer(f.fixtureConfig);
  try{
   const result=await other.app.inject(req);assert.equal(result.statusCode,202,result.body);
   assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_reviews').get().n,1);
   assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,option==='accept'?1:0);
   assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),before);
  }finally{await other.app.close();other.db.close();}
 }
});

test('failure saving the business certificate rolls the answers and review back, leaving the original card pending',async t=>{
 const f=await completionFixture(t),card=(await f.list())[0];
 f.db.exec("CREATE TRIGGER certificate_save_fault BEFORE INSERT ON wb_task_business_certificates BEGIN SELECT RAISE(ABORT,'certificate_save_failed'); END");
 const response=await send(f,card,body(card));assert.equal(response.statusCode,500);
 assert.equal((await f.list())[0].status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_reviews').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_wait_receipts').get().n,0);
});
