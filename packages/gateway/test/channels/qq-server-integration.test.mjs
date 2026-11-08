import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

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

test('the actual Gateway app registers QQ challenge and signed intake through buildServer', async t => {
  const server = await buildServer({
    databasePath: ':memory:',
    workspaces: ['qq-server-workspace'],
    csrfToken: 'synthetic-csrf-token-for-qq-tests',
    allowedOrigins: ['https://app.example.test'],
    qqWebhook: { appId: 'app-qq', botSecret: secret },
  });
  t.after(async () => {
    await server.app.close();
    if (server.db.isOpen) server.db.close();
  });

  server.db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-qq-server', 'owner-qq-server', 'qq', 'qq:group:group-server', 'verified', 1000, 1000);

  const timestamp = '1725442341';
  const plainToken = 'Arq0D5A61EgUu4OxUvOp';
  const challengeBody = Buffer.from(JSON.stringify({
    op: 13,
    d: { plain_token: plainToken, event_ts: timestamp },
  }), 'utf8');
  const challenge = await server.app.inject({
    method: 'POST',
    url: '/hooks/v1/channels/qq',
    headers: { 'content-type': 'application/json', 'x-bot-appid': 'app-qq' },
    payload: challengeBody,
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeResult = challenge.json();
  assert.equal(challengeResult.plain_token, plainToken);
  const privateKey = createPrivateKey({
    key: Buffer.concat([seedPrefix, Buffer.from(secret, 'utf8').subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  assert.equal(verify(null, Buffer.from(`${timestamp}${plainToken}`), createPublicKey(privateKey),
    Buffer.from(challengeResult.signature, 'hex')), true);

  const body = Buffer.from(`{\n  "id": "gateway-dispatch-1", "op": 0,\n  "t": "GROUP_AT_MESSAGE_CREATE",\n  "d": { "id": "gateway-message-1", "group_openid": "group-server",\n    "author": { "member_openid": "member-server" }, "content": "hello through Gateway" }\n}`, 'utf8');
  const alternateToken = 'custom token / β';
  const alternateChallenge = await server.app.inject({
    method: 'POST',
    url: '/hooks/v1/channels/qq',
    headers: { 'content-type': 'application/json', 'x-bot-appid': 'app-qq' },
    payload: Buffer.from(JSON.stringify({
      op: 13,
      d: { plain_token: alternateToken, event_ts: timestamp },
    }), 'utf8'),
  });
  assert.equal(alternateChallenge.statusCode, 200, alternateChallenge.body);
  assert.equal(alternateChallenge.json().plain_token, alternateToken);
  assert.equal(verify(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(alternateToken)]),
    createPublicKey(privateKey), Buffer.from(alternateChallenge.json().signature, 'hex')), true);

  const dispatchText = body.toString('utf8');
  const dispatchCases = [
    { eventTs: timestamp, plainToken: dispatchText },
    { eventTs: timestamp, plainToken: '\r\n ' + dispatchText + '\t ' },
    { eventTs: timestamp.slice(0, 1), plainToken: timestamp.slice(1) + dispatchText },
    {
      eventTs: timestamp.slice(0, 2),
      plainToken: timestamp.slice(2) + '\r\n ' + dispatchText.replace('"op": 0', '"o\\u0070": 0') + '\t ',
    },
  ];
  for (const { eventTs, plainToken } of dispatchCases) {
    const maliciousChallenge = await server.app.inject({
      method: 'POST',
      url: '/hooks/v1/channels/qq',
      headers: { 'content-type': 'application/json', 'x-bot-appid': 'app-qq' },
      payload: Buffer.from(JSON.stringify({
        op: 13,
        d: { plain_token: plainToken, event_ts: eventTs },
      }), 'utf8'),
    });
    assert.ok(maliciousChallenge.statusCode >= 400, maliciousChallenge.body);
    assert.equal(maliciousChallenge.json().signature, undefined);
  }
  assert.equal(server.db.prepare(`SELECT count(*) AS count FROM ga_channel_message_events
    WHERE channel='qq' AND provider_message_id='gateway-message-1'`).get().count, 0);

  const headers = {
    'content-type': 'application/json',
    'x-bot-appid': 'app-qq',
    'x-signature-timestamp': timestamp,
    'x-signature-ed25519': signCallback(timestamp, body),
  };
  const invalidSignature = await server.app.inject({
    method: 'POST',
    url: '/hooks/v1/channels/qq',
    headers: { ...headers, 'x-signature-ed25519': '0'.repeat(128) },
    payload: body,
  });
  assert.ok(invalidSignature.statusCode >= 400, invalidSignature.body);
  assert.equal(server.db.prepare(`SELECT count(*) AS count FROM ga_channel_message_events
    WHERE channel='qq' AND provider_message_id='gateway-message-1'`).get().count, 0);

  const ordinaryPost = await server.app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'owner-qq-server',
      origin: 'https://app.example.test',
    },
    payload: { name: 'CSRF boundary fixture' },
  });
  assert.equal(ordinaryPost.statusCode, 403, ordinaryPost.body);
  assert.equal(ordinaryPost.json().error.code, 'CSRF_INVALID');
  assert.equal(server.db.prepare("SELECT count(*) AS count FROM wb_agents WHERE name='CSRF boundary fixture'").get().count, 0);

  const first = await server.app.inject({ method: 'POST', url: '/hooks/v1/channels/qq', headers, payload: body });
  const replay = await server.app.inject({ method: 'POST', url: '/hooks/v1/channels/qq', headers, payload: body });

  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { op: 12 });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), { op: 12 });
  const events = server.db.prepare(`SELECT principal,run_id,conversation_id FROM ga_channel_message_events
    WHERE channel='qq' AND provider_message_id='gateway-message-1'`).all();
  assert.equal(events.length, 1);
  assert.equal(events[0].principal, 'qq:group:group-server');
  assert.equal(server.db.prepare('SELECT count(*) AS count FROM ga_runs WHERE id=?').get(events[0].run_id).count, 1);
});
