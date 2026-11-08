import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { ChannelIntakeService } from '../../src/channels/intake.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { createVersionedWeixinContextProtector } from '../../src/channels/weixin-context-protector.ts';
import { createWeixinIlinkAdapter } from '../../src/channels/weixin-ilink.ts';

function testKeyAuthority() {
  const encryptionKeys = new Map([['fixture-encryption-v1', randomBytes(32)]]);
  const fingerprintKeys = new Map([['fixture-fingerprint-v1', randomBytes(32)]]);
  let currentEncryptionId = 'fixture-encryption-v1';
  let currentFingerprintId = 'fixture-fingerprint-v1';
  const calls = { currentEncryption: 0, encryptionById: [], currentFingerprint: 0,
    fingerprintById: [] };
  const resolver = {
    currentEncryptionKey() {
      calls.currentEncryption++;
      return { keyId: currentEncryptionId, key: encryptionKeys.get(currentEncryptionId) };
    },
    encryptionKey(keyId) {
      calls.encryptionById.push(keyId);
      return encryptionKeys.get(keyId);
    },
    currentFingerprintKey() {
      calls.currentFingerprint++;
      return { keyId: currentFingerprintId, key: fingerprintKeys.get(currentFingerprintId) };
    },
    fingerprintKey(keyId) {
      calls.fingerprintById.push(keyId);
      return fingerprintKeys.get(keyId);
    },
  };
  return {
    calls, encryptionKeys, fingerprintKeys, resolver,
    rotate() {
      if (!encryptionKeys.has('fixture-encryption-v2')) encryptionKeys.set('fixture-encryption-v2', randomBytes(32));
      if (!fingerprintKeys.has('fixture-fingerprint-v2')) fingerprintKeys.set('fixture-fingerprint-v2', randomBytes(32));
      currentEncryptionId = 'fixture-encryption-v2';
      currentFingerprintId = 'fixture-fingerprint-v2';
    },
  };
}

function instrumentedProtector(authority) {
  const actual = createVersionedWeixinContextProtector(authority.resolver);
  const calls = { seal: 0, open: 0, fingerprint: 0, verifyFingerprint: 0 };
  return {
    calls,
    seal(value, aad) { calls.seal++; return actual.seal(value, aad); },
    open(value, aad) { calls.open++; return actual.open(value, aad); },
    fingerprint(value, aad) { calls.fingerprint++; return actual.fingerprint(value, aad); },
    verifyFingerprint(value, aad, expected) {
      calls.verifyFingerprint++;
      return actual.verifyFingerprint(value, aad, expected);
    },
  };
}

function createFixture(dbPath, keyAuthority = testKeyAuthority()) {
  const db = openProductDatabase(dbPath);
  let now = 1_000;
  const bindings = new OwnerChannelBindings(db, { enabled: ['wecom'], now: () => now });
  installChannelAuthorityMigration(db);
  const intake = new ChannelIntakeService(db, new RunRepository(db, new EventStore(db)), 'workspace-a', bindings);
  const delivery = new ChannelDeliveryService(db, () => now);
  const apiCalls = [];
  const api = { async sendText(input) { apiCalls.push(input); return { ret: 0 }; } };
  const protector = instrumentedProtector(keyAuthority);
  const adapter = createWeixinIlinkAdapter({ db, intake, bindings, delivery,
    protector, api, now: () => now });
  return { db, bindings, intake, delivery, protector, keyAuthority, adapter, apiCalls, api, close() { db.close(); },
    setNow(value) { now = value; } };
}

function fixture(t) {
  const f = createFixture(':memory:');
  t.after(() => f.close());
  return f;
}

function principal(accountId, senderId) {
  return JSON.stringify([accountId, senderId]);
}

function bind(f, ownerId, accountId = 'bot-a', senderId = 'user-a') {
  // Synthetic precondition for adapter tests only; Unit 6 owns real Weixin provisioning.
  const providerPrincipal = principal(accountId, senderId);
  const channelBindingId = `synthetic-weixin-binding-${ownerId}`;
  f.db.prepare(`INSERT INTO ga_owner_channel_bindings(
    channel_binding_id,owner_id,channel,principal,status,version,verified_at,revoked_at,created_at
  ) VALUES(?,?,'weixin',?,'verified',1,?,NULL,?)`).run(channelBindingId, ownerId, providerPrincipal, 1_000, 1_000);
  return f.bindings.resolve(ownerId, channelBindingId);
}

function update(messageId, overrides = {}) {
  return { senderId: 'user-a', messageId, text: 'hello Jot', isDirect: true,
    contextToken: 'fixture-only-reply-context', contextExpiresAt: 2_000, ...overrides };
}

function batch(accountId, expectedCursor, nextCursor, updates,
  expectedGeneration = expectedCursor === null ? 0 : 1) {
  return { accountId, expectedCursor, expectedGeneration, nextCursor, updates };
}

function insertSendingDelivery(f, effectId, runId, recipient) {
  const timestamp = new Date(1_000_000).toISOString();
  f.db.prepare(`INSERT INTO ga_channel_deliveries(
    effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,
    generation,lease_owner,lease_expires_at,created_at,updated_at
  ) VALUES(?,?,?,'weixin',?,NULL,?,'sending',1,'fixture-worker',1_100,?,?)`)
    .run(effectId, runId, `assistant-${effectId}`, recipient,
      JSON.stringify({ kind: 'text', text: 'reply text' }), timestamp, timestamp);
}

test('unbound Weixin messages are rejected without creating a synthetic-owner run', t => {
  const f = fixture(t);
  const result = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-41')]));

  assert.deepEqual(result.items, [{ status: 'rejected_unbound', provider_message_id: 'native-41' }]);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 0);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-1', generation: 1 });
});

test('bound Weixin intake keeps native message identity and rejects a replay after owner reassignment', t => {
  const f = fixture(t);
  const binding = bind(f, 'alice');
  const accepted = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-0042')]));
  assert.equal(accepted.items[0].status, 'accepted');
  assert.equal(accepted.items[0].provider_message_id, 'native-0042');
  const firstRunId = accepted.items[0].run_id;
  const event = f.db.prepare(`SELECT e.provider_message_id,c.owner_id FROM ga_channel_message_events e
    JOIN ga_conversations c ON c.id=e.conversation_id WHERE e.run_id=?`).get(firstRunId);
  assert.equal(event.provider_message_id, 'native-0042');
  assert.equal(event.owner_id, 'alice');

  f.bindings.revoke('alice', binding.channel_binding_id, binding.version);
  bind(f, 'bob');
  const reassignedReplay = f.adapter.acceptPollBatch(batch('bot-a', 'cursor-1', 'cursor-2', [update('native-0042')]));
  assert.deepEqual(reassignedReplay.items, [{ status: 'rejected_owner_conflict', provider_message_id: 'native-0042' }]);
  assert.equal(Object.hasOwn(reassignedReplay.items[0], 'run_id'), false);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
});

test('context-sidecar failure rolls back nested intake writes and the cursor on the same SQLite handle', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.db.exec(`CREATE TRIGGER reject_context_insert BEFORE INSERT ON ga_channel_reply_contexts
    BEGIN SELECT RAISE(ABORT,'fixture_context_write_failed'); END`);

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-43')])),
    /fixture_context_write_failed/);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: null, generation: 0 });
});

test('the poll cursor generation is CAS-written before new event and context sidecar rows', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.db.exec(`CREATE TRIGGER require_cursor_before_sidecars BEFORE INSERT ON ga_channel_poll_cursors
    WHEN EXISTS(SELECT 1 FROM ga_channel_message_events WHERE provider_message_id='native-cursor-first')
      OR EXISTS(SELECT 1 FROM ga_channel_reply_contexts WHERE provider_message_id='native-cursor-first')
    BEGIN SELECT RAISE(ABORT,'fixture_cursor_not_first'); END`);

  const result = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-first', [update('native-cursor-first')]));
  assert.equal(result.items[0].status, 'accepted');
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-first', generation: 1 });
});

test('Weixin binding commands stay unsupported until owner provisioning is implemented', t => {
  const f = fixture(t);
  const result = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-bind-command', [{
    senderId: 'user-a', messageId: 'native-bind-command', text: '/jot-bind placeholder-code', isDirect: true,
  }]));

  assert.deepEqual(result.items, [{ status: 'ignored_unsupported', provider_message_id: 'native-bind-command' }]);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings WHERE channel=\'weixin\'').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_channel_reply_contexts').get().n), 0);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-bind-command', generation: 1 });
});

test('cursor write failure rolls back intake and context rows from the complete poll batch', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.db.exec(`CREATE TRIGGER reject_cursor_insert BEFORE INSERT ON ga_channel_poll_cursors
    BEGIN SELECT RAISE(ABORT,'fixture_cursor_write_failed'); END`);

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-atomicity', [update('native-cursor-fail')])),
    /fixture_cursor_write_failed/);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_channel_reply_contexts').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: null, generation: 0 });
});

test('event replay keeps the same run and context, while a changed token rolls back the cursor', t => {
  const f = fixture(t);
  bind(f, 'alice');
  const first = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-44')]));
  const replay = f.adapter.acceptPollBatch(batch('bot-a', 'cursor-1', 'cursor-2', [update('native-44')]));

  assert.equal(replay.items[0].status, 'replayed');
  assert.equal(replay.items[0].run_id, first.items[0].run_id);
  assert.equal(replay.items[0].provider_message_id, 'native-44');
  const context = f.db.prepare('SELECT * FROM ga_channel_reply_contexts').get();
  assert.equal(context.state, 'available');
  assert.equal(context.provider_message_id, 'native-44');
  assert.equal(context.context_key_id, 'fixture-encryption-v1');
  assert.equal(context.context_fingerprint_key_id, 'fixture-fingerprint-v1');
  assert.match(context.context_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(context.context_ciphertext).keyId, context.context_key_id);
  assert.equal(context.principal, '["bot-a","user-a"]');
  assert.equal(JSON.stringify(context).includes('fixture-only-reply-context'), false);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-2', generation: 2 });

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', 'cursor-2', 'cursor-3', [
    update('native-44', { contextToken: 'different-fixture-context' }),
  ], 2)), /weixin_reply_context_conflict/);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-2', generation: 2 });
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
});

test('replay after context expiry clears both key-ID pairs and advances only the committed cursor', t => {
  const f = fixture(t);
  bind(f, 'alice');
  const accepted = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-before-expiry', [
    update('native-expire-replay'),
  ]));
  f.setNow(2_001);

  const replay = f.adapter.acceptPollBatch(batch('bot-a', 'cursor-before-expiry',
    'cursor-after-expiry', [update('native-expire-replay')]));

  assert.equal(replay.items[0].status, 'replayed');
  assert.equal(replay.items[0].run_id, accepted.items[0].run_id);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-after-expiry', generation: 2 });
  const row = f.db.prepare(`SELECT state,context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id,expires_at FROM ga_channel_reply_contexts`).get();
  assert.deepEqual({ ...row }, { state: 'expired', context_ciphertext: null, context_key_id: null,
    context_fingerprint: null, context_fingerprint_key_id: null, expires_at: 2_000 });
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
});

test('a stale poll response cannot overwrite the current account cursor', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-45')]));

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-stale', [update('native-46')])),
    /weixin_cursor_conflict/);
  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-1', generation: 1 });
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
});

test('a late poll response cannot commit after a repeated cursor value advances generation', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'same-provider-cursor', []));
  const requestSnapshot = f.adapter.getCursor('bot-a');

  // Two responses were issued from the same persisted (value, generation) snapshot.
  const newerResponse = batch('bot-a', requestSnapshot.value, 'same-provider-cursor', [],
    requestSnapshot.generation);
  const olderResponse = batch('bot-a', requestSnapshot.value, 'stale-next-cursor',
    [update('native-stale-response')], requestSnapshot.generation);
  f.adapter.acceptPollBatch(newerResponse);

  assert.throws(() => f.adapter.acceptPollBatch(olderResponse), /weixin_cursor_conflict/);
  assert.deepEqual(f.adapter.getCursor('bot-a'), {
    value: requestSnapshot.value, generation: requestSnapshot.generation + 1,
  });
  assert.equal(Number(f.db.prepare(`SELECT count(*) n FROM ga_channel_message_events
    WHERE provider_message_id='native-stale-response'`).get().n), 0);
  assert.equal(Number(f.db.prepare(`SELECT count(*) n FROM ga_channel_reply_contexts
    WHERE provider_message_id='native-stale-response'`).get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);
});

test('encrypted cursor and reply context recover by stored key IDs after restart and rotation', t => {
  const directory = resolve(process.cwd(), '.test-tmp');
  mkdirSync(directory, { recursive: true });
  const dbPath = resolve(directory, `weixin-restart-${process.pid}-${randomBytes(6).toString('hex')}.sqlite`);
  const keyAuthority = testKeyAuthority();
  let reopened = createFixture(dbPath, keyAuthority);
  t.after(() => {
    reopened.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  bind(reopened, 'alice');
  const accepted = reopened.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-durable-1', [update('native-restart')]));
  const originalRunId = accepted.items[0].run_id;
  const originalContext = reopened.db.prepare(`SELECT context_ciphertext,context_key_id,
    context_fingerprint,context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  reopened.close();

  keyAuthority.rotate();
  reopened = createFixture(dbPath, keyAuthority);
  assert.deepEqual(reopened.adapter.getCursor('bot-a'), { value: 'cursor-durable-1', generation: 1 });
  const context = reopened.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint_key_id
    FROM ga_channel_reply_contexts
    WHERE provider_message_id='native-restart'`).get();
  assert.ok(context.context_ciphertext);
  assert.equal(context.context_key_id, 'fixture-encryption-v1');
  assert.equal(context.context_fingerprint_key_id, 'fixture-fingerprint-v1');
  const replay = reopened.adapter.acceptPollBatch(batch('bot-a', 'cursor-durable-1', 'cursor-durable-2', [
    update('native-restart'),
  ]));
  assert.equal(replay.items[0].status, 'replayed');
  assert.equal(replay.items[0].run_id, originalRunId);
  assert.deepEqual(reopened.adapter.getCursor('bot-a'), { value: 'cursor-durable-2', generation: 2 });
  assert.equal(Number(reopened.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
  const afterReplay = reopened.db.prepare(`SELECT context_ciphertext,context_key_id,
    context_fingerprint,context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  assert.deepEqual(afterReplay, originalContext, 'replay keeps the old ciphertext and both stored key IDs');
  const cursor = reopened.db.prepare(`SELECT cursor_ciphertext,cursor_key_id FROM ga_channel_poll_cursors
    WHERE provider_account_id='bot-a'`).get();
  assert.equal(cursor.cursor_key_id, 'fixture-encryption-v2');
  assert.equal(JSON.parse(cursor.cursor_ciphertext).keyId, cursor.cursor_key_id);
  assert.ok(keyAuthority.calls.encryptionById.includes('fixture-encryption-v1'));
  assert.ok(keyAuthority.calls.fingerprintById.includes('fixture-fingerprint-v1'));
});

test('reply context ciphertext cannot be moved to a different provider message identity', async t => {
  const f = fixture(t);
  bind(f, 'alice');
  const accepted = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-aad-1', [
    update('native-aad-a'), update('native-aad-b', { contextToken: 'second-fixture-context' }),
  ]));
  const contexts = f.db.prepare(`SELECT provider_message_id,context_ciphertext,context_key_id
    FROM ga_channel_reply_contexts ORDER BY provider_message_id`).all();
  const first = contexts.find(row => row.provider_message_id === 'native-aad-a');
  f.db.prepare(`UPDATE ga_channel_reply_contexts SET context_ciphertext=?,context_key_id=?
    WHERE provider_message_id='native-aad-b'`).run(first.context_ciphertext, first.context_key_id);
  insertSendingDelivery(f, 'effect-aad-mismatch', accepted.items[1].run_id, principal('bot-a', 'user-a'));

  const sent = await f.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
    messageId: 'native-aad-b', effectId: 'effect-aad-mismatch', generation: 1, text: 'reply text' });
  assert.deepEqual(sent, { kind: 'blocked', reason: 'WEIXIN_CONTEXT_INVALID' });
  assert.equal(f.apiCalls.length, 0);
});

test('missing context blocks a reply before invoking the provider', async t => {
  const f = fixture(t);
  bind(f, 'alice');
  const result = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [
    update('native-47', { contextToken: undefined, contextExpiresAt: undefined }),
  ]));
  insertSendingDelivery(f, 'effect-missing-context', result.items[0].run_id, principal('bot-a', 'user-a'));

  const sent = await f.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
    messageId: 'native-47', effectId: 'effect-missing-context', generation: 1, text: 'reply text' });
  assert.deepEqual(sent, { kind: 'blocked', reason: 'WEIXIN_CONTEXT_MISSING' });
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.delivery.get('effect-missing-context').status, 'sending');
});

test('expired or revoked reply authority is blocked without a provider call', async t => {
  const f = fixture(t);
  const binding = bind(f, 'alice');
  const result = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-48')]));
  insertSendingDelivery(f, 'effect-revoked-context', result.items[0].run_id, principal('bot-a', 'user-a'));
  f.bindings.revoke('alice', binding.channel_binding_id, binding.version);

  const sent = await f.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
    messageId: 'native-48', effectId: 'effect-revoked-context', generation: 1, text: 'reply text' });
  assert.deepEqual(sent, { kind: 'blocked', reason: 'WEIXIN_OWNER_BINDING_REVOKED' });
  assert.equal(f.apiCalls.length, 0);
  const context = f.db.prepare('SELECT state,context_ciphertext FROM ga_channel_reply_contexts').get();
  assert.equal(context.state, 'revoked');
  assert.equal(context.context_ciphertext, null);
  const revoked = f.db.prepare(`SELECT context_key_id,context_fingerprint,context_fingerprint_key_id
    FROM ga_channel_reply_contexts`).get();
  assert.deepEqual({ ...revoked }, { context_key_id: null, context_fingerprint: null,
    context_fingerprint_key_id: null });
  assert.equal(f.delivery.get('effect-revoked-context').status, 'sending');

  const g = fixture(t);
  bind(g, 'alice');
  const expired = g.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [
    update('native-49', { contextExpiresAt: 1_001 }),
  ]));
  g.setNow(1_002);
  insertSendingDelivery(g, 'effect-expired-context', expired.items[0].run_id, principal('bot-a', 'user-a'));
  const expiredResult = await g.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
    messageId: 'native-49', effectId: 'effect-expired-context', generation: 1, text: 'reply text' });
  assert.deepEqual(expiredResult, { kind: 'blocked', reason: 'WEIXIN_CONTEXT_EXPIRED' });
  assert.equal(g.apiCalls.length, 0);
  assert.equal(g.delivery.get('effect-expired-context').status, 'sending');
  const expiredContext = g.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  assert.deepEqual({ ...expiredContext }, { context_ciphertext: null, context_key_id: null,
    context_fingerprint: null, context_fingerprint_key_id: null });
});

test('a successful provider response without stable receipt becomes outcome_unknown, never a synthetic receipt', async t => {
  const f = fixture(t);
  bind(f, 'alice');
  const accepted = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-50')]));
  insertSendingDelivery(f, 'effect-no-receipt', accepted.items[0].run_id, principal('bot-a', 'user-a'));

  const sent = await f.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
    messageId: 'native-50', effectId: 'effect-no-receipt', generation: 1, text: 'reply text' });
  assert.deepEqual(sent, { kind: 'outcome_unknown' });
  assert.equal(f.apiCalls.length, 1);
  const row = f.delivery.get('effect-no-receipt');
  assert.equal(row.status, 'outcome_unknown');
  assert.equal(row.provider_receipt_json, null);
});

test('a stable native provider receipt is recorded verbatim for receipt-only recovery', async t => {
  const f = fixture(t);
  bind(f, 'alice');
  const accepted = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-1', [update('native-51')]));
  insertSendingDelivery(f, 'effect-stable-receipt', accepted.items[0].run_id, principal('bot-a', 'user-a'));
  f.api.sendText = async input => { f.apiCalls.push(input); return { ret: 0, remoteMessageId: 'remote-message-991' }; };

  const sent = await f.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
    messageId: 'native-51', effectId: 'effect-stable-receipt', generation: 1, text: 'reply text' });
  assert.deepEqual(sent, { kind: 'sent', provider_message_id: 'remote-message-991' });
  const row = f.delivery.get('effect-stable-receipt');
  assert.equal(row.status, 'receipt_pending');
  assert.equal(JSON.parse(row.provider_receipt_json).provider_message_id, 'remote-message-991');
  assert.equal(f.apiCalls[0].contextToken, 'fixture-only-reply-context');
  assert.ok(f.protector.calls.seal >= 2, 'context and cursor use the real AES-GCM helper');
  assert.ok(f.protector.calls.fingerprint >= 1, 'context fingerprint uses the real HMAC helper');
  assert.ok(f.protector.calls.open >= 1, 'reply preflight decrypts with the real helper');
  assert.ok(f.protector.calls.verifyFingerprint >= 1, 'reply preflight verifies the stored fingerprint');
});

test('a missing retained fingerprint key holds replay without resealing context or advancing the cursor', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-before-missing-key', [update('native-old-key')]));
  const before = f.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  f.keyAuthority.rotate();
  f.keyAuthority.fingerprintKeys.delete('fixture-fingerprint-v1');
  const sealCallsBefore = f.protector.calls.seal;
  const fingerprintCallsBefore = f.protector.calls.fingerprint;
  const currentFingerprintCallsBefore = f.keyAuthority.calls.currentFingerprint;

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', 'cursor-before-missing-key',
    'cursor-must-not-advance', [update('native-old-key')])),
  error => error instanceof Error && error.message === 'weixin_protector_key_unavailable');

  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-before-missing-key', generation: 1 });
  assert.deepEqual(f.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get(), before);
  assert.equal(f.protector.calls.seal, sealCallsBefore + 1, 'only the cursor is sealed before the batch rolls back');
  assert.equal(f.protector.calls.fingerprint, fingerprintCallsBefore,
    'replay uses the stored fingerprint key ID rather than the current fingerprint key');
  assert.deepEqual(f.keyAuthority.calls.fingerprintById.slice(-1), ['fixture-fingerprint-v1']);
  assert.equal(f.keyAuthority.calls.currentFingerprint, currentFingerprintCallsBefore + 1,
    'only the cursor seal resolves a current fingerprint key; context replay uses the stored key ID');
});

test('a missing retained context encryption key holds its old sidecar without resealing', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-context-enc-v1', [update('native-context-enc-v1')]));
  f.keyAuthority.rotate();
  f.adapter.acceptPollBatch(batch('bot-a', 'cursor-context-enc-v1', 'cursor-context-enc-v2', []));
  const before = f.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  f.keyAuthority.encryptionKeys.delete('fixture-encryption-v1');
  const sealCallsBefore = f.protector.calls.seal;
  const currentEncryptionCallsBefore = f.keyAuthority.calls.currentEncryption;

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', 'cursor-context-enc-v2',
    'cursor-context-enc-v3', [update('native-context-enc-v1')], 2)),
  error => error instanceof Error && error.message === 'weixin_protector_key_unavailable');

  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-context-enc-v2', generation: 2 });
  assert.deepEqual(f.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get(), before);
  assert.equal(f.protector.calls.seal, sealCallsBefore + 1, 'only the cursor is sealed before the batch rolls back');
  assert.equal(f.keyAuthority.calls.currentEncryption, currentEncryptionCallsBefore + 1,
    'only the cursor uses the active encryption key; the historical context does not fall back');
  assert.deepEqual(f.keyAuthority.calls.encryptionById.slice(-3),
    ['fixture-encryption-v2', 'fixture-encryption-v1', 'fixture-encryption-v2']);
});

test('a missing retained encryption key holds the cursor without falling back or resetting it', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-encrypted-with-v1', [update('native-v1')]));
  const before = f.db.prepare(`SELECT cursor_ciphertext,cursor_key_id,generation
    FROM ga_channel_poll_cursors WHERE provider_account_id='bot-a'`).get();
  f.keyAuthority.rotate();
  f.keyAuthority.encryptionKeys.delete('fixture-encryption-v1');
  const currentEncryptionCallsBefore = f.keyAuthority.calls.currentEncryption;

  assert.throws(() => f.adapter.getCursor('bot-a'),
    error => error instanceof Error && error.message === 'weixin_protector_key_unavailable');
  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', 'cursor-encrypted-with-v1',
    'cursor-must-not-reset', [])),
  error => error instanceof Error && error.message === 'weixin_protector_key_unavailable');

  assert.deepEqual({ ...f.db.prepare(`SELECT cursor_ciphertext,cursor_key_id,generation
    FROM ga_channel_poll_cursors WHERE provider_account_id='bot-a'`).get() }, { ...before });
  assert.deepEqual(f.keyAuthority.calls.encryptionById.slice(-2),
    ['fixture-encryption-v1', 'fixture-encryption-v1']);
  assert.equal(f.keyAuthority.calls.currentEncryption, currentEncryptionCallsBefore,
    'cursor reads never fall back to the active encryption key');
});

test('a mid-batch context conflict rolls back earlier event writes and cursor CAS', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-before-batch', [update('native-existing')]));

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', 'cursor-before-batch', 'cursor-after-batch', [
    update('native-first-in-batch'), update('native-existing', { contextToken: 'different-fixture-context' }),
  ])), /weixin_reply_context_conflict/);

  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-before-batch', generation: 1 });
  assert.equal(Number(f.db.prepare(`SELECT count(*) n FROM ga_channel_message_events
    WHERE provider_message_id='native-first-in-batch'`).get().n), 0);
  assert.equal(Number(f.db.prepare(`SELECT count(*) n FROM ga_channel_reply_contexts
    WHERE provider_message_id='native-first-in-batch'`).get().n), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 1);
});

test('a context envelope key ID mismatch is held without changing the stored row or cursor', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-before-tamper', [update('native-tamper')]));
  const original = f.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  f.keyAuthority.rotate();
  f.db.prepare(`UPDATE ga_channel_reply_contexts SET context_key_id='fixture-encryption-v2'
    WHERE provider_message_id='native-tamper'`).run();

  assert.throws(() => f.adapter.acceptPollBatch(batch('bot-a', 'cursor-before-tamper', 'cursor-after-tamper', [
    update('native-tamper'),
  ])), error => error instanceof Error && error.message === 'weixin_protector_envelope_invalid');

  assert.deepEqual(f.adapter.getCursor('bot-a'), { value: 'cursor-before-tamper', generation: 1 });
  const held = f.db.prepare(`SELECT context_ciphertext,context_key_id,context_fingerprint,
    context_fingerprint_key_id FROM ga_channel_reply_contexts`).get();
  assert.equal(held.context_ciphertext, original.context_ciphertext);
  assert.equal(held.context_key_id, 'fixture-encryption-v2', 'tampered key-ID remains visible for remediation');
  assert.equal(held.context_fingerprint, original.context_fingerprint);
  assert.equal(held.context_fingerprint_key_id, original.context_fingerprint_key_id);
});

test('a poll cursor envelope key ID must match its stored column before decrypting', t => {
  const f = fixture(t);
  bind(f, 'alice');
  f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-before-keyid-tamper', [update('native-keyid-tamper')]));
  const before = f.db.prepare(`SELECT cursor_ciphertext,cursor_key_id,generation
    FROM ga_channel_poll_cursors WHERE provider_account_id='bot-a'`).get();
  f.keyAuthority.rotate();
  f.db.prepare(`UPDATE ga_channel_poll_cursors SET cursor_key_id='fixture-encryption-v2'
    WHERE provider_account_id='bot-a'`).run();
  const currentEncryptionCallsBefore = f.keyAuthority.calls.currentEncryption;

  assert.throws(() => f.adapter.getCursor('bot-a'),
    error => error instanceof Error && error.message === 'weixin_protector_envelope_invalid');

  const held = f.db.prepare(`SELECT cursor_ciphertext,cursor_key_id,generation
    FROM ga_channel_poll_cursors WHERE provider_account_id='bot-a'`).get();
  assert.equal(held.cursor_ciphertext, before.cursor_ciphertext);
  assert.equal(held.cursor_key_id, 'fixture-encryption-v2');
  assert.equal(held.generation, before.generation);
  assert.equal(f.keyAuthority.calls.currentEncryption, currentEncryptionCallsBefore,
    'cursor reads do not fall back to the active key');
});

test('missing retained context fingerprint is reported with a fixed reason and no sensitive logging', async t => {
  const f = fixture(t);
  bind(f, 'alice');
  const accepted = f.adapter.acceptPollBatch(batch('bot-a', null, 'cursor-before-missing-context-key', [
    update('native-missing-context-key'),
  ]));
  insertSendingDelivery(f, 'effect-missing-context-key', accepted.items[0].run_id,
    principal('bot-a', 'user-a'));
  f.db.prepare(`UPDATE ga_channel_reply_contexts SET context_fingerprint_key_id='fixture-fingerprint-deleted'
    WHERE provider_message_id='native-missing-context-key'`).run();
  const originalConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug']
    .map(name => [name, console[name]]));
  const logOutput = [];
  for (const name of Object.keys(originalConsole)) console[name] = (...args) => logOutput.push(args.join(' '));
  let result;
  try {
    result = await f.adapter.sendReply({ accountId: 'bot-a', senderId: 'user-a',
      messageId: 'native-missing-context-key', effectId: 'effect-missing-context-key',
      generation: 1, text: 'reply text' });
  } finally {
    for (const [name, fn] of Object.entries(originalConsole)) console[name] = fn;
  }

  assert.deepEqual(result, { kind: 'blocked', reason: 'WEIXIN_CONTEXT_INVALID' });
  assert.equal(f.apiCalls.length, 0);
  assert.deepEqual(logOutput, []);
  assert.equal(JSON.stringify(logOutput).includes('fixture-only-reply-context'), false);
});

test('adapter refuses to start without an injected context protector', t => {
  const db = openProductDatabase(':memory:');
  const bindings = new OwnerChannelBindings(db, { enabled: ['wecom'] });
  installChannelAuthorityMigration(db);
  const intake = new ChannelIntakeService(db, new RunRepository(db, new EventStore(db)), 'workspace-a', bindings);
  const delivery = new ChannelDeliveryService(db);
  t.after(() => db.close());

  assert.throws(() => createWeixinIlinkAdapter({ db, intake, bindings, delivery,
    protector: undefined, api: { async sendText() { return { ret: 0 }; } } }), /weixin_context_protector_required/);
});

test('adapter refuses an intake whose event store uses a different SQLite connection', t => {
  const db = openProductDatabase(':memory:');
  const eventDb = openProductDatabase(':memory:');
  const bindings = new OwnerChannelBindings(db, { enabled: ['wecom'] });
  installChannelAuthorityMigration(db);
  const intake = new ChannelIntakeService(db, new RunRepository(db, new EventStore(eventDb)), 'workspace-a', bindings);
  const delivery = new ChannelDeliveryService(db);
  t.after(() => { db.close(); eventDb.close(); });

  assert.throws(() => createWeixinIlinkAdapter({ db, intake, bindings, delivery,
    protector: instrumentedProtector(testKeyAuthority()),
    api: { async sendText() { return { ret: 0 }; } } }), /weixin_database_mismatch/);
});
