import assert from 'node:assert/strict';
import test from 'node:test';

const publicKey=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url');
const subscription={endpoint:'https://push.example.test/subscription/private-token',keys:{p256dh:'client-public-key',auth:'client-auth'}};

test('browser Push enrollment is offered only when the server capability and browser APIs are available',async()=>{
 const {canOfferBrowserPushEnrollment}=await import('./push-notifications.mjs');
 const supported={webPushBindingsEnabled:true,secureContext:true,notification:{requestPermission(){}},pushManager:{},serviceWorker:{register(){}}};
 assert.equal(canOfferBrowserPushEnrollment({...supported,webPushBindingsEnabled:false}),false);
 assert.equal(canOfferBrowserPushEnrollment({...supported,secureContext:false}),false);
 assert.equal(canOfferBrowserPushEnrollment(supported),true);
});

test('VAPID public keys decode to an uncompressed P-256 point and reject malformed values',async()=>{
 const {decodeVapidPublicKey}=await import('./push-notifications.mjs');
 const decoded=decodeVapidPublicKey(publicKey);
 assert.equal(decoded.length,65);assert.equal(decoded[0],4);assert.equal(decoded[64],7);
 for(const invalid of ['', 'not base64!', Buffer.alloc(64,7).toString('base64url'), Buffer.alloc(65,7).toString('base64url')])assert.throws(()=>decodeVapidPublicKey(invalid));
});

test('browser push asks permission only from the explicit flow, registers same-origin worker, and sends only subscription data',async()=>{
 const {enableBrowserPush}=await import('./push-notifications.mjs'),calls=[];
 const localSubscription={endpoint:subscription.endpoint,toJSON:()=>subscription};
 const result=await enableBrowserPush({
  notification:{permission:'default',requestPermission:async()=>{calls.push('permission');return 'granted';}},
  serviceWorker:{register:async(path,options)=>{calls.push(['worker',path,options]);return {pushManager:{getSubscription:async()=>{calls.push('get-subscription');return null;},subscribe:async options=>{calls.push(['subscribe',options.userVisibleOnly,options.applicationServerKey.length]);return localSubscription;}}};}},
  api:{getPushVapidPublicKey:async()=>{calls.push('vapid-key');return {public_key:publicKey,generation:'generation-a'};},registerPushSubscription:async(body,key)=>{calls.push(['register',body,key]);return {channel_binding_id:'push-binding-1',channel:'webpush',status:'verified',version:1};}},
  idempotencyKey:'push-register-key-0001',
 });
 assert.equal(result.channel_binding_id,'push-binding-1');
 assert.deepEqual(calls.map(call=>Array.isArray(call)?call[0]:call),['permission','vapid-key','worker','get-subscription','subscribe','register']);
 assert.equal(calls[2][1],'/workbench-notifications-sw.js');assert.deepEqual(calls[2][2],{scope:'/'});
 assert.equal(calls[4][1],true);assert.equal(calls[4][2],65);
 assert.deepEqual(calls[5][1],subscription);assert.equal(calls[5][2],'push-register-key-0001');
});

test('an existing local subscription is re-registered without creating a duplicate browser subscription',async()=>{
 const {enableBrowserPush}=await import('./push-notifications.mjs');let subscribed=0,registered=0;
 const localSubscription={endpoint:subscription.endpoint,options:{applicationServerKey:Uint8Array.from(Buffer.from(publicKey,'base64url')).buffer},toJSON:()=>subscription};
 const result=await enableBrowserPush({
  notification:{permission:'granted',requestPermission:async()=>{throw new Error('must not prompt again');}},
  serviceWorker:{register:async()=>({pushManager:{getSubscription:async()=>localSubscription,subscribe:async()=>{subscribed++;return localSubscription;}}})},
  api:{getPushVapidPublicKey:async()=>({public_key:publicKey,generation:'generation-a'}),registerPushSubscription:async()=>{registered++;return {channel_binding_id:'existing-binding'};}},
  idempotencyKey:'push-register-key-0005',
 });
 assert.equal(result.channel_binding_id,'existing-binding');assert.equal(subscribed,0);assert.equal(registered,1);
});

test('an existing subscription with a stale VAPID key must be revoked before re-enrollment',async()=>{
 const {enableBrowserPush}=await import('./push-notifications.mjs');let subscribed=0,registered=0;
 const oldKey=Uint8Array.from(Buffer.from(publicKey,'base64url'));oldKey[1]^=1;
 const localSubscription={endpoint:subscription.endpoint,options:{applicationServerKey:oldKey.buffer},toJSON:()=>subscription};
 await assert.rejects(enableBrowserPush({
  notification:{permission:'granted'},
  serviceWorker:{register:async()=>({pushManager:{getSubscription:async()=>localSubscription,subscribe:async()=>{subscribed++;return localSubscription;}}})},
  api:{getPushVapidPublicKey:async()=>({public_key:publicKey,generation:'generation-b'}),registerPushSubscription:async()=>{registered++;}},
  idempotencyKey:'push-register-key-0007',
 }),/请先撤销此渠道，再重新启用/);
 assert.equal(subscribed,0);assert.equal(registered,0);
});

test('an existing subscription with an unreadable VAPID key is not registered as current',async()=>{
 const {enableBrowserPush}=await import('./push-notifications.mjs');let registered=0,subscribed=0;
 const localSubscription={endpoint:subscription.endpoint,options:{applicationServerKey:null},toJSON:()=>subscription};
 await assert.rejects(enableBrowserPush({
  notification:{permission:'granted'},
  serviceWorker:{register:async()=>({pushManager:{getSubscription:async()=>localSubscription,subscribe:async()=>{subscribed++;return localSubscription;}}})},
  api:{getPushVapidPublicKey:async()=>({public_key:publicKey,generation:'generation-a'}),registerPushSubscription:async()=>{registered++;}},
  idempotencyKey:'push-register-key-0008',
 }),/无法确认密钥/);
 assert.equal(subscribed,0);assert.equal(registered,0);
});

test('denied browser permission does not fetch keys, register a worker, or create a server binding',async()=>{
 const {enableBrowserPush}=await import('./push-notifications.mjs');let calls=0;
 await assert.rejects(enableBrowserPush({
  notification:{permission:'default',requestPermission:async()=>{calls++;return 'denied';}},
  serviceWorker:{register:async()=>{calls++;}},
  api:{getPushVapidPublicKey:async()=>{calls++;},registerPushSubscription:async()=>{calls++;}},
  idempotencyKey:'push-register-key-0002',
 }),/权限/);
 assert.equal(calls,1);
});

test('revoke removes the server binding and only unsubscribes the matching local browser subscription',async()=>{
 const {revokeBrowserPush}=await import('./push-notifications.mjs');let unsubscribed=0,request;
 const local={endpoint:subscription.endpoint,unsubscribe:async()=>{unsubscribed++;return true;}};
 const binding={channel_binding_id:'push-binding-1',channel:'webpush',status:'verified',version:2};
 const serviceWorker={getRegistration:async scope=>{assert.equal(scope,'/');return {pushManager:{getSubscription:async()=>local}};}};
 const api={revokePushSubscription:async(target,key,endpoint)=>{request={target,key,endpoint};return {binding:{...binding,status:'revoked'},local_subscription_matches:true};}};
 const result=await revokeBrowserPush({api,serviceWorker,binding,idempotencyKey:'push-revoke-key-0001'});
 assert.equal(request.target,binding);assert.equal(request.key,'push-revoke-key-0001');assert.equal(request.endpoint,subscription.endpoint);
 assert.equal(unsubscribed,1);assert.equal(result.binding.status,'revoked');assert.equal(result.localUnsubscribeFailed,false);
});

test('revoking a different device never unsubscribes this browser local subscription',async()=>{
 const {revokeBrowserPush}=await import('./push-notifications.mjs');let unsubscribed=0;
 const local={endpoint:subscription.endpoint,unsubscribe:async()=>{unsubscribed++;return true;}};
 const result=await revokeBrowserPush({
  api:{revokePushSubscription:async()=>({binding:{status:'revoked'},local_subscription_matches:false})},
  serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:async()=>local}})},
  binding:{channel_binding_id:'push-binding-remote',channel:'webpush',version:1},idempotencyKey:'push-revoke-key-0002',
 });
 assert.equal(unsubscribed,0);assert.equal(result.binding.status,'revoked');
});

test('local unsubscribe failure keeps the successful server revocation explicit',async()=>{
 const {revokeBrowserPush}=await import('./push-notifications.mjs');
 const result=await revokeBrowserPush({
  api:{revokePushSubscription:async()=>({binding:{status:'revoked'},local_subscription_matches:true})},
  serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:async()=>({endpoint:subscription.endpoint,unsubscribe:async()=>{throw new Error('local failure');}})}})},
  binding:{channel_binding_id:'push-binding-1',channel:'webpush',version:1},idempotencyKey:'push-revoke-key-0003',
 });
 assert.equal(result.binding.status,'revoked');assert.equal(result.localUnsubscribeFailed,true);
});

test('unknown revoke response never cancels the local subscription',async()=>{
 const {revokeBrowserPush}=await import('./push-notifications.mjs');let unsubscribed=0;
 await assert.rejects(revokeBrowserPush({
  api:{revokePushSubscription:async()=>{throw new Error('response lost');}},
  serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:async()=>({endpoint:subscription.endpoint,unsubscribe:async()=>{unsubscribed++;return true;}})}})},
  binding:{channel_binding_id:'push-binding-1',channel:'webpush',version:1},idempotencyKey:'push-revoke-key-0004',
 }),/response lost/);
 assert.equal(unsubscribed,0);
});

test('an owner-scope change before registration prevents posting the browser subscription',async()=>{
 const {enableBrowserPush}=await import('./push-notifications.mjs');let current=true,registered=0;
 await assert.rejects(enableBrowserPush({
  notification:{permission:'granted'},
  serviceWorker:{register:async()=>{throw new Error('must not register after scope change');}},
  api:{getPushVapidPublicKey:async()=>{current=false;return {public_key:publicKey,generation:'generation-a'};},registerPushSubscription:async()=>{registered++;}},
  idempotencyKey:'push-register-key-0006',isCurrent:()=>current,
 }),/账户范围已变化/);
 assert.equal(registered,0);
});
