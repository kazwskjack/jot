import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { budgetedModelStream } from '../model-budget-stream.js';
import { ModelBudgetLedger } from '../../gateway/src/workbench/model-budget.ts';
import { openProductDatabase } from '../../gateway/src/db/database.ts';
import { ConversationRepository } from '../../gateway/src/conversations/repository.ts';
import { RunRepository } from '../../gateway/src/runs/repository.ts';
import { EventStore } from '../../gateway/src/events/event-store.ts';

const owner = 'm0705-fixture';
const primary = { provider: 'provider-a', model: 'model-a' };
const fallback = { provider: 'provider-b', model: 'model-b' };
const completeUsage = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 40 };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const metadataFor = route => ({ provider: route.provider, id: route.model, name: `${route.provider}/${route.model}`,
  context: { contextWindow: 65536 }, defaultMaxTokens: 4096, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, inputModalities: ['text'] });
const metadataDigest = metadata => createHash('sha256').update(canonical({ digest_revision: 'jot-model-metadata-v1', metadata })).digest('hex');
const metadataBindings = routes => routes.map(route => {
  const metadata = metadataFor(route);
  return { provider: route.provider, model: route.model, digest_revision: 'jot-model-metadata-v1',
    metadata_digest: metadataDigest(metadata), source_config_revision: null, upstream_revision: null };
});

test('M07.05 keeps unknown primary spend held and bills a later fallback as its own attempt', async t => {
  const db = openProductDatabase(':memory:');
  t.after(() => db.close());
  const routes = [primary, fallback].map(route => ({ ...route, revision: 'fixture-v1', context_window: 100,
    max_output_tokens: 20, rates: { input: 2, output: 10, cache_read: 1, cache_write: 3 } }));
  const ledger = new ModelBudgetLedger(db, { routes });
  const conversations = new ConversationRepository(db);
  const runs = new RunRepository(db, new EventStore(db));
  const conversation = conversations.create(owner, { workspace_id: 'main', model: { ...primary, fallbacks: [fallback] } });
  const scope = ledger.createScope(owner, `chat-root:${conversation.conversation_id}`, { tokens: 1_000, nano_usd: 10_000, model_calls: 10 });

  const makeRun = index => {
    const run = runs.enqueue(conversation.conversation_id, owner, {
      client_message_id: `m0705-${index}`, content: [{ type: 'text', text: 'Controlled budget fixture' }],
    }, { modelMetadataBindings: metadataBindings([primary, fallback]) });
    db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
    ledger.bindRun(owner, run.run_id, [scope.scope_id]);
    return run.run_id;
  };
  const firstRun = makeRun(1);
  const reservations = [];
  let providerCalls = 0;
  const invoke = async (runId, route, providerChunks) => {
    const binding = { runId, sessionRef: `session-${runId}`, executionLease: { owner: 'worker-a', generation: 1 } };
    const options = { ...route, sessionId: binding.sessionRef, maxTokens: 20, signal: new AbortController().signal };
    const request = async (path, received, payload) => {
      assert.equal(path, 'model-budget');
      assert.equal(received.runId, runId);
      let receipt;
      if (payload.action === 'reserve') {
        reservations.push(payload.request);
        receipt = ledger.reserve(owner, runId, payload.request);
      } else if (payload.action === 'dispatch') receipt = ledger.dispatch(owner, runId, payload.attempt_id);
      else if (payload.action === 'settle') receipt = ledger.settle(owner, runId, payload.attempt_id, payload.usage);
      else if (payload.action === 'unknown') receipt = ledger.markUnknown(owner, runId, payload.attempt_id, payload.reason);
      else if (payload.action === 'release') receipt = ledger.releaseUndispatched(owner, runId, payload.attempt_id);
      else throw new Error('unexpected_model_budget_action');
      return { receipt };
    };
    const next = async function* () {
      providerCalls++;
      for (const chunk of providerChunks) yield chunk;
    };
    const output = [];
    for await (const chunk of budgetedModelStream({ binding, options, request, check: async () => {}, next })) output.push(chunk);
    return output;
  };

  await assert.rejects(invoke(firstRun, primary, [
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 40 } },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'SYNTHETIC_PROVIDER_FAILURE' } } },
  ]), /budget_usage_unknown/);
  assert.equal(providerCalls, 1);
  const firstAttempt = db.prepare('SELECT attempt_id,state,actual_tokens,actual_nano_usd FROM wb_model_budget_attempts WHERE run_id=?').get(firstRun);
  assert.equal(firstAttempt.state, 'unknown');
  assert.equal(firstAttempt.actual_tokens, null);
  assert.equal(firstAttempt.actual_nano_usd, null);
  assert.deepEqual(ledger.balance(owner, scope.scope_id).held, { tokens: '100', nano_usd: '1000', model_calls: '1' });
  assert.deepEqual(db.prepare('SELECT state FROM wb_model_budget_events WHERE run_id=? AND attempt_id=? ORDER BY rowid').all(firstRun, firstAttempt.attempt_id).map(row => row.state),
    ['reserved', 'in_flight', 'unknown']);

  db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(firstRun);
  const fallbackRun = makeRun(2);
  await assert.rejects(invoke(fallbackRun, fallback, [
    { type: 'usage', usage: completeUsage }, { type: 'finish', reason: { kind: 'stop' } },
  ]), /budget_usage_unknown/);
  assert.equal(providerCalls, 1, 'the unknown primary hold blocks fallback before another provider dispatch');
  assert.equal(db.prepare('SELECT count(*) AS n FROM wb_model_budget_attempts').get().n, 1, 'a rejected fallback creates no attempt');

  const reconciled = ledger.settle(owner, firstRun, firstAttempt.attempt_id, completeUsage);
  assert.equal(reconciled.state, 'settled');
  const fallbackOutput = await invoke(fallbackRun, fallback, [
    { type: 'text-delta', index: 0, text: 'Fallback completed.' },
    { type: 'usage', usage: completeUsage }, { type: 'finish', reason: { kind: 'stop' } },
  ]);
  assert.equal(fallbackOutput.at(-1).reason.kind, 'stop');
  assert.equal(providerCalls, 2);

  const attempts = db.prepare('SELECT run_id,attempt_id,route_json,state,actual_tokens,actual_nano_usd FROM wb_model_budget_attempts ORDER BY rowid').all();
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].attempt_id, attempts[1].attempt_id);
  assert.deepEqual(attempts.map(row => {
    const route = JSON.parse(row.route_json);
    return { provider: route.provider, model: route.model, state: row.state, actual_tokens: row.actual_tokens, actual_nano_usd: row.actual_nano_usd };
  }), [
    { provider: primary.provider, model: primary.model, state: 'settled', actual_tokens: '40', actual_nano_usd: '115' },
    { provider: fallback.provider, model: fallback.model, state: 'settled', actual_tokens: '40', actual_nano_usd: '115' },
  ]);
  for (const runId of [firstRun, fallbackRun]) assert.deepEqual(ledger.balancesForRun(owner, runId).map(item => item.scope_id), [scope.scope_id]);
  assert.deepEqual(ledger.balance(owner, scope.scope_id).used, { tokens: '80', nano_usd: '230', model_calls: '2' });
  assert.deepEqual(ledger.balance(owner, scope.scope_id).held, { tokens: '0', nano_usd: '0', model_calls: '0' });
  assert.deepEqual(db.prepare('SELECT state FROM wb_model_budget_events WHERE run_id=? AND attempt_id=? ORDER BY rowid').all(fallbackRun, attempts[1].attempt_id).map(row => row.state),
    ['reserved', 'in_flight', 'settled']);
  assert.equal(reservations.length, 3, 'primary, blocked fallback, and admitted fallback each request a reservation');
});
