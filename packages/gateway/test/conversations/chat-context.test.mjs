import test from 'node:test';
import assert from 'node:assert/strict';
import {stripNewMemberFencesForLegacyFixture,assertReopenedMemberFences} from '../support/workspace-legacy-fixture.mjs';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
const policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'};
function fixture(t){const db=openProductDatabase(':memory:');t.after(()=>db.close());const conversations=new ConversationRepository(db),runs=new RunRepository(db,new EventStore(db));const c=conversations.create('context-owner',{workspace_id:'ws',model:{provider:'fixture',model:'work'},mode:'chat'},{chatPolicy:policy});
 const history=(id,role,text,extra={})=>db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?)').run(id,c.conversation_id,role,extra.status??'complete',JSON.stringify({blocks:[{kind:'reasoning',text:'PRIVATE-REASONING-NEVER-SEED'},{kind:'text',text},...(extra.blocks??[])],attachments:extra.attachments??[]}),id,id);
 const send=(id='current')=>runs.enqueue(c.conversation_id,'context-owner',{client_message_id:id,content:[{type:'text',text:'Current original question must not become its own seed.'}]},{modePolicy:policy});return{db,c,history,send};}
test('Chat acceptance freezes the newest twelve prior complete text messages with stable source references',t=>{
 const f=fixture(t);for(let i=0;i<16;i++)f.history('history-'+String(i).padStart(2,'0'),i%2?'assistant':'user','Synthetic prior '+i);
 f.history('history-17','assistant','INCOMPLETE-NEVER-SEED',{status:'streaming'});
 const accepted=f.send(),row=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(accepted.run_id);assert.equal(typeof row.chat_context_json,'string');const snapshot=JSON.parse(row.chat_context_json);
 assert.equal(snapshot.algorithm,'recent-text-v1');assert.equal(snapshot.context_revision,policy.context_revision);assert.equal(snapshot.conversation_id,f.c.conversation_id);assert.equal(snapshot.messages.length,12);
 assert.deepEqual(snapshot.messages.map(item=>item.message_id),Array.from({length:12},(_,i)=>'history-'+String(i+4).padStart(2,'0')));
 for(const item of snapshot.messages){assert.equal(item.updated_at,item.message_id);assert.match(item.source_content_sha256,/^[a-f0-9]{64}$/);}
 assert.ok(!snapshot.model_text.includes('PRIVATE-REASONING'));assert.ok(!snapshot.model_text.includes('INCOMPLETE'));assert.ok(!snapshot.model_text.includes('Current original'));
 f.db.prepare("UPDATE ga_messages SET content_json='[]',updated_at='later' WHERE id='history-15'").run();assert.deepEqual(f.send(),accepted);assert.equal(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(accepted.run_id).chat_context_json,row.chat_context_json);
 assert.throws(()=>f.db.prepare("UPDATE ga_runs SET chat_context_json='{}' WHERE id=?").run(accepted.run_id),/chat_context_immutable/);
});
test('the complete model-facing context is bounded and never splits a surrogate pair or carries inline image bytes',t=>{
 const f=fixture(t);for(let i=0;i<12;i++)f.history('history-'+String(i).padStart(2,'0'),i%2?'assistant':'user','🙂'.repeat(5000));
 f.history('history-13','user','A prior image ![source](data:image/png;base64,QUJDREVGRw==) and useful text.',{blocks:[{kind:'image',data:'IMAGE-BYTES-NEVER-SEED'}],attachments:['image-artifact']});
 const snapshot=JSON.parse(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(f.send().run_id).chat_context_json);
 assert.ok(snapshot.model_text.length<=14000);assert.ok(snapshot.messages.length<=12);assert.ok(snapshot.messages.some(item=>item.truncated));
 assert.ok(!snapshot.model_text.includes('QUJDREVGRw=='));assert.ok(!snapshot.model_text.includes('IMAGE-BYTES'));
 assert.equal(snapshot.messages.at(-1).omitted_images,1);assert.ok(snapshot.model_text.includes('useful text'));
 for(const item of snapshot.messages){assert.ok(item.text.length<=(item.role==='user'?4000:2400));assert.ok(!/[\uD800-\uDBFF]$/.test(item.text));}
});
test('Work acceptance does not create Chat context or change the stored transcript',t=>{
 const db=openProductDatabase(':memory:');t.after(()=>db.close());const conversations=new ConversationRepository(db),runs=new RunRepository(db,new EventStore(db)),c=conversations.create('work-owner',{workspace_id:'ws',model:{provider:'fixture',model:'work'}});
 const result=runs.enqueue(c.conversation_id,'work-owner',{client_message_id:'work-input',content:[{type:'text',text:'Synthetic Work question'}]});assert.equal(db.prepare('SELECT * FROM ga_runs WHERE id=?').get(result.run_id).chat_context_json,null);
});
test('image data URLs with metadata, percent encoding or empty payload remain outside the model context',t=>{
 const f=fixture(t);f.history('prior-uri','user','before data:image/png;charset=utf-8;base64,QUJDRA== middle data:image/svg+xml,%3Csvg%3E end data:image/png;base64,');
 const snapshot=JSON.parse(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(f.send().run_id).chat_context_json);assert.equal(snapshot.messages[0].omitted_images,3);assert.ok(!snapshot.model_text.includes('data:image/'));assert.ok(snapshot.model_text.includes('before'));assert.ok(snapshot.model_text.includes('middle'));assert.ok(snapshot.model_text.includes(' end '));
});

test('disk migration leaves legacy contexts absent and retains a new immutable snapshot after reopening',()=>{
 const base=resolve('.test-tmp/chat-context-migration');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let db;
 try{
  db=openProductDatabase(path);const conversations=new ConversationRepository(db),runs=new RunRepository(db,new EventStore(db));
  const legacy=conversations.create('migration-owner',{workspace_id:'ws',model:{provider:'fixture',model:'work'}}),old=runs.enqueue(legacy.conversation_id,'migration-owner',{client_message_id:'old',content:[{type:'text',text:'Original legacy question.'}]});
  const original=db.prepare('SELECT execution_policy_json,native_session_ref,input_message_id FROM ga_runs WHERE id=?').get(old.run_id);
  stripNewMemberFencesForLegacyFixture(db);db.exec('DROP TRIGGER ga_chat_context_immutable; ALTER TABLE ga_runs DROP COLUMN chat_context_json; ALTER TABLE ga_runs DROP COLUMN chat_context_sha256;');db.close();db=openProductDatabase(path);
  assert.equal(db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(old.run_id).chat_context_json,null);
  assert.deepEqual(db.prepare('SELECT execution_policy_json,native_session_ref,input_message_id FROM ga_runs WHERE id=?').get(old.run_id),original);
  assert.throws(()=>db.prepare("UPDATE ga_runs SET chat_context_json='{}' WHERE id=?").run(old.run_id),/chat_context_immutable/);
  const chat=new ConversationRepository(db).create('migration-owner',{workspace_id:'ws',mode:'chat',model:{provider:'fixture',model:'work'}},{chatPolicy:policy});
  const accepted=new RunRepository(db,new EventStore(db)).enqueue(chat.conversation_id,'migration-owner',{client_message_id:'new',content:[{type:'text',text:'A new Chat question.'}]},{modePolicy:policy});
  const frozen=db.prepare('SELECT chat_context_json,chat_context_sha256 FROM ga_runs WHERE id=?').get(accepted.run_id);db.close();db=openProductDatabase(path);
  assert.deepEqual(db.prepare('SELECT chat_context_json,chat_context_sha256 FROM ga_runs WHERE id=?').get(accepted.run_id),frozen);
  assert.throws(()=>db.prepare("UPDATE ga_runs SET chat_context_sha256=? WHERE id=?").run('0'.repeat(64),accepted.run_id),/chat_context_immutable/);
  assertReopenedMemberFences(db);
 }finally{db?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
