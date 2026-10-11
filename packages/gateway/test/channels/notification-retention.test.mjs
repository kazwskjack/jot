import test from 'node:test';import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {buildNotificationRetentionPlan,pruneNotificationCaches} from '../../src/channels/notification-retention.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
const now='2026-10-04T00:00:00Z',old='2026-01-01T00:00:00Z';
function fixture(t){const db=openProductDatabase(':memory:');t.after(()=>db.close());new ChannelDeliveryService(db);
 db.prepare(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('c','owner','w','private title','m',?,?)`).run(old,old);
 return {db,add:(id,status='delivered',runStatus='succeeded')=>{
  db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('run-'+id,'c',runStatus,old,old);
  db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,provider_receipt_json,created_at,updated_at) VALUES(?,?,?,'wecom','private recipient',?,?,?,?,?)`).run(id,'run-'+id,'message-'+id,'{"kind":"text","text":"private payload"}',status,status==='delivered'?'{"provider_message_id":"private receipt"}':null,old,old);
  db.prepare('INSERT INTO wb_task_notification_deferrals VALUES(?,?)').run(id,1);db.prepare('INSERT INTO wb_task_notification_quiet_queue VALUES(?,?)').run(id,1);
 }};
}
test('read-only retention inventory bounds old terminal candidates without exposing message content or recipient facts',t=>{
 const f=fixture(t);f.add('old');f.add('unknown','outcome_unknown');f.add('pending','pending');f.add('receipt','receipt_pending');f.add('active-run','delivered','running');
 f.db.exec('PRAGMA query_only=ON');const report=buildNotificationRetentionPlan(f.db,{now});assert.equal(report.mode,'dry-run');assert.equal(report.candidates.length,5);
 const candidate=report.candidates.find(row=>row.delivery_id==='old');assert.equal(candidate.eligible_for_backup,true);assert.equal(candidate.cache_prunable,true);assert.equal(candidate.deletable,false);assert.equal(candidate.backup_verified,false);
 for(const id of ['unknown','pending','receipt','active-run'])assert.equal(report.candidates.find(row=>row.delivery_id===id).cache_prunable,false);
 assert.ok(!JSON.stringify(report).includes('private'));assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,5);
});
test('pruning terminal wait caches never deletes payloads, receipts, quotas or an unfinished digest member',t=>{
 const f=fixture(t);f.add('standalone');f.add('group-done');f.add('group-pending','pending');f.add('unknown','outcome_unknown');
 f.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run('digest','group-done','private digest','a'.repeat(64),old);
 f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run('group-done','digest',1,0);f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run('group-pending','digest',1,1);
 f.db.prepare('INSERT INTO wb_task_notification_send_reservations VALUES(?,?,?)').run('standalone','bucket',1);
 const before=f.db.prepare('SELECT * FROM ga_channel_deliveries ORDER BY effect_id').all(),result=pruneNotificationCaches(f.db,{now});assert.equal(result.removed_deferrals,1);assert.equal(result.removed_quiet_entries,1);
 assert.deepEqual(f.db.prepare('SELECT * FROM ga_channel_deliveries ORDER BY effect_id').all(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_send_reservations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_digest_members').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_deferrals').get().n,3);
});
test('cache cleanup rolls back all removals on a write error and respects malformed timestamps or missing delivered receipts',t=>{
 const f=fixture(t);f.add('eligible');f.add('bad-date');f.add('bad-receipt');f.db.prepare('UPDATE ga_channel_deliveries SET updated_at=? WHERE effect_id=?').run('invalid','bad-date');f.db.prepare('UPDATE ga_channel_deliveries SET provider_receipt_json=NULL WHERE effect_id=?').run('bad-receipt');
 f.db.exec("CREATE TRIGGER fixture_cache_failure BEFORE DELETE ON wb_task_notification_quiet_queue BEGIN SELECT RAISE(ABORT,'fixture_cache_failure'); END;");assert.throws(()=>pruneNotificationCaches(f.db,{now}),/fixture_cache_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_deferrals').get().n,3);
 f.db.exec('DROP TRIGGER fixture_cache_failure');assert.equal(pruneNotificationCaches(f.db,{now}).removed_deferrals,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,3);
});
test('inventory and cleanup pages advance beyond protected effects and enforce explicit age bounds',t=>{
 const f=fixture(t);f.add('a-protected','pending');f.add('b-old');f.add('c-old');const first=pruneNotificationCaches(f.db,{now,limit:1});assert.equal(first.removed_deferrals,0);assert.equal(first.next_after_delivery_id,'a-protected');
 const second=pruneNotificationCaches(f.db,{now,limit:1,afterDeliveryId:first.next_after_delivery_id});assert.equal(second.removed_deferrals,1);assert.equal(second.next_after_delivery_id,'b-old');
 assert.throws(()=>buildNotificationRetentionPlan(f.db,{now,retentionDays:0}),/invalid_notification_retention/);assert.throws(()=>buildNotificationRetentionPlan(f.db,{now:'invalid'}),/invalid_notification_retention/);
});
test('a terminal digest with one unconfirmed receipt remains protected as an entire group',t=>{
 const f=fixture(t);f.add('a');f.add('b');f.db.prepare('UPDATE ga_channel_deliveries SET provider_receipt_json=NULL WHERE effect_id=?').run('b');
 f.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run('digest','a','private digest','a'.repeat(64),old);f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run('a','digest',1,0);f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run('b','digest',1,1);
 const report=buildNotificationRetentionPlan(f.db,{now});assert.ok(report.candidates.every(c=>!c.cache_prunable));assert.equal(pruneNotificationCaches(f.db,{now}).removed_deferrals,0);
});
test('ordinary task notification maintenance prunes only cold disposable caches and retains its existing emitted count',t=>{
 const f=fixture(t);f.add('old');const tasks=new PersistentTaskService(f.db,{getAgent(){throw new Error('no execution requested');},bindRun(){throw new Error('no execution requested');}},{now:()=>new Date(now)});
 const result=tasks.maintainNotifications();assert.equal(result.emitted,0);assert.equal(result.caches.removed_deferrals,1);assert.equal(result.caches.removed_quiet_entries,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
});
