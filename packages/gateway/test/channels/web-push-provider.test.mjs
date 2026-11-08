import assert from 'node:assert/strict';
import { createECDH, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { encryptWebPushPayload, isPublicPushAddress, createVapidAuthorization, createWebPushProvider, loadWebPushVapidConfiguration, safeWebPushNotificationPayload } from '../../src/channels/web-push-provider.ts';
import { PushSubscriptions } from '../../src/channels/push-subscriptions.ts';

const decode = value => Buffer.from(value.replace(/\s+/g, ''), 'base64url');

test('Web Push encryption matches the RFC 8291 published payload vector', () => {
  const body = encryptWebPushPayload('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, {
    ephemeralPrivateKey: decode('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    salt: decode('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID authorization signs the push-service audience and a bounded ES256 expiry', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const vapidPublic = Buffer.concat([Buffer.from([4]), decode(jwk.x), decode(jwk.y)]).toString('base64url');
  const authorization = createVapidAuthorization(privateKey, vapidPublic,
    new URL('https://push.example.net/send/token'), 'mailto:ops@example.net', 1_800_000_000);
  const match = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
  assert.ok(match);
  assert.equal(match[2], vapidPublic);
  const [header, claims, signature] = match[1].split('.');
  assert.deepEqual(JSON.parse(decode(header).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(decode(claims).toString()), {
    aud: 'https://push.example.net', exp: 1_800_043_200, sub: 'mailto:ops@example.net',
  });
  assert.equal(decode(signature).length, 64);
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, decode(signature)), true);
});

test('endpoint address screening accepts public addresses and rejects local or special ranges', () => {
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicPushAddress(address), true, address);
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.1.1', '::1', 'fc00::1', '2001:db8::1', '2002:7f00:0001::1']) {
    assert.equal(isPublicPushAddress(address), false, address);
  }
});

test('push notification payload never includes task text, title, URL or provider error details', () => {
  const payload=JSON.parse(safeWebPushNotificationPayload().toString('utf8'));
  assert.deepEqual(payload,{title:'Jot task update',body:'You have a task update. Open Jot to review it.',url:'/'});
  assert.ok(!JSON.stringify(payload).includes('Private project title'));
});

function pushFixture() {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const config = loadWebPushVapidConfiguration({
    GENERAL_AGENT_WEBPUSH_VAPID_PRIVATE_KEY_FILE: 'server-vapid-reference',
    GENERAL_AGENT_WEBPUSH_SUBJECT: 'mailto:ops@example.net',
  }, path => { assert.equal(path, 'server-vapid-reference'); return pem; });
  assert.ok(config);
  assert.equal(Object.hasOwn(config, 'privateKeyFile'), false);
  const db = openProductDatabase(':memory:');
  const subscriptions = new PushSubscriptions(db, { publicKey: config.publicKey, generation: config.generation });
  const client = createECDH('prime256v1'); client.generateKeys();
  const registered = subscriptions.register('alice', {
    endpoint: 'https://push.example.net/push/private-token',
    keys: { p256dh: client.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 8).toString('base64url') },
  }, 'push-register-0001');
  return { config, db, subscriptions, bindingId: registered.channel_binding_id };
}

test('VAPID private-key reference errors use a fixed code without echoing its path', () => {
  assert.throws(() => loadWebPushVapidConfiguration({
    GENERAL_AGENT_WEBPUSH_VAPID_PRIVATE_KEY_FILE: 'private/secret/path.pem',
    GENERAL_AGENT_WEBPUSH_SUBJECT: 'mailto:ops@example.net',
  }, () => { throw new Error('private/secret/path.pem'); }), error => error.message === 'push_vapid_configuration_invalid');
});

test('webpush provider pins public DNS answers and never contacts a private address', async () => {
  const f = pushFixture(); let requests = 0;
  const provider = createWebPushProvider(f.subscriptions, f.config, {
    resolveAddresses: async () => [{ address: '10.20.30.40', family: 4 }],
    request: async () => { requests += 1; return 201; },
  });
  try {
    const result = await provider.send('Private data stays encrypted', f.bindingId);
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'PUSH_ENDPOINT_UNAVAILABLE');
    assert.equal(requests, 0);
  } finally { f.db.close(); }
});

test('subscription storage faults remain uncertain instead of expiring a binding', async () => {
  const f = pushFixture();
  f.subscriptions.resolveRecipient = () => { throw new Error('SQLITE_BUSY'); };
  const provider = createWebPushProvider(f.subscriptions, f.config, {
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => 201,
  });
  try {
    await assert.rejects(provider.send('Task update', f.bindingId), error => error.message === 'SQLITE_BUSY');
    assert.equal(f.db.prepare("SELECT status FROM ga_owner_channel_bindings WHERE channel_binding_id=?").get(f.bindingId).status, 'verified');
  } finally { f.db.close(); }
});

test('accepted push uses the existing HTTPS endpoint with RFC headers and 410 revokes the owner binding', async () => {
  const f = pushFixture(); const calls = [];
  let status = 201;
  const provider = createWebPushProvider(f.subscriptions, f.config, {
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (...args) => { calls.push(args); return status; },
  });
  try {
    const accepted = await provider.send('Bounded task update', f.bindingId);
    assert.deepEqual(accepted, { ok: true, accepted: true, status: 201 });
    assert.equal(calls[0][0].origin, 'https://push.example.net');
    assert.equal(calls[0][1].TTL, '60');
    assert.equal(calls[0][1]['Content-Encoding'], 'aes128gcm');
    assert.equal(calls[0][3][0].address, '8.8.8.8');
    assert.ok(calls[0][2].length <= 4096);
    status = 410;
    const expired = await provider.send('No longer subscribed', f.bindingId);
    assert.equal(expired.code, 'PUSH_SUBSCRIPTION_EXPIRED');
    assert.equal(f.db.prepare("SELECT status FROM ga_owner_channel_bindings WHERE channel_binding_id=?").get(f.bindingId).status, 'revoked');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE channel_binding_id=?').get(f.bindingId).n, 0);
  } finally { f.db.close(); }
});

test('429 is retryable while provider 5xx keeps the send outcome unknown',async()=>{
 for(const [status,expected] of [[429,{accepted:false,retryable:true,status:429,code:'PUSH_PROVIDER_RATE_LIMITED'}],[503,{accepted:false,outcome_unknown:true,status:503,code:'PUSH_PROVIDER_OUTCOME_UNKNOWN'}]]){
  const f=pushFixture(),provider=createWebPushProvider(f.subscriptions,f.config,{resolveAddresses:async()=>[{address:'8.8.8.8',family:4}],request:async()=>status});
  try{assert.deepEqual(await provider.send('Task update',f.bindingId),expected);assert.equal(f.db.prepare('SELECT status FROM ga_owner_channel_bindings WHERE channel_binding_id=?').get(f.bindingId).status,'verified');}
  finally{f.db.close();}
 }
});
