import assert from 'node:assert/strict';
import test from 'node:test';

import { UniverseRuntimeClient, RuntimeTransportError } from '../../src/harness/runtime-client.ts';

const request = { tool: 'universe_search', arguments: { query: 'AI' }, execution: { call_id: 'call-1', session_ref: 'session-1' } };

test('HTTP 429 becomes a temporary rate-limit fact with bounded Retry-After', async () => {
  const client = new UniverseRuntimeClient('http://runtime', async () => new Response('{}', {
    status: 429, headers: { 'retry-after': '3' },
  }));
  await assert.rejects(() => client.invokeLeaf(request), error => {
    assert.ok(error instanceof RuntimeTransportError);
    assert.equal(error.reason_code, 'RUNTIME_RATE_LIMITED');
    assert.equal(error.failure_class, 'rate_limit');
    assert.equal(error.transience, 'temporary');
    assert.equal(error.retry_after_ms, 3000);
    return true;
  });
});

test('transport timeout remains distinguishable from a Runtime protocol error', async () => {
  const client = new UniverseRuntimeClient('http://runtime', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(() => client.invokeLeaf(request), error => {
    assert.ok(error instanceof RuntimeTransportError);
    assert.equal(error.reason_code, 'RUNTIME_TRANSPORT_UNAVAILABLE');
    assert.equal(error.failure_class, 'upstream');
    assert.equal(error.transience, 'temporary');
    return true;
  });
});
