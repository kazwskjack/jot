import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {migrateHostDeliveries} from '../../src/db/host-delivery-migration.ts';
test('nullable host delivery migration preserves legacy receipts, child foreign keys, triggers and views',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE ga_runs(id TEXT PRIMARY KEY);
 CREATE TABLE ga_channel_deliveries(effect_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,status TEXT NOT NULL,provider_receipt_json TEXT);
 CREATE TABLE child(effect_id TEXT REFERENCES ga_channel_deliveries(effect_id));
 CREATE VIEW legacy_receipts AS SELECT effect_id,provider_receipt_json FROM ga_channel_deliveries;
 CREATE INDEX legacy_status ON ga_channel_deliveries(status);
 CREATE TRIGGER legacy_receipt_protection BEFORE UPDATE OF provider_receipt_json ON ga_channel_deliveries WHEN OLD.status='delivered' BEGIN SELECT RAISE(ABORT,'receipt_immutable');END;
 INSERT INTO ga_runs VALUES('old-run');INSERT INTO ga_channel_deliveries VALUES('old-effect','old-run','delivered','{"provider_message_id":"old"}');INSERT INTO child VALUES('old-effect');`);
 migrateHostDeliveries(db);migrateHostDeliveries(db);
 assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(db.prepare('SELECT provider_receipt_json FROM legacy_receipts').get().provider_receipt_json,'{"provider_message_id":"old"}');
 assert.throws(()=>db.prepare('UPDATE ga_channel_deliveries SET provider_receipt_json=? WHERE effect_id=?').run('{}','old-effect'),/receipt_immutable/);
 assert.throws(()=>db.prepare('INSERT INTO child VALUES(?)').run('missing'),/FOREIGN KEY/);
 db.prepare('INSERT INTO ga_channel_deliveries VALUES(?,?,?,?)').run('host-effect',null,'pending',null);
 assert.equal(db.prepare('SELECT run_id FROM ga_channel_deliveries WHERE effect_id=?').get('host-effect').run_id,null);
 assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_status'").get());
 }finally{db.close();}
});
test('a blocked schema rebuild rolls back legacy data and restores connection safety settings',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE ga_runs(id TEXT PRIMARY KEY);
 CREATE TABLE ga_channel_deliveries(effect_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id));
 INSERT INTO ga_runs VALUES('run');INSERT INTO ga_channel_deliveries VALUES('effect','run');CREATE TABLE ga_channel_deliveries_host_upgrade(block INTEGER);`);
 assert.throws(()=>migrateHostDeliveries(db),/already exists/);assert.equal(db.isTransaction,false);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table,0);
 assert.equal(db.prepare('SELECT run_id FROM ga_channel_deliveries').get().run_id,'run');assert.equal(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all().find(c=>c.name==='run_id').notnull,1);
 }finally{db.close();}
});
