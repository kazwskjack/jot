import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {installMattermostTextControl,normalizeMattermostTextWire,proveMattermostTextObservation} from '../../src/channels/mattermost-text-control.ts';
import {setup} from './fixtures/mattermost-text-test-support.mjs';
test('text observation schema rejects incompatible tables/triggers, foreign-key disablement and malformed source wire',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('PRAGMA foreign_keys=ON');new OwnerChannelBindings(db);db.exec('CREATE TABLE ga_mattermost_text_observations(bad TEXT)');assert.throws(()=>installMattermostTextControl(db),/mattermost_text_schema_mismatch/);}finally{db.close();}
 const second=new DatabaseSync(':memory:');try{second.exec('PRAGMA foreign_keys=ON');new OwnerChannelBindings(second);installMattermostTextControl(second);second.exec('DROP TRIGGER ga_mattermost_text_observations_no_delete; CREATE TRIGGER ga_mattermost_text_observations_no_delete BEFORE DELETE ON ga_mattermost_text_observations BEGIN SELECT 1; END');assert.throws(()=>installMattermostTextControl(second),/mattermost_text_schema_mismatch/);second.exec('PRAGMA foreign_keys=OFF');assert.throws(()=>installMattermostTextControl(second),/mattermost_foreign_keys_required/);}finally{second.close();}
 const wire={channel:'mattermost',principal:JSON.stringify(['https://chat.example.test','bot-account','owner-user']),thread_id:JSON.stringify(['private-dm','']),message_id:'text-post',text:'Text',attachments:[]};
 for(const change of [{owner_id:'other'},{attachments:[{}]},{text:'/jot-bind '+'A'.repeat(43)},{text:' text '},{text:'x'.repeat(4001)},{principal:'plain-user'}])assert.throws(()=>normalizeMattermostTextWire({...wire,...change}),/mattermost_text_source_invalid|channel_authority_binding_invalid/);
});

test('frozen source JSON/hash/owner/generation must prove exactly; metadata cannot update or delete',async t=>{
 const f=await setup(t);await f.start();await f.emit();f.post={...f.post,id:'normal-text',message:'Original'};await f.emit();
 const row=f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').get(),account={instance:'https://chat.example.test',botUserId:'bot-account'};assert.ok(row);
 for(const change of [{source_json:'not json'},{source_json:JSON.stringify(JSON.parse(row.source_json),null,2)},{source_sha256:'f'.repeat(64)},{owner_id:'bob'},{binding_version:2},{post_id:'other-post'}])assert.throws(()=>proveMattermostTextObservation(f.product.db,account,{...row,...change}));
 assert.throws(()=>f.product.db.exec('UPDATE ga_mattermost_text_observations SET binding_version=2'),/mattermost_source_immutable/);
 assert.throws(()=>f.product.db.exec('DELETE FROM ga_mattermost_text_observations'),/mattermost_source_immutable/);
 const insert=f.product.db.prepare('INSERT INTO ga_mattermost_text_observations(instance,bot_user_id,post_id,principal,provider_thread_id,source_sha256,source_json,owner_id,channel_binding_id,binding_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 for(const [digest,json,version,time] of [[Buffer.alloc(64),row.source_json,1,0],['A'.repeat(64),row.source_json,1,0],[row.source_sha256,'not json',1,0],[row.source_sha256,row.source_json,0,0],[row.source_sha256,row.source_json,1,-1]])assert.throws(()=>insert.run(row.instance,row.bot_user_id,'bad',row.principal,row.provider_thread_id,digest,json,row.owner_id,row.channel_binding_id,version,time));
});
