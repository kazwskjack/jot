import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {EmailChannelBindings} from '../../src/channels/email-bindings.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {TaskNotifications} from '../../src/persistent-tasks/notifications.ts';
async function setup(t){const base=resolve('.test-tmp/task-create-delivery');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'case-'));const f=await buildServer({databasePath:join(dir,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(dir,'files'),csrfToken:'test-create-delivery',allowedOrigins:['https://fixture.invalid']});t.after(async()=>{await f.app.close();f.db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});});const agent=f.workbench.createAgent('alice',{name:'Reader',instructions:'Read public information'});let code;const email=new EmailChannelBindings(f.db,{send:async text=>{code=text.match(/[A-Za-z0-9_-]{43}/)[0];return {provider_message_id:'accepted'};}});const challenge=await email.begin('alice','alice@example.test','email-task-create');const binding=email.confirm('alice',challenge.channel_binding_id,code);const input={title:'Notify task',agent_id:agent.agent_id,objective:'Track progress',trigger:{kind:'once'},notification_settings:{channel_binding_ids:[binding.channel_binding_id],events:['completed','failed'],delivery_policy:{min_interval_seconds:120,max_per_24_hours:10,quiet_hours:null}}};return {...f,agent,binding,input};}
test('creation saves verified delivery authorization in the same transaction and replay never reapplies it',async t=>{
 const f=await setup(t),task=f.persistentTasks.create('alice',f.input,'create-with-mail');const notifications=new TaskNotifications(f.db),settings=notifications.get('alice',task.task_id);
 assert.deepEqual(settings.channel_binding_ids,[f.binding.channel_binding_id]);assert.deepEqual(settings.events,['completed','failed']);assert.equal(settings.version,1);assert.equal(settings.delivery_policy.min_interval_seconds,120);
 notifications.update('alice',task.task_id,{expected_version:1,channel_binding_ids:[]});
 const replay=f.persistentTasks.create('alice',f.input,'create-with-mail');assert.equal(replay.task_id,task.task_id);assert.equal(notifications.get('alice',task.task_id).channel_binding_ids.length,0);
 assert.throws(()=>f.persistentTasks.create('alice',{...f.input,notification_settings:{...f.input.notification_settings,events:['completed']}},'create-with-mail'),/idempotency_conflict/);
});
test('invalid or revoked binding and notification write failure roll back task and request receipt',async t=>{
 const f=await setup(t);new OwnerChannelBindings(f.db).revoke('alice',f.binding.channel_binding_id,1);
 assert.throws(()=>f.persistentTasks.create('alice',f.input,'revoked-mail'),/channel_binding_not_verified/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_create_requests').get().n,0);
 f.db.exec("CREATE TRIGGER fixture_notification_failure BEFORE INSERT ON wb_task_notification_settings BEGIN SELECT RAISE(ABORT,'fixture_notification_write'); END;");
 assert.throws(()=>f.persistentTasks.create('alice',{...f.input,notification_settings:{channel_binding_ids:[],events:['completed']}},'rollback-notification'),/fixture_notification_write/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_create_requests').get().n,0);
});
test('create API accepts reviewed delivery settings but cannot accept recipients, authority or delivery edits through PATCH',async t=>{
 const f=await setup(t),headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-create-delivery','idempotency-key':'create-delivery-api'};
 const created=await f.app.inject({method:'POST',url:'/v1/persistent-tasks',headers,payload:f.input});assert.equal(created.statusCode,201,created.body);
 for(const extra of [{recipient:'other@example.test'},{expected_version:0},{channel:'email'},{owner_id:'bob'}]){const response=await f.app.inject({method:'POST',url:'/v1/persistent-tasks',headers:{...headers,'idempotency-key':crypto.randomUUID()},payload:{...f.input,notification_settings:{...f.input.notification_settings,...extra}}});assert.ok([400,422].includes(response.statusCode),response.body);}
 const edited=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${created.json().task_id}`,headers:{...headers,'idempotency-key':'delivery-edit-denied'},payload:{expected_version:created.json().version,notification_settings:f.input.notification_settings}});assert.ok([400,422].includes(edited.statusCode),edited.body);
});

test('capabilities advertise atomic task creation delivery settings',async t=>{
 const f=await setup(t);const response=await f.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':'alice'}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().workbench.task_create_delivery,true);
});
