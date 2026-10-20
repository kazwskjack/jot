import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {stripNewMemberFencesForLegacyFixture,assertReopenedMemberFences} from '../support/workspace-legacy-fixture.mjs';

test('old databases retain unknown legacy policies while new accepted snapshots survive reopen',()=>{
 const base=resolve('.test-tmp/model-policy-migration');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let db;
 try{
  db=openProductDatabase(path);
  stripNewMemberFencesForLegacyFixture(db);
  db.exec('DROP TRIGGER ga_run_model_policy_immutable; DROP TRIGGER ga_run_model_resolution_immutable; ALTER TABLE ga_runs DROP COLUMN model_policy_json; ALTER TABLE ga_runs DROP COLUMN model_resolution_json;');
  const model={provider:'fixture',model:'original',reasoning_effort:'high'},now=new Date().toISOString();
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('migration-conversation','migration-owner','ws','Fixture',JSON.stringify(model),1,now,now);
  db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('legacy-run','migration-conversation','succeeded',now,now);
  db.close();db=openProductDatabase(path);
  const old=db.prepare('SELECT model_policy_json,model_resolution_json FROM ga_runs WHERE id=?').get('legacy-run');assert.equal(old.model_policy_json,null);assert.equal(old.model_resolution_json,null);
  const created=new RunRepository(db,new EventStore(db)).enqueue('migration-conversation','migration-owner',{client_message_id:'new-input',content:[{type:'text',text:'Synthetic migrated input'}]});
  const saved=db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(created.run_id).model_policy_json;assert.deepEqual(JSON.parse(saved),{protocol:1,conversation_version:1,model});
  db.close();db=openProductDatabase(path);assert.equal(db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(created.run_id).model_policy_json,saved);
  assert.throws(()=>db.prepare('UPDATE ga_runs SET model_policy_json=? WHERE id=?').run('{}',created.run_id),/model_policy_immutable/);
  assert.throws(()=>db.prepare('UPDATE ga_runs SET model_policy_json=? WHERE id=?').run(saved,'legacy-run'),/model_policy_immutable/);
  assertReopenedMemberFences(db);
 }finally{db?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
