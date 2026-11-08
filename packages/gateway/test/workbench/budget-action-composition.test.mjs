import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(new URL('../../src/workbench/execution.ts', import.meta.url), 'utf8');
const prefix = "app.post('/internal/v1/workbench/model-budget',";
const start = source.indexOf(prefix);
const end = source.indexOf("app.post('/internal/v1/workbench/guard'", start);
assert.ok(start >= 0 && end > start);
const callback = stripTypeScriptTypes(source.slice(start, end).trim().slice(prefix.length, -2));

test('composed budget endpoint retains selection and memory provider-receipt fences', async () => {
  let leaseChecks = 0, identityChecks = 0;
  let identity = { kind: 'memory_capture', model_budget: true };
  const storedReceipt = { state: 'recorded' };
  const scope = new Proxy({
    authorized: value => assert.equal(value, 'Bearer service'),
    object: value => value,
    fields: (input, keys) => assert.ok(Object.keys(input).every(key => keys.includes(key) || key === 'execution_lease')),
    db: { prepare: sql => { assert.match(sql, /wb_model_budget_admissions/);
      return { get: () => ({ route_json: JSON.stringify({ provider: 'fixture', model: 'accepted' }) }) }; } },
    modelBudgets: { recordMemoryProviderReceipt: (owner, run, attempt, stable, usage) => {
      assert.equal(owner, 'alice'); assert.equal(run, 'run-1'); assert.equal(attempt, 'call-1');
      assert.equal(stable, 'stable-1'); assert.deepEqual(usage, { inputTokens: 3 }); return storedReceipt;
    } },
    withImmediateTransaction: (_db, action) => action(), accountingOwner: () => 'alice',
    assertExecutionLease: (_db, run, lease) => { assert.equal(run, 'run-1'); assert.equal(lease, 'lease-1'); leaseChecks++; },
    context: () => identity, assertIdentityAccounting: value => { assert.equal(value, identity); identityChecks++; },
    validCallId: value => value === 'call-1',
  }, { has: () => true, get: (object, key) => key === Symbol.unscopables ? undefined
    : key in object ? object[key] : key in globalThis ? globalThis[key] : (() => { throw Error(`Unexpected boundary ${String(key)}`); }) });
  const handler = new Function('scope', `with (scope) { return (${callback}); }`)(scope);
  const request = action => ({ headers: { authorization: 'Bearer service' },
    body: { run_id: 'run-1', session_ref: 'session-1', execution_lease: 'lease-1', action } });
  assert.deepEqual(await handler(request('selection')), { route: { provider: 'fixture', model: 'accepted' } });
  const receiptRequest = request('provider_receipt');
  Object.assign(receiptRequest.body, { attempt_id: 'call-1', stable_request_id: 'stable-1', usage: { inputTokens: 3 } });
  assert.equal(await handler(receiptRequest), storedReceipt);
  assert.equal(leaseChecks, 2); assert.equal(identityChecks, 2);
  identity = { kind: 'task', model_budget: true };
  await assert.rejects(handler(receiptRequest), /budget_provider_receipt_invalid/);
  identity = { kind: 'memory_capture', model_budget: false };
  await assert.rejects(handler(request('selection')), /budget_service_unavailable/);
});
