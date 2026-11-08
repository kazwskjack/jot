import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionControllerClient } from '../../src/harness/session-controller-client.ts';

const token = 'chat-checkpoint-recovery-client-test-token-2026';
const scope = { owner_id: 'owner-a', conversation_id: 'conversation-a', run_id: 'run-a', expected_run_version: 7 };
const checkpoint = {
  protocol: 1,
  kind: 'chat_compaction_checkpoint',
  checkpoint_id: 'checkpoint-a',
  checkpoint_sha256: 'a'.repeat(64),
  run_id: 'run-a',
  session_id: 'session-a',
  source_sha256: 'b'.repeat(64),
  summary_text_sha256: 'c'.repeat(64),
  native_summary_sha256: 'd'.repeat(64),
  parent_checkpoint_id: null,
  execution_authorized: false,
};
const recovered = {
  protocol: 1,
  status: 'recovered',
  checkpoint,
  execution_authorized: false,
};
function fixture(value) {
  const calls = [];
  return {
    calls,
    client: new SessionControllerClient('http://127.0.0.1:18841', token, async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(value);
    }),
  };
}

test('recovery client uses only the exact authenticated original scope and validates the checkpoint receipt', async () => {
  const f = fixture(recovered), caller = new AbortController();
  const result = await f.client.recoverChatCheckpoint('session-a', scope, 'intent-a', caller.signal);
  assert.deepEqual(result, recovered);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:18841/v1/sessions/session-a/chat-checkpoint-recovery');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { history: scope, intent_id: 'intent-a' });
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  assert.equal(f.calls[0].init.signal.aborted, false);
});

test('recovery client accepts only exact unavailable or complete non-authorizing receipts', async () => {
  const unavailable = { protocol: 1, status: 'unavailable', reason: 'NO_DISPATCHED_ATTEMPT', checkpoint: null, execution_authorized: false };
  assert.deepEqual(await fixture(unavailable).client.recoverChatCheckpoint('session-a', scope, 'intent-a'), unavailable);
  for (const value of [
    { ...recovered, protocol: 2 },
    { ...recovered, status: 'compacted' },
    { ...recovered, execution_authorized: true },
    { ...recovered, extra: 'private' },
    { ...recovered, checkpoint: { ...checkpoint, run_id: 'foreign-run' } },
    { ...recovered, checkpoint: { ...checkpoint, session_id: 'foreign-session' } },
    { ...recovered, checkpoint: { ...checkpoint, checkpoint_sha256: 'invalid' } },
    { ...unavailable, reason: 'provider error with private details' },
    { ...unavailable, checkpoint: checkpoint },
    { ...unavailable, execution_authorized: true },
  ]) {
    await assert.rejects(() => fixture(value).client.recoverChatCheckpoint('session-a', scope, 'intent-a'), /chat_checkpoint_recovery_receipt_invalid/);
  }
});

test('invalid original scope and intent are rejected before transport', async () => {
  const f = fixture(recovered);
  for (const [sessionId, history, intentId] of [
    ['session-a', { ...scope, run_id: '../foreign' }, 'intent-a'],
    ['session-a', { ...scope, expected_run_version: '7' }, 'intent-a'],
    ['session-a', scope, '../intent'],
    ['../session', scope, 'intent-a'],
  ]) await assert.rejects(() => f.client.recoverChatCheckpoint(sessionId, history, intentId), /chat_checkpoint_recovery_scope_invalid/);
  assert.equal(f.calls.length, 0);
});

test('recovery cancellation reaches transport and the fixed one-second deadline aborts it', async () => {
  const parent = new AbortController();
  let callerSignal;
  const cancellable = new SessionControllerClient('http://127.0.0.1:18841', token, async (_url, init) => {
    callerSignal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const pending = cancellable.recoverChatCheckpoint('session-a', scope, 'intent-a', parent.signal);
  while (!callerSignal) await new Promise(resolve => setImmediate(resolve));
  parent.abort(new Error('caller_cancelled'));
  await assert.rejects(pending, /caller_cancelled/);
  assert.equal(callerSignal.aborted, true);

  const timed = new SessionControllerClient('http://127.0.0.1:18841', token, async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const start = performance.now();
  await assert.rejects(() => timed.recoverChatCheckpoint('session-a', scope, 'intent-a'));
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 800 && elapsed < 1400, `expected a one-second recovery deadline, got ${elapsed.toFixed(0)}ms`);
});
