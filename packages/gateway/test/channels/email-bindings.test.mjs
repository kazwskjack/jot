import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import * as email from '../../src/channels/email-bindings.ts';
function fixture(t,send){const db=openProductDatabase(':memory:');t.after(()=>db.close());let now=1000;assert.equal(typeof email.EmailChannelBindings,'function');const service=new email.EmailChannelBindings(db,{send,now:()=>now});return {db,service,clock:value=>now=value};}
test('mailbox proof is mailed once, not exposed to the browser, and owner-bound',async t=>{
 const deliveries=[];const {db,service}=fixture(t,async(text,to)=>{deliveries.push({text,to});return {provider_message_id:'accepted'};});
 const first=await service.begin('alice','alice@EXAMPLE.test','create-mail-1');
 assert.equal(first.channel,'email');assert.equal(first.status,'pending');assert.equal(first.code,undefined);assert.equal(first.principal,undefined);
 const code=deliveries[0].text.match(/[A-Za-z0-9_-]{43}/)[0];assert.equal(deliveries[0].to,'alice@example.test');
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM ga_email_binding_challenges').all()).includes(code),false);
 assert.deepEqual(await service.begin('alice','alice@example.test','create-mail-1'),first);assert.equal(deliveries.length,1);
 await assert.rejects(service.begin('alice','other@example.test','create-mail-1'),/idempotency_conflict/);
 assert.throws(()=>service.confirm('bob',first.channel_binding_id,code),/email_binding_proof_invalid/);
 assert.throws(()=>service.confirm('alice',first.channel_binding_id,'x'.repeat(43)),/email_binding_proof_invalid/);
 const verified=service.confirm('alice',first.channel_binding_id,code);assert.equal(verified.status,'verified');
 assert.equal(new OwnerChannelBindings(db).resolve('alice',verified.channel_binding_id).principal,'alice@example.test');
 assert.deepEqual(service.confirm('alice',first.channel_binding_id,code),verified);
 new OwnerChannelBindings(db).revoke('alice',verified.channel_binding_id,1);
 assert.throws(()=>service.confirm('alice',first.channel_binding_id,code),/email_binding_proof_invalid/);
});
test('unknown delivery never resends; received code proves ownership but expired, exhausted and cross-owner claims cannot bind',async t=>{
 let code,sends=0;const {db,service,clock}=fixture(t,async text=>{sends++;code=text.match(/[A-Za-z0-9_-]{43}/)[0];throw new Error('socket secret');});
 const first=await service.begin('alice','alice@example.test','request-one');assert.equal(first.delivery_status,'outcome_unknown');
 await service.begin('alice','alice@example.test','request-one');assert.equal(sends,1);
 assert.equal(service.confirm('alice',first.channel_binding_id,code).status,'verified');
 clock(1061);const second=await service.begin('bob','alice@example.test','request-two');
 assert.throws(()=>service.confirm('bob',second.channel_binding_id,code),/channel_principal_already_bound/);
 clock(1122);const third=await service.begin('alice','new@example.test','request-three');
 for(let i=0;i<5;i++)assert.throws(()=>service.confirm('alice',third.channel_binding_id,'x'.repeat(43)),/email_binding_proof_invalid/);
 assert.throws(()=>service.confirm('alice',third.channel_binding_id,code),/email_binding_proof_invalid/);
 clock(1183);const fourth=await service.begin('alice','later@example.test','request-four');clock(1800);
 assert.throws(()=>service.confirm('alice',fourth.channel_binding_id,code),/email_binding_proof_invalid/);
 assert.equal(db.prepare("SELECT count(*) n FROM ga_owner_channel_bindings WHERE status='verified'").get().n,1);
});
test('email challenge validates requests, limits mail abuse, and stays disabled without a transport',async t=>{
 let sends=0;const {db,service,clock}=fixture(t,async()=>{sends++;return {provider_message_id:'ok'};});
 await assert.rejects(service.begin('alice','a@example.test,b@example.test','request-key'),/email_address_invalid/);
 await assert.rejects(service.begin('alice','a@example.test','short'),/idempotency_key_invalid/);assert.equal(sends,0);
 await service.begin('alice','a@example.test','request-key');await assert.rejects(service.begin('bob','a@example.test','another-key'),/email_binding_rate_limited/);
 for(let i=1;i<5;i++){clock(1000+i*61);await service.begin('alice',`a${i}@example.test`,`request-key-${i}`);}
 clock(1400);await assert.rejects(service.begin('alice','last@example.test','request-key-last'),/email_binding_rate_limited/);
 const disabled=new email.EmailChannelBindings(db,{});await assert.rejects(disabled.begin('alice','a@example.test','request-disabled'),/channel_binding_unavailable/);
});
