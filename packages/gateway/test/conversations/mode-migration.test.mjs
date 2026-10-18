import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';

test('legacy conversations become Work without replacing their saved native Session or Goal control',()=>{
 const base=resolve('.test-tmp/mode-migration');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let db;
 try{
  db=openProductDatabase(path);db.exec('DROP TABLE ga_conversation_mode_sessions; DROP TRIGGER ga_execution_policy_immutable; ALTER TABLE ga_runs DROP COLUMN execution_policy_json; ALTER TABLE ga_conversations DROP COLUMN mode;');
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('legacy-conversation','legacy-owner','ws','Synthetic','{}','now','now');
  db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('legacy-conversation','legacy-owner','original-native','now','now');
  db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('legacy-source','legacy-conversation','succeeded','now','now');
  db.prepare('INSERT INTO ga_runs(id,conversation_id,status,continuation_of,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('legacy-continuation','legacy-conversation','queued','legacy-source','now','now');
  db.prepare("INSERT INTO ga_conversation_goal_controls(control_id,owner_id,conversation_id,session_id,source_run_id,run_id,goal_id,goal_revision,idempotency_key,request_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued','now','now')").run('legacy-control','legacy-owner','legacy-conversation','original-native','legacy-source','legacy-continuation','original-goal',1,'legacy-goal-key','a'.repeat(64));
  const goal=db.prepare('SELECT * FROM ga_conversation_goal_controls').get();db.close();db=openProductDatabase(path);
  assert.equal(db.prepare('SELECT mode FROM ga_conversations').get().mode,'work');
  assert.deepEqual(db.prepare('SELECT * FROM ga_conversation_goal_controls').get(),goal);
  assert.equal(db.prepare('SELECT session_id FROM ga_conversation_mode_sessions').get().session_id,'original-native');
  assert.equal(db.prepare('SELECT execution_policy_json FROM ga_runs WHERE id=?').get('legacy-source').execution_policy_json,null);
  assert.equal(new SessionBindingRepository(db,'different-prefix').getOrCreate('legacy-owner','legacy-conversation').session_id,'original-native');
  assert.throws(()=>db.prepare("UPDATE ga_conversation_mode_sessions SET session_id='replacement'").run(),/mode_session_immutable/);
  db.close();db=openProductDatabase(path);assert.equal(db.prepare('SELECT count(*) n FROM ga_conversation_mode_sessions').get().n,1);assert.deepEqual(db.prepare('SELECT * FROM ga_conversation_goal_controls').get(),goal);
 }finally{db?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
