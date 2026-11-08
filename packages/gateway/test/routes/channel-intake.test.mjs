import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ga-channel-intake-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['jot'],
    internalChannelToken: 'test-intake-123456' });
  const headers = { authorization: 'Bearer test-intake-123456' };
  const bindings = new OwnerChannelBindings(service.db, { enabled: ['wecom'] });
  t.after(async () => { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, headers, bindings };
}

function message(principal, messageId, text, extra = {}) {
  return { channel: 'wecom', principal, message_id: messageId, text, ...extra };
}

function post(service, headers, payload) {
  return service.app.inject({ method: 'POST', url: '/internal/v1/channel/messages', headers, payload });
}

function generationPin(binding) {
  return { channel_binding_id: binding.channel_binding_id, binding_version: binding.version };
}

async function bind(service, headers, bindings, owner, principal, requestKey) {
  const challenge = bindings.create(owner, 'wecom', requestKey);
  const proof = await post(service, headers,
    message(principal, `proof-${requestKey}`, `/jot-bind ${challenge.code}`));
  assert.equal(proof.statusCode, 202, proof.body);
  assert.equal(proof.json().accepted, true);
  return bindings.resolve(owner, challenge.channel_binding_id);
}

test('internal intake preserves WeCom challenge proof and pins root messages to the verified owner generation', async t => {
  const { service, headers, bindings } = await fixture(t);
  assert.equal((await post(service, {}, message('provider-user', 'untrusted-1', 'hello'))).statusCode, 401);

  const authority = await bind(service, headers, bindings, 'owner-a', 'provider-user', 'bind-owner-a-001');
  const payload = message('provider-user', 'wx-1', '去 Wikipedia 读取正文');
  const first = await post(service, headers, payload);
  assert.equal(first.statusCode, 202, first.body);
  assert.equal(first.json().accepted, true);
  const replay = await post(service, headers, payload);
  assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().run_id, first.json().run_id);

  const second = await post(service, headers, message('provider-user', 'wx-2', '继续'));
  assert.equal(second.statusCode, 202, second.body);
  assert.equal(second.json().conversation_id, first.json().conversation_id);
  const event = service.db.prepare(`SELECT conversation_id,message_id,run_id,channel_binding_id,binding_version
    FROM ga_channel_message_events WHERE channel='wecom' AND principal=? AND provider_message_id='wx-1'`)
    .get('provider-user');
  const root = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version
    FROM ga_channel_bindings WHERE channel='wecom' AND principal=?`).get('provider-user');
  const conversation = service.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(first.json().conversation_id);
  assert.deepEqual({ channel_binding_id: event.channel_binding_id, binding_version: event.binding_version }, generationPin(authority));
  assert.deepEqual({ channel_binding_id: root.channel_binding_id, binding_version: root.binding_version }, generationPin(authority));
  assert.equal(root.conversation_id, event.conversation_id);
  assert.equal(conversation.owner_id, 'owner-a');
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 2);
});

test('provider opaque message and thread IDs replay while unbound JSON identities remain unverified', async t => {
  const { service, headers, bindings } = await fixture(t);
  const providerPrincipal = JSON.stringify(['bot-a', 'user-a']);
  const original = await bind(service, headers, bindings, 'owner-a', providerPrincipal, 'bind-opaque-ids-01');

  const payload = message(providerPrincipal, 'message/@:2026-10', 'opaque provider event', {
    thread_id: 'thread/@:root/2026',
  });
  const first = await post(service, headers, payload);
  assert.equal(first.statusCode, 202, first.body);
  const replay = await post(service, headers, payload);
  assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().run_id, first.json().run_id);
  assert.equal(replay.json().conversation_id, first.json().conversation_id);
  const originalThread = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version
    FROM ga_channel_threads WHERE channel='wecom' AND principal=? AND provider_thread_id=?`)
    .get(providerPrincipal, payload.thread_id);
  assert.deepEqual({ channel_binding_id: originalThread.channel_binding_id,
    binding_version: originalThread.binding_version }, generationPin(original));

  const changedPrincipal = JSON.stringify(['bot-a', 'different-user']);
  const changedIdentity = await post(service, headers, message(changedPrincipal,
    payload.message_id, payload.text, { thread_id: payload.thread_id }));
  assert.equal(changedIdentity.statusCode, 409, changedIdentity.body);
  assert.equal(changedIdentity.json().error.code, 'CHANNEL_BINDING_NOT_VERIFIED');
  assert.equal(changedIdentity.json().run_id, undefined);

  bindings.revoke('owner-a', original.channel_binding_id, original.version);
  const rebound = await bind(service, headers, bindings, 'owner-b', providerPrincipal, 'bind-opaque-ids-02');
  const staleReplay = await post(service, headers, payload);
  assert.equal(staleReplay.statusCode, 409, staleReplay.body);
  assert.equal(staleReplay.json().error.code, 'CHANNEL_CACHED_EVENT_BINDING_MISMATCH');
  assert.equal(staleReplay.json().run_id, undefined);

  const next = await post(service, headers, message(providerPrincipal, 'message/@:2026-11', 'next generation', {
    thread_id: payload.thread_id,
  }));
  assert.equal(next.statusCode, 202, next.body);
  assert.notEqual(next.json().conversation_id, first.json().conversation_id);
  assert.equal(service.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(next.json().conversation_id).owner_id,
    'owner-b');
  const currentThread = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version
    FROM ga_channel_threads WHERE channel='wecom' AND principal=? AND provider_thread_id=?`)
    .get(providerPrincipal, payload.thread_id);
  assert.deepEqual({ channel_binding_id: currentThread.channel_binding_id,
    binding_version: currentThread.binding_version }, generationPin(rebound));

  const oversized = await post(service, headers, message(providerPrincipal, 'oversized-message', 'hello', {
    thread_id: 'x'.repeat(513),
  }));
  assert.equal(oversized.statusCode, 422, oversized.body);
  assert.equal(oversized.json().error.code, 'CHANNEL_MESSAGE_INVALID');

  const unboundJsonPrincipal = JSON.stringify(['bot-b', 'unbound-user']);
  const unboundJsonIdentity = await post(service, headers, message(unboundJsonPrincipal, 'json-message-1', 'hello'));
  assert.equal(unboundJsonIdentity.statusCode, 409, unboundJsonIdentity.body);
  assert.equal(unboundJsonIdentity.json().error.code, 'CHANNEL_BINDING_NOT_VERIFIED');
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 2);
});

test('unbound provider identities and unstaged attachments fail before creating runs or conversations', async t => {
  const { service, headers, bindings } = await fixture(t);
  const malformedBody = await post(service, headers, null);
  assert.equal(malformedBody.statusCode, 422, malformedBody.body);
  assert.equal(malformedBody.json().error.code, 'CHANNEL_MESSAGE_INVALID');
  const malformedInputs = [
    message(' provider-user', 'principal-leading', 'hello'),
    message('provider-user ', 'principal-trailing', 'hello'),
    message('provider\u0001user', 'principal-control', 'hello'),
    message('provider-user', ' message-leading', 'hello'),
    message('provider-user', 'message-trailing ', 'hello'),
    message('provider-user', 'message\u0001control', 'hello'),
    message('provider-user', 'x'.repeat(513), 'hello'),
    message('provider-user', 'thread-leading', 'hello', { thread_id: ' leading' }),
    message('provider-user', 'thread-trailing', 'hello', { thread_id: 'trailing ' }),
    message('provider-user', 'thread-control', 'hello', { thread_id: 'thread\u0001control' }),
    message('provider-user', 'thread-oversized', 'hello', { thread_id: 'x'.repeat(513) }),
  ];
  for (const malformed of malformedInputs) {
    const response = await post(service, headers, malformed);
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'CHANNEL_MESSAGE_INVALID');
  }
  const unbound = await post(service, headers, message('provider-unbound', 'unbound-1', 'hello'));
  assert.equal(unbound.statusCode, 409, unbound.body);
  assert.equal(unbound.json().error.code, 'CHANNEL_BINDING_NOT_VERIFIED');
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_conversations').get().n), 0);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);

  await bind(service, headers, bindings, 'owner-a', 'provider-user', 'bind-attachments-01');
  const attached = await post(service, headers, message('provider-user', 'attachment-1', 'read this', {
    attachments: [{ provider_file_id: 'provider-file-a', file_name: 'report.pdf', media_type: 'application/pdf' }],
  }));
  assert.equal(attached.statusCode, 422, attached.body);
  assert.equal(attached.json().error.code, 'CHANNEL_ATTACHMENT_STAGING_MISSING');
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n), 0);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 0);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_conversations').get().n), 0);
});

test('root rebind to another owner or the same owner allocates a new conversation and rejects old cached runs', async t => {
  const { service, headers, bindings } = await fixture(t);
  const original = await bind(service, headers, bindings, 'owner-a', 'provider-user', 'bind-root-a-001');
  const first = await post(service, headers, message('provider-user', 'root-old', 'old run'));
  assert.equal(first.statusCode, 202, first.body);
  const oldEvent = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_message_events
    WHERE channel='wecom' AND principal='provider-user' AND provider_message_id='root-old'`).get();

  bindings.revoke('owner-a', original.channel_binding_id, original.version);
  const rebound = await bind(service, headers, bindings, 'owner-b', 'provider-user', 'bind-root-b-001');
  const [next, concurrentNext] = await Promise.all([
    post(service, headers, message('provider-user', 'root-new', 'new owner run')),
    post(service, headers, message('provider-user', 'root-new-concurrent', 'concurrent new owner run')),
  ]);
  assert.equal(next.statusCode, 202, next.body);
  assert.equal(concurrentNext.statusCode, 202, concurrentNext.body);
  assert.notEqual(next.json().conversation_id, first.json().conversation_id);
  assert.equal(concurrentNext.json().conversation_id, next.json().conversation_id);
  assert.equal(service.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(next.json().conversation_id).owner_id,
    'owner-b');
  const currentRoot = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_bindings
    WHERE channel='wecom' AND principal='provider-user'`).get();
  assert.deepEqual({ channel_binding_id: currentRoot.channel_binding_id, binding_version: currentRoot.binding_version }, generationPin(rebound));
  assert.equal(currentRoot.conversation_id, next.json().conversation_id);
  assert.deepEqual({ channel_binding_id: oldEvent.channel_binding_id, binding_version: oldEvent.binding_version }, generationPin(original));

  const staleReplay = await post(service, headers, message('provider-user', 'root-old', 'old run'));
  assert.equal(staleReplay.statusCode, 409, staleReplay.body);
  assert.notEqual(staleReplay.json().run_id, first.json().run_id);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 3);

  const sameOwnerOriginal = await bind(service, headers, bindings, 'owner-a', 'provider-user-2', 'bind-same-a-001');
  const sameOwnerFirst = await post(service, headers, message('provider-user-2', 'same-old', 'old same owner'));
  assert.equal(sameOwnerFirst.statusCode, 202, sameOwnerFirst.body);
  bindings.revoke('owner-a', sameOwnerOriginal.channel_binding_id, sameOwnerOriginal.version);
  await bind(service, headers, bindings, 'owner-a', 'provider-user-2', 'bind-same-a-002');
  const sameOwnerNext = await post(service, headers, message('provider-user-2', 'same-new', 'new binding same owner'));
  assert.equal(sameOwnerNext.statusCode, 202, sameOwnerNext.body);
  assert.notEqual(sameOwnerNext.json().conversation_id, sameOwnerFirst.json().conversation_id);
});

test('thread cache proof and thread generation CAS reject stale replays while retaining historical pins', async t => {
  const { service, headers, bindings } = await fixture(t);
  const original = await bind(service, headers, bindings, 'owner-a', 'provider-thread-user', 'bind-thread-a-001');
  const oldPayload = message('provider-thread-user', 'thread-old', 'old thread run', { thread_id: 'thread-1' });
  const first = await post(service, headers, oldPayload);
  assert.equal(first.statusCode, 202, first.body);
  const oldEvent = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_message_events
    WHERE channel='wecom' AND principal='provider-thread-user' AND provider_message_id='thread-old'`).get();
  const oldThread = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads
    WHERE channel='wecom' AND principal='provider-thread-user' AND provider_thread_id='thread-1'`).get();
  assert.deepEqual({ channel_binding_id: oldThread.channel_binding_id, binding_version: oldThread.binding_version }, generationPin(original));

  bindings.revoke('owner-a', original.channel_binding_id, original.version);
  const rebound = await bind(service, headers, bindings, 'owner-b', 'provider-thread-user', 'bind-thread-b-001');
  const [next, concurrentNext] = await Promise.all([
    post(service, headers, message('provider-thread-user', 'thread-new', 'new thread run', { thread_id: 'thread-1' })),
    post(service, headers, message('provider-thread-user', 'thread-new-concurrent', 'concurrent new thread run', {
      thread_id: 'thread-1',
    })),
  ]);
  assert.equal(next.statusCode, 202, next.body);
  assert.equal(concurrentNext.statusCode, 202, concurrentNext.body);
  assert.notEqual(next.json().conversation_id, first.json().conversation_id);
  assert.equal(concurrentNext.json().conversation_id, next.json().conversation_id);
  const currentThread = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads
    WHERE channel='wecom' AND principal='provider-thread-user' AND provider_thread_id='thread-1'`).get();
  assert.deepEqual({ channel_binding_id: currentThread.channel_binding_id, binding_version: currentThread.binding_version }, generationPin(rebound));
  assert.equal(currentThread.conversation_id, next.json().conversation_id);
  assert.deepEqual({ channel_binding_id: oldEvent.channel_binding_id, binding_version: oldEvent.binding_version }, generationPin(original));
  const staleReplay = await post(service, headers, oldPayload);
  assert.equal(staleReplay.statusCode, 409, staleReplay.body);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 3);
});

test('intake refuses damaged cached proofs and does not auto-pin legacy root or thread rows', async t => {
  const { service, headers, bindings } = await fixture(t);
  const authority = await bind(service, headers, bindings, 'owner-a', 'provider-user', 'bind-legacy-root-001');
  const rootPayload = message('provider-user', 'legacy-root-old', 'root input');
  const first = await post(service, headers, rootPayload);
  assert.equal(first.statusCode, 202, first.body);
  const event = service.db.prepare(`SELECT event_sha256 FROM ga_channel_message_events
    WHERE channel='wecom' AND principal='provider-user' AND provider_message_id='legacy-root-old'`).get();
  const cachedMessage = service.db.prepare(`SELECT m.id,m.content_json FROM ga_messages m
    JOIN ga_channel_message_events e ON e.message_id=m.id
    WHERE e.channel='wecom' AND e.principal='provider-user' AND e.provider_message_id='legacy-root-old'`).get();
  service.db.prepare(`UPDATE ga_channel_message_events SET event_sha256=?
    WHERE channel='wecom' AND principal='provider-user' AND provider_message_id='legacy-root-old'`)
    .run('0'.repeat(64));
  const corruptedReplay = await post(service, headers, rootPayload);
  assert.equal(corruptedReplay.statusCode, 409, corruptedReplay.body);
  assert.equal(corruptedReplay.json().run_id, undefined);
  service.db.prepare(`UPDATE ga_channel_message_events SET event_sha256=?
    WHERE channel='wecom' AND principal='provider-user' AND provider_message_id='legacy-root-old'`)
    .run(event.event_sha256);
  service.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run('{}', cachedMessage.id);
  const damagedMessageReplay = await post(service, headers, rootPayload);
  assert.equal(damagedMessageReplay.statusCode, 409, damagedMessageReplay.body);
  assert.equal(damagedMessageReplay.json().error.code, 'CHANNEL_CACHED_EVENT_MESSAGE_MISMATCH');
  assert.equal(damagedMessageReplay.json().run_id, undefined);
  service.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run(cachedMessage.content_json, cachedMessage.id);

  service.db.prepare(`UPDATE ga_channel_bindings SET channel_binding_id=NULL,binding_version=NULL
    WHERE channel='wecom' AND principal='provider-user'`).run();
  const beforeRoot = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_bindings
    WHERE channel='wecom' AND principal='provider-user'`).get();
  const rejectedRoot = await post(service, headers, message('provider-user', 'legacy-root-new', 'must not repair'));
  assert.equal(rejectedRoot.statusCode, 409, rejectedRoot.body);
  assert.deepEqual(service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_bindings
    WHERE channel='wecom' AND principal='provider-user'`).get(), beforeRoot);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 1);

  bindings.revoke('owner-a', authority.channel_binding_id, authority.version);
  await bind(service, headers, bindings, 'owner-a', 'thread-user', 'bind-legacy-thread-001');
  const threadPayload = message('thread-user', 'legacy-thread-old', 'thread input', { thread_id: 'legacy-thread' });
  const threadFirst = await post(service, headers, threadPayload);
  assert.equal(threadFirst.statusCode, 202, threadFirst.body);
  service.db.prepare(`UPDATE ga_channel_threads SET channel_binding_id=NULL
    WHERE channel='wecom' AND principal='thread-user' AND provider_thread_id='legacy-thread'`).run();
  const beforeThread = service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads
    WHERE channel='wecom' AND principal='thread-user' AND provider_thread_id='legacy-thread'`).get();
  const rejectedThread = await post(service, headers, message('thread-user', 'legacy-thread-new', 'must not repair', {
    thread_id: 'legacy-thread',
  }));
  assert.equal(rejectedThread.statusCode, 409, rejectedThread.body);
  assert.deepEqual(service.db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads
    WHERE channel='wecom' AND principal='thread-user' AND provider_thread_id='legacy-thread'`).get(), beforeThread);
  assert.equal(Number(service.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n), 2);
});
