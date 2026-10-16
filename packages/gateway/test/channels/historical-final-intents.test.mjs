import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';
import {captureHistoricalDeliverySnapshot} from '../../src/channels/historical-final-snapshot.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
const api=await import('../../src/channels/historical-final-intents.ts').catch(()=>({}));
const sha=v=>createHash('sha256').update(v).digest('hex'),scope={owner_id:'owner',conversation_id:'conversation',run_id:'run'};
function fixture(t){
 const db=openProductDatabase(':memory:');t.after(()=>db.close());
 db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('conversation','owner','workspace','Synthetic','{}','now','now')").run();
 db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('run','conversation','interrupted','now','now')").run();
 db.prepare("INSERT INTO ga_harness_session_bindings VALUES('conversation','owner','session','now','now')").run();
 db.prepare("INSERT INTO ga_channel_bindings VALUES('wecom','synthetic-recipient','conversation','now','now')").run();
 const queue=new ChannelDeliveryService(db,()=>100),service=()=>new api.HistoricalFinalDeliveryIntents(db,queue),text='Synthetic final answer',content=JSON.stringify({blocks:[{kind:'text',text}],attachments:[]});
 const final={message_id:'final',text,content_sha256:sha(content),publication_source_sha256:'a'.repeat(64),answer_sha256:sha(text)};
 const enqueue=(patch={})=>queue.enqueueExternal({runId:'run',messageId:'final',destination:'wecom',recipient:'synthetic-recipient',artifactRef:null,text:'Synthetic old answer',...patch});
 const publish=()=>{db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES('final','conversation','run','assistant','complete',?,'now','now') ON CONFLICT(id) DO UPDATE SET content_json=excluded.content_json").run(content);db.prepare('INSERT INTO ga_ordinary_final_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('run','conversation','owner','session','final',final.publication_source_sha256,'{}','b'.repeat(64),JSON.stringify({answer_sha256:final.answer_sha256}),'c'.repeat(64),'{}','[]','now');};
 const commit=()=>{const snapshot=captureHistoricalDeliverySnapshot(db,scope);return withImmediateTransaction(db,()=>{const result=service().commit(scope,snapshot.sha256,final);publish();return result;});};
 return{db,queue,service,text,content,final,enqueue,publish,commit};
}
test('historical final intent and existing outbox commit together and retry cannot multiply them',t=>{
 assert.equal(typeof api.HistoricalFinalDeliveryIntents,'function');const f=fixture(t);f.commit();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_historical_final_delivery_batches').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
 const effect=f.db.prepare('SELECT * FROM ga_channel_deliveries').get();assert.equal(JSON.parse(effect.payload_json).text,f.text);assert.equal(f.service().verifyPublished('run','final',f.final.publication_source_sha256),true);
 assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
 assert.throws(()=>f.db.exec("UPDATE ga_historical_final_delivery_batches SET message_id='other'"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM ga_historical_final_delivery_batches'),/immutable/);
});
test('outbox and intent writes roll back when final publication fails',t=>{
 const f=fixture(t),snapshot=captureHistoricalDeliverySnapshot(f.db,scope);assert.throws(()=>withImmediateTransaction(f.db,()=>{f.service().commit(scope,snapshot.sha256,f.final);throw Error('synthetic publication failure');}));
 for(const table of ['ga_historical_final_delivery_batches','ga_historical_final_delivery_intents','ga_channel_deliveries'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('no transaction, stale provider facts, malformed text proof or an existing batch cannot mint another intent',t=>{
 const f=fixture(t),snapshot=captureHistoricalDeliverySnapshot(f.db,scope);assert.throws(()=>f.service().commit(scope,snapshot.sha256,f.final),/transaction/);f.enqueue();
 withImmediateTransaction(f.db,()=>assert.throws(()=>f.service().commit(scope,snapshot.sha256,f.final),/changed/));const current=captureHistoricalDeliverySnapshot(f.db,scope);
 withImmediateTransaction(f.db,()=>assert.throws(()=>f.service().commit(scope,current.sha256,{...f.final,answer_sha256:'d'.repeat(64)})));
 f.commit();withImmediateTransaction(f.db,()=>assert.throws(()=>f.service().commit(scope,captureHistoricalDeliverySnapshot(f.db,scope).sha256,f.final)));
});
test('superseding cancels only an undispatched old body and queues one new final',t=>{
 const f=fixture(t),old=f.enqueue();f.commit();assert.equal(f.queue.get(old.effect_id).status,'cancelled');assert.equal(f.queue.get(old.effect_id).last_reason_code,'HISTORICAL_FINAL_SUPERSEDED');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_channel_deliveries WHERE status='pending'").get().n,1);
});
test('conclusive old delivery queues a labeled correction without changing the old receipt',t=>{
 const f=fixture(t),old=f.enqueue();f.db.prepare("UPDATE ga_channel_deliveries SET status='delivered',generation=1,provider_receipt_json=? WHERE effect_id=?").run(JSON.stringify({provider_message_id:'synthetic-old-receipt'}),old.effect_id);const before=f.queue.get(old.effect_id);f.commit();assert.deepEqual(f.queue.get(old.effect_id),before);
 const pending=f.db.prepare("SELECT * FROM ga_channel_deliveries WHERE status='pending'").get();assert.equal(JSON.parse(pending.payload_json).text,'更新后的结果：\n'+f.text);assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,2);
});
test('unknown old send holds, later conclusive receipt releases one correction without model or native work',t=>{
 const f=fixture(t),old=f.enqueue();f.db.prepare("UPDATE ga_channel_deliveries SET status='outcome_unknown',generation=1 WHERE effect_id=?").run(old.effect_id);f.commit();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.equal(f.db.prepare('SELECT status FROM ga_historical_final_delivery_states').get().status,'hold');
 assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
 f.db.prepare("UPDATE ga_channel_deliveries SET status='delivered',provider_receipt_json=? WHERE effect_id=?").run(JSON.stringify({provider_message_id:'synthetic-recovered-receipt'}),old.effect_id);
 assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,2);
});
test('same final effect is reused and original send reservations remain protected',t=>{
 const f=fixture(t),effect=f.enqueue({text:f.text});f.db.prepare('INSERT INTO wb_task_notification_send_reservations VALUES(?,?,?)').run(effect.effect_id,'synthetic-bucket',1);const before=f.queue.get(effect.effect_id);f.commit();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.deepEqual(f.queue.get(effect.effect_id),before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_historical_final_delivery_grants').get().n,0);
});
test('the real delivery worker sends once, records the provider receipt and never invokes native runtime',async t=>{
 const f=fixture(t);f.commit();const sent=[],registered=[];const worker=new ChannelDeliveryWorker(f.queue,{providers:{wecom:{send:async(text,recipient)=>{sent.push({text,recipient});return{provider_message_id:'synthetic-final-receipt'};},sendFile:async()=>{throw Error('unexpected file');}}}},{registerDeliveryReceipt:async(...args)=>{registered.push(args);return{};}},{resolveRuntime:()=>({runtimeRunId:'synthetic-runtime',clientRunId:'run'}),resolveArtifact:()=>{throw Error('unexpected file');}},'delivery-worker');
 assert.equal(await worker.processNext(),true);assert.equal(await worker.processNext(),false);assert.deepEqual(sent,[{text:f.text,recipient:'synthetic-recipient'}]);assert.equal(registered.length,0);assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'delivered');
});
test('missing publication, changed canonical output, revoked binding or cancelled run refuses the actual send',t=>{
 for(const mutate of [f=>f.db.exec("UPDATE ga_messages SET content_json='{}' WHERE id='final'"),f=>f.db.exec("UPDATE ga_channel_bindings SET updated_at='changed'"),f=>f.db.exec("UPDATE ga_conversations SET archived_at='later'"),f=>f.db.exec("UPDATE ga_runs SET status='cancelled'"),f=>f.db.exec("DELETE FROM ga_messages WHERE id='final'")]){
  const f=fixture(t);f.commit();mutate(f);const effect=f.queue.claim('provider',90,['wecom']);assert.ok(effect);assert.equal(f.queue.authorizeSend(effect.effect_id,effect.generation),false);assert.equal(f.queue.get(effect.effect_id).status,'cancelled');
 }
 const f=fixture(t),snapshot=captureHistoricalDeliverySnapshot(f.db,scope);withImmediateTransaction(f.db,()=>f.service().commit(scope,snapshot.sha256,f.final));const effect=f.queue.claim('provider',90,['wecom']);assert.equal(f.queue.authorizeSend(effect.effect_id,effect.generation),false);
});
test('late obsolete final effects cannot bypass history while independent progress/file intents keep their path',t=>{
 const f=fixture(t);f.commit();const final=f.queue.claim('first',90,['wecom']);assert.equal(f.queue.authorizeSend(final.effect_id,final.generation),true);f.queue.recordProviderSent(final.effect_id,final.generation,{provider_message_id:'synthetic-sent'});f.queue.recordDelivered(final.effect_id);
 const late=f.enqueue({text:'Late obsolete final'}),other=f.enqueue({messageId:'progress',text:'Separate progress'});f.db.prepare("UPDATE ga_channel_deliveries SET created_at='0000' WHERE effect_id=?").run(late.effect_id);
 const next=f.queue.claim('second',90,['wecom']);assert.equal(next.effect_id,late.effect_id);assert.equal(f.queue.authorizeSend(next.effect_id,next.generation),false);
 const progress=f.queue.claim('third',90,['wecom']);assert.equal(progress.effect_id,other.effect_id);assert.equal(f.queue.authorizeSend(progress.effect_id,progress.generation),true);
});

test('deleting the original run or conversation cascades intent state without allowing direct intent erasure',t=>{
 for(const table of ['ga_runs','ga_conversations']){const f=fixture(t);f.commit();assert.throws(()=>f.db.exec('DELETE FROM ga_historical_final_delivery_intents'),/immutable/);f.db.exec(`DELETE FROM ${table}`);for(const child of ['ga_historical_final_delivery_batches','ga_historical_final_delivery_intents','ga_historical_final_delivery_grants','ga_historical_final_delivery_states'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${child}`).get().n,0);}
});
test('revocation after a partial send retains unknown provider facts instead of calling it unsent',t=>{
 const f=fixture(t);f.commit();const effect=f.queue.claim('provider',90,['wecom']);f.queue.recordProviderPart(effect.effect_id,effect.generation,1,2,{provider_message_id:'synthetic-part-one'});f.db.exec("UPDATE ga_channel_bindings SET updated_at='revoked'");assert.equal(f.queue.authorizeSend(effect.effect_id,effect.generation),false);const row=f.queue.get(effect.effect_id);assert.equal(row.status,'outcome_unknown');assert.equal(JSON.parse(row.provider_receipt_json).receipts[0].provider_message_id,'synthetic-part-one');
});
test('a later owner binding cannot retarget a held delivery or renew revoked original authority',t=>{
 const f=fixture(t),old=f.enqueue();f.db.prepare("UPDATE ga_channel_deliveries SET status='outcome_unknown',generation=1 WHERE effect_id=?").run(old.effect_id);f.commit();new OwnerChannelBindings(f.db);f.db.prepare("INSERT INTO ga_owner_channel_bindings VALUES('new-binding','owner','wecom','new-recipient','verified',1,1,NULL,1)").run();assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_historical_final_delivery_intents').get().n,1);
 f.db.exec("UPDATE ga_channel_bindings SET updated_at='revoked'");assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT status FROM ga_historical_final_delivery_states').get().status,'revoked');f.db.exec("UPDATE ga_channel_bindings SET updated_at='now'");f.db.prepare("UPDATE ga_channel_deliveries SET status='delivered',provider_receipt_json=? WHERE effect_id=?").run(JSON.stringify({provider_message_id:'synthetic-recovered'}),old.effect_id);assert.equal(f.service().reconcileHeld('run'),true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
});
test('one missing frozen effect rolls back all target reconciliation instead of committing earlier targets',t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO ga_channel_bindings VALUES('wecom','second-recipient','conversation','now','now')").run();const old=f.enqueue(),second=f.enqueue({recipient:'second-recipient'});f.db.exec("UPDATE ga_channel_deliveries SET status='outcome_unknown',generation=1");f.commit();
 const ordered=f.db.prepare('SELECT * FROM ga_historical_final_delivery_intents ORDER BY intent_id').all(),firstRecipient=ordered[0].recipient,first=[old,second].find(e=>e.recipient===firstRecipient),last=[old,second].find(e=>e.recipient!==firstRecipient);
 f.db.prepare("UPDATE ga_channel_deliveries SET status='delivered',provider_receipt_json=? WHERE effect_id=?").run(JSON.stringify({provider_message_id:'synthetic-recovered'}),first.effect_id);f.db.prepare('DELETE FROM ga_channel_deliveries WHERE effect_id=?').run(last.effect_id);
 assert.equal(f.service().reconcileHeld('run'),false);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.ok(f.db.prepare('SELECT status FROM ga_historical_final_delivery_states').all().every(s=>s.status==='hold'));
});
test('an ambiguous provider timeout is never retried by held reconciliation',async t=>{
 const f=fixture(t);f.commit();let sends=0;const worker=new ChannelDeliveryWorker(f.queue,{send:async()=>{sends++;throw Error('synthetic network timeout');},sendFile:async()=>{throw Error('unexpected file');}},{registerDeliveryReceipt:async()=>{throw Error('unexpected runtime');}},{resolveRuntime:()=>{throw Error('unexpected runtime');},resolveArtifact:()=>{throw Error('unexpected file');}},'delivery-worker');
 assert.equal(await worker.processNext(),true);assert.equal(f.service().reconcileHeld('run'),true);assert.equal(await worker.processNext(),false);assert.equal(sends,1);assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'outcome_unknown');
});
test('a granted effect cannot escape history authority by changing its run, message, artifact, channel or recipient',t=>{
 for(const [column,value] of [['run_id','other-run'],['message_id','other-message'],['artifact_ref','artifact-unowned'],['destination','email'],['recipient','other-recipient'],['payload_json',JSON.stringify({kind:'text',text:'Changed body'})]]){
  const f=fixture(t);f.commit();f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('other-run','conversation','interrupted','now','now')").run();f.db.prepare(`UPDATE ga_channel_deliveries SET ${column}=?`).run(value);const effect=f.queue.claim('provider',90,['wecom','email']);assert.equal(f.queue.authorizeSend(effect.effect_id,effect.generation),false,column);
 }
});
test('replacing the original controller Session cannot renew an already queued send',t=>{
 const f=fixture(t);f.commit();f.db.exec("UPDATE ga_harness_session_bindings SET session_id='replacement-session'");const effect=f.queue.claim('provider',90,['wecom']);assert.equal(f.queue.authorizeSend(effect.effect_id,effect.generation),false);
});
test('a queue from another database cannot create a non-atomic cross-database delivery',t=>{
 const first=fixture(t),second=fixture(t);assert.throws(()=>new api.HistoricalFinalDeliveryIntents(first.db,second.queue),/database/);assert.equal(second.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
});
test('a historical text send with prior provider parts or a repeated send generation cannot be sent again',t=>{
 for(const mode of ['partial','generation']){const f=fixture(t);f.commit();if(mode==='generation')f.db.exec('UPDATE ga_channel_deliveries SET generation=1');const effect=f.queue.claim('provider',90,['wecom']);if(mode==='partial')f.queue.recordProviderPart(effect.effect_id,effect.generation,1,2,{provider_message_id:'synthetic-part'});assert.equal(f.queue.authorizeSend(effect.effect_id,effect.generation),false,mode);assert.equal(f.queue.get(effect.effect_id).status,'outcome_unknown');}
});
