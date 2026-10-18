import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {OrdinaryFinalPublisher} from '../../src/harness/ordinary-final-publication.ts';
import {canonicalModelJson} from '../../src/conversations/model-policy.ts';
import {createHash} from 'node:crypto';
import {RunCommandService} from '../../src/runs/commands.ts';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {inspectOrdinaryModelPolicy,bindOrdinaryModelResolution} from '../../src/conversations/model-policy.ts';
const impl=await import('../../src/conversations/chat-compaction-source.ts').catch(()=>({}));
const policy={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'};
function fixture(t,{work=false,path=':memory:'}={}){
 assert.equal(typeof impl.inspectChatCompactionSource,'function','completion-bound Chat maintenance source is not implemented');
 const db=openProductDatabase(path);t.after(()=>{if(db.isOpen)db.close();});const events=new EventStore(db),conversations=new ConversationRepository(db),runs=new RunRepository(db,events);
 const c=conversations.create('compact-owner',{workspace_id:'ws',model:{provider:'fixture',model:work?'work':'fast'},...(work?{}:{mode:'chat'})},work?{}:{chatPolicy:policy});
 if(work)new SessionBindingRepository(db).getOrCreate('compact-owner',c.conversation_id);
 const run=runs.enqueue(c.conversation_id,'compact-owner',{client_message_id:'compact-input',content:[{type:'text',text:'Synthetic compaction question.'}]},work?{}:{modePolicy:policy}),coordinator=new HarnessCoordinator(db,runs,events),lease=coordinator.claimNext('compact-worker',30000);coordinator.start(lease);
 const native=db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(run.run_id).native_session_ref,model=inspectOrdinaryModelPolicy(db,run.run_id,native,{owner:lease.owner,generation:lease.generation});
 bindOrdinaryModelResolution(db,run.run_id,native,{owner:lease.owner,generation:lease.generation},model.policy_sha256,{provider:'fixture',model:work?'work':'fast',reasoning_effort:'off'});
 const scope=()=>({owner_id:'compact-owner',conversation_id:c.conversation_id,run_id:run.run_id,session_ref:native,expected_run_version:runs.get(run.run_id,'compact-owner').version});
 const publish=()=>{coordinator.recordCandidate(lease,'Synthetic committed answer.');coordinator.setCandidateStatus(lease,'verified',[]);coordinator.recordAssistant(lease,'Synthetic committed answer.');coordinator.finalizePublication(lease,'succeeded',null);};
 return{db,runs,events,coordinator,c,run,lease,scope,publish,inspect:()=>impl.inspectChatCompactionSource(db,scope())};
}
test('maintenance source exists only after the original Chat answer and foreground lease have committed',t=>{
 const f=fixture(t);assert.throws(f.inspect);f.publish();const before=f.db.prepare('SELECT total_changes() n').get().n,source=f.inspect();
 assert.equal(source.kind,'chat_compaction_source');assert.equal(source.run_id,f.run.run_id);assert.equal(source.session_id,f.scope().session_ref);assert.equal(source.execution_authorized,false);assert.equal(source.policy.mode,'chat');assert.equal(source.model.reasoning_effort,'off');assert.match(source.answer_content_sha256,/^[a-f0-9]{64}$/);assert.match(source.history_sha256,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(source).includes('Synthetic compaction question.'));assert.ok(!JSON.stringify(source).includes('Synthetic committed answer.'));
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(f.run.run_id).n,0);
});

test('native maintenance evidence must match the original committed answer and source, without writes or authority',t=>{
 const f=fixture(t);f.publish();assert.equal(typeof impl.inspectChatCompactionNative,'function');const scope=f.scope(),source=f.inspect(),digest=v=>createHash('sha256').update(canonicalModelJson(v)).digest('hex');
 const proof={protocol:1,kind:'ordinary_run_completion',run_id:scope.run_id,session_id:scope.session_ref,run_version:scope.expected_run_version,source_sha256:source.history_sha256,raw_sha256:'a'.repeat(64),raw_event_count:8,profile_fingerprint:'b'.repeat(64),command_ids:[],native_message_ids:['original-native'],answer_sha256:createHash('sha256').update('Synthetic committed answer.').digest('hex'),answer_seq:5,turn_end_seq:7,answer_event:{seq:5,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'text',text:'Synthetic committed answer.'}]}}},output_events:[],execution_authorized:false};
 const witness={protocol:1,kind:'chat_compaction_native_witness',run_id:proof.run_id,run_version:proof.run_version,session_id:proof.session_id,history_sha256:proof.source_sha256,proof_sha256:digest(proof),raw_sha256:proof.raw_sha256,raw_event_count:proof.raw_event_count,profile_fingerprint:proof.profile_fingerprint,command_ids_sha256:digest(proof.command_ids),native_message_ids_sha256:digest(proof.native_message_ids),native_message_count:proof.native_message_ids.length,answer_sha256:proof.answer_sha256,answer_seq:proof.answer_seq,turn_end_seq:proof.turn_end_seq,execution_authorized:false};
 const before=f.db.prepare('SELECT total_changes() n').get().n,result=impl.inspectChatCompactionNative(f.db,scope,digest(source),witness);
 assert.equal(result.kind,'chat_compaction_native');assert.equal(result.execution_authorized,false);assert.equal(result.source_sha256,digest(source));assert.equal(result.proof_sha256,digest(proof));assert.ok(!JSON.stringify(result).includes('Synthetic committed answer.'));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 for(const change of [p=>p.session_id='foreign',p=>p.answer_sha256='c'.repeat(64),p=>p.history_sha256='d'.repeat(64),p=>p.command_ids_sha256='e'.repeat(64),p=>p.native_message_count++,p=>p.answer_event=proof.answer_event]){const p=structuredClone(witness);change(p);assert.throws(()=>impl.inspectChatCompactionNative(f.db,scope,digest(source),p));}
 assert.throws(()=>impl.inspectChatCompactionNative(f.db,scope,'d'.repeat(64),witness));
});
test('one immutable intent reuses the exact completed source without creating a run, answer or event',t=>{
 const f=fixture(t);f.publish();assert.equal(typeof impl.prepareChatCompactionIntent,'function');const counts=()=>['ga_runs','ga_messages','ga_events','ga_outbox','ga_worker_leases'].map(table=>f.db.prepare('SELECT count(*) n FROM '+table).get().n),before=counts();
 const intent=impl.prepareChatCompactionIntent(f.db,f.scope());assert.equal(intent.execution_authorized,false);assert.equal(intent.source.kind,'chat_compaction_source');assert.equal(intent.run_id,f.run.run_id);assert.deepEqual(impl.prepareChatCompactionIntent(f.db,f.scope()),intent);assert.deepEqual(impl.readChatCompactionIntent(f.db,f.scope(),intent.intent_id),intent);assert.deepEqual(counts(),before);
 assert.throws(()=>f.db.prepare("UPDATE ga_chat_compaction_intents SET source_json='{}'").run(),/chat_compaction_intent_immutable/);
});
test('a newly accepted input revokes maintenance eligibility but preserves its frozen source for later accounting',t=>{
 const f=fixture(t);f.publish();const intent=impl.prepareChatCompactionIntent(f.db,f.scope()),row=f.db.prepare('SELECT * FROM ga_chat_compaction_intents').get();
 f.runs.enqueue(f.c.conversation_id,'compact-owner',{client_message_id:'next-question',content:[{type:'text',text:'New foreground input.'}]},{modePolicy:policy});assert.throws(f.inspect);assert.throws(()=>impl.readChatCompactionIntent(f.db,f.scope(),intent.intent_id));assert.deepEqual(f.db.prepare('SELECT * FROM ga_chat_compaction_intents').get(),row);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_intents').get().n,1);
});
test('Work, foreign owner/Session, stale versions and changed final answer cannot supply a maintenance source',t=>{
 const work=fixture(t,{work:true});work.publish();assert.throws(work.inspect);
 const f=fixture(t);f.publish();for(const scope of [{...f.scope(),owner_id:'foreign-owner'},{...f.scope(),session_ref:'foreign-session'},{...f.scope(),expected_run_version:f.scope().expected_run_version-1}])assert.throws(()=>impl.inspectChatCompactionSource(f.db,scope));
 const intent=impl.prepareChatCompactionIntent(f.db,f.scope());f.db.prepare("UPDATE ga_messages SET content_json=? WHERE run_id=? AND role='assistant'").run(JSON.stringify({blocks:[{kind:'text',text:'Changed answer.'}],attachments:[]}),f.run.run_id);assert.throws(()=>impl.readChatCompactionIntent(f.db,f.scope(),intent.intent_id));
});
test('an original reconciled Chat answer retains its interrupted execution status and supplies only its verified publication source',async t=>{
 const f=fixture(t),digest=value=>createHash('sha256').update(canonicalModelJson(value)).digest('hex');f.coordinator.interruptWithoutRuntime(f.lease,'synthetic interruption');
 const text='Synthetic reconciled answer.',answer={seq:2,type:'assistant/message',data:{turn:1,step:1,message:{id:'native-answer',role:'assistant',content:[{type:'text',text}]}}};
 const publisher=new OrdinaryFinalPublisher(f.db,f.events,{observeRunCompletion:async(session,scope,source)=>({protocol:1,kind:'ordinary_run_completion',run_id:scope.run_id,session_id:session,run_version:scope.expected_run_version,source_sha256:digest(source),raw_sha256:'d'.repeat(64),raw_event_count:5,profile_fingerprint:'e'.repeat(64),command_ids:[],native_message_ids:['original-native'],answer_sha256:createHash('sha256').update(text).digest('hex'),answer_seq:2,turn_end_seq:4,answer_event:answer,output_events:[],execution_authorized:false})});
 assert.equal(await publisher.reconcile(f.run.run_id,f.scope().session_ref),true);assert.equal(f.runs.get(f.run.run_id,'compact-owner').status,'interrupted');
 const source=f.inspect();assert.match(source.historical_publication_sha256,/^[a-f0-9]{64}$/);assert.equal(source.execution_authorized,false);
});
test('a completed row cannot hide an unapplied supplemental input from maintenance source checks',t=>{
 const f=fixture(t);new RunCommandService(f.db,f.events).steer(f.run.run_id,'compact-owner',{text:'Unapplied synthetic supplement.',client_message_id:'late-supplement',expected_run_version:f.scope().expected_run_version},'late-supplement');f.publish();assert.throws(f.inspect);
});
test('an expired original lease is historical evidence, not reusable execution authority; a live lease still blocks maintenance',t=>{
 const f=fixture(t);f.publish();f.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,expires_at,generation,updated_at) VALUES(?,?,?,?,?)').run(f.run.run_id,'old-compact-worker',String(Date.now()-1),1,new Date().toISOString());
 assert.equal(f.inspect().execution_authorized,false);assert.equal(impl.prepareChatCompactionIntent(f.db,f.scope()).execution_authorized,false);
 f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()+30000),f.run.run_id);assert.throws(f.inspect);
});
for(const legacy of [false,true])test(legacy?'legacy database migration creates no maintenance intent automatically':'an immutable maintenance intent survives closing all database connections and reopening',t=>{
 const base=resolve('.test-tmp/chat-compaction-source');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'product.db');let reopened;
 try{
  const f=fixture(t,{path});assert.equal(f.db.isOpen,true);f.publish();const scope=f.scope(),source=f.inspect(),intent=legacy?undefined:impl.prepareChatCompactionIntent(f.db,scope);
  if(legacy)f.db.exec('DROP TABLE ga_chat_compaction_intents');f.db.close();assert.equal(f.db.isOpen,false);reopened=openProductDatabase(path);
  assert.deepEqual(impl.inspectChatCompactionSource(reopened,scope),source);
  if(legacy){assert.equal(reopened.prepare('SELECT count(*) n FROM ga_chat_compaction_intents').get().n,0);assert.equal(impl.prepareChatCompactionIntent(reopened,scope).execution_authorized,false);}
  else{assert.deepEqual(impl.readChatCompactionIntent(reopened,scope,intent.intent_id),intent);assert.deepEqual(impl.prepareChatCompactionIntent(reopened,scope),intent);assert.throws(()=>reopened.prepare("UPDATE ga_chat_compaction_intents SET source_sha256=?").run('f'.repeat(64)),/chat_compaction_intent_immutable/);}
 }finally{reopened?.close();const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
test('a legacy current-conversation fallback cannot replace the original run native identity for maintenance',t=>{
 const f=fixture(t);f.publish();const scope=f.scope(),trigger=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='ga_run_native_session_immutable'").get();
 assert.throws(()=>f.db.prepare('UPDATE ga_runs SET native_session_ref=NULL WHERE id=?').run(f.run.run_id),/run_native_session_immutable/);
 // Simulate a legacy row in this isolated test database. Restore the real
 // trigger before reading; never weaken a running Host's admission policy.
 f.db.exec('DROP TRIGGER ga_run_native_session_immutable');try{f.db.prepare('UPDATE ga_runs SET native_session_ref=NULL,native_owner_id=NULL,native_conversation_id=NULL WHERE id=?').run(f.run.run_id);}finally{f.db.exec(trigger.sql);}
 f.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(scope.conversation_id,scope.owner_id,scope.session_ref,'now','now');
 assert.equal(f.db.prepare('SELECT session_id FROM ga_run_native_sessions WHERE run_id=?').get(f.run.run_id).session_id,scope.session_ref);assert.throws(f.inspect);
});
