import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { RuntimeEventClient } from '../../src/harness/runtime-events.ts';

test('runtime event client signs the exact private path and bounded query', async () => {
  const canonicalSecret = Buffer.from('0123456789abcdef0123456789abcdef');
  const secret = Buffer.concat([canonicalSecret, Buffer.from('\r\n')]);
  const calls = [];
  const client = new RuntimeEventClient('https://runtime.example', secret, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, run_id: 'a'.repeat(32), head_revision: 4,
      events: [{ revision: 4, status: 'running' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const page = await client.events('a'.repeat(32), 3, 20);
  assert.equal(page.head_revision, 4);
  const path = `/v2/runs/${'a'.repeat(32)}/events`;
  const expected = createHmac('sha256', canonicalSecret).update(`${path}\n{"after_revision":3,"limit":20}`).digest('hex');
  assert.equal(calls[0].init.headers.authorization, `HMAC-SHA256 ${expected}`);
  assert.equal(calls[0].url, `https://runtime.example${path}?after_revision=3&limit=20`);
});

test('runtime client binds the DSH session context before leaf execution', async () => {
  const requests = [];
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 3), async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, enabled: true, mode: 'shadow', ingress_state: 'HARNESS_ENQUEUED', durable: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  await client.bindContext({ taskRequestId: 'run-1', conversationId: 'conversation-1', messageId: 'message-1',
    sessionRef: 'session-1', message: 'read one page', receivedAt: 1700000000 });
  assert.equal(requests[0].url, 'https://runtime.example/v2/harness/intake');
  assert.equal(requests[0].init.method, 'POST');
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.session_ref, 'session-1');
  assert.equal(body.message_id, 'message-1');
  assert.equal(body.raw_messages[0].content, 'read one page');
  assert.equal(body.received_at, 1700000000);
  assert.match(String(requests[0].init.headers.authorization), /^HMAC-SHA256 [0-9a-f]{64}$/);
});

test('runtime intake retry preserves the exact immutable envelope', async () => {
  const bodies = [];
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 3), async (_url, init) => {
    bodies.push(String(init.body));
    return new Response(JSON.stringify({ enabled: true, ingress_state: 'HARNESS_ENQUEUED', durable: true }), { status: 200 });
  });
  const input = { taskRequestId: 'run-retry', conversationId: 'conversation-1', messageId: 'message-1',
    sessionRef: 'session-retry', message: 'read one page', receivedAt: 1700000000 };
  await client.bindContext(input);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await client.bindContext(input);
  assert.equal(bodies[0], bodies[1]);
});

test('lazy context staging sends a signed Runtime intake envelope only to the local leaf bridge', async () => {
  const requests = [];
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 7),
    async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ ok: true, staged: true }), { status: 200 });
    });
  await client.stageContext({ taskRequestId: 'run-1', conversationId: 'conversation-1',
    messageId: 'message-1', sessionRef: 'runtime-session-1', controllerSessionRef: 'jot-session-1',
    message: '你好', receivedAt: 1_788_000_000 },
  'http://127.0.0.1:18792');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:18792/v2/harness/context');
  const envelope = JSON.parse(requests[0].init.body);
  assert.equal(envelope.session_ref, 'runtime-session-1');
  assert.equal(envelope.controller_session_ref, 'jot-session-1');
  assert.equal(envelope.intake.path, '/v2/harness/intake');
  assert.equal(envelope.intake.authorization.startsWith('HMAC-SHA256 '), true);
  assert.equal(JSON.parse(envelope.intake.payload).raw_messages[0].content, '你好');
});


test('runtime intake recovers a legacy timestamp conflict only through an exact existing binding', async () => {
  const runId = 'a'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 3), async (url, init) => {
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ enabled: true, ok: false, error: 'IDEMPOTENCY_CONFLICT' }), { status: 200 });
    }
    assert.match(String(url), /session-legacy\/binding\?expected_client_run_id=run-legacy$/);
    return new Response(JSON.stringify({ ok: true, session_ref: 'session-legacy', client_run_id: 'run-legacy',
      runtime_run_id: runId, runtime_owner: 'runtime-c-primary', fence_epoch: 1 }), { status: 200 });
  });
  const receipt = await client.bindContext({ taskRequestId: 'run-legacy', conversationId: 'conversation-1',
    messageId: 'message-1', sessionRef: 'session-legacy', message: 'read one page', receivedAt: 1700000000 });
  assert.deepEqual(receipt, { enabled: true, ingress_state: 'HARNESS_ENQUEUED', durable: true,
    recovered_from_binding: true, runtime_run_id: runId });
});

test('runtime event client rejects invalid identifiers and malformed pages', async () => {
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 1),
    async () => new Response(JSON.stringify({ ok: true, events: 'bad' }), { status: 200 }));
  await assert.rejects(() => client.events('../secret', 0, 10), /runtime_run_id_invalid/);
  await assert.rejects(() => client.events('a'.repeat(32), 0, 10), /runtime_event_page_invalid/);
});

test('runtime completion client resolves binding once and reads completion without a call id', async () => {
  const calls = [];
  const runId = 'a'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 4), async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/binding?')) {
      return new Response(JSON.stringify({ ok: true, session_ref: 'session-1',
        client_run_id: 'client-run-1', runtime_run_id: runId,
        runtime_owner: 'runtime-c-primary', fence_epoch: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, session_ref: 'session-1', run_id: runId,
      runtime_revision: 7, goal_revision: 2, status: 'completion_eligible', reason_code: null,
      progress: { satisfied: 2, total: 2, missing_requirement_ids: [] } }), { status: 200 });
  });

  const binding = await client.binding('session-1', 'client-run-1');
  const completion = await client.completion(binding.runtime_run_id);

  assert.equal(completion.runtime_revision, 7);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls.every(call => call.init.body === undefined), true);
  assert.doesNotMatch(JSON.stringify(calls), /call_id|universe_finish/);
});

test('runtime completion client rejects malformed or guessed success', async () => {
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 5),
    async () => new Response(JSON.stringify({ ok: true, status: 'completion_eligible' }), { status: 200 }));
  await assert.rejects(() => client.completion('a'.repeat(32)), /runtime_completion_snapshot_invalid/);
});

test('runtime client registers the pending answer before reading terminal completion', async () => {
  const calls = [];
  const runId = 'a'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 6), async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, run_id: runId,
      status: 'completion_eligible', runtime_revision: 8 }), { status: 200 });
  });
  const value = await client.registerAnswer(runId, 'client-run-1', '1. A\n2. B\n3. C', 3);
  assert.equal(value.status, 'completion_eligible');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.expected_client_run_id, 'client-run-1');
  assert.equal(body.minimum_key_points, 3);
});

test('runtime client registers an exact provider delivery receipt', async () => {
  const calls = [];
  const runId = 'b'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 7), async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, run_id: runId,
      status: 'completion_eligible', runtime_revision: 9 }), { status: 200 });
  });
  const value = await client.registerDeliveryReceipt(
    runId, 'client-run-1', 'wecom:msg-123', 'owner', 'delivered'
  );
  assert.equal(value.status, 'completion_eligible');
  assert.equal(calls[0].url, `https://runtime.example/v2/harness/runs/${runId}/delivery-receipt`);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, { expected_client_run_id: 'client-run-1', receipt_ref: 'wecom:msg-123',
    recipient_ref: 'owner', status: 'delivered' });
});

test('runtime client reads structured delivery requests for the bound run', async () => {
  const runId = 'c'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 8), async () =>
    new Response(JSON.stringify({ ok: true, run_id: runId, requests: [{
      request_id: 'delivery:abc', run_id: runId, client_run_id: 'client-run-1',
      requirement_id: 'r-delivery', artifact_ref: 'artifact:1', recipient_ref: 'owner',
      status: 'requested', created_at: 'now',
    }] }), { status: 200 }));
  const requests = await client.deliveryRequests(runId, 'client-run-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].artifact_ref, 'artifact:1');
});

test('runtime client reads materialized artifact requests for the bound run', async () => {
  const runId = 'd'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 9), async () =>
    new Response(JSON.stringify({ ok: true, run_id: runId, requests: [{
      request_id: 'artifact-request:abc', run_id: runId, client_run_id: 'client-run-1',
      requirement_id: 'r-artifact', result_refs: ['ref-1'],
      source_results: [{ result_ref: 'ref-1', result: { text: '正文' } }],
      format: 'docx', template: 'default', status: 'requested', created_at: 'now',
      artifact_ref: null,
    }] }), { status: 200 }));
  const requests = await client.artifactRequests(runId, 'client-run-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source_results[0].result_ref, 'ref-1');
});

test('runtime client posts the exact artifact QA receipt', async () => {
  const calls = [];
  const runId = 'e'.repeat(32);
  const client = new RuntimeEventClient('https://runtime.example', Buffer.alloc(32, 11), async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, run_id: runId,
      status: 'artifact_verified', artifact_ref: 'artifact:doc-1' }), { status: 200 });
  });
  const value = await client.registerArtifactReceipt(runId, 'client-run-1', {
    request_id: 'artifact-request:abc', artifact_ref: 'artifact:doc-1',
    size_bytes: 4096, sha256: 'a'.repeat(64), render_status: 'passed',
  });
  assert.equal(value.status, 'artifact_verified');
  assert.equal(calls[0].url, `https://runtime.example/v2/harness/runs/${runId}/artifact-receipt`);
  assert.equal(JSON.parse(String(calls[0].init.body)).size_bytes, 4096);
});
