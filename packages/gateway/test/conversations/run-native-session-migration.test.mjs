import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {stripNewMemberFencesForLegacyFixture,assertReopenedMemberFences} from '../support/workspace-legacy-fixture.mjs';

test('migration preserves legacy Session pointers and only new accepted runs get a frozen binding',()=>{
 const base=resolve('.test-tmp/native-session-migration');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let db;
 try{
  db=openProductDatabase(path);
  stripNewMemberFencesForLegacyFixture(db);
  db.exec('DROP VIEW ga_run_native_sessions; DROP TRIGGER ga_run_native_session_immutable; DROP INDEX idx_ga_runs_native_session; ALTER TABLE ga_runs DROP COLUMN native_session_ref; ALTER TABLE ga_runs DROP COLUMN native_owner_id; ALTER TABLE ga_runs DROP COLUMN native_conversation_id;');
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('migration-conversation','migration-owner','ws','Fixture','{}','now','now');
  db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('migration-conversation','migration-owner','legacy-native','now','now');
  db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('legacy-run','migration-conversation','succeeded','now','now');
  db.close();db=openProductDatabase(path);
  assert.equal(db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get('legacy-run').native_session_ref,null);
  assert.equal(db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get('migration-conversation').session_id,'legacy-native');
  const receipt=new RunRepository(db,new EventStore(db)).enqueue('migration-conversation','migration-owner',{client_message_id:'new-input',content:[{type:'text',text:'Synthetic migrated input'}]});
  db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('new-pointer','migration-conversation');
  db.close();db=openProductDatabase(path);
  assert.equal(db.prepare('SELECT session_id FROM ga_run_native_sessions WHERE run_id=?').get(receipt.run_id).session_id,'legacy-native');
  const saved=db.prepare('SELECT native_owner_id,native_conversation_id,native_session_ref FROM ga_runs WHERE id=?').get(receipt.run_id);
  assert.deepEqual({...saved},{native_owner_id:'migration-owner',native_conversation_id:'migration-conversation',native_session_ref:'legacy-native'});
  assert.throws(()=>db.prepare('UPDATE ga_runs SET native_owner_id=? WHERE id=?').run('other-owner',receipt.run_id),/run_native_session_immutable/);
  assert.throws(()=>db.prepare('UPDATE ga_runs SET native_conversation_id=? WHERE id=?').run('other-conversation',receipt.run_id),/run_native_session_immutable/);
  assert.equal(db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get('legacy-run').native_session_ref,null);
  assertReopenedMemberFences(db);
 }finally{db?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
