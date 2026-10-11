import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {buildServer} from '../../src/server.ts';
const base=resolve('.test-tmp/channel-owner-bindings');mkdirSync(base,{recursive:true});
async function setup(t){const dir=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(dir,'db.sqlite'));t.after(()=>{db.close();const rel=relative(base,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});});const {OwnerChannelBindings}=await import('../../src/channels/owner-bindings.ts');let now=1000;return {db,bindings:new OwnerChannelBindings(db,{enabled:['wecom'],now:()=>now}),advance:n=>now+=n,dir};}

test('only trusted proof consumes a short-lived code, without storing its plaintext or exposing another owner',async t=>{
 const f=await setup(t),challenge=f.bindings.create('alice','wecom');
 assert.ok(challenge.code);assert.equal(f.bindings.list('alice').items[0].status,'pending');
 const row=f.db.prepare('SELECT * FROM ga_owner_channel_challenges').get();assert.ok(!JSON.stringify(row).includes(challenge.code));
 const result=f.bindings.acceptProof('wecom','principal-a',challenge.code);assert.equal(result.status,'verified');assert.ok(!JSON.stringify(result).includes('alice'));
 assert.equal(f.bindings.list('bob').items.length,0);const binding=f.bindings.list('alice').items[0];assert.equal(binding.status,'verified');assert.ok(!Object.hasOwn(binding,'principal'));
 assert.equal(f.bindings.resolve('alice',binding.channel_binding_id).principal,'principal-a');
 assert.throws(()=>f.bindings.resolve('bob',binding.channel_binding_id),/channel_binding_not_found/);
 assert.deepEqual(f.bindings.acceptProof('wecom','principal-a',challenge.code),result);
 assert.throws(()=>f.bindings.acceptProof('wecom','principal-b',challenge.code),/channel_binding_proof_invalid/);
 f.bindings.revoke('alice',binding.channel_binding_id,binding.version);
 assert.throws(()=>f.bindings.resolve('alice',binding.channel_binding_id),/channel_binding_not_verified/);
 assert.throws(()=>f.bindings.acceptProof('wecom','principal-a',challenge.code),/channel_binding_proof_invalid/);
});

test('expired, replaced, rate-limited and conflicting proofs cannot create new destinations',async t=>{
 const f=await setup(t),expired=f.bindings.create('alice','wecom');f.advance(601);
 assert.throws(()=>f.bindings.acceptProof('wecom','a',expired.code),/channel_binding_proof_invalid/);
 const old=f.bindings.create('alice','wecom'),current=f.bindings.create('alice','wecom');assert.throws(()=>f.bindings.acceptProof('wecom','a',old.code),/channel_binding_proof_invalid/);
 f.bindings.acceptProof('wecom','a',current.code);
 const foreign=f.bindings.create('bob','wecom');assert.throws(()=>f.bindings.acceptProof('wecom','a',foreign.code),/channel_principal_already_bound/);
 assert.equal(f.bindings.list('bob').items[0].status,'pending');
 f.bindings.create('alice','wecom');f.bindings.create('alice','wecom');assert.throws(()=>f.bindings.create('alice','wecom'),/channel_binding_rate_limited/);
 assert.throws(()=>f.bindings.create('alice','smtp'),/channel_binding_unavailable/);
});

test('trusted channel intake consumes binding messages without creating a model run or storing the code in conversation text',async t=>{
 const dir=mkdtempSync(join(base,'intake-')),f=await buildServer({databasePath:join(dir,'db.sqlite'),workspaces:['ws'],internalChannelToken:'test-edc8a2ee8c4ea0b1',workbenchRoot:join(dir,'workspace')});
 t.after(async()=>{await f.app.close();f.db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const {OwnerChannelBindings}=await import('../../src/channels/owner-bindings.ts'),bindings=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom');
 const request={method:'POST',url:'/internal/v1/channel/messages',payload:{channel:'wecom',principal:'fixture-principal',message_id:'binding-1',text:'/jot-bind '+challenge.code}};
 assert.equal((await f.app.inject(request)).statusCode,401);
 const response=await f.app.inject({...request,headers:{authorization:'Bearer test-edc8a2ee8c4ea0b1'}});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().kind,'channel_binding');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,0);assert.equal(bindings.list('alice').items[0].status,'verified');
});

test('public binding creation and revocation keep owner, CSRF and idempotency boundaries without caching the plaintext code',async t=>{
 const dir=mkdtempSync(join(base,'public-')),f=await buildServer({databasePath:join(dir,'db.sqlite'),workspaces:['ws'],internalChannelToken:'test-edc8a2ee8c4ea0b1',csrfToken:'test-2b235b3231742cab',allowedOrigins:['https://fixture.invalid'],workbenchRoot:join(dir,'workspace')});
 t.after(async()=>{await f.app.close();f.db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-2b235b3231742cab','idempotency-key':'fixture-binding-create'};
 const send=(payload,extra={})=>f.app.inject({method:'POST',url:'/v1/channel-bindings',headers:{...headers,...extra},payload});
 assert.equal((await send({channel:'wecom'},{'x-csrf-token':'wrong'})).statusCode,403);
 const created=await send({channel:'wecom'});assert.equal(created.statusCode,201,created.body);const challenge=created.json();assert.ok(challenge.code);
 const replay=await send({channel:'wecom'});assert.equal(replay.statusCode,201,replay.body);assert.equal(replay.json().channel_binding_id,challenge.channel_binding_id);assert.equal(replay.json().code,undefined);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_owner_channel_challenges').get().n,1);
 const cached=f.db.prepare('SELECT response_json FROM ga_idempotency').all();assert.ok(!JSON.stringify(cached).includes(challenge.code));
 assert.equal((await send({channel:'wecom',principal:'arbitrary-recipient'},{'idempotency-key':'spoof-binding-key'})).statusCode,422);
 const proof=await f.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:{authorization:'Bearer test-edc8a2ee8c4ea0b1'},payload:{channel:'wecom',principal:'fixture-principal',message_id:'bind-public',text:'/jot-bind '+challenge.code}});assert.equal(proof.statusCode,202,proof.body);
 const own=await f.app.inject({url:'/v1/channel-bindings',headers:{'x-user-id':'alice'}});assert.equal(own.statusCode,200,own.body);assert.equal(own.json().items[0].status,'verified');
 const foreign=await f.app.inject({url:'/v1/channel-bindings',headers:{'x-user-id':'bob'}});assert.deepEqual(foreign.json().items,[]);
 const revoke=await f.app.inject({method:'POST',url:`/v1/channel-bindings/${challenge.channel_binding_id}/revoke`,headers:{...headers,'idempotency-key':'fixture-revoke-key'},payload:{expected_version:1}});assert.equal(revoke.statusCode,200,revoke.body);assert.equal(revoke.json().status,'revoked');
});
