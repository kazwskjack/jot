import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {TaskNotifications} from '../../src/persistent-tasks/notifications.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {maintainWorkbench} from '../../src/persistent-tasks/scheduler.ts';
async function setup(t,events=['needs_confirmation'],channel='wecom'){let settings,binding;
 const f=await fixture(t,'wait_user',{beforeRun:async f=>{
  settings=new TaskNotifications(f.db);const channels=new OwnerChannelBindings(f.db,{enabled:['wecom']});
  if(channel==='email'){const {EmailChannelBindings}=await import('../../src/channels/email-bindings.ts');let code;const email=new EmailChannelBindings(f.db,{send:async text=>{code=text.match(/[A-Za-z0-9_-]{43}/)[0];return {provider_message_id:'accepted'};}});const challenge=await email.begin('alice','events@example.test','events-email-key');email.confirm('alice',challenge.channel_binding_id,code);}else{const challenge=channels.create('alice','wecom');channels.acceptProof('wecom','event-recipient',challenge.code);}binding=channels.list('alice').items[0];
  settings.update('alice',f.task.task_id,{expected_version:0,channel_binding_ids:[binding.channel_binding_id],events});
 }});return {...f,settings,binding};
}
function worker(db,send){return new ChannelDeliveryWorker(new ChannelDeliveryService(db),{send,sendFile:async()=>{throw new Error('unused');}},{registerDeliveryReceipt:async()=>{throw new Error('unused');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('unused');}});}

test('task confirmation notices retain the verified email destination and send once to its provider',async t=>{
 const f=await setup(t,['needs_confirmation'],'email');await f.persistentTasks.tick();await f.persistentTasks.tick();
 assert.equal(f.db.prepare('SELECT destination FROM ga_channel_deliveries').get().destination,'email');let sent=0;
 const delivery=new ChannelDeliveryWorker(new ChannelDeliveryService(f.db),{providers:{email:{send:async(text,to)=>{sent++;assert.equal(to,'events@example.test');assert.match(text,/需要你补充信息/);return {provider_message_id:'notice'};},sendFile:async()=>{throw new Error('unused');}}}},{registerDeliveryReceipt:async()=>{throw new Error('unused');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('unused');}});
 await delivery.processNext();await delivery.processNext();assert.equal(sent,1);
});
test('only scheduler maintenance emits a durable confirmation notice once, without a final answer or new model run',async t=>{
 const f=await setup(t);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
 await f.app.inject({url:`/v1/persistent-tasks/${f.task.task_id}/occurrences`,headers:{'x-user-id':'alice'}});assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
 await f.persistentTasks.tick();await f.persistentTasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);let sent=0;
 await worker(f.db,async(text,recipient)=>{sent++;assert.equal(recipient,'event-recipient');assert.match(text,/需要你补充信息/);return {provider_message_id:'event-confirmation'};}).processNext();assert.equal(sent,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('answering a pending task question before notice delivery invalidates its source proof',async t=>{
 const f=await setup(t);await f.persistentTasks.tick();const card=(await f.list())[0];
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:[],custom_text:'Use the concise report.'}))});assert.equal(response.statusCode,202,response.body);
 await worker(f.db,async()=>{throw new Error('resolved question must not notify');}).processNext();assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'cancelled');assert.equal(f.db.prepare('SELECT last_reason_code FROM ga_channel_deliveries').get().last_reason_code,'TASK_NOTIFICATION_SOURCE_RESOLVED');
});
test('a failed run can notify without claiming business completion, but an unknown outcome never becomes a failure notice',async t=>{
 const f=await setup(t,['failed']);f.db.prepare("UPDATE ga_runs SET status='failed',reason_code='OUTCOME_UNKNOWN',version=version+1 WHERE id=?").run(f.runId);
 await f.persistentTasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
 f.db.prepare("UPDATE ga_runs SET reason_code='RUNTIME_FAILED',version=version+1 WHERE id=?").run(f.runId);await f.persistentTasks.tick();await f.persistentTasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
 await worker(f.db,async text=>{assert.match(text,/执行失败/);return {provider_message_id:'failure-notice'};}).processNext();assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'delivered');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('a notification setting added after dispatch cannot replay an older occurrence',async t=>{
 const f=await fixture(t);f.db.prepare("UPDATE ga_runs SET status='failed',reason_code='RUNTIME_FAILED' WHERE id=?").run(f.runId);
 const channels=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=channels.create('alice','wecom');channels.acceptProof('wecom','event-recipient',challenge.code);
 new TaskNotifications(f.db).update('alice',f.task.task_id,{expected_version:0,channel_binding_ids:[channels.list('alice').items[0].channel_binding_id],events:['failed']});
 await f.persistentTasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
});
test('page monitoring establishes a silent baseline, then emits one trusted change notice independently of model completion',async t=>{
 const f=await setup(t,['changed']);let now=new Date('2026-10-03T10:00:00Z'),page='Initial content';
 const tasks=new PersistentTaskService(f.db,f.workbench,{now:()=>now,pageReader:async()=>({text:page,url:'https://example.org/news'})});
 const task=tasks.create('alice',{title:'Page monitor',agent_id:f.a.agent_id,objective:'Monitor the public page',trigger:{kind:'page_change',url:'https://example.org/news',interval_seconds:60}});
 f.settings.update('alice',task.task_id,{expected_version:0,channel_binding_ids:[f.binding.channel_binding_id],events:['changed']});
 await tasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
 now=new Date(now.getTime()+61000);page='Updated content';await tasks.tick();await tasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
 await worker(f.db,async text=>{assert.match(text,/页面有变化/);assert.match(text,/https:\/\/example.org\/news/);return {provider_message_id:'page-change-notice'};}).processNext();
 assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'delivered');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('owner-provided evidence does not impersonate the host page-change ledger',async t=>{
 const f=await setup(t,['changed']);f.persistentTasks.recordEvidence('alice',f.task.task_id,f.occurrence.occurrence_id,[{kind:'page_snapshot',reference:'https://example.org/news',hash:'a'.repeat(64)}]);
 await f.persistentTasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_events').get().n,0);
});
test('signal event and outbox commit atomically; maintenance after a failed commit or restart never duplicates the cause',async t=>{
 const f=await setup(t);f.db.exec("CREATE TRIGGER fixture_notice_failure BEFORE INSERT ON ga_channel_deliveries BEGIN SELECT RAISE(ABORT,'fixture_notice_failure'); END;");
 assert.throws(()=>f.persistentTasks.maintainNotifications(),/fixture_notice_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_events').get().n,0);
 f.db.exec('DROP TRIGGER fixture_notice_failure');assert.equal(f.persistentTasks.maintainNotifications().emitted,1);assert.equal(new PersistentTaskService(f.db,f.workbench).maintainNotifications().emitted,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('notification maintenance remains available while model execution is not ready, without admitting any new run',async t=>{
 const f=await setup(t);const result=await maintainWorkbench(f.workbench,f.persistentTasks,false);assert.equal(result.execution_ready,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
