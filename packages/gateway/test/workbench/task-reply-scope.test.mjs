import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {TaskReplyPolicies} from '../../src/persistent-tasks/reply-policy.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
const policy=id=>({mode:'review',target:{kind:'conversation',conversation_id:id},direction:{topic:'Public release notes',tone:'Brief',evidence_required:true,forbidden:['No purchase']},limits:{max_per_24_hours:2,min_interval_seconds:60,expires_at:'2026-10-06T00:00:00Z'},quiet_hours:null});
async function setup(t){let clock=new Date('2026-10-05T00:00:00Z');const f=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/reply-scope',});t.after(async()=>{await f.app.close();f.db.close();});const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'});const task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Notes',objective:'Read updates',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:2}});const target=f.conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}});const policies=new TaskReplyPolicies(f.db,{now:()=>clock});const tasks=new PersistentTaskService(f.db,f.workbench,{now:()=>clock});return {...f,persistentTasks:tasks,agent,task,target,policies,setClock:value=>clock=new Date(value)};}
test('dispatch freezes owned reply authority and gives only DSH planning context, never a send receipt',async t=>{
 const f=await setup(t);f.policies.update('alice',f.task.task_id,{expected_version:0,policy:policy(f.target.conversation_id)});
 const occurrence=f.persistentTasks.runNow('alice',f.task.task_id,'test-reply-scope-run');const scope=f.policies.scope('alice',occurrence.run_id);
 assert.equal(scope.allowed,true);assert.equal(scope.policy_version,1);assert.equal(scope.task_version,2);assert.deepEqual(scope.policy,policy(f.target.conversation_id));assert.equal(scope.occurrence_id,occurrence.occurrence_id);
 assert.equal(f.policies.authorize('alice',occurrence.run_id).allowed,true);
 const message=f.db.prepare("SELECT content_json FROM ga_messages WHERE run_id=? AND role='user'").get(occurrence.run_id);assert.match(message.content_json,/回复规则/);assert.match(message.content_json,/Public release notes/);assert.match(message.content_json,/不能直接发送/);
 assert.throws(()=>f.policies.scope('bob',occurrence.run_id),/task_reply_scope_not_found/);
 assert.throws(()=>f.db.exec("UPDATE wb_task_reply_scopes SET scope_json='{}'"),/reply_scope_immutable/);assert.throws(()=>f.db.exec('DELETE FROM wb_task_reply_scopes'),/reply_scope_immutable/);
 assert.deepEqual(f.policies.capture('alice',f.task.task_id,occurrence.occurrence_id,occurrence.run_id),scope);
 f.conversations.update(f.target.conversation_id,'alice',{expected_version:1,title:'Changed target'});assert.equal(f.policies.authorize('alice',occurrence.run_id).reason,'REPLY_TARGET_CHANGED');assert.deepEqual(f.policies.scope('alice',occurrence.run_id),scope);
});
test('default, expired and revoked target rules are frozen as non-posting scopes while the task still dispatches',async t=>{
 const f=await setup(t);const defaultRun=f.persistentTasks.runNow('alice',f.task.task_id,'test-default-scope');assert.equal(f.policies.scope('alice',defaultRun.run_id).allowed,false);assert.equal(f.policies.authorize('alice',defaultRun.run_id).reason,'REPLY_REPORT_ONLY');
 const another=f.persistentTasks.create('alice',{agent_id:f.agent.agent_id,title:'Expired',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});f.policies.update('alice',another.task_id,{expected_version:0,policy:policy(f.target.conversation_id)});f.setClock('2026-10-06T00:00:01Z');const expired=f.persistentTasks.runNow('alice',another.task_id,'test-expired-scope');assert.equal(f.policies.scope('alice',expired.run_id).reason,'REPLY_POLICY_EXPIRED');assert.equal(f.policies.authorize('alice',expired.run_id).allowed,false);
});
test('live fences reject expiry, task and role changes without rewriting captured authorization',async t=>{
 const f=await setup(t);f.policies.update('alice',f.task.task_id,{expected_version:0,policy:policy(f.target.conversation_id)});const occurrence=f.persistentTasks.runNow('alice',f.task.task_id,'test-fence-scope');const scope=f.policies.scope('alice',occurrence.run_id);f.setClock('2026-10-06T00:00:00Z');assert.equal(f.policies.authorize('alice',occurrence.run_id).reason,'REPLY_POLICY_EXPIRED');f.setClock('2026-10-05T00:00:00Z');
 f.persistentTasks.pause('alice',f.task.task_id,2);assert.equal(f.policies.authorize('alice',occurrence.run_id).allowed,false);assert.deepEqual(f.policies.scope('alice',occurrence.run_id),scope);
});
test('channel revocation and role permission changes stop captured authority independently of notifications',async t=>{
 const f=await setup(t),bindings=new OwnerChannelBindings(f.db,{enabled:['wecom']});const challenge=bindings.create('alice','wecom','test-scope-channel');bindings.acceptProof('wecom','test-principal',challenge.code);const binding=bindings.resolve('alice',challenge.channel_binding_id);
 const channelPolicy={...policy('unused'),target:{kind:'channel',channel_binding_id:binding.channel_binding_id}};f.policies.update('alice',f.task.task_id,{expected_version:0,policy:channelPolicy});const occurrence=f.persistentTasks.runNow('alice',f.task.task_id,'test-channel-scope');assert.equal(f.policies.authorize('alice',occurrence.run_id).allowed,true);
 assert.equal(JSON.stringify(f.policies.scope('alice',occurrence.run_id)).includes('test-principal'),false);bindings.revoke('alice',binding.channel_binding_id,binding.version);assert.equal(f.policies.authorize('alice',occurrence.run_id).reason,'REPLY_TARGET_CHANGED');
 const next=f.persistentTasks.create('alice',{agent_id:f.agent.agent_id,title:'Role change',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});f.policies.update('alice',next.task_id,{expected_version:0,policy:policy(f.target.conversation_id)});const second=f.persistentTasks.runNow('alice',next.task_id,'test-role-scope');f.workbench.updateAgent('alice',f.agent.agent_id,{expected_version:f.agent.version,status:'disabled'});assert.equal(f.policies.authorize('alice',second.run_id).reason,'REPLY_ROLE_CHANGED');
});
test('scope write failure rolls back the entire dispatch and cannot leave a run without its grant snapshot',async t=>{
 const f=await setup(t);f.policies.update('alice',f.task.task_id,{expected_version:0,policy:policy(f.target.conversation_id)});const before=f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n;f.db.exec("CREATE TRIGGER fixture_scope_write_failure BEFORE INSERT ON wb_task_reply_scopes BEGIN SELECT RAISE(ABORT,'fixture_scope_write_failure'); END;");
 assert.throws(()=>f.persistentTasks.runNow('alice',f.task.task_id,'test-scope-rollback'),/fixture_scope_write_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,0);assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,0);
});
test('legacy role adapters freeze report-only scope and cannot infer reply permission from their role object',()=>{
 const db=openProductDatabase(':memory:');try{const conversations=new ConversationRepository(db),conversation=conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),agent={agent_id:'legacy-reader',status:'active',workspace_id:'shared',project_id:conversation.project_id,conversation_id:conversation.conversation_id};const workbench={getAgent:()=>agent,bindRun:()=>{}};
 const tasks=new PersistentTaskService(db,workbench),task=tasks.create('alice',{agent_id:agent.agent_id,title:'Legacy report',objective:'Read',trigger:{kind:'once'}}),occurrence=tasks.runNow('alice',task.task_id,'test-legacy-scope');const policies=new TaskReplyPolicies(db);assert.equal(policies.scope('alice',occurrence.run_id).allowed,false);assert.equal(policies.authorize('alice',occurrence.run_id).reason,'REPLY_REPORT_ONLY');assert.throws(()=>policies.update('alice',task.task_id,{expected_version:0,policy:policy(conversation.conversation_id)}));
 }finally{db.close();}
});
