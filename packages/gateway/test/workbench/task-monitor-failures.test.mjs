import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {TaskNotifications} from '../../src/persistent-tasks/notifications.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';

async function monitor(t){
 const f=await fixture(t);let clock=new Date('2026-10-03T10:00:00Z'),fails=true;
 const tasks=new PersistentTaskService(f.db,f.workbench,{now:()=>clock,pageReader:async()=>{
  if(fails)throw new Error('request includes private transport details');
  return {text:'Initial page',url:'https://example.org/news'};
 }});
 const task=tasks.create('alice',{title:'Monitor',agent_id:f.a.agent_id,objective:'Monitor this page',trigger:{kind:'page_change',url:'https://example.org/news',interval_seconds:60}});
 return {...f,tasks,task,advance:()=>{clock=new Date(clock.getTime()+3601000);},recover:()=>{fails=false;},fail:()=>{fails=true;}};
}
test('continuous page poll failures create one host episode without inventing a run, and recovery permits a new episode',async t=>{
 const f=await monitor(t);const before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 await f.tasks.tick();f.advance();await f.tasks.tick();
 let rows=f.db.prepare('SELECT * FROM wb_task_monitor_failure_episodes WHERE task_id=?').all(f.task.task_id);
 assert.equal(rows.length,1);assert.equal(rows[0].reason_code,'task_tick_failed');assert.equal(rows[0].notification_scope_json,null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);
 f.advance();f.recover();await f.tasks.tick();
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_resolutions').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_active').get().n,0);
 f.advance();f.fail();await f.tasks.tick();rows=f.db.prepare('SELECT * FROM wb_task_monitor_failure_episodes WHERE task_id=?').all(f.task.task_id);assert.equal(rows.length,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);
 assert.throws(()=>f.db.prepare('UPDATE wb_task_monitor_failure_episodes SET reason_code=?').run('changed'),/immutable/);
});
test('notification permission is frozen when a host failure begins and cannot be added retrospectively',async t=>{
 const f=await monitor(t);await f.tasks.tick();
 const bindings=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom');bindings.acceptProof('wecom','monitor-recipient',challenge.code);
 const saved=bindings.list('alice').items[0];new TaskNotifications(f.db).update('alice',f.task.task_id,{expected_version:0,channel_binding_ids:[saved.channel_binding_id],events:['failed']});
 f.advance();await f.tasks.tick();assert.equal(f.db.prepare('SELECT notification_scope_json FROM wb_task_monitor_failure_episodes').get().notification_scope_json,null);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
 f.advance();f.recover();await f.tasks.tick();f.advance();f.fail();await f.tasks.tick();
 const episodes=f.db.prepare('SELECT * FROM wb_task_monitor_failure_episodes ORDER BY started_at').all();assert.equal(episodes.length,2);
 const scope=JSON.parse(episodes[1].notification_scope_json);assert.equal(scope.settings_version,1);assert.equal(scope.bindings[0].channel_binding_id,saved.channel_binding_id);assert.equal(scope.bindings[0].version,saved.version);
 assert.ok(!episodes[1].notification_scope_json.includes('monitor-recipient'));assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.equal(f.db.prepare('SELECT message_id FROM ga_channel_deliveries').get().message_id,episodes[1].episode_id);
});
test('a reconstructed scheduler preserves the open episode and ignores a stale asynchronous failure after pause',async t=>{
 const f=await monitor(t);await f.tasks.tick();f.advance();
 const restarted=new PersistentTaskService(f.db,f.workbench,{now:()=>new Date('2026-10-03T12:00:00Z'),pageReader:async()=>{throw new Error('page_read_failed');}});await restarted.tick();
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_episodes').get().n,1);
 f.advance();f.advance();f.recover();await f.tasks.tick();
 let raced=false;
 const race=new PersistentTaskService(f.db,f.workbench,{now:()=>new Date('2026-10-04T12:00:00Z'),pageReader:async()=>{
  raced=true;
  const current=f.tasks.get('alice',f.task.task_id);f.tasks.pause('alice',f.task.task_id,current.version);throw new Error('page_read_failed');
 }});await race.tick();assert.equal(raced,true);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_episodes').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_active').get().n,0);
});
test('a fault ledger write failure rolls back scheduler error counters and retry deadlines',async t=>{
 const f=await monitor(t);f.db.exec("CREATE TRIGGER fixture_fault_write BEFORE INSERT ON wb_task_monitor_failure_episodes BEGIN SELECT RAISE(ABORT,'fixture_fault_write'); END;");
 await assert.rejects(()=>f.tasks.tick(),/fixture_fault_write/);
 const task=f.db.prepare('SELECT failure_count,last_error,retry_after_at FROM wb_persistent_tasks WHERE task_id=?').get(f.task.task_id);
 assert.equal(task.failure_count,0);assert.equal(task.last_error,null);assert.equal(task.retry_after_at,null);
 f.db.exec('DROP TRIGGER fixture_fault_write');await f.tasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_episodes').get().n,1);
});
test('pause and resume close the previous generation fault even before the next page poll succeeds',async t=>{
 const f=await monitor(t);await f.tasks.tick();let task=f.tasks.get('alice',f.task.task_id);
 f.tasks.pause('alice',task.task_id,task.version);await f.tasks.tick();assert.equal(f.db.prepare('SELECT reason FROM wb_task_monitor_failure_resolutions').get().reason,'task_revoked');
 task=f.tasks.get('alice',task.task_id);f.tasks.resume('alice',task.task_id,task.version);f.advance();await f.tasks.tick();
 const episodes=f.db.prepare('SELECT generation FROM wb_task_monitor_failure_episodes ORDER BY started_at').all();assert.equal(episodes.length,2);assert.notEqual(episodes[0].generation,episodes[1].generation);
});
async function notified(t){const f=await monitor(t),bindings=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom');bindings.acceptProof('wecom','monitor-recipient',challenge.code);
 const binding=bindings.list('alice').items[0];new TaskNotifications(f.db).update('alice',f.task.task_id,{expected_version:0,channel_binding_ids:[binding.channel_binding_id],events:['failed']});return {...f,bindings,binding};}
function deliveryWorker(f,send,store=new ChannelDeliveryService(f.db)){return new ChannelDeliveryWorker(store,{send,sendFile:async()=>{throw new Error('unused');}},{registerDeliveryReceipt:async()=>{throw new Error('host fault must not register model receipt');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('host fault must not fabricate model binding');}});}

test('host failure uses an owner verified email without inventing a model run',async t=>{
 const f=await monitor(t),before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 const {EmailChannelBindings}=await import('../../src/channels/email-bindings.ts');let code;
 const bindings=new EmailChannelBindings(f.db,{send:async text=>{code=text.match(/[A-Za-z0-9_-]{43}/)[0];return {provider_message_id:'accepted'};}}),challenge=await bindings.begin('alice','monitor@example.test','monitor-mail-key');const binding=bindings.confirm('alice',challenge.channel_binding_id,code);
 new TaskNotifications(f.db).update('alice',f.task.task_id,{expected_version:0,channel_binding_ids:[binding.channel_binding_id],events:['failed']});
 await f.tasks.tick();assert.equal(f.db.prepare('SELECT destination FROM ga_channel_deliveries').get()?.destination,'email');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);
 let sent=0;const worker=new ChannelDeliveryWorker(new ChannelDeliveryService(f.db),{providers:{email:{send:async(text,to)=>{sent++;assert.equal(to,'monitor@example.test');return {provider_message_id:'host-mail'};},sendFile:async()=>{throw new Error('unused');}}}},{registerDeliveryReceipt:async()=>{throw new Error('no model receipt');}},{resolveArtifact:()=>{throw new Error('unused');},resolveRuntime:()=>{throw new Error('no model runtime');}});
 await worker.processNext();await worker.processNext();assert.equal(sent,1);
});
test('host fault sends through the existing leased worker exactly once without a run or assistant answer',async t=>{
 const f=await notified(t),before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;await f.tasks.tick();f.advance();await f.tasks.tick();
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);assert.equal(f.db.prepare('SELECT run_id FROM ga_channel_deliveries').get().run_id,null);let sent=0;
 const worker=deliveryWorker(f,async(text,recipient)=>{sent++;assert.equal(recipient,'monitor-recipient');assert.match(text,/暂时无法检查/);assert.ok(!text.includes('private transport'));return {provider_message_id:'host-receipt'};});
 await worker.processNext();await worker.processNext();assert.equal(sent,1);assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'delivered');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('a recovered host fault or revoked binding cancels its queued notice before provider invocation',async t=>{
 for(const mode of ['recover','revoke']){const f=await notified(t);await f.tasks.tick();
  if(mode==='recover'){f.advance();f.recover();await f.tasks.tick();}else f.bindings.revoke('alice',f.binding.channel_binding_id,f.binding.version);
  await deliveryWorker(f,async()=>{throw new Error('obsolete host notice must not send');}).processNext();const item=f.db.prepare('SELECT status,last_reason_code FROM ga_channel_deliveries').get();assert.equal(item.status,'cancelled');assert.equal(item.last_reason_code,mode==='recover'?'TASK_NOTIFICATION_SOURCE_RESOLVED':'TASK_DELIVERY_AUTHORIZATION_REVOKED');
 }
});
test('an ungranted NULL-run effect and altered host payload fail closed before provider invocation',async t=>{
 const f=await notified(t);await f.tasks.tick();f.db.prepare('UPDATE ga_channel_deliveries SET payload_json=?').run(JSON.stringify({kind:'text',text:'Injected external text'}));
 await deliveryWorker(f,async()=>{throw new Error('modified host payload must not send');}).processNext();assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'cancelled');
 f.db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,payload_json,status,created_at,updated_at) VALUES('ungranted',NULL,'unknown','wecom','monitor-recipient','{"kind":"text","text":"ungranted"}','pending','now','now')`).run();
 await deliveryWorker(f,async()=>{throw new Error('NULL run must not bypass the host grant');}).processNext();assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries WHERE effect_id=?').get('ungranted').status,'cancelled');
});
test('host notification outbox and scheduler fault evidence roll back together on an authorization write failure',async t=>{
 const f=await notified(t);f.db.exec("CREATE TRIGGER fixture_host_grant BEFORE INSERT ON wb_task_host_notification_authorizations BEGIN SELECT RAISE(ABORT,'fixture_host_grant'); END;");
 await assert.rejects(()=>f.tasks.tick(),/fixture_host_grant/);for(const table of ['wb_task_monitor_failure_episodes','wb_task_monitor_failure_active','ga_channel_deliveries'])assert.equal(f.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
 assert.equal(f.db.prepare('SELECT failure_count FROM wb_persistent_tasks WHERE task_id=?').get(f.task.task_id).failure_count,0);
 f.db.exec('DROP TRIGGER fixture_host_grant');await f.tasks.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,1);
});
async function quietFaults(t,count){
 const f=await notified(t),settings=new TaskNotifications(f.db),policy={min_interval_seconds:120,max_per_24_hours:20,quiet_hours:{start:'09:00',end:'11:00',timezone:'UTC'}};
 settings.update('alice',f.task.task_id,{expected_version:1,channel_binding_ids:[f.binding.channel_binding_id],events:['failed'],delivery_policy:policy});await f.tasks.tick();
 for(let i=1;i<count;i++){const next=f.tasks.create('alice',{title:'Monitor '+i,agent_id:f.a.agent_id,objective:'Check another public page',trigger:{kind:'page_change',url:'https://example.org/monitor-'+i,interval_seconds:60}});
  settings.update('alice',next.task_id,{expected_version:0,channel_binding_ids:[f.binding.channel_binding_id],events:['failed'],delivery_policy:policy});await f.tasks.tick();}
 return f;
}
test('quiet host faults form bounded five-member digests and share the owner-channel provider-attempt rate bucket',async t=>{
 const f=await quietFaults(t,6);let now=Math.floor(Date.parse('2026-10-03T10:00:00Z')/1000),sent=0;const store=new ChannelDeliveryService(f.db,()=>now),worker=deliveryWorker(f,async text=>{sent++;if(sent===1){assert.match(text,/5 条任务提醒/);assert.ok(Buffer.byteLength(text)<=1800);}return {provider_message_id:'host-'+sent};},store);
 assert.equal(await worker.processNext(),false);assert.equal(sent,0);now+=3600;await worker.processNext();await worker.processNext();assert.equal(sent,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_digest_members').get().n,5);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_channel_deliveries WHERE status='delivered'").get().n,5);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_channel_deliveries WHERE status='pending' AND last_reason_code='TASK_NOTIFICATION_RATE_LIMIT'").get().n,1);
 now+=120;await worker.processNext();assert.equal(sent,2);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_notification_send_reservations').get().n,2);
});
test('a frozen host digest cancels all unsent members if one source recovers before the final provider fence',async t=>{
 const f=await quietFaults(t,2),now=Math.floor(Date.parse('2026-10-03T11:00:00Z')/1000),store=new ChannelDeliveryService(f.db,()=>now),item=store.claim('host-digest-test',90);
 assert.equal(store.authorizeSend(item.effect_id,item.generation),true);const text=store.prepareTextDelivery(item.effect_id,item.generation);assert.match(text,/2 条任务提醒/);
 const tasks=new PersistentTaskService(f.db,f.workbench,{now:()=>new Date('2026-10-03T11:00:00Z'),pageReader:async url=>{if(url==='https://example.org/news')return {url,text:'Recovered first page'};throw new Error('page_read_failed');}});await tasks.tick();
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_monitor_failure_active').get().n,1);assert.equal(store.authorizeSend(item.effect_id,item.generation),false);
 const rows=f.db.prepare('SELECT status,last_reason_code FROM ga_channel_deliveries').all();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='cancelled'&&r.last_reason_code==='TASK_NOTIFICATION_SOURCE_RESOLVED'));
 assert.equal(f.db.prepare('SELECT payload_text FROM wb_task_notification_digests').get().payload_text,text);
});
test('task notification history exposes host notices before any occurrence and never leaks recipients or provider receipts',async t=>{
 const f=await quietFaults(t,2),headers={'x-user-id':'alice'},url=`/v1/persistent-tasks/${f.task.task_id}/deliveries`;
 const response=await f.app.inject({url,headers});assert.equal(response.statusCode,200,response.body);const page=response.json();assert.equal(page.items.length,1);assert.equal(page.items[0].source,'monitor');assert.equal(page.items[0].occurrence_id,null);assert.equal(page.has_more,false);assert.equal(page.next_cursor,null);
 assert.ok(!response.body.includes('monitor-recipient'));assert.ok(!response.body.includes('payload_json'));assert.ok(!response.body.includes('notification_scope_json'));
 const denied=await f.app.inject({url,headers:{'x-user-id':'bob'}});assert.equal(denied.statusCode,404);const badCursor=await f.app.inject({url:url+'?cursor=foreign-effect',headers});assert.equal(badCursor.statusCode,404);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,2);
});
test('task history pages fifty stable owned effects at a time without repeating the cursor boundary',async t=>{
 const f=await notified(t);await f.tasks.tick();
 for(let i=1;i<51;i++){f.advance();f.recover();await f.tasks.tick();f.advance();f.fail();await f.tasks.tick();}
 const url=`/v1/persistent-tasks/${f.task.task_id}/deliveries`,headers={'x-user-id':'alice'},first=await f.app.inject({url,headers});assert.equal(first.statusCode,200,first.body);const a=first.json();assert.equal(a.items.length,50);assert.equal(a.has_more,true);assert.equal(a.next_cursor,a.items.at(-1).delivery_id);
 const second=await f.app.inject({url:url+'?cursor='+encodeURIComponent(a.next_cursor),headers});assert.equal(second.statusCode,200,second.body);const b=second.json();assert.equal(b.items.length,1);assert.equal(b.has_more,false);assert.equal(b.next_cursor,null);assert.ok(!a.items.some(item=>item.delivery_id===b.items[0].delivery_id));
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,51);
});
test('ambiguous host sends are not retried and confirmed provider receipts finish after binding revocation',async t=>{
 const unknown=await notified(t);await unknown.tasks.tick();let sent=0;const unknownWorker=deliveryWorker(unknown,async()=>{sent++;throw new Error('network timeout');});await unknownWorker.processNext();await unknownWorker.processNext();assert.equal(sent,1);assert.equal(unknown.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'outcome_unknown');
 assert.equal(unknown.db.prepare('SELECT count(*) n FROM wb_task_notification_send_reservations').get().n,1);
 const f=await notified(t);await f.tasks.tick();const store=new ChannelDeliveryService(f.db),item=store.claim('receipt-test',90);assert.equal(store.authorizeSend(item.effect_id,item.generation),true);store.recordProviderSent(item.effect_id,item.generation,{provider_message_id:'confirmed-host'});f.bindings.revoke('alice',f.binding.channel_binding_id,f.binding.version);
 await deliveryWorker(f,async()=>{throw new Error('receipt recovery must not send again');},store).processNext();assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'delivered');
});
