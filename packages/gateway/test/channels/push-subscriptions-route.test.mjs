import assert from 'node:assert/strict';
import { createECDH, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { buildServer } from '../../src/server.ts';

const origin='https://push-ui.example',csrf='push-csrf-fixture-123456';
function vapid(){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  return {publicKey:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url'),generation:'fixture-generation'};
}

test('push API returns only the VAPID public key and scopes registration and revoke to the owner',async t=>{
  const key=vapid();
  const service=await buildServer({databasePath:':memory:',workspaces:['main'],csrfToken:csrf,allowedOrigins:[origin],
    templateRoot:'packages/gateway/file-engine/templates',webPushVapid:key});
  t.after(async()=>{await service.app.close();service.db.close();});
  const baseHeaders={origin,'x-csrf-token':csrf};
  const publicResponse=await service.app.inject({url:'/v1/push/vapid-public-key'});
  assert.equal(publicResponse.statusCode,200,publicResponse.body);
  assert.deepEqual(publicResponse.json(),{public_key:key.publicKey,generation:key.generation});
  assert.match(publicResponse.headers['cache-control'],/no-store/);

  const client=createECDH('prime256v1');client.generateKeys();
  const input={endpoint:'https://push.example.net/subscription/opaque-token',keys:{p256dh:client.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,4).toString('base64url')}};
  const missingOwner=await service.app.inject({method:'POST',url:'/v1/push/subscriptions',headers:{...baseHeaders,'idempotency-key':'push-register-route-1'},payload:input});
  assert.equal(missingOwner.statusCode,401,missingOwner.body);
  const created=await service.app.inject({method:'POST',url:'/v1/push/subscriptions',headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-register-route-1'},payload:input});
  assert.equal(created.statusCode,201,created.body);
  const binding=created.json();assert.equal(binding.channel,'webpush');assert.equal(binding.status,'verified');
  const list=await service.app.inject({url:'/v1/channel-bindings',headers:{'x-user-id':'alice'}});
  assert.equal(list.statusCode,200,list.body);assert.ok(list.body.includes(binding.channel_binding_id));
  assert.ok(!list.body.includes(input.endpoint));assert.ok(!list.body.includes(input.keys.p256dh));assert.ok(!list.body.includes(input.keys.auth));

  const revokeBody={expected_version:binding.version,local_endpoint:input.endpoint};
  const foreign=await service.app.inject({method:'POST',url:`/v1/push/subscriptions/${binding.channel_binding_id}/revoke`,headers:{...baseHeaders,'x-user-id':'bob','idempotency-key':'push-revoke-route-bob'},payload:revokeBody});
  assert.equal(foreign.statusCode,404,foreign.body);
  const revoked=await service.app.inject({method:'POST',url:`/v1/push/subscriptions/${binding.channel_binding_id}/revoke`,headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-revoke-route-alice'},payload:revokeBody});
  assert.equal(revoked.statusCode,200,revoked.body);assert.equal(revoked.json().binding.status,'revoked');assert.equal(revoked.json().local_subscription_matches,true);
  assert.equal(revoked.body.includes(input.endpoint),false);assert.equal(revoked.body.includes(input.keys.p256dh),false);assert.equal(revoked.body.includes(input.keys.auth),false);
  const remoteInput={...input,endpoint:'https://push.example.net/subscription/other-opaque-token'};
  const remoteCreated=await service.app.inject({method:'POST',url:'/v1/push/subscriptions',headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-register-route-remote'},payload:remoteInput});
  assert.equal(remoteCreated.statusCode,201,remoteCreated.body);
  const remote=remoteCreated.json();
  const remoteRevoked=await service.app.inject({method:'POST',url:`/v1/push/subscriptions/${remote.channel_binding_id}/revoke`,headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-revoke-route-remote'},payload:{expected_version:remote.version,local_endpoint:input.endpoint}});
  assert.equal(remoteRevoked.statusCode,200,remoteRevoked.body);assert.equal(remoteRevoked.json().binding.status,'revoked');assert.equal(remoteRevoked.json().local_subscription_matches,false);
  const invalid=await service.app.inject({method:'POST',url:`/v1/push/subscriptions/${remote.channel_binding_id}/revoke`,headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-revoke-route-invalid'},payload:{expected_version:remote.version,local_endpoint:input.endpoint,keys:input.keys}});
  assert.equal(invalid.statusCode,400,invalid.body);
  const legacyInput={...input,endpoint:'https://push.example.net/subscription/legacy-opaque-token'};
  const legacyCreated=await service.app.inject({method:'POST',url:'/v1/push/subscriptions',headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-register-route-legacy'},payload:legacyInput});
  assert.equal(legacyCreated.statusCode,201,legacyCreated.body);
  const legacy=legacyCreated.json();
  const legacyRevoked=await service.app.inject({method:'POST',url:`/v1/channel-bindings/${legacy.channel_binding_id}/revoke`,headers:{...baseHeaders,'x-user-id':'alice','idempotency-key':'push-generic-revoke-route'},payload:{expected_version:legacy.version}});
  assert.equal(legacyRevoked.statusCode,200,legacyRevoked.body);assert.equal(legacyRevoked.json().status,'revoked');
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM wb_push_subscriptions').get().n,0);
});
