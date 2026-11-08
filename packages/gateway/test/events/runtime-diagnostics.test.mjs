import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { ModelBudgetLedger } from '../../src/workbench/model-budget.ts';
import { readRunRuntimeDiagnostics } from '../../src/events/runtime-diagnostics.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ga_runs(id TEXT PRIMARY KEY,conversation_id TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE ga_events(conversation_id TEXT,seq INTEGER,run_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE wb_model_budget_attempts(run_id TEXT,attempt_id TEXT,request_json TEXT,route_json TEXT,state TEXT,
      usage_json TEXT,actual_tokens TEXT,actual_nano_usd TEXT,reason TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE wb_model_budget_events(run_id TEXT,attempt_id TEXT,state TEXT,detail_json TEXT,created_at TEXT);
  `);
  db.prepare('INSERT INTO ga_runs VALUES(?,?,?,?,?)').run('r1','c1','succeeded','2026-10-21T10:00:00.000Z','2026-10-21T10:00:06.000Z');
  const event = db.prepare('INSERT INTO ga_events VALUES(?,?,?,?,?,?)');
  event.run('c1',1,'r1','run.state',JSON.stringify({status:'queued'}),'2026-10-21T10:00:00.000Z');
  event.run('c1',2,'r1','run.state',JSON.stringify({status:'starting'}),'2026-10-21T10:00:02.000Z');
  event.run('c1',3,'r1','runtime.preparation_timing',JSON.stringify({event:'jot_preparation_timing',phase:'preparation_total',duration_ms:120,outcome:'succeeded',run_hash:'a'.repeat(64)}),'2026-10-21T10:00:04.000Z');
  event.run('c1',4,'r1','assistant.delta',JSON.stringify({attempt_id:'a1',kind:'text',text:'private answer'}),'2026-10-21T10:00:05.300Z');
  event.run('c1',5,'r1','assistant.settled',JSON.stringify({attempt_id:'a1',message:{status:'complete',blocks:[{kind:'text',text:'private answer'}]}}),'2026-10-21T10:00:06.000Z');
  const route = {provider:'fixture-provider',model:'fixture-model',revision:'rates-v1',rates:{input:1,output:2,cache_read:1,cache_write:1}};
  db.prepare('INSERT INTO wb_model_budget_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('r1','a1',JSON.stringify({max_tokens:20}),JSON.stringify(route),'settled',JSON.stringify({inputTokens:'20',outputTokens:'5',cacheReadTokens:'10',cacheWriteTokens:'2',totalTokens:'37',reasoningTokens:'1'}),'37','47',null,'2026-10-21T10:00:04.900Z','2026-10-21T10:00:06.100Z');
  const budget = db.prepare('INSERT INTO wb_model_budget_events VALUES(?,?,?,?,?)');
  budget.run('r1','a1','in_flight','{}','2026-10-21T10:00:05.000Z');
  budget.run('r1','a1','settled','{}','2026-10-21T10:00:06.100Z');
  return db;
}

test('run diagnostics join authoritative timing, assistant projections, and cache-aware attempt receipts without content', () => {
  const db = fixture();
  try {
    const report = readRunRuntimeDiagnostics(db, 'r1');
    assert.equal(report.run_id, 'r1');
    assert.equal(report.queue_ms, 2000);
    assert.equal(report.preparation.total_ms, 120);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].attempt_id, 'a1');
    assert.equal(report.attempts[0].ttft_ms, 300);
    assert.equal(report.attempts[0].generation_ms, 1000);
    assert.deepEqual(report.attempts[0].usage, {
      input_tokens: '20', output_tokens: '5', cache_read_tokens: '10', cache_write_tokens: '2',
      total_tokens: '37', reasoning_tokens: '1',
    });
    assert.deepEqual(report.attempts[0].cost, {nano_usd:'47',basis:'configured_rates'});
    assert.equal(report.attempts[0].unknown, false);
    assert.equal(report.manual_intervention_required, false);
    assert.doesNotMatch(JSON.stringify(report), /private answer|private content/);
  } finally { db.close(); }
});

test('unknown provider effects remain visible and missing preparation or completion is not inferred', () => {
  const db = fixture();
  try {
    db.prepare("UPDATE wb_model_budget_attempts SET state='unknown',usage_json=NULL,actual_tokens=NULL,actual_nano_usd=NULL,reason='provider_ack_lost' WHERE attempt_id='a1'").run();
    db.prepare("DELETE FROM ga_events WHERE type IN ('runtime.preparation_timing','assistant.delta','assistant.settled')").run();
    db.prepare("DELETE FROM wb_model_budget_events WHERE state='settled'").run();
    const report = readRunRuntimeDiagnostics(db, 'r1');
    assert.equal(report.preparation.total_ms, null);
    assert.ok(report.missing.includes('preparation_timing_unavailable'));
    assert.equal(report.attempts[0].ttft_ms, null);
    assert.equal(report.attempts[0].generation_ms, null);
    assert.equal(report.attempts[0].unknown, true);
    assert.equal(report.attempts[0].unknown_reason, 'provider_ack_lost');
    assert.equal(report.attempts[0].usage, null);
    assert.equal(report.attempts[0].cost, null);
    assert.equal(report.manual_intervention_required, true);
  } finally { db.close(); }
});

test('partial usage does not convert absent input or cache values to zero', () => {
  const db = fixture();
  try {
    db.prepare("UPDATE wb_model_budget_attempts SET usage_json=? WHERE attempt_id='a1'").run(JSON.stringify({totalTokens:'37'}));
    const report = readRunRuntimeDiagnostics(db, 'r1');
    assert.equal(report.attempts[0].usage_status, 'partial');
    assert.deepEqual(report.attempts[0].usage, {total_tokens:'37'});
    assert.ok(report.attempts[0].missing.includes('usage_input_tokens_unavailable'));
    assert.ok(report.attempts[0].missing.includes('usage_cache_read_tokens_unavailable'));
    assert.ok(report.attempts[0].missing.includes('usage_cache_write_tokens_unavailable'));
  } finally { db.close(); }
});

test('retry attempts keep their own indices and unresolved attempts request manual review', () => {
  const db = fixture();
  try {
    const route = db.prepare("SELECT route_json FROM wb_model_budget_attempts WHERE attempt_id='a1'").get().route_json;
    db.prepare('INSERT INTO wb_model_budget_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('r1','a2',JSON.stringify({max_tokens:20}),route,'unknown',null,null,null,'usage_incomplete','2026-10-21T10:00:07.000Z','2026-10-21T10:00:08.000Z');
    const budget = db.prepare('INSERT INTO wb_model_budget_events VALUES(?,?,?,?,?)');
    budget.run('r1','a2','in_flight','{}','2026-10-21T10:00:07.100Z');
    budget.run('r1','a2','unknown','{}','2026-10-21T10:00:08.000Z');
    const report = readRunRuntimeDiagnostics(db, 'r1');
    assert.equal(report.retry_count, 1);
    assert.deepEqual(report.attempts.map(attempt => [attempt.attempt_id,attempt.retry_index]), [['a1',0],['a2',1]]);
    assert.equal(report.attempts[1].unknown, true);
    assert.equal(report.attempts[1].manual_intervention_required, true);
    assert.equal(report.manual_intervention_required, true);
  } finally { db.close(); }
});

test('missing run is returned as null without creating or changing run state', () => {
  const db = fixture();
  try {
    assert.equal(readRunRuntimeDiagnostics(db, 'absent'), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ga_runs').get().n, 1);
  } finally { db.close(); }
});

test('missing optional budget tables produce explicit missing diagnostics', () => {
  const db = fixture();
  try {
    db.exec('DROP TABLE wb_model_budget_events; DROP TABLE wb_model_budget_attempts');
    const report = readRunRuntimeDiagnostics(db, 'r1');
    assert.deepEqual(report.attempts, []);
    assert.ok(report.missing.includes('model_attempts_unavailable'));
    assert.ok(report.missing.includes('budget_events_unavailable'));
  } finally { db.close(); }
});

test('native and budget attempt identities are never guessed into first-body timing correlation',()=>{
 const db=fixture();try{
  db.prepare("UPDATE wb_model_budget_attempts SET attempt_id='model-ledger-call' WHERE attempt_id='a1'").run();
  db.prepare("UPDATE wb_model_budget_events SET attempt_id='model-ledger-call' WHERE attempt_id='a1'").run();
  const report=readRunRuntimeDiagnostics(db,'r1');
  assert.equal(report.attempts[0].ttft_ms,null);assert.equal(report.attempts[0].generation_ms,null);
  assert.ok(report.attempts[0].missing.includes('time_to_first_text_unavailable'));
  assert.equal(report.attempts[0].usage.input_tokens,'20');
 }finally{db.close();}
});

test('diagnostics read real run and attempt receipts from the existing Jot authorities', () => {
  const db = openProductDatabase(':memory:');
  try {
    const events = new EventStore(db);
    const conversations = new ConversationRepository(db);
    const runs = new RunRepository(db, events);
    const conversation = conversations.create('alice', {workspace_id:'main',model:{provider:'fixture-provider',model:'fixture-model'}});
    const accepted = runs.enqueue(conversation.conversation_id, 'alice', {
      client_message_id:'diagnostic-fixture-message',content:[{type:'text',text:'fixture-only input'}],
    });
    const runId = accepted.run_id;
    assert.equal(runs.get(runId, 'alice').run_id, runId);
    assert.throws(() => runs.get(runId, 'bob'), /run_not_found/);
    db.prepare('UPDATE ga_runs SET created_at=? WHERE id=?').run(new Date(Date.now() - 2000).toISOString(), runId);
    db.prepare("UPDATE ga_runs SET status='starting' WHERE id=?").run(runId);
    withImmediateTransaction(db, () => events.append(conversation.conversation_id, runId, 'run.state', {status:'starting'}));
    db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(runId);
    withImmediateTransaction(db, () => events.append(conversation.conversation_id, runId, 'run.state', {status:'running'}));
    withImmediateTransaction(db, () => events.append(conversation.conversation_id, runId, 'runtime.preparation_timing', {
      event:'jot_preparation_timing',phase:'preparation_total',duration_ms:75,outcome:'succeeded',run_hash:'b'.repeat(64),
    }));

    const ledger = new ModelBudgetLedger(db, {routes:[{
      provider:'fixture-provider',model:'fixture-model',revision:'fixture-rates',context_window:100,
      max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3},
    }]});
    const scope = ledger.createScope('alice','diagnostics-fixture',{tokens:500,nano_usd:5000,model_calls:5});
    ledger.bindRun('alice',runId,[scope.scope_id]);
    ledger.reserve('alice',runId,{attempt_id:'native-attempt-1',provider:'fixture-provider',model:'fixture-model',max_tokens:20});
    ledger.dispatch('alice',runId,'native-attempt-1');
    withImmediateTransaction(db, () => events.append(conversation.conversation_id, runId, 'assistant.delta', {
      attempt_id:'native-attempt-1',kind:'text',text:'fixture-only answer',
    }));
    withImmediateTransaction(db, () => events.append(conversation.conversation_id, runId, 'assistant.settled', {
      attempt_id:'native-attempt-1',message:{status:'complete',blocks:[{kind:'text',text:'fixture-only answer'}]},
    }));
    ledger.settle('alice',runId,'native-attempt-1',{
      inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40,reasoningTokens:2,
    });

    const report = readRunRuntimeDiagnostics(db, runId);
    assert.equal(report.status, 'running');
    assert.ok(report.queue_ms >= 1000 && report.queue_ms < 10000);
    assert.equal(report.preparation.total_ms, 75);
    assert.equal(report.attempts[0].state, 'settled');
    assert.equal(report.attempts[0].usage_status, 'available');
    assert.equal(report.attempts[0].cost.nano_usd, '115');
    assert.equal(report.manual_intervention_required, false);
    assert.doesNotMatch(JSON.stringify(report), /fixture-only input|fixture-only answer/);
  } finally { db.close(); }
});
