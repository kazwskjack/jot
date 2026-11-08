import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';

test('reviewed file output publishes after native confirmation, rolls back atomically and downloads its frozen bytes',async t=>{
 const f=await completionFixture(t,{candidate:{text:'Here is the reviewed report.',presented_files:[{path:'report.md'}]},prepare:f=>{
  const proof=withImmediateTransaction(f.db,()=>{
   const written=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Reviewed original',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'report-output','files.write',written);
  });
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Report file',acceptance:'Contains the reviewed report.',status:'completed',evidence:[proof]},f.runId);
 }});
 const card=(await f.list())[0];
 const initial=await f.app.inject({url:`/v1/conversations/${f.occurrence.conversation_id}/snapshot`,headers:{'x-user-id':'alice'}});
 assert.equal(initial.statusCode,200);assert.deepEqual(initial.json().interactions,[card]);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.equal(response.statusCode,202,response.body);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 assert.throws(()=>f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),/task_finalization_unconfirmed/);
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}}));
 const project=f.workbench.contextForRun(f.runId).project_id;
 f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'Later overwritten',expected_version:1});
 const events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 f.db.exec("CREATE TRIGGER file_publish_fault BEFORE INSERT ON wb_task_finalizations BEGIN SELECT RAISE(ABORT,'file_publish_failed'); END");
 assert.throws(()=>f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),/file_publish_failed/);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);
 f.db.exec('DROP TRIGGER file_publish_fault');
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id);
 const outputs=f.artifacts.listForRun(f.runId,'alice').items;assert.equal(outputs.length,1);
 const event=JSON.parse(f.db.prepare("SELECT payload_json FROM ga_events WHERE type='artifact.upsert'").get().payload_json);
 assert.equal(event.media_type,'text/markdown');assert.equal(event.artifact_id,outputs[0].artifact_id);
 assert.equal(event.preview_kind,'text');assert.equal(event.origin,'generated');
 const content=JSON.parse(f.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant'").get().content_json);
 assert.deepEqual(content.attachments,[outputs[0].artifact_id]);assert.equal(content.blocks[0].text,'Here is the reviewed report.');
 const download=await f.app.inject({url:`/v1/artifacts/${outputs[0].artifact_id}/download?version=1`,headers:{'x-user-id':'alice'}});
 assert.equal(download.statusCode,200);assert.equal(download.body,'Reviewed original');
 const finalEvents=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 assert.deepEqual(f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,finalEvents);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,1);
});

test('owner API file opt-in reaches the reviewed exact pin through the worker and synthetic receipts',async t=>{
 const bytes='Reviewed synthetic delivery bytes';let binding;
 const f=await completionFixture(t,{candidate:{text:'The reviewed report is ready.',presented_files:[{path:'report.md'}]},beforeRun:async f=>{
  const channels=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=channels.create('alice','wecom');channels.acceptProof('wecom','task-file-recipient',challenge.code);
  binding=channels.list('alice').items.find(item=>item.channel==='wecom'&&item.status==='verified');
  const saved=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${f.task.task_id}/notifications`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'task-file-consent'},payload:{expected_version:0,channel_binding_ids:[binding.channel_binding_id],artifact_delivery_binding_ids:[binding.channel_binding_id]}});
  assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().artifact_delivery_binding_ids,[binding.channel_binding_id]);
 },prepare:f=>{
  const project=f.workbench.contextForRun(f.runId).project_id;
  const written=f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:bytes,expected_version:0},f.runId);
  const proof=withImmediateTransaction(f.db,()=>new TaskExecutionEvidence(f.db).record(f.runId,'report-output','files.write',written));
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Report file',acceptance:'Contains the reviewed report.',status:'completed',evidence:[proof]},f.runId);
 }});
 const card=(await f.list())[0],accepted=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});assert.equal(accepted.statusCode,202,accepted.body);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}},intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}}));
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),message=JSON.parse(f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(receipt.message_id).content_json);
 const outputs=f.artifacts.listForRun(f.runId,'alice').items;assert.equal(outputs.length,1);assert.deepEqual(message.attachments,[outputs[0].artifact_id]);
 const fileRows=f.db.prepare("SELECT * FROM ga_channel_deliveries WHERE run_id=? AND json_extract(payload_json,'$.kind')='artifact'").all(f.runId);assert.equal(fileRows.length,1);
 const pinned=JSON.parse(fileRows[0].payload_json);assert.equal(pinned.artifact_id,outputs[0].artifact_id);assert.equal(pinned.version,outputs[0].version);
 assert.deepEqual({...f.db.prepare('SELECT owner_id,task_id,channel_binding_id,binding_version,settings_version FROM wb_task_notification_grants WHERE effect_id=?').get(fileRows[0].effect_id)},{owner_id:'alice',task_id:f.task.task_id,channel_binding_id:binding.channel_binding_id,binding_version:binding.version,settings_version:1});
 let now=Math.floor(Date.now()/1000);const store=new ChannelDeliveryService(f.db,()=>now),sentFiles=[],sentTexts=[];let runtimeReceipts=0;
 const worker=new ChannelDeliveryWorker(store,{providers:{wecom:{send:async(text,recipient)=>{sentTexts.push({text,recipient});return{provider_message_id:'synthetic-task-text'};},sendFile:async(path,recipient,displayName)=>{sentFiles.push({bytes:readFileSync(path,'utf8'),recipient,displayName});return{provider_message_id:'synthetic-task-file'};}}}},{registerDeliveryReceipt:async()=>{runtimeReceipts++;return{ok:true};}},{artifacts:f.artifacts,cleanupArtifact:pin=>f.artifacts.markPinnedDeliveredAndDelete(pin.run_id,pin),resolveRuntime:clientRunId=>({runtimeRunId:'synthetic-runtime-'+clientRunId,clientRunId})});
 for(let count=0;count<4;count++){if(!await worker.processNext())now+=60;}
 assert.equal(sentTexts.length,1);assert.equal(sentTexts[0].text,'The reviewed report is ready.');assert.equal(sentFiles.length,1);assert.deepEqual(sentFiles[0],{bytes,recipient:'task-file-recipient',displayName:'report.md'});assert.equal(runtimeReceipts,1);
 assert.equal(store.get(fileRows[0].effect_id).status,'delivered');assert.equal(f.artifacts.get(outputs[0].artifact_id,'alice',outputs[0].version).status,'delivered');
});

test('a selected WeCom text channel without file opt-in keeps reviewed files in app only',async t=>{
 let binding;
 const f=await completionFixture(t,{candidate:{text:'The report is ready.',presented_files:[{path:'report.md'}]},beforeRun:async f=>{
  const channels=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=channels.create('alice','wecom');channels.acceptProof('wecom','task-text-only-recipient',challenge.code);
  binding=channels.list('alice').items.find(item=>item.channel==='wecom'&&item.status==='verified');
  const saved=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${f.task.task_id}/notifications`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'task-text-only'},payload:{expected_version:0,channel_binding_ids:[binding.channel_binding_id],events:['completed']}});
  assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().artifact_delivery_binding_ids,[]);
 },prepare:f=>{
  const project=f.workbench.contextForRun(f.runId).project_id,written=f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'App only file bytes',expected_version:0},f.runId);
  const proof=withImmediateTransaction(f.db,()=>new TaskExecutionEvidence(f.db).record(f.runId,'report-output','files.write',written));
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Report file',acceptance:'Contains the reviewed report.',status:'completed',evidence:[proof]},f.runId);
 }});
 const card=(await f.list())[0],accepted=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});assert.equal(accepted.statusCode,202,accepted.body);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}},intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'c'.repeat(64)}}));
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),outputs=f.artifacts.listForRun(f.runId,'alice').items;assert.equal(outputs.length,1);
 assert.deepEqual(JSON.parse(f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(receipt.message_id).content_json).attachments,[outputs[0].artifact_id]);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_channel_deliveries WHERE run_id=? AND json_extract(payload_json,'$.kind')='artifact'").get(f.runId).n,0);
 let now=Math.floor(Date.now()/1000);const store=new ChannelDeliveryService(f.db,()=>now),sentTexts=[],sentFiles=[];
 const worker=new ChannelDeliveryWorker(store,{providers:{wecom:{send:async(text,recipient)=>{sentTexts.push({text,recipient});return{provider_message_id:'synthetic-text-only'};},sendFile:async(path,recipient,displayName)=>{sentFiles.push({path,recipient,displayName});return{provider_message_id:'unexpected-file'};}}}},{registerDeliveryReceipt:async()=>({ok:true})},{artifacts:f.artifacts,cleanupArtifact:pin=>f.artifacts.markPinnedDeliveredAndDelete(pin.run_id,pin),resolveRuntime:clientRunId=>({runtimeRunId:'synthetic-runtime-'+clientRunId,clientRunId})});
 assert.equal(await worker.processNext(),true);assert.equal(await worker.processNext(),false);assert.deepEqual(sentTexts,[{text:'The report is ready.',recipient:'task-text-only-recipient'}]);assert.deepEqual(sentFiles,[]);
});

async function reviewedFileRecoveryFixture(t,key){
 let binding;
 const headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':key};
 const f=await completionFixture(t,{candidate:{text:'The recovery report is ready.',presented_files:[{path:'report.md'}]},beforeRun:async f=>{
  const channels=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=channels.create('alice','wecom');channels.acceptProof('wecom','task-recovery-recipient',challenge.code);
  binding=channels.list('alice').items.find(item=>item.channel==='wecom'&&item.status==='verified');
  const saved=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${f.task.task_id}/notifications`,headers,payload:{expected_version:0,channel_binding_ids:[binding.channel_binding_id],artifact_delivery_binding_ids:[binding.channel_binding_id]}});
  assert.equal(saved.statusCode,200,saved.body);
 },prepare:f=>{
  const written=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Reviewed receipt recovery bytes',expected_version:0},f.runId);
  const proof=withImmediateTransaction(f.db,()=>new TaskExecutionEvidence(f.db).record(f.runId,'recovery-output','files.write',written));
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Recovery file',acceptance:'Contains the reviewed recovery bytes.',status:'completed',evidence:[proof]},f.runId);
 }});
 const card=(await f.list())[0],accepted=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});assert.equal(accepted.statusCode,202,accepted.body);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}},intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'d'.repeat(64)}}));
 f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id);
 const effect=f.db.prepare("SELECT * FROM ga_channel_deliveries WHERE run_id=? AND json_extract(payload_json,'$.kind')='artifact'").get(f.runId);assert.ok(effect);
 const pin=JSON.parse(effect.payload_json);assert.equal(pin.version,1);
 // A synthetic later immutable version must not inherit v1's accepted receipt.
 f.db.prepare(`INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at)
  SELECT artifact_id,2,server_path,sha256,size_bytes,mime_type,json_set(metadata_json,'$.status','ready'),created_at
  FROM ga_artifact_versions WHERE artifact_id=? AND version=1`).run(pin.artifact_id);
 return{f,binding,headers,effect,pin};
}

for(const scenario of [
 {name:'binding revocation',failure:'runtime',revoke:async({f,binding})=>new OwnerChannelBindings(f.db).revoke('alice',binding.channel_binding_id,binding.version)},
 {name:'notification settings change',failure:'cleanup',revoke:async({f,binding,headers})=>{const response=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${f.task.task_id}/notifications`,headers:{...headers,'idempotency-key':'recovery-disable-file'},payload:{expected_version:1,channel_binding_ids:[binding.channel_binding_id],artifact_delivery_binding_ids:[]}});assert.equal(response.statusCode,200,response.body);}},
 {name:'task pause',failure:'runtime',revoke:async({f,headers})=>{const task=f.persistentTasks.get('alice',f.task.task_id),response=await f.app.inject({method:'POST',url:`/v1/persistent-tasks/${f.task.task_id}/pause`,headers:{...headers,'idempotency-key':'recovery-pause-task'},payload:{expected_version:task.version}});assert.equal(response.statusCode,200,response.body);}},
])test(`accepted pinned task receipt survives ${scenario.name} and recovers only exact v1 cleanup`,async t=>{
 const context=await reviewedFileRecoveryFixture(t,'file-recovery-'+scenario.name.replaceAll(' ','-')),{f,effect,pin}=context;
 let now=Math.floor(Date.now()/1000),fileSends=0,runtimeCalls=0,cleanups=0;
 const store=new ChannelDeliveryService(f.db,()=>now),worker=new ChannelDeliveryWorker(store,{providers:{wecom:{send:async()=>({provider_message_id:'synthetic-recovery-text'}),sendFile:async path=>{assert.equal(readFileSync(path,'utf8'),'Reviewed receipt recovery bytes');fileSends++;return{provider_message_id:'synthetic-recovery-file'};}}}},
  {registerDeliveryReceipt:async()=>{runtimeCalls++;return{ok:scenario.failure!=='runtime'||runtimeCalls>1};}},
  {artifacts:f.artifacts,resolveRuntime:clientRunId=>({runtimeRunId:'synthetic-runtime-'+clientRunId,clientRunId}),cleanupArtifact:pin=>{cleanups++;if(scenario.failure==='cleanup'&&cleanups===1)throw Error('synthetic_cleanup_retry');return f.artifacts.markPinnedDeliveredAndDelete(pin.run_id,pin);}});
 for(let count=0;count<6&&runtimeCalls===0;count++){if(!await worker.processNext())now+=60;}
 const accepted=store.get(effect.effect_id);assert.equal(accepted.status,'receipt_pending');assert.equal(fileSends,1);assert.ok(JSON.parse(accepted.provider_receipt_json).provider_message_id);
 await scenario.revoke(context);
 for(let count=0;count<4&&store.get(effect.effect_id).status!=='delivered';count++)await worker.processNext();
 const recovered=store.get(effect.effect_id);assert.equal(recovered.status,'delivered');assert.equal(recovered.provider_receipt_json,accepted.provider_receipt_json);assert.equal(fileSends,1);assert.equal(runtimeCalls,2);assert.equal(cleanups,scenario.failure==='cleanup'?2:1);
 const versions=f.db.prepare("SELECT version,json_extract(metadata_json,'$.status') AS status FROM ga_artifact_versions WHERE artifact_id=? ORDER BY version").all(pin.artifact_id);
 assert.deepEqual(versions.map(row=>[row.version,row.status]),[[1,'delivered'],[2,'ready']]);
});

