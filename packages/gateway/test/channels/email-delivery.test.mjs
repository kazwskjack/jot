import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';
function fixture(t){const db=openProductDatabase(':memory:');t.after(()=>db.close());db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES('c','alice','ws','t','{}',1,'now','now')").run();db.prepare("INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES('input','c','user','complete','{}','now','now')").run();db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES('run','c','input','running',1,'now','now')").run();return new ChannelDeliveryService(db);}
const runtime={registerDeliveryReceipt:async()=>{throw new Error('no file');}},resolvers={resolveArtifact(){throw new Error('no file');},resolveRuntime(){throw new Error('no file');}};

test('email outbox rejects multiple or injected recipients before persisting an effect',t=>{
 const store=fixture(t);
 for(const recipient of ['alice@example.test,bob@example.test','alice@example.test\r\nBcc:bob@example.test','invalid'])assert.throws(()=>store.enqueueText({runId:'run',messageId:'message',destination:'email',recipient,text:'Task update'}),/email_address_invalid/);
 assert.equal(store.claim('test',90,['email']),null);
});
test('email notification is dispatched only to its configured provider and sends once',async t=>{
 const store=fixture(t),delivery=store.enqueueText({runId:'run',messageId:'message',destination:'email',recipient:'alice@example.test',text:'Task update'}),calls=[];
 const provider={send:async(text,to)=>{calls.push([text,to]);return {provider_message_id:'smtp-accepted-1'};},sendFile:async()=>{throw new Error('no file');}};
 const worker=new ChannelDeliveryWorker(store,{providers:{email:provider}},runtime,resolvers);
 assert.equal(await worker.processNext(),true);assert.equal(await worker.processNext(),false);assert.deepEqual(calls,[['Task update','alice@example.test']]);assert.equal(store.get(delivery.effect_id).status,'delivered');
});
test('legacy WeCom worker does not claim email and SMTP timeout is unknown without automatic resend',async t=>{
 const store=fixture(t),delivery=store.enqueueText({runId:'run',messageId:'message',destination:'email',recipient:'alice@example.test',text:'Task update'});let sends=0;
 const wrong=new ChannelDeliveryWorker(store,{send:async()=>{throw new Error('must not send');},sendFile:async()=>{throw new Error('must not send');}},runtime,resolvers);
 assert.equal(await wrong.processNext(),false);assert.equal(store.get(delivery.effect_id).status,'pending');
 const worker=new ChannelDeliveryWorker(store,{providers:{email:{send:async()=>{sends++;throw new Error('socket timeout');},sendFile:async()=>{throw new Error('no file');}}}},runtime,resolvers);
 assert.equal(await worker.processNext(),true);assert.equal(store.get(delivery.effect_id).status,'outcome_unknown');assert.equal(await worker.processNext(),false);assert.equal(sends,1);
});
