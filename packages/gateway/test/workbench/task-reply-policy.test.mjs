import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {mkdirSync,mkdtempSync} from 'node:fs';import {join,resolve} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {TaskReplyPolicies,normalizeTaskReplyPolicy} from '../../src/persistent-tasks/reply-policy.ts';
const now=()=>new Date('2026-10-05T00:00:00Z');
const input=id=>({mode:'bounded_auto_reply',target:{kind:'conversation',conversation_id:id},direction:{topic:'Public release notes',tone:'Brief and polite',evidence_required:true,forbidden:['Do not purchase or delete']},limits:{max_per_24_hours:5,min_interval_seconds:120,expires_at:'2026-10-06T00:00:00Z'},quiet_hours:null});
async function fixture(t,databasePath=':memory:'){const f=await buildServer({databasePath,workspaces:['shared','other'],workbenchRoot:'.test-tmp/reply-policy'});t.after(async()=>{await f.app.close();if(f.db.isOpen)f.db.close();});const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'});const task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Monitor',objective:'Track public notes',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});const conversation=f.conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}});return {...f,agent,task,conversation,policies:new TaskReplyPolicies(f.db,{now})};}
test('reply policy defaults to report and validates exact human-controlled limits and direction',()=>{
 assert.deepEqual(normalizeTaskReplyPolicy({mode:'report'},now()),{mode:'report'});const value=input('c');assert.deepEqual(normalizeTaskReplyPolicy(value,now()),value);
 for(const change of [{owner_id:'bob'},{limits:{...value.limits,max_per_24_hours:21}},{limits:{...value.limits,min_interval_seconds:0}},{limits:{...value.limits,expires_at:'2026-10-04T00:00:00Z'}},{limits:{...value.limits,expires_at:'2099-01-01T00:00:00Z'}},{direction:{...value.direction,evidence_required:false}},{target:{...value.target,recipient:'someone'}},{mode:'report',target:value.target}])assert.throws(()=>normalizeTaskReplyPolicy({...value,...change},now()),/invalid_task_reply_policy/);
});
test('owned policy revisions survive a new service and cannot be changed or deleted behind CAS',async t=>{
 const f=await fixture(t);assert.equal(f.policies.get('alice',f.task.task_id).version,0);const saved=f.policies.update('alice',f.task.task_id,{expected_version:0,policy:input(f.conversation.conversation_id)});assert.equal(saved.version,1);assert.deepEqual(new TaskReplyPolicies(f.db,{now}).get('alice',f.task.task_id),saved);assert.equal(f.persistentTasks.get('alice',f.task.task_id).version,f.task.version+1);
 assert.throws(()=>f.policies.update('alice',f.task.task_id,{expected_version:0,policy:{mode:'report'}}),/version_conflict/);assert.throws(()=>f.policies.get('bob',f.task.task_id),/task_not_found/);
 const revoked=f.policies.update('alice',f.task.task_id,{expected_version:1,policy:{mode:'report'}});assert.equal(revoked.version,2);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_policy_revisions').get().n,2);
 assert.throws(()=>f.db.exec("UPDATE wb_task_reply_policy_revisions SET policy_json='{}'"),/reply_policy_revision_immutable/);assert.throws(()=>f.db.exec('DELETE FROM wb_task_reply_policy_revisions'),/reply_policy_revision_immutable/);
});
test('foreign, archived and incompatible targets roll back without policy or task version changes',async t=>{
 const f=await fixture(t);const foreign=f.conversations.create('bob',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),other=f.conversations.create('alice',{workspace_id:'other',model:{provider:'harness',model:'automatic'}});f.conversations.update(f.conversation.conversation_id,'alice',{expected_version:1,archived:true});
 for(const id of [foreign.conversation_id,other.conversation_id,f.conversation.conversation_id])assert.throws(()=>f.policies.update('alice',f.task.task_id,{expected_version:0,policy:input(id)}),/task_reply_target_invalid/);
 assert.throws(()=>f.policies.update('alice',f.task.task_id,{expected_version:0,policy:{...input('unused'),target:{kind:'channel',channel_binding_id:'absent'}}}),/channel_binding/);
 assert.equal(f.policies.get('alice',f.task.task_id).version,0);assert.equal(f.persistentTasks.get('alice',f.task.task_id).version,f.task.version);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_policy_revisions').get().n,0);
});
test('invalid calendar expiry, active runs and failed revision writes cannot grant reply authority',async t=>{
 assert.throws(()=>normalizeTaskReplyPolicy({...input('c'),limits:{...input('c').limits,expires_at:'2026-11-31T00:00:00Z'}},new Date('2026-11-15T00:00:00Z')),/invalid_task_reply_policy/);
 const f=await fixture(t);f.db.exec("CREATE TRIGGER fixture_reply_write_failure BEFORE INSERT ON wb_task_reply_policies BEGIN SELECT RAISE(ABORT,'fixture_reply_write_failure'); END;");
 assert.throws(()=>f.policies.update('alice',f.task.task_id,{expected_version:0,policy:input(f.conversation.conversation_id)}),/fixture_reply_write_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_policy_revisions').get().n,0);assert.equal(f.persistentTasks.get('alice',f.task.task_id).version,f.task.version);
 f.db.exec('DROP TRIGGER fixture_reply_write_failure');f.persistentTasks.runNow('alice',f.task.task_id,'test-start-reply-run');
 assert.throws(()=>f.policies.update('alice',f.task.task_id,{expected_version:0,policy:input(f.conversation.conversation_id)}),/task_reply_run_active/);assert.equal(f.policies.get('alice',f.task.task_id).version,0);
});
test('closing and reopening the SQLite connection preserves the exact policy and revocation history',async t=>{
 const base=resolve('.test-tmp/reply-policy-restart');mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'fixture-'));const path=join(directory,'state.sqlite');const f=await fixture(t,path);const saved=f.policies.update('alice',f.task.task_id,{expected_version:0,policy:input(f.conversation.conversation_id)});await f.app.close();f.db.close();
 const db=openProductDatabase(path);try{const policies=new TaskReplyPolicies(db,{now});assert.deepEqual(policies.get('alice',f.task.task_id),saved);assert.throws(()=>policies.update('alice',f.task.task_id,{expected_version:0,policy:{mode:'report'}}),/version_conflict/);assert.equal(policies.update('alice',f.task.task_id,{expected_version:1,policy:{mode:'report'}}).version,2);assert.equal(db.prepare('SELECT count(*) n FROM wb_task_reply_policy_revisions WHERE task_id=?').get(f.task.task_id).n,2);}finally{db.close();}
});
