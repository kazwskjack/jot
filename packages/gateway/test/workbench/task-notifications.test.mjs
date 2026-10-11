import test from 'node:test';import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';
const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
const after={host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}};
async function setup(t,policy,events,channel='wecom'){let settings,binding;
 // Enqueue-time policy and the controlled worker clock must share the same date.
 // Otherwise a calendar rollover makes an older worker clock precede the real quiet deferral.
 if(policy?.quiet_hours)t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T10:00:00Z')});
 const f=await completionFixture(t,{beforeRun:async f=>{
  const {TaskNotifications}=await import('../../src/persistent-tasks/notifications.ts');settings=new TaskNotifications(f.db);
  const channels=new OwnerChannelBindings(f.db,{enabled:['wecom']});
  if(channel==='email'){const {EmailChannelBindings}=await import('../../src/channels/email-bindings.ts');let code;const email=new EmailChannelBindings(f.db,{send:async text=>{code=text.match(/[A-Za-z0-9_-]{43}/)[0];return {provider_message_id:'accepted'};}});const challenge=await email.begin('alice','task@example.test','task-email-create');email.confirm('alice',challenge.channel_binding_id,code);}else{const challenge=channels.create('alice','wecom');channels.acceptProof('wecom','task-recipient',challenge.code);}binding=channels.list('alice').items[0];
  settings.update('alice',f.task.task_id,{expected_version:0,channel_binding_ids:[binding.channel_binding_id],...(policy?{delivery_policy:policy}:{}),...(events?{events}:{})});
  f.db.prepare('UPDATE wb_persistent_tasks SET max_runs=1 WHERE task_id=?').run(f.task.task_id);
 }});
 const card=(await f.list())[0];const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});assert.equal(response.statusCode,202,response.body);
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after));
 return {...f,settings,binding,intent};
}

test('reviewed completion follows the verified email channel and retains revoke-before-send protection',async t=>{
 const f=await setup(t,undefined,undefined,'email'),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id),store=new ChannelDeliveryService(f.db);
 assert.equal(store.get(receipt.delivery_effect_ids[0]).destination,'email');
 new OwnerChannelBindings(f.db).revoke('alice',f.binding.channel_binding_id,1);
 let sends=0;const worker=new ChannelDeliveryWorker(store,{providers:{email:{send:async()=>{sends++;return {provider_message_id:'unexpected'};},sendFile:async()=>{throw new Error('unused');}}}},{registerDeliveryReceipt:async()=>{throw new Error('unused');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('unused');}});
 await worker.processNext();assert.equal(sends,0);assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'cancelled');
});
test('an explicitly configured verified owner channel produces one notification and owner-scoped delivery status',async t=>{
 const f=await setup(t);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_bindings').get().n,0);
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);assert.equal(receipt.delivery_effect_ids.length,1);
 assert.deepEqual(f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id),receipt);
 let sent=0;const store=new ChannelDeliveryService(f.db),worker=new ChannelDeliveryWorker(store,{send:async(text,principal)=>{sent++;assert.equal(principal,'task-recipient');return {provider_message_id:'fixture-notification'};},sendFile:async()=>{throw new Error('unused');}},{registerDeliveryReceipt:async()=>{throw new Error('unused');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('unused');}});
 await worker.processNext();assert.equal(sent,1);assert.equal(f.settings.deliveries('alice',f.task.task_id,f.occurrence.occurrence_id).items[0].status,'delivered');
 assert.throws(()=>f.settings.deliveries('bob',f.task.task_id,f.occurrence.occurrence_id),/task_not_found/);
 assert.ok(!JSON.stringify(f.settings.deliveries('alice',f.task.task_id,f.occurrence.occurrence_id)).includes('task-recipient'));
});
test('turning off completed notifications keeps the reviewed final result but does not enqueue a completion message',async t=>{
 const f=await setup(t,undefined,['failed']),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);
 assert.deepEqual(receipt.delivery_effect_ids,[]);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
});

test('quiet hours defer the same outbox effect across worker restart and recheck revocation before sending',async t=>{
 // Enqueue and provider fences use the same controlled date. A real calendar
 // rollover must not enqueue a quiet deferral later than this worker's clock.
 const policy={min_interval_seconds:60,max_per_24_hours:20,quiet_hours:{start:'22:00',end:'08:00',timezone:'Asia/Hong_Kong'}};
 const f=await setup(t,policy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_deferrals').get().n,0);
 let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 let store=new ChannelDeliveryService(f.db,()=>now),item=store.claim('first',90);
 assert.equal(store.authorizeSend(item.effect_id,item.generation),false);
 assert.equal(store.get(item.effect_id).status,'pending');assert.equal(store.get(item.effect_id).last_reason_code,'TASK_NOTIFICATION_QUIET_HOURS');
 assert.equal(store.claim('first',90),null);
 store=new ChannelDeliveryService(f.db,()=>now);assert.equal(store.claim('restarted',90),null);
 new OwnerChannelBindings(f.db).revoke('alice',f.binding.channel_binding_id,1);
 now=Date.parse('2026-10-04T00:00:00Z')/1000;item=store.claim('restarted',90);assert.ok(item);
 assert.equal(store.authorizeSend(item.effect_id,item.generation),false);assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'cancelled');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});

test('task send reservations persist and an ambiguous send consumes the recipient quota',async t=>{
 const f=await setup(t,{min_interval_seconds:60,max_per_24_hours:1,quiet_hours:null});
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.now()/1000|0;
 const store=new ChannelDeliveryService(f.db,()=>now),first=store.claim('first',90);assert.equal(store.authorizeSend(first.effect_id,first.generation),true);
 // Per-file rechecks of the same effect must not consume quota again.
 assert.equal(store.authorizeSend(first.effect_id,first.generation),true);store.recordProviderUnknown(first.effect_id,first.generation);
 const source=f.db.prepare('SELECT * FROM wb_task_delivery_authorizations WHERE effect_id=?').get(first.effect_id);
 let second;withImmediateTransaction(f.db,()=>{
  second=store.enqueueText({runId:f.runId,messageId:String(store.get(first.effect_id).message_id),destination:'wecom',recipient:'task-recipient',text:'Another authorized result'});
  store.bindTaskAuthorization(second.effect_id,source,source.conversation_id,source.principal);
  f.settings.grant(second.effect_id,'alice',f.task.task_id,f.settings.targets('alice',f.task.task_id)[0]);
 });
 const item=store.claim('second',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),false);assert.equal(store.get(item.effect_id).last_reason_code,'TASK_NOTIFICATION_RATE_LIMIT');
 assert.equal(new ChannelDeliveryService(f.db,()=>now).claim('restart',90),null);
 now+=86400;const later=store.claim('later',90);assert.equal(store.authorizeSend(later.effect_id,later.generation),true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(receipt.delivery_effect_ids.length,1);
});

test('invalid notification policy is rejected without changing task settings or permission revision',async t=>{
 const f=await setup(t),future=f.persistentTasks.create('alice',{title:'Policy task',agent_id:f.a.agent_id,objective:'Future',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 for(const policy of [{min_interval_seconds:0,max_per_24_hours:20,quiet_hours:null},{min_interval_seconds:60,max_per_24_hours:101,quiet_hours:null},{min_interval_seconds:60,max_per_24_hours:20,quiet_hours:{start:'22:00',end:'22:00',timezone:'UTC'}},{min_interval_seconds:60,max_per_24_hours:20,quiet_hours:{start:'22:00',end:'08:00',timezone:'Not/AZone'}}])assert.throws(()=>f.settings.update('alice',future.task_id,{expected_version:0,channel_binding_ids:[],delivery_policy:policy}),/invalid_task_notification_settings/);
 assert.equal(f.settings.get('alice',future.task_id).version,0);assert.equal(f.persistentTasks.get('alice',future.task_id).version,future.version);
});

async function extraNotification(f,store,sourceEffect,text){let result;
 const source=f.db.prepare('SELECT * FROM wb_task_delivery_authorizations WHERE effect_id=?').get(sourceEffect);
 withImmediateTransaction(f.db,()=>{result=store.enqueueText({runId:f.runId,messageId:String(store.get(sourceEffect).message_id),destination:'wecom',recipient:'task-recipient',text});
  store.bindTaskAuthorization(result.effect_id,source,source.conversation_id,source.principal);f.settings.grant(result.effect_id,'alice',f.task.task_id,f.settings.targets('alice',f.task.task_id)[0]);});return result;
}
const quietPolicy={min_interval_seconds:60,max_per_24_hours:20,quiet_hours:{start:'22:00',end:'08:00',timezone:'Asia/Hong_Kong'}};
function notificationWorker(store,send){return new ChannelDeliveryWorker(store,{send,sendFile:async()=>{throw new Error('unused');}},{registerDeliveryReceipt:async()=>{throw new Error('unused');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('unused');}});}
test('quiet-period text notifications share one bounded digest and one provider receipt without rerunning the task',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Second result marker');let calls=0,payload;
 const worker=notificationWorker(store,async text=>{calls++;payload=text;return {provider_message_id:'digest-provider-receipt'};});
 await worker.processNext();await worker.processNext();assert.equal(calls,0);
 now=Date.parse('2026-10-04T00:00:00Z')/1000;await worker.processNext();assert.equal(calls,1);assert.match(payload,/2 条任务提醒/);assert.match(payload,/Second result marker/);assert.ok(Buffer.byteLength(payload)<=1800);
 assert.equal(store.get(second.effect_id).status,'delivered');assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'delivered');assert.equal(await worker.processNext(),false);
 assert.equal(f.settings.deliveries('alice',f.task.task_id,f.occurrence.occurrence_id).items[0].digest_size,2);
 const publicStatus=await f.app.inject({url:`/v1/persistent-tasks/${f.task.task_id}/occurrences/${f.occurrence.occurrence_id}/deliveries`,headers:{'x-user-id':'alice'}});assert.equal(publicStatus.statusCode,200,publicStatus.body);assert.ok(publicStatus.json().items.every(item=>item.digest_size===2));assert.ok(!publicStatus.body.includes('digest-provider-receipt'));assert.ok(!publicStatus.body.includes('task-recipient'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_send_reservations').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('a frozen digest rechecks all permissions before send and rejects a revoked group without emitting text',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Another result');
 for(let i=0;i<2;i++){const item=store.claim('quiet',90);if(!item)break;assert.equal(store.authorizeSend(item.effect_id,item.generation),false);}
 now=Date.parse('2026-10-04T00:00:00Z')/1000;const item=store.claim('digest',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),true);assert.match(store.prepareTextDelivery(item.effect_id,item.generation),/2 条任务提醒/);
 new OwnerChannelBindings(f.db).revoke('alice',f.binding.channel_binding_id,1);assert.equal(store.authorizeSend(item.effect_id,item.generation),false);
 assert.equal(store.get(second.effect_id).status,'cancelled');assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'cancelled');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
});
test('an ambiguous digest marks every included effect unknown and a restarted worker never resends it',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Another result');let calls=0;
 const worker=notificationWorker(store,async()=>{calls++;throw new Error('network timeout');});await worker.processNext();await worker.processNext();now=Date.parse('2026-10-04T00:00:00Z')/1000;await worker.processNext();
 assert.equal(calls,1);assert.equal(store.get(second.effect_id).status,'outcome_unknown');assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'outcome_unknown');assert.equal(await notificationWorker(new ChannelDeliveryService(f.db,()=>now),async()=>{calls++;return {provider_message_id:'bad-repeat'};}).processNext(),false);assert.equal(calls,1);
});
test('notifications queued during quiet hours are included even when the delivery worker was offline',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now);let payload;
 const worker=notificationWorker(store,async text=>{payload=text;return {provider_message_id:'offline-digest'};});await worker.processNext();
 const second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Queued while worker offline');
 now=Date.parse('2026-10-04T00:00:00Z')/1000;await worker.processNext();assert.match(payload,/2 条任务提醒/);assert.match(payload,/Queued while worker offline/);assert.equal(store.get(second.effect_id).status,'delivered');
});
test('a stale receipt failure cannot reopen a delivered digest or resend its members',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Another result');let sent=0;
 const worker=notificationWorker(store,async()=>{sent++;return {provider_message_id:'confirmed-digest'};});await worker.processNext();now=Date.parse('2026-10-04T00:00:00Z')/1000;await worker.processNext();
 store.recordReceiptFailure(receipt.delivery_effect_ids[0],'STALE_FAILURE_CALLBACK');assert.equal(store.get(second.effect_id).status,'delivered');assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'delivered');assert.equal(await worker.processNext(),false);assert.equal(sent,1);
});
test('digest receipt-only recovery finishes every member after revocation without another provider send',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Another result');
 const quiet=store.claim('quiet',90);if(quiet)store.authorizeSend(quiet.effect_id,quiet.generation);now=Date.parse('2026-10-04T00:00:00Z')/1000;
 const item=store.claim('sender',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),true);store.prepareTextDelivery(item.effect_id,item.generation);store.recordProviderSent(item.effect_id,item.generation,{provider_message_id:'already-accepted-digest'});
 new OwnerChannelBindings(f.db).revoke('alice',f.binding.channel_binding_id,1);
 const recovery=notificationWorker(new ChannelDeliveryService(f.db,()=>now),async()=>{throw new Error('must not resend');});assert.equal(await recovery.processNext(),true);
 assert.equal(store.get(second.effect_id).status,'delivered');assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'delivered');assert.equal(await recovery.processNext(),false);
});
test('a failed digest receipt transaction cannot leave one member confirmed while another is still sending',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Another result');
 const quiet=store.claim('quiet',90);if(quiet)store.authorizeSend(quiet.effect_id,quiet.generation);now=Date.parse('2026-10-04T00:00:00Z')/1000;
 const item=store.claim('sender',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),true);store.prepareTextDelivery(item.effect_id,item.generation);
 f.db.exec(`CREATE TRIGGER fixture_digest_receipt_failure BEFORE UPDATE ON ga_channel_deliveries WHEN NEW.status='receipt_pending' AND NEW.effect_id='${second.effect_id}' BEGIN SELECT RAISE(ABORT,'fixture_digest_receipt_failure'); END;`);
 assert.throws(()=>store.recordProviderSent(item.effect_id,item.generation,{provider_message_id:'accepted-before-db-failure'}),/fixture_digest_receipt_failure/);
 for(const id of [second.effect_id,receipt.delivery_effect_ids[0]]){assert.equal(store.get(id).status,'sending');assert.equal(store.get(id).provider_receipt_json,null);}
 now+=91;assert.equal(new ChannelDeliveryService(f.db,()=>now).claim('restarted',90),null);
 for(const id of [second.effect_id,receipt.delivery_effect_ids[0]])assert.equal(store.get(id).status,'outcome_unknown');
});
test('quiet digests cap membership and Unicode byte size, leaving overflow behind the same rate gate',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now);const payloads=[];
 const worker=notificationWorker(store,async text=>{payloads.push(text);return {provider_message_id:'bounded-'+payloads.length};});await worker.processNext();
 for(let index=0;index<5;index++)await extraNotification(f,store,receipt.delivery_effect_ids[0],`${index}: ${'结果🌤️'.repeat(400)}`);
 now=Date.parse('2026-10-04T00:00:00Z')/1000;await worker.processNext();assert.match(payloads[0],/5 条任务提醒/);assert.ok(Buffer.byteLength(payloads[0])<=1800);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_channel_deliveries WHERE status='delivered'").get().n,5);
 await worker.processNext();assert.equal(payloads.length,1);now+=60;await worker.processNext();assert.equal(payloads.length,2);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_channel_deliveries WHERE status='delivered'").get().n,6);
});
test('an expired digest send lease is not authority for a late provider call',async t=>{
 const f=await setup(t,quietPolicy),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);let now=Date.parse('2026-10-03T15:00:00Z')/1000;
 const store=new ChannelDeliveryService(f.db,()=>now),second=await extraNotification(f,store,receipt.delivery_effect_ids[0],'Another result');
 const quiet=store.claim('quiet',90);if(quiet)store.authorizeSend(quiet.effect_id,quiet.generation);now=Date.parse('2026-10-04T00:00:00Z')/1000;
 const item=store.claim('expired-worker',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),true);store.prepareTextDelivery(item.effect_id,item.generation);now+=91;
 assert.equal(store.authorizeSend(item.effect_id,item.generation),false);for(const id of [second.effect_id,receipt.delivery_effect_ids[0]])assert.equal(store.get(id).status,'outcome_unknown');
});
test('revocation after publication cancels notification and does not revoke the persisted result or rerun the task',async t=>{
 const f=await setup(t),receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);
 new OwnerChannelBindings(f.db).revoke('alice',f.binding.channel_binding_id,1);
 const store=new ChannelDeliveryService(f.db),item=store.claim('fixture',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),false);
 assert.equal(store.get(receipt.delivery_effect_ids[0]).status,'cancelled');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.runs.get(f.runId,'alice').status,'succeeded');
});
test('task notification settings refuse active execution, stale versions, foreign channels and arbitrary recipients',async t=>{
 const f=await setup(t);assert.throws(()=>f.settings.update('alice',f.task.task_id,{expected_version:1,channel_binding_ids:[]}),/task_notification_run_active/);
 const independent=f.persistentTasks.create('alice',{title:'Future task',agent_id:f.a.agent_id,objective:'Future',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 assert.throws(()=>f.settings.update('alice',independent.task_id,{expected_version:0,channel_binding_ids:['foreign']}),/channel_binding_not_found/);
 assert.throws(()=>f.settings.update('alice',independent.task_id,{expected_version:0,channel_binding_ids:[],principal:'victim'}),/invalid_task_notification_settings/);
 const saved=f.settings.update('alice',independent.task_id,{expected_version:0,channel_binding_ids:[]});assert.equal(saved.version,1);
 assert.throws(()=>f.settings.update('alice',independent.task_id,{expected_version:0,channel_binding_ids:[]}),/version_conflict/);
});

test('public task settings and delivery status validate the owner and reject unverified notification destinations',async t=>{
 const f=await setup(t),id=f.task.task_id;
 const own=await f.app.inject({url:`/v1/persistent-tasks/${id}/notifications`,headers:{'x-user-id':'alice'}});assert.equal(own.statusCode,200,own.body);assert.equal(own.json().version,1);
 const foreign=await f.app.inject({url:`/v1/persistent-tasks/${id}/notifications`,headers:{'x-user-id':'bob'}});assert.equal(foreign.statusCode,404);
 const future=f.persistentTasks.create('alice',{title:'Future notification',agent_id:f.a.agent_id,objective:'Future',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 const update=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${future.task_id}/notifications`,headers:f.headers,payload:{expected_version:0,channel_binding_ids:[f.binding.channel_binding_id]}});assert.equal(update.statusCode,200,update.body);
 const invalid=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${future.task_id}/notifications`,headers:{...f.headers,'idempotency-key':'forged-notification'},payload:{expected_version:1,channel_binding_ids:[],recipient:'victim'}});assert.equal(invalid.statusCode,422,invalid.body);
 const empty=await f.app.inject({url:`/v1/persistent-tasks/${id}/occurrences/${f.occurrence.occurrence_id}/deliveries`,headers:{'x-user-id':'alice'}});assert.equal(empty.statusCode,200,empty.body);assert.deepEqual(empty.json().items,[]);
});
