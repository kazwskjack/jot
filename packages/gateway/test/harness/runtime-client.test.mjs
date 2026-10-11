import assert from 'node:assert/strict';
import test from 'node:test';

import { UniverseRuntimeClient, RuntimeProtocolError } from '../../src/harness/runtime-client.ts';

test('runtime client forwards the exact leaf envelope and accepts a typed outcome', async () => {
  const requests = [];
  const client = new UniverseRuntimeClient('http://127.0.0.1:18792', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      ok: false, status: 'rejected', reason_code: 'CONSTRAINT_SCOPE_UNRESOLVED',
      failure_class: 'goal_contract', transience: 'deterministic', session_ref: 'session-1',
      run_id: 'run-1', call_id: 'call-1', goal_revision: 0, attempt: 1,
      progress: { satisfied: 0, total: 1, missing_requirement_ids: ['r-1'] },
      result_ref: null, evidence_refs: [], upstream_hint: null,
      observed_at: '2026-09-10T00:00:00Z', runtime_revision: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const outcome = await client.invokeLeaf({ tool: 'universe_search', arguments: { query: 'AI' }, execution: { call_id: 'call-1', session_ref: 'session-1' } });
  assert.equal(outcome.status, 'rejected');
  assert.equal(requests[0].url, 'http://127.0.0.1:18792/v2/harness/leaf');
  assert.equal(requests[0].body.tool, 'universe_search');
});

test('runtime client rejects a legacy or malformed response instead of guessing', async () => {
  const client = new UniverseRuntimeClient('http://127.0.0.1:18792', async () =>
    new Response(JSON.stringify({ ok: false, error: 'harness_leaf_unavailable' }), { status: 200 }));
  await assert.rejects(() => client.invokeLeaf({ tool: 'universe_search', arguments: {}, execution: { call_id: 'c', session_ref: 's' } }), RuntimeProtocolError);
});
