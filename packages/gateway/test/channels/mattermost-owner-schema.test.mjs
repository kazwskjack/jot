import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {installMattermostOwnerProof} from '../../src/channels/mattermost-owner-proof.ts';
function database(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');new OwnerChannelBindings(db);return db;}
test('Mattermost install rejects incompatible existing table and altered immutable trigger',()=>{
 const db=database();try{db.exec('CREATE TABLE ga_mattermost_ingress_observations (bad TEXT)');assert.throws(()=>installMattermostOwnerProof(db),/mattermost_schema_mismatch/);}finally{db.close();}
 const second=database();try{installMattermostOwnerProof(second);second.exec("DROP TRIGGER ga_mattermost_owner_proofs_no_update; CREATE TRIGGER ga_mattermost_owner_proofs_no_update BEFORE UPDATE ON ga_mattermost_owner_proofs BEGIN SELECT 1; END");assert.throws(()=>installMattermostOwnerProof(second),/mattermost_schema_mismatch/);}finally{second.close();}
});
test('Mattermost metadata demands enabled foreign keys and valid immutable observation digest/timestamp',()=>{
 const db=database();try{
  installMattermostOwnerProof(db);installMattermostOwnerProof(db);
  const insert=db.prepare('INSERT INTO ga_mattermost_ingress_observations(instance,bot_user_id,post_id,principal,provider_thread_id,source_sha256,created_at) VALUES(?,?,?,?,?,?,?)');
  for(const [digest,time] of [['A'.repeat(64),0],['g'.repeat(64),0],['a'.repeat(63),0],[Buffer.alloc(64,0),0],['a'.repeat(64),-1],['a'.repeat(64),1.5]])assert.throws(()=>insert.run('https://chat.test','bot','post','principal','thread',digest,time));
  insert.run('https://chat.test','bot','post','principal','thread','a'.repeat(64),0);
  assert.throws(()=>db.exec('DELETE FROM ga_mattermost_ingress_observations'),/mattermost_source_immutable/);
  assert.throws(()=>db.exec('UPDATE ga_mattermost_ingress_observations SET created_at=1'),/mattermost_source_immutable/);
  db.exec('PRAGMA foreign_keys=OFF');assert.throws(()=>installMattermostOwnerProof(db),/mattermost_foreign_keys_required/);
 }finally{db.close();}
});
