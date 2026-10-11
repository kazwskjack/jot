import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {buildServer} from '../../src/server.ts';

import {crash} from './task-receipt-fault-fixture.mjs';
const payload=card=>card.kind==='question'?{expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Markdown with sources.'}]}:{expected_version:card.version,action_digest:card.action_digest,decision:'approve'};
const request=(f,card,body)=>({method:'POST',url:`/v1/interactions/${card.interaction_id}/${card.kind==='question'?'response':'decision'}`,headers:f.headers,payload:body});

test('a real process exit after committed input, confirmation or refusal recovers the original receipt without replaying its effects',async t=>{
 for(const kind of ['input','approve','deny']){
  const f=await fixture(t,kind==='input'?'wait_user':'wait_approval'),card=(await f.list())[0],body=payload(card);if(kind==='deny')body.decision='deny';const req=request(f,card,body);
  await crash(f,req,'after_domain');
  assert.equal(f.db.prepare('SELECT response_status FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get('alice',`POST ${req.url}`,f.headers['idempotency-key']).response_status,null);
  assert.equal(f.db.prepare('SELECT status FROM ga_interactions WHERE id=?').get(card.interaction_id).status,kind==='deny'?'denied':'answered');
  const expectedRuns=kind==='deny'?1:2;assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,expectedRuns);
  const before=f.modelBudgets.balancesForRun('alice',f.runId),events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
  const proof=f.db.prepare('SELECT * FROM wb_task_wait_receipts WHERE interaction_id=?').get(card.interaction_id);assert.equal(proof.idempotency_key,f.headers['idempotency-key']);
  assert.throws(()=>f.db.prepare('UPDATE wb_task_wait_receipts SET receipt_json=? WHERE interaction_id=?').run('{}',card.interaction_id),/task_wait_receipt_immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM wb_task_wait_receipts WHERE interaction_id=?').run(card.interaction_id),/task_wait_receipt_immutable/);
  const other=await buildServer(f.fixtureConfig);
  try{
   const replay=await other.app.inject(req);assert.equal(replay.statusCode,202,replay.body);
   assert.deepEqual(replay.json(),{accepted:true,interaction_id:card.interaction_id,run_id:f.runId,status:kind==='deny'?'denied':'answered',version:2});
   assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,expectedRuns);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),before);assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
   const again=await f.app.inject(req);assert.equal(again.body,replay.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0);
   t.diagnostic(JSON.stringify({kind,crash:'after_domain_before_onSend',process_exit:73,runs:expectedRuns,replay_status:replay.statusCode,immutable_receipt:true,duplicate_effects:0}));
  }finally{await other.app.close();other.db.close();}
 }
});

test('a process exit inside the answer transaction rolls back the result, event, lineage and budget together',async t=>{
 const f=await fixture(t),card=(await f.list())[0],req=request(f,card,payload(card));
 const tables=['ga_runs','ga_outbox','ga_events','wb_task_run_occurrences','wb_task_wait_responses','wb_task_wait_receipts','wb_model_budget_bindings','wb_model_budget_attempts','wb_model_budget_events'];
 const counts=()=>Object.fromEntries(tables.map(name=>[name,f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n]));
 const before=counts(),balances=f.modelBudgets.balancesForRun('alice',f.runId),parent=f.runs.get(f.runId,'alice');
 await crash(f,req,'in_transaction');
 assert.deepEqual(counts(),before);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balances);assert.deepEqual(f.runs.get(f.runId,'alice'),parent);assert.equal((await f.list())[0].status,'pending');
 const replay=await f.app.inject(req);assert.equal(replay.statusCode,409,replay.body);assert.equal(replay.json().error.code,'IDEMPOTENCY_IN_PROGRESS');
 t.diagnostic(JSON.stringify({crash:'in_transaction_after_receipt_insert',process_exit:73,rolled_back:true,replay_status:409,automatic_replay:false}));
});

test('committed recovery requires the original owner, key, operation, CSRF and exact canonical body even after later task revocation',async t=>{
 const f=await fixture(t),card=(await f.list())[0],req=request(f,card,payload(card));await crash(f,req,'after_domain');
 const effects=()=>({runs:f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,events:f.db.prepare('SELECT count(*) n FROM ga_events').get().n,budgets:f.modelBudgets.balancesForRun('alice',f.runId)});
 const before=effects();
 for(const [bad,status] of [
  [{...req,headers:{...req.headers,'x-user-id':'bob'}},404],
  [{...req,headers:{...req.headers,'x-csrf-token':'incorrect'}},403],
  [{...req,headers:{...req.headers,'idempotency-key':'another-recovery-key'}},409],
  [{...req,payload:{...req.payload,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Changed.'}]}},409],
  [{...req,url:`/v1/interactions/${card.interaction_id}/decision`,payload:{expected_version:1,action_digest:'sha256:'+'a'.repeat(64),decision:'approve'}},409],
 ]){
  const response=await f.app.inject(bad);assert.equal(response.statusCode,status,response.body);assert.deepEqual(effects(),before);
 }
 const task=f.persistentTasks.get('alice',f.task.task_id);f.persistentTasks.pause('alice',f.task.task_id,task.version);const stopped=effects();
 // Historical acknowledgement is safe after revocation; it must not restart
 // the cancelled continuation or rerun admission against new authority.
 const reordered={...req,payload:{answers:req.payload.answers,expected_version:req.payload.expected_version}};
 const original=await f.app.inject(reordered);assert.equal(original.statusCode,202,original.body);assert.deepEqual(effects(),stopped);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].status,'cancelled');
});

test('failure saving the immutable receipt rolls back an otherwise accepted answer instead of leaving a recoverable false success',async t=>{
 const f=await fixture(t),card=(await f.list())[0],req=request(f,card,payload(card));
 const balance=f.modelBudgets.balancesForRun('alice',f.runId),events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 f.db.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON wb_task_wait_receipts BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END");
 const response=await f.app.inject(req);assert.equal(response.statusCode,500,response.body);assert.equal((await f.list())[0].status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_wait_receipts').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balance);
});

test('a process exit before the domain handler has no committed result to replay and never guesses a continuation',async t=>{
 const f=await fixture(t),card=(await f.list())[0],req=request(f,card,payload(card));await crash(f,req,'before_handler');
 const replay=await f.app.inject(req);assert.equal(replay.statusCode,409,replay.body);assert.equal(replay.json().error.code,'IDEMPOTENCY_IN_PROGRESS');assert.equal((await f.list())[0].status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});

test('a pre-upgrade result without immutable receipt proof remains unresolved instead of inventing success from its current task state',async t=>{
 const f=await fixture(t),card=(await f.list())[0],req=request(f,card,payload(card));await crash(f,req,'legacy_after_domain');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_wait_receipts').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 const events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n,budgets=f.modelBudgets.balancesForRun('alice',f.runId);
 const replay=await f.app.inject(req);assert.equal(replay.statusCode,409,replay.body);assert.equal(replay.json().error.code,'IDEMPOTENCY_IN_PROGRESS');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),budgets);
});
