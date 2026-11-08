import test from 'node:test';
import assert from 'node:assert/strict';
import {settledCheckpointFixture} from '../support/chat-checkpoint-fixture.mjs';
import {completedChatFixture} from '../support/chat-maintenance-fixture.mjs';
import {ChatCompactionAttempts} from '../../src/conversations/chat-compaction-attempts.ts';
import {ConversationModes} from '../../src/conversations/modes.ts';
import {ChatCompactionCheckpoints} from '../../src/conversations/chat-compaction-checkpoints.ts';

test('Chat admission recovers only the original dispatched attempt before freezing the next context', async t => {
  const f = settledCheckpointFixture(t);
  const published = new ChatCompactionCheckpoints(f.db);
  const calls = [];
  let recoveredCheckpoint;
  const client = {
    conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
    recoverChatCheckpoint: async (sessionId, history, intentId, signal) => {
      calls.push({ sessionId, history, intentId, signal });
      assert.equal(sessionId, f.scope.session_ref);
      assert.deepEqual(history, {
        owner_id: f.scope.owner_id,
        conversation_id: f.scope.conversation_id,
        run_id: f.scope.run_id,
        expected_run_version: f.scope.expected_run_version,
      });
      assert.equal(intentId, f.intent.intent_id);
      assert.ok(signal instanceof AbortSignal);
      recoveredCheckpoint = published.publish(f.scope, f.input);
      return { protocol: 1, status: 'recovered', checkpoint: recoveredCheckpoint, execution_authorized: false };
    },
  };
  const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);

  const commit = await modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
    client_message_id: 'after-recovery',
    content: [{ type: 'text', text: 'Next synthetic input.' }],
  });
  const accepted = commit();
  const row = f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(accepted.run_id);
  const snapshot = JSON.parse(row.chat_context_json);

  assert.equal(calls.length, 1, 'the existing recovery operation must run before acceptance');
  assert.equal(snapshot.checkpoint.checkpoint_id, recoveredCheckpoint.checkpoint_id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n, 1,
    'recovery reuses the original attempt instead of reserving another one');
});

test('missing intent or an undispatched attempt is never inferred into recovery work', async t => {
  for (const state of ['no-intent', 'reserved', 'released']) {
    const f = completedChatFixture(t, { contextRevision: 'checkpoint-text-v2' });
    let calls = 0;
    if (state === 'no-intent') {
      f.db.prepare('DELETE FROM ga_chat_compaction_intents WHERE run_id=?').run(f.scope.run_id);
    } else {
      const attempts = new ChatCompactionAttempts(f.db);
      const base = { intent_id: f.intent.intent_id, attempt_id: `attempt-${state}`, observer_id: 'test-host' };
      const reserved = attempts.reserve(f.scope, { ...base, request: f.request, witness: f.witness });
      if (state === 'released') attempts.release(f.scope, { ...base, fence_id: reserved.fence_id });
    }
    const client = {
      conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
      recoverChatCheckpoint: async () => { calls++; throw Error('must_not_recover'); },
    };
    const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
    const commit = await modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
      client_message_id: `fallback-${state}`,
      content: [{ type: 'text', text: 'Bounded fallback input.' }],
    });
    assert.equal(commit().accepted, true);
    assert.equal(calls, 0, state);
  }
});

test('an incomplete latest user message prevents recovering an older run', async t => {
  const f = settledCheckpointFixture(t);
  f.db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('incomplete-user', f.c.conversation_id, null, 'user', 'streaming', JSON.stringify({ blocks: [{ kind: 'text', text: 'Still arriving.' }], attachments: [] }), 'later', 'later');
  let calls = 0;
  const client = {
    conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
    recoverChatCheckpoint: async () => { calls++; throw Error('must_not_recover_older_run'); },
  };
  const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
  const commit = await modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
    client_message_id: 'after-incomplete-user',
    content: [{ type: 'text', text: 'Fallback.' }],
  });
  assert.equal(commit().accepted, true);
  assert.equal(calls, 0);
});

test('usage-unknown original attempt may be inspected but never receives a replacement attempt', async t => {
  const f = settledCheckpointFixture(t, { settled: false });
  let calls = 0;
  const client = {
    conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
    recoverChatCheckpoint: async (sessionId, history, intentId) => {
      calls++;
      assert.equal(sessionId, f.scope.session_ref);
      assert.equal(history.run_id, f.scope.run_id);
      assert.equal(intentId, f.intent.intent_id);
      return { protocol: 1, status: 'unavailable', reason: 'NO_DISPATCHED_ATTEMPT', checkpoint: null, execution_authorized: false };
    },
  };
  const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
  const commit = await modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
    client_message_id: 'usage-unknown-fallback',
    content: [{ type: 'text', text: 'Unknown usage fallback.' }],
  });
  assert.equal(commit().accepted, true);
  assert.equal(calls, 1);
  assert.equal(f.db.prepare('SELECT state FROM ga_chat_compaction_attempts WHERE attempt_id=?').get(f.input.attempt_id).state, 'usage_unknown');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n, 1);
});

test('two admissions can recover the same exact attempt idempotently before either context freezes', async t => {
  const f = settledCheckpointFixture(t), published = new ChatCompactionCheckpoints(f.db);
  let calls = 0, checkpoint;
  const client = {
    conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
    recoverChatCheckpoint: async () => {
      calls++;
      await new Promise(resolve => setImmediate(resolve));
      checkpoint = published.publish(f.scope, f.input);
      return { protocol: 1, status: 'recovered', checkpoint, execution_authorized: false };
    },
  };
  const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
  const prepare = suffix => modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
    client_message_id: `concurrent-${suffix}`,
    content: [{ type: 'text', text: `Concurrent input ${suffix}.` }],
  });
  const commits = await Promise.all([prepare('a'), prepare('b')]);
  const accepted = commits.map(commit => commit());
  assert.equal(calls, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n, 1);
  for (const receipt of accepted) {
    const row = f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(receipt.run_id);
    assert.equal(JSON.parse(row.chat_context_json).checkpoint.checkpoint_id, checkpoint.checkpoint_id);
  }
});

test('cancellation during recovery falls back to ordinary bounded-context acceptance', async t => {
  const f = settledCheckpointFixture(t), canceled = new AbortController(), calls = [];
  canceled.abort(Error('request_cancelled'));
  const client = {
    conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
    recoverChatCheckpoint: async (...args) => { calls.push(args); throw Error('must_not_reach_transport'); },
  };
  const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
  const commit = await modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
    client_message_id: 'cancelled-recovery-fallback',
    content: [{ type: 'text', text: 'Still accept with bounded context.' }],
  }, canceled.signal);
  assert.equal(commit().accepted, true);
  assert.equal(calls.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n, 1);
});

test('a non-cooperative recovery cannot hold admission open and late results cannot rewrite its context', async t => {
  const scenario = async outcome => {
    const f = settledCheckpointFixture(t);
    let resolveRecovery, rejectRecovery, recoverySignal;
    const pendingRecovery = new Promise((resolve, reject) => { resolveRecovery = resolve; rejectRecovery = reject; });
    const client = {
      conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
      // Deliberately ignores the signal and never settles until the test releases it.
      recoverChatCheckpoint: (_sessionId, _history, _intentId, signal) => {
        recoverySignal = signal;
        return pendingRecovery;
      },
    };
    const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
    const started = Date.now();
    const prepared = await Promise.race([
      modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
        client_message_id: `late-recovery-${outcome}`,
        content: [{ type: 'text', text: `Accept before late ${outcome}.` }],
      }).then(commit => ({ commit })),
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 2200)),
    ]);
    assert.equal(prepared.timedOut, undefined, 'the 1-second recovery deadline must release admission');
    assert.ok(Date.now() - started < 2200);
    assert.equal(recoverySignal.aborted, true, 'the bounded operation deadline elapsed even though the client ignored it');

    const accepted = prepared.commit();
    const before = f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(accepted.run_id).chat_context_json;
    assert.equal(JSON.parse(before).checkpoint, null, 'acceptance uses bounded stored context when recovery misses its deadline');
    if (outcome === 'resolve') {
      resolveRecovery({
        protocol: 1,
        status: 'recovered',
        execution_authorized: false,
        checkpoint: {
          protocol: 1,
          kind: 'chat_compaction_checkpoint',
          checkpoint_id: 'late-checkpoint',
          checkpoint_sha256: 'a'.repeat(64),
          run_id: f.scope.run_id,
          session_id: f.scope.session_ref,
          source_sha256: f.input.source_sha256,
          summary_text_sha256: 'b'.repeat(64),
          native_summary_sha256: 'c'.repeat(64),
          parent_checkpoint_id: null,
          execution_authorized: false,
        },
      });
    } else {
      rejectRecovery(Error('late_recovery_transport_failure'));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(accepted.run_id).chat_context_json, before,
      `late ${outcome} must not change the accepted immutable snapshot`);
  };
  await Promise.all([scenario('resolve'), scenario('reject')]);
});

test('a user run accepted during recovery is present in the later transaction snapshot', { timeout: 5000 }, async t => {
  const f = settledCheckpointFixture(t), published = new ChatCompactionCheckpoints(f.db);
  let resolveRecovery, signal;
  let announceRecoveryStarted;
  const recoveryStarted = new Promise(resolve => { announceRecoveryStarted = resolve; });
  const client = {
    conversationModeReadiness: async () => ({ protocol: 1, ready: true, policy: f.policy }),
    recoverChatCheckpoint: (_sessionId, _history, _intentId, requestSignal) => {
      signal = requestSignal;
      const checkpoint = published.publish(f.scope, f.input);
      announceRecoveryStarted(checkpoint);
      return new Promise(resolve => { resolveRecovery = () => resolve({ protocol: 1, status: 'recovered', checkpoint, execution_authorized: false }); });
    },
  };
  const modes = new ConversationModes(f.db, f.conversations, f.runs, client, true);
  const expectedVersion = f.conversations.get(f.c.conversation_id, f.scope.owner_id).version;
  const preparing = modes.prepareEnqueue(f.c.conversation_id, f.scope.owner_id, {
    client_message_id: 'delayed-admission',
    content: [{ type: 'text', text: 'Delayed admission text.' }],
  });
  const checkpoint = await recoveryStarted;
  const interleaved = f.newInput();
  assert.equal(f.conversations.get(f.c.conversation_id, f.scope.owner_id).version, expectedVersion,
    'ordinary message acceptance does not advance conversation.version');
  resolveRecovery();
  const accepted = (await preparing)();
  const snapshot = JSON.parse(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(accepted.run_id).chat_context_json);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(snapshot.checkpoint.checkpoint_id, checkpoint.checkpoint_id);
  assert.ok(snapshot.messages.some(message => message.message_id === interleaved.message_id),
    'RunRepository snapshots messages accepted while the recovery RPC was pending');
  assert.ok(snapshot.model_text.includes('New synthetic input.'));
});
