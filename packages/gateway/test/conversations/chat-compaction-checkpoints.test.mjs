import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {completedChatFixture} from '../support/chat-maintenance-fixture.mjs';
import {settledCheckpointFixture as fixture} from '../support/chat-checkpoint-fixture.mjs';
import {openProductDatabase} from '../../src/db/database.ts';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
const impl=await import('../../src/conversations/chat-compaction-checkpoints.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
test('a settled native checkpoint is immutable, owner-bound and frozen into the next v2 acceptance without a new answer',t=>{
 assert.equal(typeof impl.ChatCompactionCheckpoints,'function');const f=fixture(t),store=new impl.ChatCompactionCheckpoints(f.db),before=f.db.prepare('SELECT count(*) n FROM ga_messages').get().n;
 const receipt=store.publish(f.scope,f.input);assert.equal(receipt.execution_authorized,false);assert.deepEqual(store.publish(f.scope,f.input),receipt);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,before);
 const next=f.newInput(),row=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(next.run_id),snapshot=JSON.parse(row.chat_context_json);assert.equal(snapshot.algorithm,'checkpoint-text-v2');assert.equal(snapshot.checkpoint.checkpoint_id,receipt.checkpoint_id);assert.equal(snapshot.checkpoint.summary_text,f.text);assert.ok(snapshot.model_text.includes(f.text));assert.deepEqual(snapshot.messages,[]);assert.ok(snapshot.model_text.length<=14000);
 assert.deepEqual(store.publish(f.scope,f.input),receipt,'exact already-persisted retry survives newer input');
 assert.throws(()=>f.db.prepare("UPDATE ga_chat_compaction_checkpoints SET checkpoint_json='{}'").run(),/immutable/);
});
test('new publication refuses newer input, foreign scopes, invalid native evidence and unconfirmed usage',t=>{
 for(const mode of ['new','owner','range','generation','text','usage','source','command','unknown','unsettled']){const f=fixture(t,{settled:mode!=='unsettled'}),store=new impl.ChatCompactionCheckpoints(f.db);if(mode==='new')f.newInput();if(mode==='owner')f.scope.owner_id='foreign';if(mode==='range')f.witness.shadowed_end=4;if(mode==='generation')f.witness.surface_generation_after=1;if(mode==='text')f.input.summary_text+=' changed';if(mode==='usage')f.witness.usage.outputTokens=2;if(mode==='source')f.input.source_sha256='0'.repeat(64);if(mode==='command')f.witness.source_command_id='foreign';if(mode==='unknown')f.input.attempt_id='other-attempt';assert.throws(()=>store.publish(f.scope,f.input),undefined,mode);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,0);}
});
test('changed covered text re-enters the recent seed while prior v1 callers retain their original format',t=>{
 const f=fixture(t),store=new impl.ChatCompactionCheckpoints(f.db);store.publish(f.scope,f.input);f.db.prepare('UPDATE ga_messages SET content_json=?,updated_at=? WHERE id=?').run(JSON.stringify({blocks:[{kind:'text',text:'UPDATED-SOURCE-TEXT'}],attachments:[]}),'updated',f.intent.source.answer_message_id);
 const next=f.newInput(),snapshot=JSON.parse(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.run_id).chat_context_json);assert.ok(snapshot.model_text.includes('UPDATED-SOURCE-TEXT'));assert.ok(snapshot.model_text.includes(f.text));
 const old=completedChatFixture(t);const original=JSON.parse(old.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(old.scope.run_id).chat_context_json);assert.equal(original.algorithm,'recent-text-v1');assert.equal(Object.hasOwn(original,'checkpoint'),false);
});

test('checkpoint text and recent excerpts share one total bound and acceptance retries retain the exact seed',t=>{
 const f=fixture(t);f.input.summary_text='"\\\n'.repeat(2000);f.witness.summary_text_sha256=createHash('sha256').update(f.input.summary_text).digest('hex');new impl.ChatCompactionCheckpoints(f.db).publish(f.scope,f.input);
 for(let i=0;i<12;i++)f.db.prepare('INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('later-'+i,f.scope.conversation_id,i%2?'assistant':'user','complete',JSON.stringify({blocks:[{kind:'text',text:'x'.repeat(4000)}],attachments:[]}),'zz-'+i,'zz-'+i);
 const next=f.newInput(),row=f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.run_id),snapshot=JSON.parse(row.chat_context_json);assert.ok(snapshot.model_text.length<=14000);assert.equal(snapshot.checkpoint.summary_text,f.input.summary_text);assert.ok(snapshot.messages.length<12);assert.deepEqual(f.newInput(),next);assert.equal(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.run_id).chat_context_json,row.chat_context_json);
});

test('disk reopen preserves checkpoint receipts and frozen acceptance; an empty migration invents no checkpoint',t=>{
 const base=resolve('.test-tmp/chat-checkpoint-migration');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let db;
 try{db=openProductDatabase(path);const f=fixture(t,{db}),receipt=new impl.ChatCompactionCheckpoints(db).publish(f.scope,f.input),next=f.newInput(),snapshot=db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.run_id);db.close();db=openProductDatabase(path);
  assert.deepEqual(new impl.ChatCompactionCheckpoints(db).publish(f.scope,f.input),receipt);assert.deepEqual(new impl.ChatCompactionCheckpoints(db).read(f.scope,f.binding),receipt);assert.deepEqual(db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.run_id),snapshot);db.exec('DROP TABLE ga_chat_compaction_checkpoints');db.close();db=openProductDatabase(path);assert.equal(db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);
 }finally{db?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});

test('v2 native witnesses bind surface positions rather than numeric intervals and preserve retained answers',t=>{
 for(const answerCovered of [true,false]){const f=fixture(t);Object.assign(f.witness,{protocol:2,shadowed_start:6,shadowed_end:2,surface_node_count:answerCovered?5:6,shadowed_start_position:1,shadowed_end_position:4,context_marker_position:2,answer_position:answerCovered?3:5,answer_covered:answerCovered});
  const store=new impl.ChatCompactionCheckpoints(f.db),receipt=store.publish(f.scope,f.input);assert.deepEqual(store.publish(f.scope,f.input),receipt);
  const next=f.newInput(),context=JSON.parse(f.db.prepare('SELECT chat_context_json FROM ga_runs WHERE id=?').get(next.run_id).chat_context_json);assert.equal(context.messages.some(m=>m.message_id===f.intent.source.answer_message_id),!answerCovered);
 }
 for(const mode of ['size','span','marker','answer','bound','extra','marker-seq','answer-seq','same-position']){const f=fixture(t);Object.assign(f.witness,{protocol:2,surface_node_count:5,shadowed_start_position:1,shadowed_end_position:4,context_marker_position:1,answer_position:3});if(mode==='size')f.witness.surface_node_count=9;if(mode==='span')f.witness.shadowed_end_position=3;if(mode==='marker')f.witness.context_marker_position=0;if(mode==='answer')f.witness.answer_position=0;if(mode==='bound')f.witness.shadowed_start=8;if(mode==='extra')f.witness.authorization=true;if(mode==='marker-seq')f.witness.context_marker_position=2;if(mode==='answer-seq')f.witness.answer_position=4;if(mode==='same-position')f.witness.context_marker_position=3;assert.throws(()=>new impl.ChatCompactionCheckpoints(f.db).publish(f.scope,f.input),undefined,mode);}
});

test('historical checkpoint reads recover only the exact original receipt after newer input without renewing authority',t=>{
 const f=fixture(t),store=new impl.ChatCompactionCheckpoints(f.db);assert.equal(typeof store.read,'function');assert.equal(store.read(f.scope,f.binding),null);
 const receipt=store.publish(f.scope,f.input);f.newInput();const changes=f.db.prepare('SELECT total_changes() n').get().n;assert.deepEqual(store.read(f.scope,f.binding),receipt);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(Object.hasOwn(store.read(f.scope,f.binding),'summary_text'),false);
 assert.throws(()=>store.read({...f.scope,owner_id:'foreign'},f.binding));for(const field of ['intent_id','attempt_id','observer_id','fence_id'])assert.throws(()=>store.read(f.scope,{...f.binding,[field]:'foreign'}),undefined,field);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_checkpoints').get().n,1);
});
