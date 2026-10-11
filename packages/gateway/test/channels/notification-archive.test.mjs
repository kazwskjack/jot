import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {resolve} from 'node:path';import {readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {openProductDatabase} from '../../src/db/database.ts';import {ChannelDeliveryService} from '../../src/channels/delivery.ts';import {NotificationArchiveService,resolveNotificationDigestArchive} from '../../src/channels/notification-archive.ts';
const now='2026-10-05T00:00:00Z',old='2026-01-01T00:00:00Z';
function fixture(t){const db=openProductDatabase(':memory:');t.after(()=>db.close());const store=new ChannelDeliveryService(db);db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('c','test-owner','shared','Notes','m',?,?)").run(old,old);const add=(id,status='delivered',runStatus='succeeded')=>{db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('run-'+id,'c',runStatus,old,old);db.prepare("INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,provider_receipt_json,created_at,updated_at) VALUES(?,?,?,'wecom','test-recipient',?,?,?,?,?)").run(id,'run-'+id,'msg-'+id,JSON.stringify({kind:'text',text:'Synthetic cold content '.repeat(1000)}),status,status==='delivered'?JSON.stringify({provider_message_id:'test-provider-'+id,detail:'Synthetic receipt '.repeat(100)}):null,old,old);};const root=resolve('.test-tmp/notification-archive',randomUUID()),archive=new NotificationArchiveService(db,root);return {db,store,add,archive,root};}
test('verified cold archive compacts only payload fields, preserves deduplication and restores exact content without sending',t=>{
 const f=fixture(t);f.add('cold');const original={...f.store.get('cold')},record=f.archive.archive('cold',{now});assert.equal(record.verified,true);assert.equal(record.compacted,true);assert.ok(record.compressed_bytes<record.original_bytes);assert.notEqual(f.db.prepare('SELECT payload_json FROM ga_channel_deliveries WHERE effect_id=?').get('cold').payload_json,original.payload_json);assert.deepEqual({...f.store.get('cold')},original);assert.equal(f.store.claim('test-worker',90),null);assert.equal(f.archive.archive('cold',{now}).archive_id,record.archive_id);assert.equal(f.archive.restore('cold').restored,true);assert.deepEqual({...f.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get('cold')},original);assert.equal(f.archive.restore('cold').restored,false);assert.equal(f.store.claim('test-worker',90),null);
});
test('unknown, pending, missing receipt, leased and active-source notifications cannot be compacted',t=>{
 const f=fixture(t);for(const [id,status,run] of [['unknown','outcome_unknown','succeeded'],['pending','pending','succeeded'],['active','delivered','running'],['missing','delivered','succeeded'],['leased','delivered','succeeded']])f.add(id,status,run);f.db.prepare('UPDATE ga_channel_deliveries SET provider_receipt_json=NULL WHERE effect_id=?').run('missing');f.db.prepare('UPDATE ga_channel_deliveries SET lease_owner=? WHERE effect_id=?').run('test-lease','leased');for(const id of ['unknown','pending','active','missing','leased'])assert.throws(()=>f.archive.archive(id,{now}),/notification_archive_protected/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,0);
});
test('corrupt gzip or changed hot anchors block read-through and restore without requeueing',t=>{
 const f=fixture(t);f.add('cold');const record=f.archive.archive('cold',{now}),file=resolve(f.root,record.archive_id+'.json.gz'),bytes=readFileSync(file);writeFileSync(file,Buffer.from('corrupt'));assert.throws(()=>f.store.get('cold'),/notification_archive_corrupt/);assert.throws(()=>f.archive.restore('cold'),/notification_archive_corrupt/);writeFileSync(file,bytes);f.db.prepare("UPDATE ga_channel_deliveries SET status='pending' WHERE effect_id='cold'").run();assert.throws(()=>f.archive.restore('cold'),/notification_archive_anchor_changed/);assert.equal(f.store.claim('test-worker',90),null);
});
test('a failed compact transaction preserves the original payload and cannot register a verified archive',t=>{
 const f=fixture(t);f.add('cold');const original={...f.store.get('cold')};f.db.exec("CREATE TRIGGER test_archive_failure BEFORE UPDATE ON ga_channel_deliveries BEGIN SELECT RAISE(ABORT,'test_archive_failure'); END;");assert.throws(()=>f.archive.archive('cold',{now}),/test_archive_failure/);assert.deepEqual({...f.store.get('cold')},original);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,0);
});
test('a digest with a nonterminal member protects its completed leader',t=>{
 const f=fixture(t);f.add('leader');f.add('member','pending');f.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run('test-digest','leader','Synthetic summary','a'.repeat(64),old);f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run('leader','test-digest',1,0);f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run('member','test-digest',1,1);assert.throws(()=>f.archive.archive('leader',{now}),/notification_archive_protected/);
});

test('archive index and exact read-through survive a new SQLite connection and CLI restoration',t=>{
 const root=resolve('.test-tmp/notification-archive',randomUUID());mkdirSync(root,{recursive:true});const path=resolve(root,'product.sqlite'),db=openProductDatabase(path),store=new ChannelDeliveryService(db),archive=new NotificationArchiveService(db,resolve(root,'cold'));db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('c','test-owner','shared','Notes','m',?,?)").run(old,old);db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('r','c','succeeded',?,?)").run(old,old);db.prepare("INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,provider_receipt_json,created_at,updated_at) VALUES('cold','r','msg','wecom','test-recipient',?,'delivered',?,?,?)").run('{"kind":"text","text":"Synthetic persisted content"}','{"provider_message_id":"test-receipt"}',old,old);const original={...store.get('cold')};archive.archive('cold',{now});db.close();
 const reopened=openProductDatabase(path);assert.deepEqual({...new ChannelDeliveryService(reopened).get('cold')},original);reopened.close();const result=spawnSync(process.execPath,['src/channels/notification-archive-main.ts','restore',path,resolve(root,'cold'),'cold'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).restored,true);assert.equal(result.stdout.includes('test-recipient'),false);const restored=openProductDatabase(path);t.after(()=>restored.close());assert.deepEqual({...restored.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get('cold')},original);
});

test('archive metadata is immutable and junction roots cannot redirect private payload writes',t=>{
 const f=fixture(t);f.add('cold');f.archive.archive('cold',{now});assert.throws(()=>f.db.prepare("UPDATE wb_task_notification_archives SET root='other' WHERE effect_id='cold'").run(),/notification_archive_anchor_immutable/);assert.throws(()=>f.db.prepare("DELETE FROM wb_task_notification_archives WHERE effect_id='cold'").run(),/notification_archive_anchor_immutable/);const outside=resolve('.test-tmp/notification-archive',randomUUID()),link=resolve(f.root,'link');mkdirSync(outside,{recursive:true});symlinkSync(outside,link,'junction');assert.throws(()=>new NotificationArchiveService(f.db,link),/notification_archive_path_denied/);
});

test('read-through observes one SQLite snapshot while another connection restores the archive',t=>{
 const root=resolve('.test-tmp/notification-archive',randomUUID());mkdirSync(root,{recursive:true});const path=resolve(root,'product.sqlite'),db=openProductDatabase(path);t.after(()=>db.close());const store=new ChannelDeliveryService(db),archive=new NotificationArchiveService(db,resolve(root,'cold'));db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('c','test-owner','shared','Notes','m',?,?)").run(old,old);db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES('r','c','succeeded',?,?)").run(old,old);db.prepare("INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,provider_receipt_json,created_at,updated_at) VALUES('cold','r','msg','wecom','test-recipient',?,'delivered',?,?,?)").run('{"kind":"text","text":"Synthetic concurrent content"}','{"provider_message_id":"test-receipt"}',old,old);const original={...store.get('cold')};archive.archive('cold',{now});const other=openProductDatabase(path);t.after(()=>other.close());const second=new NotificationArchiveService(other,resolve(root,'cold')),prepare=db.prepare.bind(db);let restored=false;
 db.prepare=sql=>{const statement=prepare(sql);if(sql!=='SELECT * FROM ga_channel_deliveries WHERE effect_id=?')return statement;return new Proxy(statement,{get(target,key){if(key==='get')return(...args)=>{const value=target.get(...args);if(!restored){restored=true;second.restore('cold');}return value;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
 assert.deepEqual({...store.get('cold')},original);assert.equal(restored,true);
});

function digest(f){f.add('leader');f.add('member');const text='Synthetic shared summary '.repeat(50),hash=createHash('sha256').update(text).digest('hex');f.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run('cold-digest','leader',text,hash,old);for(const [i,id]of ['leader','member'].entries())f.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run(id,'cold-digest',1,i);return text;}

test('whole cold digest compacts duplicate summary and all member bodies, then restores exactly without requeue',t=>{
 const f=fixture(t),text=digest(f),before=f.db.prepare('SELECT * FROM wb_task_notification_digests').get(),members=f.db.prepare('SELECT * FROM wb_task_notification_digest_members ORDER BY ordinal').all(),effects=['leader','member'].map(id=>({...f.store.get(id)}));
 const result=f.archive.archiveDigest('cold-digest',{now});assert.equal(result.compacted,true);assert.equal(result.member_count,2);
 const hot=f.db.prepare('SELECT * FROM wb_task_notification_digests').get();assert.notEqual(hot.payload_text,text);assert.equal(hot.payload_sha256,before.payload_sha256);assert.equal(hot.anchor_effect_id,'leader');
 assert.deepEqual(f.db.prepare('SELECT * FROM wb_task_notification_digest_members ORDER BY ordinal').all(),members);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,2);
 assert.deepEqual(['leader','member'].map(id=>({...f.store.get(id)})),effects);
 assert.equal(f.archive.archiveDigest('cold-digest',{now}).archive_id,result.archive_id);
 assert.equal(f.archive.restoreDigest('cold-digest').restored,true);assert.deepEqual(f.db.prepare('SELECT * FROM wb_task_notification_digests').get(),before);
 assert.deepEqual(['leader','member'].map(id=>({...f.store.get(id)})),effects);assert.equal(f.archive.restoreDigest('cold-digest').restored,false);assert.equal(f.store.claim('test-worker',90),null);
 assert.throws(()=>f.db.prepare("UPDATE wb_task_notification_digests SET payload_sha256='changed'").run(),/immutable/);
});

test('an active member protects the whole digest; a failed summary compact rolls back every member',t=>{
 const f=fixture(t),text=digest(f);f.db.prepare("UPDATE ga_channel_deliveries SET status='outcome_unknown' WHERE effect_id='member'").run();assert.throws(()=>f.archive.archiveDigest('cold-digest',{now}),/notification_archive_protected/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,0);
 f.db.prepare("UPDATE ga_channel_deliveries SET status='delivered' WHERE effect_id='member'").run();
 f.db.exec("CREATE TRIGGER test_digest_compact_failure BEFORE UPDATE ON wb_task_notification_digests BEGIN SELECT RAISE(ABORT,'test_digest_compact_failure'); END;");
 assert.throws(()=>f.archive.archiveDigest('cold-digest',{now}),/test_digest_compact_failure/);assert.equal(f.db.prepare('SELECT payload_text FROM wb_task_notification_digests').get().payload_text,text);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_archives').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_digest_archives').get().n,0);
});

test('corrupt digest archive cannot materialize or admit modified archived members to worker claims',t=>{
 const f=fixture(t),text=digest(f),record=f.archive.archiveDigest('cold-digest',{now});writeFileSync(resolve(f.root,record.archive_id+'.json.gz'),Buffer.from('corrupt'));
 assert.throws(()=>f.archive.restoreDigest('cold-digest'),/notification_archive_corrupt/);assert.notEqual(f.db.prepare('SELECT payload_text FROM wb_task_notification_digests').get().payload_text,text);
 f.db.prepare("UPDATE ga_channel_deliveries SET status='pending' WHERE effect_id='leader'").run();assert.equal(f.store.claim('test-worker',90),null);
});

test('live summary payload is immutable and compacted summary read-through returns its exact original text',t=>{
 const f=fixture(t),text=digest(f);assert.throws(()=>f.db.prepare("UPDATE wb_task_notification_digests SET payload_text='changed'").run(),/immutable/);
 f.archive.archiveDigest('cold-digest',{now});const hot=f.db.prepare('SELECT * FROM wb_task_notification_digests').get();assert.equal(resolveNotificationDigestArchive(f.db,hot).payload_text,text);
 assert.throws(()=>f.db.prepare("UPDATE wb_task_notification_digests SET payload_text='changed'").run(),/immutable/);assert.equal(f.db.prepare('SELECT restore_text FROM wb_task_notification_digest_archives').get().restore_text,null);
});

test('digest archive and restore CLI survive a copied database without disclosing message bodies',t=>{
 const f=fixture(t),text=digest(f),path=resolve(f.root,'product.sqlite');f.db.prepare('VACUUM INTO ?').run(path);
 const run=operation=>spawnSync(process.execPath,['src/channels/notification-archive-main.ts',operation,path,f.root,'cold-digest',...(operation==='archive-digest'?[now]:[])],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});
 const archived=run('archive-digest');assert.equal(archived.status,0,archived.stderr);assert.equal(JSON.parse(archived.stdout).member_count,2);
 const restored=run('restore-digest');assert.equal(restored.status,0,restored.stderr);assert.equal(JSON.parse(restored.stdout).restored,true);assert.equal(JSON.parse(run('restore-digest').stdout).restored,false);
 for(const result of [archived,restored]){assert.equal(result.stdout.includes('Synthetic'),false);assert.equal(result.stdout.includes('test-recipient'),false);}
 const reopened=openProductDatabase(path);t.after(()=>reopened.close());assert.equal(reopened.prepare('SELECT payload_text FROM wb_task_notification_digests').get().payload_text,text);assert.equal(reopened.prepare('SELECT count(*) n FROM wb_task_notification_digest_members').get().n,2);assert.equal(new ChannelDeliveryService(reopened).claim('test-worker',90),null);
});
