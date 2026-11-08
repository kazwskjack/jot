import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import Fastify from 'fastify';
import test from 'node:test';
import { ChannelIntakeService } from '../../src/channels/intake.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { registerQQWebhookRoutes } from '../../src/channels/qq-routes.ts';

const secret = Buffer.alloc(32, 0x4a).toString('hex');
const seedPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');

function signCallback(timestamp, body) {
  const key = createPrivateKey({
    key: Buffer.concat([seedPrefix, Buffer.from(secret, 'utf8').subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), body]), key).toString('hex');
}

test('QQ route answers a validation challenge through the registered Fastify caller', async t => {
  const app = Fastify({ logger: false });
  const intake = { accept() { throw new Error('challenge_must_not_enter_intake'); } };
  registerQQWebhookRoutes(app, { appId: 'app-qq', botSecret: secret, intake });
  t.after(() => app.close());

  const payload = JSON.stringify({ op: 13, d: { plain_token: 'route-token', event_ts: '1725442341' } });
  const response = await app.inject({
    method: 'POST',
    url: '/hooks/v1/channels/qq',
    headers: { 'x-bot-appid': 'app-qq', 'content-type': 'application/json' },
    payload,
  });

  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.plain_token, 'route-token');
  const privateKey = createPrivateKey({
    key: Buffer.concat([seedPrefix, Buffer.from(secret, 'utf8').subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  assert.equal(verify(null, Buffer.from('1725442341route-token'), createPublicKey(privateKey),
    Buffer.from(result.signature, 'hex')), true);
});

test('QQ route preserves signed raw bytes and uses existing intake replay deduplication', async t => {
  const app = Fastify({ logger: false });
  const db = openProductDatabase(':memory:');
  t.after(async () => { await app.close(); db.close(); });
  const bindings = new OwnerChannelBindings(db, { enabled: ['qq'] });
  installChannelAuthorityMigration(db);
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-qq-route', 'owner-qq-route', 'qq', 'qq:group:group-route', 'verified', 1000, 1000);
  const intake = new ChannelIntakeService(db, new RunRepository(db, new EventStore(db)), 'ws', bindings);
  registerQQWebhookRoutes(app, { appId: 'app-qq', botSecret: secret, intake });

  const body = Buffer.from(`{\n  "id": "dispatch-route-1", "op": 0,\n  "t": "GROUP_AT_MESSAGE_CREATE",\n  "d": { "id": "group-message-route-1", "group_openid": "group-route",\n    "author": { "member_openid": "member-route" }, "content": "hello over QQ" }\n}`, 'utf8');
  const timestamp = '1725442341';
  const headers = {
    'content-type': 'application/json',
    'x-bot-appid': 'app-qq',
    'x-signature-timestamp': timestamp,
    'x-signature-ed25519': signCallback(timestamp, body),
  };

  const first = await app.inject({ method: 'POST', url: '/hooks/v1/channels/qq', headers, payload: body });
  const replay = await app.inject({ method: 'POST', url: '/hooks/v1/channels/qq', headers, payload: body });

  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { op: 12 });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), { op: 12 });
  const events = db.prepare(`SELECT principal,provider_message_id,run_id,conversation_id
    FROM ga_channel_message_events WHERE channel='qq' AND provider_message_id='group-message-route-1'`).all();
  assert.equal(events.length, 1);
  assert.equal(events[0].principal, 'qq:group:group-route');
  const runs = db.prepare('SELECT count(*) AS count FROM ga_runs WHERE id=?').get(events[0].run_id);
  assert.equal(runs.count, 1);
});
