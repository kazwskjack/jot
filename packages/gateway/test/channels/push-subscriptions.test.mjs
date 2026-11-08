import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { PushSubscriptions } from '../../src/channels/push-subscriptions.ts';

function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/test') {
  const client = createECDH('prime256v1');
  client.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: client.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function fixture() {
  const db = openProductDatabase(':memory:');
  const bindings = new OwnerChannelBindings(db);
  const vapid = createECDH('prime256v1'); vapid.generateKeys();
  let now = 1_700_000_000;
  const push = new PushSubscriptions(db, {
    publicKey: vapid.getPublicKey().toString('base64url'),
    generation: 'vapid-generation-a',
    now: () => now,
  });
  return { db, bindings, push, setNow: value => { now = value; } };
}

test('push subscription is owner scoped and public projections exclude the endpoint and keys', () => {
  const f = fixture();
  try {
    const data = subscription();
    const created = f.push.register('alice', data, 'register-key-0001');
    assert.equal(created.channel, 'webpush');
    assert.equal(created.status, 'verified');
    const resolved = f.push.resolveRecipient(created.channel_binding_id, 'vapid-generation-a');
    assert.equal(resolved.endpoint, data.endpoint);
    assert.equal(resolved.p256dh, data.keys.p256dh);
    assert.equal(resolved.auth, data.keys.auth);
    const projection = JSON.stringify(f.bindings.list('alice'));
    assert.ok(projection.includes(created.channel_binding_id));
    assert.ok(!projection.includes(data.endpoint));
    assert.ok(!projection.includes(data.keys.p256dh));
    assert.ok(!projection.includes(data.keys.auth));
    assert.throws(() => f.push.revoke('bob', created.channel_binding_id, created.version), /push_subscription_not_found/);
  } finally { f.db.close(); }
});

test('push registration is idempotent and conflicting idempotency reuse is rejected', () => {
  const f = fixture();
  try {
    const data = subscription();
    const first = f.push.register('alice', data, 'register-key-0002');
    f.setNow(1_700_000_010);
    const refreshed = f.push.register('alice', data, 'register-key-0003');
    const replay = f.push.register('alice', data, 'register-key-0003');
    assert.equal(refreshed.channel_binding_id, first.channel_binding_id);
    assert.equal(refreshed.version, 2);
    assert.equal(refreshed.created_at, first.created_at);
    assert.equal(replay.channel_binding_id, first.channel_binding_id);
    assert.equal(replay.created_at, first.created_at);
    assert.throws(() => f.push.register('alice', subscription(), 'register-key-0003'), /idempotency_conflict/);
  } finally { f.db.close(); }
});

test('revoke removes private subscription material and stale key generations cannot send', () => {
  const f = fixture();
  try {
    const data = subscription();
    const created = f.push.register('alice', data, 'register-key-0003');
    assert.throws(() => f.push.resolveRecipient(created.channel_binding_id, 'vapid-generation-b'), /push_subscription_stale/);
    const revoked = f.push.revoke('alice', created.channel_binding_id, created.version);
    assert.equal(revoked.binding.status, 'revoked');
    assert.equal(revoked.local_subscription_matches, false);
    assert.throws(() => f.push.resolveRecipient(created.channel_binding_id, 'vapid-generation-a'), /push_subscription_not_found/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions').get().n, 0);
  } finally { f.db.close(); }
});

test('push revoke reports a local endpoint match without exposing endpoint or keys',()=>{
 const f=fixture();
 try{
  const local=subscription('https://fcm.googleapis.com/fcm/send/local'),remote=subscription('https://fcm.googleapis.com/fcm/send/remote');
  const localBinding=f.push.register('alice',local,'register-local-0001'),remoteBinding=f.push.register('alice',remote,'register-remote-01');
  const remoteRevoked=f.push.revoke('alice',remoteBinding.channel_binding_id,remoteBinding.version,local.endpoint);
  assert.equal(remoteRevoked.binding.status,'revoked');assert.equal(remoteRevoked.local_subscription_matches,false);
  const localRevoked=f.push.revoke('alice',localBinding.channel_binding_id,localBinding.version,local.endpoint);
  assert.equal(localRevoked.binding.status,'revoked');assert.equal(localRevoked.local_subscription_matches,true);
  assert.equal(JSON.stringify(localRevoked).includes(local.endpoint),false);
  assert.equal(JSON.stringify(localRevoked).includes(local.keys.p256dh),false);
  assert.equal(JSON.stringify(localRevoked).includes(local.keys.auth),false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions').get().n,0);
 }finally{f.db.close();}
});

test('push revoke treats a missing local endpoint as unknown and validates a supplied endpoint',()=>{
 const f=fixture();
 try{
  const data=subscription(),binding=f.push.register('alice',data,'register-key-0007');
  const noLocal=f.push.revoke('alice',binding.channel_binding_id,binding.version);
  assert.equal(noLocal.local_subscription_matches,false);
  assert.throws(()=>f.push.revoke('alice',binding.channel_binding_id,binding.version,'http://fcm.googleapis.com/fcm/send/local'),/push_subscription_invalid/);
 }finally{f.db.close();}
});

test('generic owner-channel revoke also removes private push keys for compatibility callers',()=>{
 const f=fixture();
 try{
  const data=subscription(),binding=f.push.register('alice',data,'register-key-0008');
  const revoked=f.bindings.revoke('alice',binding.channel_binding_id,binding.version);
  assert.equal(revoked.status,'revoked');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE channel_binding_id=?').get(binding.channel_binding_id).n,0);
  assert.throws(()=>f.push.resolveRecipient(binding.channel_binding_id,'vapid-generation-a'),/push_subscription_not_found/);
  const rebound=f.push.register('alice',data,'register-key-0009');
  assert.notEqual(rebound.channel_binding_id,binding.channel_binding_id);
  assert.equal(f.push.resolveRecipient(rebound.channel_binding_id,'vapid-generation-a').endpoint,data.endpoint);
 }finally{f.db.close();}
});

test('registration cleans stale private subscriptions left by legacy revoked bindings',()=>{
 const f=fixture();
 try{
  const data=subscription(),other=subscription('https://fcm.googleapis.com/fcm/send/legacy-other'),oldBinding=f.push.register('alice',data,'register-legacy-row-01');
  const oldOther=f.push.register('alice',other,'register-legacy-row-other');
  f.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1,revoked_at=? WHERE owner_id=? AND channel_binding_id IN(?,?)")
   .run(1_700_000_010,'alice',oldBinding.channel_binding_id,oldOther.channel_binding_id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE channel_binding_id=?').get(oldBinding.channel_binding_id).n,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE channel_binding_id=?').get(oldOther.channel_binding_id).n,1);
  const rebound=f.push.register('alice',data,'register-legacy-row-02');
  assert.notEqual(rebound.channel_binding_id,oldBinding.channel_binding_id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE channel_binding_id=?').get(oldBinding.channel_binding_id).n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE channel_binding_id=?').get(oldOther.channel_binding_id).n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions WHERE owner_id=?').get('alice').n,1);
 }finally{f.db.close();}
});

test('push registration rejects non-HTTPS, private-address and malformed subscription keys', () => {
  const f = fixture();
  try {
    const data = subscription('http://fcm.googleapis.com/fcm/send/test');
    assert.throws(() => f.push.register('alice', data, 'register-key-0004'), /push_subscription_invalid/);
    const privateAddress = subscription('https://127.0.0.1/fcm/send/test');
    assert.throws(() => f.push.register('alice', privateAddress, 'register-key-0005'), /push_subscription_invalid/);
    const invalidKey = subscription(); invalidKey.keys.p256dh = Buffer.alloc(65, 0).toString('base64url');
    assert.throws(() => f.push.register('alice', invalidKey, 'register-key-0006'), /push_subscription_invalid/);
  } finally { f.db.close(); }
});
