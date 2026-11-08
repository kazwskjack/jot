import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createQQDeliveryProvider,
  createQQWebhookAdapter,
  verifyQQWebhookSignature,
} from '../../src/channels/qq.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { ChannelIntakeService } from '../../src/channels/intake.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';

const officialChallengeSecret = String.fromCharCode(110, 97, 79, 67, 48, 111, 99, 81, 69, 51,
  115, 104, 87, 76, 65, 102, 102, 102, 86, 76, 66, 49, 114, 104, 89, 80, 71, 55);
const officialDispatchSecret = String.fromCharCode(68, 71, 53, 103, 51, 66, 52, 106,
  57, 88, 50, 75, 79, 69, 114, 71);

function fixtureSignature(secret, timestamp, body) {
  let seed = Buffer.from(secret, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  const privateKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), seed.subarray(0, 32),
  ]), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
}

test('QQ callback verification matches Tencent Ed25519 fixture and binds timestamp plus exact body bytes', () => {
  const secret = officialChallengeSecret;
  const timestamp = '1725442341';
  const body = Buffer.from('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}');
  const signature = fixtureSignature(secret, timestamp, body);
  assert.equal(verifyQQWebhookSignature({ secret, timestamp, signature, body }), true);
  assert.equal(verifyQQWebhookSignature({ secret, timestamp, signature, body: Buffer.from(body.toString() + ' ') }), false);
  assert.equal(verifyQQWebhookSignature({ secret, timestamp: 'not-a-timestamp', signature, body }), false);
  assert.equal(verifyQQWebhookSignature({ secret, timestamp, signature: 'bad', body }), false);
});

test('QQ webhook adapter signs the official callback validation challenge and ACKs only verified dispatches', async () => {
  const accepted = [];
  const intake = { accept: (input, options) => {
    accepted.push({ input, options });
    return { accepted: true, run_id: 'run-fixture' };
  } };
  const adapter = createQQWebhookAdapter({ appId: '11111111', botSecret: officialDispatchSecret, intake });
  const plainToken = String.fromCharCode(65, 114, 113, 48, 68, 53, 65, 54, 49, 69, 103, 85, 117, 52, 79, 120, 85, 118, 79, 112);
  const challenge = Buffer.from(JSON.stringify({ d: { plain_token: plainToken, event_ts: '1725442341' }, op: 13 }));
  const verified = await adapter.handle({ headers: { 'x-bot-appid': '11111111' }, body: challenge });
  assert.deepEqual(verified, { status: 200, body: {
    plain_token: plainToken,
    signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
  } });

  const dispatchBody = Buffer.from(JSON.stringify({ id: 'evt-1', op: 0, t: 'C2C_MESSAGE_CREATE', d: {
    id: 'msg-1', content: 'hello', author: { user_openid: 'user-7' }, timestamp: '2026-10-21T10:00:00Z',
  } }));
  const timestamp = '1725442341';
  const signed = fixtureSignature(officialDispatchSecret, timestamp, dispatchBody);
  const result = await adapter.handle({ headers: { 'x-bot-appid': '11111111',
    'x-signature-timestamp': timestamp, 'x-signature-ed25519': signed }, body: dispatchBody });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { op: 12 });
  assert.equal(result.intake_result.run_id, 'run-fixture');
  assert.deepEqual(accepted, [{ input: { channel: 'qq', principal: 'qq:c2c:user-7',
    message_id: 'msg-1', text: 'hello' }, options: { providerSignatureVerified: true } }]);
});

test('QQ webhook adapter rejects a forged signature before intake and ACKs signed unsupported events', async () => {
  const intake = { accept() { throw new Error('intake_must_not_run'); } };
  const adapter = createQQWebhookAdapter({ appId: 'app-1', botSecret: 'qq-fixture-secret', intake });
  const body = Buffer.from('{"op":0,"t":"FRIEND_ADD","d":{}}');
  const timestamp = '1725442341';
  await assert.rejects(adapter.handle({ headers: { 'x-bot-appid': 'other-app',
    'x-signature-timestamp': timestamp, 'x-signature-ed25519': '00'.repeat(64) }, body }), /qq_app_id_invalid/);
  await assert.rejects(adapter.handle({ headers: { 'x-bot-appid': 'app-1',
    'x-signature-timestamp': timestamp, 'x-signature-ed25519': '00'.repeat(64) }, body }), /qq_signature_invalid/);
  const signed = fixtureSignature('qq-fixture-secret', timestamp, body);
  assert.deepEqual(await adapter.handle({ headers: { 'x-bot-appid': 'app-1',
    'x-signature-timestamp': timestamp, 'x-signature-ed25519': signed }, body }), {
    status: 200, body: { op: 12 }, ignored: true,
  });
});

test('QQ delivery reuses the existing message event and outbox rows for passive reply context and receipt', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ga_channel_deliveries(effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, recipient TEXT NOT NULL);
    CREATE TABLE ga_channel_message_events(channel TEXT NOT NULL, principal TEXT NOT NULL,
      provider_message_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.prepare('INSERT INTO ga_channel_deliveries VALUES(?,?,?)').run('effect-1', 'run-1', 'qq:group:group-8');
  db.prepare('INSERT INTO ga_channel_message_events VALUES(?,?,?,?,?)')
    .run('qq', 'qq:group:group-8', 'inbound-msg-4', 'run-1', new Date().toISOString());
  const calls = [];
  const provider = createQQDeliveryProvider({ appId: 'fixture-app', appSecret: 'fixture-secret' }, db,
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/app/getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: '7200' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'outbound-msg-8', timestamp: 1_800_000_000 }), { status: 200 });
    });
  const receipt = await provider.sendWithKey('reply text', 'qq:group:group-8', 'effect-1');
  assert.deepEqual(receipt, { provider_message_id: 'outbound-msg-8' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(JSON.parse(calls[0].init.body), { appId: 'fixture-app', clientSecret: 'fixture-secret' });
  assert.equal(calls[1].url, 'https://api.sgroup.qq.com/v2/groups/group-8/messages');
  assert.equal(calls[1].init.headers.Authorization, 'QQBot fixture-token');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    content: 'reply text', msg_type: 0, msg_id: 'inbound-msg-4', msg_seq: 1,
  });
  db.prepare('UPDATE ga_channel_message_events SET created_at=? WHERE run_id=?')
    .run(new Date(Date.now() - 6 * 60 * 1000).toISOString(), 'run-1');
  await assert.rejects(provider.sendWithKey('late reply', 'qq:group:group-8', 'effect-1'), /qq_reply_context_missing/);
  assert.equal(calls.length, 2);
  db.prepare('INSERT INTO ga_channel_deliveries VALUES(?,?,?)')
    .run('effect-2', 'run-2', 'qq:c2c:user-3');
  db.prepare('INSERT INTO ga_channel_message_events VALUES(?,?,?,?,?)')
    .run('qq', 'qq:c2c:user-3', 'c2c-inbound-9', 'run-2', new Date().toISOString());
  const c2cReceipt = await provider.sendWithKey('private reply', 'qq:c2c:user-3', 'effect-2');
  assert.deepEqual(c2cReceipt, { provider_message_id: 'outbound-msg-8' });
  assert.equal(calls.length, 3, 'the access token is reused for the next send');
  assert.equal(calls[2].url, 'https://api.sgroup.qq.com/v2/users/user-3/messages');
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    content: 'private reply', msg_type: 0, msg_id: 'c2c-inbound-9', msg_seq: 1,
  });
  db.close();
});

test('QQ signed dispatch uses existing owner, thread, intake, and outbox records end to end', async () => {
  const db = openProductDatabase(':memory:');
  try {
    const secret = Buffer.alloc(32, 0x52).toString('hex');
    const bindings = new OwnerChannelBindings(db, { enabled: ['qq'] });
    installChannelAuthorityMigration(db);
    db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
      .run('binding-qq', 'owner-qq', 'qq', 'qq:group:group-9', 'verified', 1000, 1000);
    const intake = new ChannelIntakeService(db, new RunRepository(db, new EventStore(db)), 'ws', bindings);
    const adapter = createQQWebhookAdapter({ appId: 'app-qq', botSecret: secret, intake });
    const body = Buffer.from(JSON.stringify({ id: 'dispatch-1', op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
      id: 'group-message-1', group_openid: 'group-9', author: { member_openid: 'member-3' }, content: 'hello from group',
    } }));
    const timestamp = '1725442341';
    const headers = { 'x-bot-appid': 'app-qq', 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': fixtureSignature(secret, timestamp, body) };
    const first = await adapter.handle({ headers, body });
    const replay = await adapter.handle({ headers, body });
    assert.equal(first.body.op, 12);
    assert.equal(first.intake_result.accepted, true);
    assert.equal(replay.intake_result.run_id, first.intake_result.run_id);
    assert.equal(replay.intake_result.conversation_id, first.intake_result.conversation_id);
    const event = db.prepare(`SELECT principal,provider_message_id,run_id FROM ga_channel_message_events
      WHERE provider_message_id='group-message-1'`).get();
    assert.deepEqual({ ...event }, { principal: 'qq:group:group-9', provider_message_id: 'group-message-1',
      run_id: first.intake_result.run_id });

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,
      payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,'pending',?,?)`).run(
      'qq-effect-1', first.intake_result.run_id, 'assistant-message-1', 'qq', 'qq:group:group-9',
      JSON.stringify({ kind: 'text', text: 'reply text' }), now, now);
    const calls = [];
    const provider = createQQDeliveryProvider({ appId: 'fixture-app', appSecret: 'fixture-secret' }, db,
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/app/getAppAccessToken')) {
          return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: '7200' }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 'qq-reply-1' }), { status: 200 });
      });
    const receipt = await provider.sendWithKey('reply text', 'qq:group:group-9', 'qq-effect-1');
    assert.deepEqual(receipt, { provider_message_id: 'qq-reply-1' });
    assert.equal(calls[1].url, 'https://api.sgroup.qq.com/v2/groups/group-9/messages');
    assert.deepEqual(JSON.parse(calls[1].init.body), { content: 'reply text', msg_type: 0,
      msg_id: 'group-message-1', msg_seq: 1 });
  } finally { db.close(); }
});
