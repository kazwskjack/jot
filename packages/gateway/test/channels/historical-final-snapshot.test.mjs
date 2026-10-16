import test from 'node:test';import assert from 'node:assert/strict';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const api=await import('../../src/channels/historical-final-snapshot.ts').catch(()=>({}));
const scope={owner_id:'owner',conversation_id:'conversation',run_id:'run'};
function fixture(t){
 const db=openProductDatabase(':memory:');t.after(()=>db.close());
 db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('conversation','owner','workspace','Synthetic','{}','now','now')").run();
 db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('run','conversation','interrupted','now','now')").run();
 db.prepare("INSERT INTO ga_channel_bindings VALUES('wecom','synthetic-recipient','conversation','now','now')").run();
 const queue=new ChannelDeliveryService(db);new OwnerChannelBindings(db);
 const enqueue=(patch={})=>queue.enqueueExternal({runId:'run',messageId:'final',destination:'wecom',recipient:'synthetic-recipient',artifactRef:null,text:'Synthetic old answer',...patch});
 return{db,queue,enqueue,read:()=>api.captureHistoricalDeliverySnapshot(db,scope)};
}
test('snapshot derives original targets and real effects without any database write or execution authority',t=>{
 const f=fixture(t),effect=f.enqueue(),before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(typeof api.captureHistoricalDeliverySnapshot,'function');const first=f.read(),second=f.read();
 assert.deepEqual(first,second);assert.match(first.sha256,/^[a-f0-9]{64}$/);assert.equal(first.execution_authorized,false);
 assert.equal(first.targets.length,1);assert.equal(first.targets[0].recipient,'synthetic-recipient');assert.equal(first.targets[0].recipient_authorized,true);assert.equal(first.targets[0].effects[0].effect_id,effect.effect_id);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
test('foreign, archived, missing and malformed scopes cannot obtain a snapshot',t=>{
 const f=fixture(t);for(const value of [{...scope,owner_id:'other'},{...scope,run_id:'missing'},{...scope,conversation_id:'missing'},{...scope,extra:true},{...scope,owner_id:3}])assert.throws(()=>api.captureHistoricalDeliverySnapshot(f.db,value));
 f.db.prepare("UPDATE ga_conversations SET archived_at='later'").run();assert.throws(f.read);
});
test('owner binding alone does not add a recipient and revoked or foreign bindings cannot authorize an original target',t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO ga_owner_channel_bindings VALUES('binding','owner','wecom','new-recipient','verified',1,1,NULL,1)").run();assert.equal(f.read().targets.length,1);
 f.db.prepare("INSERT INTO ga_owner_channel_bindings VALUES('old-binding','owner','wecom','synthetic-recipient','revoked',2,1,2,1)").run();assert.equal(f.read().targets[0].recipient_authorized,false);
 f.db.prepare("UPDATE ga_owner_channel_bindings SET status='verified' WHERE channel_binding_id='old-binding'").run();assert.equal(f.read().targets[0].recipient_authorized,true);
 f.db.prepare("DELETE FROM ga_owner_channel_bindings WHERE channel_binding_id='old-binding'").run();f.db.prepare("INSERT INTO ga_owner_channel_bindings VALUES('foreign-binding','other','wecom','synthetic-recipient','verified',1,1,NULL,1)").run();assert.equal(f.read().targets[0].recipient_authorized,false);
});
test('existing-only recipients retain uncertain sends without inventing current conversation authority',t=>{
 const f=fixture(t),effect=f.enqueue({recipient:'old-recipient'});f.db.prepare("UPDATE ga_channel_deliveries SET status='outcome_unknown',generation=1 WHERE effect_id=?").run(effect.effect_id);
 const target=f.read().targets.find(t=>t.recipient==='old-recipient');assert.equal(target.recipient_authorized,false);assert.equal(target.effects[0].status,'outcome_unknown');assert.equal(target.conversation_binding,null);
});
test('effect state, binding revision and conversation authority changes invalidate the transactional comparison',t=>{
 const f=fixture(t),effect=f.enqueue(),first=f.read();assert.throws(()=>api.assertHistoricalDeliverySnapshot(f.db,scope,first.sha256),/transaction/);
 withImmediateTransaction(f.db,()=>assert.equal(api.assertHistoricalDeliverySnapshot(f.db,scope,first.sha256).sha256,first.sha256));
 for(const [sql,args] of [["UPDATE ga_channel_deliveries SET provider_receipt_json='{}' WHERE effect_id=?",[effect.effect_id]],["UPDATE ga_channel_deliveries SET status='sending',generation=1,lease_owner='worker',lease_expires_at=1234",[]],["UPDATE ga_channel_deliveries SET payload_json='{}',updated_at='changed'",[]],["UPDATE ga_channel_bindings SET updated_at='later'",[]],["UPDATE ga_conversations SET version=version+1",[]]]){
  const prior=f.read();f.db.prepare(sql).run(...args);withImmediateTransaction(f.db,()=>assert.throws(()=>api.assertHistoricalDeliverySnapshot(f.db,scope,prior.sha256),/changed/));
 }
});
test('existing reservations and future effect metadata are protected and included by actual schema, without migration',t=>{
 const f=fixture(t),effect=f.enqueue(),before=f.read();f.db.prepare('INSERT INTO wb_task_notification_send_reservations VALUES(?,?,?)').run(effect.effect_id,'synthetic-bucket',1);
 assert.deepEqual(f.read().targets[0].protected_effect_ids,[effect.effect_id]);assert.notEqual(f.read().sha256,before.sha256);
 f.db.exec('CREATE TABLE synthetic_future_grants(effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),version INTEGER)');f.db.prepare('INSERT INTO synthetic_future_grants VALUES(?,1)').run(effect.effect_id);const prior=f.read();f.db.exec('UPDATE synthetic_future_grants SET version=2');assert.notEqual(f.read().sha256,prior.sha256);
});
test('digest peer receipt changes outside this run invalidate the frozen shared effect state',t=>{
 const f=fixture(t),effect=f.enqueue();f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('peer-run','conversation','interrupted','now','now')").run();const peer=f.enqueue({runId:'peer-run',messageId:'peer-final',text:'Synthetic peer'});
 f.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run('digest',effect.effect_id,'Synthetic digest','synthetic-hash','now');
 for(const [index,id] of [effect.effect_id,peer.effect_id].entries())f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run(id,'digest',0,index);
 const before=f.read();assert.deepEqual(before.targets[0].protected_effect_ids,[effect.effect_id]);f.db.prepare("UPDATE ga_channel_deliveries SET status='outcome_unknown' WHERE effect_id=?").run(peer.effect_id);assert.notEqual(f.read().sha256,before.sha256);
});

test('a second SQLite connection changes real provider state before the publication transaction',t=>{
 const root=mkdtempSync(join(tmpdir(),'historical-delivery-snapshot-')),path=join(root,'db.sqlite'),db=openProductDatabase(path);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('conversation','owner','workspace','Synthetic','{}','now','now')").run();
 db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('run','conversation','interrupted','now','now')").run();
 db.prepare("INSERT INTO ga_channel_bindings VALUES('wecom','synthetic-recipient','conversation','now','now')").run();const queue=new ChannelDeliveryService(db);new OwnerChannelBindings(db);const effect=queue.enqueueExternal({runId:'run',messageId:'final',destination:'wecom',recipient:'synthetic-recipient',artifactRef:null,text:'Synthetic old'});
 const before=api.captureHistoricalDeliverySnapshot(db,scope),peer=openProductDatabase(path);try{peer.prepare("UPDATE ga_channel_deliveries SET status='sending',generation=1,lease_owner='provider-worker',lease_expires_at=9999999999 WHERE effect_id=?").run(effect.effect_id);}finally{peer.close();}
 withImmediateTransaction(db,()=>assert.throws(()=>api.assertHistoricalDeliverySnapshot(db,scope,before.sha256),/changed/));assert.equal(queue.get(effect.effect_id).status,'sending');
});
