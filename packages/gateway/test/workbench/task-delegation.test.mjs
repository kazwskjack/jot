import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {ContractValidator} from '../../src/contracts/validator.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

async function setup(t){
 const f=await fixture(t),module=await import('../../src/workbench/task-delegation.ts').catch(()=>({}));
 assert.equal(typeof module.TaskDelegationService,'function');
 const service=new module.TaskDelegationService(f.db,f.workbench,f.persistentTasks);
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Review the source',acceptance:'Verified source and remaining questions'},f.runId);
 const member=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:f.a.project_id});
 const input={occurrence_id:f.occurrence.occurrence_id,subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id,client_message_id:'delegate-1'};
 return {...f,service,step,member,input};
}

test('owner delegation uses the one task board, freezes one role and replays one assignment without another message',async t=>{
 const f=await setup(t),receipt=f.service.delegate('alice',f.task.task_id,f.input);
 assert.equal(receipt.subtask_id,f.step.subtask_id);assert.equal(receipt.subtask_version,f.step.version+1);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'running');
 assert.deepEqual(f.service.delegate('alice',f.task.task_id,f.input),receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n,1);
 assert.throws(()=>f.service.delegate('alice',f.task.task_id,{...f.input,recipient_agent_id:f.a.agent_id}),/idempotency_conflict/);
 assert.throws(()=>f.service.delegate('bob',f.task.task_id,f.input),/task_not_found/);
 f.workbench.processMailbox();const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).run_id;
 const context=f.workbench.contextForRun(child);assert.equal(context.task_assignment.subtask_id,f.step.subtask_id);
 assert.equal(context.task_assignment.acceptance,f.step.acceptance);
 assert.equal(context.task_assignment.lead_agent_id,f.a.agent_id);
 assert.equal(context.kind,'internal_mailbox');
});

test('stale task versions, changed roles and unmet dependencies cannot create or continue a delegated execution',async t=>{
 const f=await setup(t);
 assert.throws(()=>f.service.delegate('alice',f.task.task_id,{...f.input,expected_subtask_version:99}),/version_conflict/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n,0);
 const receipt=f.service.delegate('alice',f.task.task_id,f.input);
 f.workbench.updateAgent('alice',f.member.agent_id,{expected_version:f.member.version,instructions:'Changed before dispatch'});
 assert.equal(f.workbench.processMailbox().queued,0);
 assert.equal(f.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).status,'task_revoked');
 const dependency=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Unfinished prerequisite'},f.runId);
 const blocked=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Dependent step',dependencies:[dependency.subtask_id]},f.runId);
 assert.throws(()=>f.service.delegate('alice',f.task.task_id,{...f.input,subtask_id:blocked.subtask_id,expected_subtask_version:blocked.version,client_message_id:'dependent'}),/dependency_not_completed/);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items.find(s=>s.subtask_id===blocked.subtask_id).status,'pending');
});

test('root board edits revoke the assigned member instead of letting it overwrite newer acceptance',async t=>{
 const f=await setup(t),receipt=f.service.delegate('alice',f.task.task_id,f.input);f.workbench.processMailbox();
 const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).run_id;
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:f.step.subtask_id,expected_version:receipt.subtask_version,acceptance:'New requirement',status:'blocked'},f.runId);
 assert.throws(()=>f.workbench.assertRunActive(child),/task_assignment_revoked/);
 f.workbench.processMailbox();assert.equal(f.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).status,'task_revoked');
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].acceptance,'New requirement');
});

test('owned HTTP delegation is contract-valid, rejects identity injection and rolls back failed assignment storage',async t=>{
 const f=await setup(t),url=`/v1/persistent-tasks/${f.task.task_id}/delegations`;
 const injected=await f.send(url,{...f.input,owner_id:'bob'});assert.equal(injected.statusCode,400,injected.body);
 const forbidden=await f.send(url,f.input,{'x-csrf-token':'wrong'});assert.equal(forbidden.statusCode,403);
 const foreign=await f.send(url,f.input,{'x-user-id':'bob'});assert.equal(foreign.statusCode,404);
 f.db.exec("CREATE TRIGGER fixture_delegation_abort BEFORE INSERT ON wb_task_delegations BEGIN SELECT RAISE(ABORT,'fixture abort'); END;");
 assert.throws(()=>f.service.delegate('alice',f.task.task_id,f.input),/fixture abort/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n,0);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].version,f.step.version);
 f.db.exec('DROP TRIGGER fixture_delegation_abort');
 const response=await f.send(url,f.input);assert.equal(response.statusCode,201,response.body);
 const validator=new ContractValidator();assert.equal(validator.validateResponse(validator.operationFor('POST','/v1/persistent-tasks/{task_id}/delegations'),201,response.json()).valid,true);
 assert.doesNotMatch(response.body,/owner_id|session|snapshot_json|role_epoch|input_hash/);
 assert.throws(()=>f.db.prepare("UPDATE wb_task_delegations SET subtask_version=99").run(),/task_delegation_immutable/);
});

test('a member reply remains material for the lead and cannot complete the step or publish in the root conversation',async t=>{
 const f=await setup(t),receipt=f.service.delegate('alice',f.task.task_id,f.input);f.workbench.processMailbox();
 const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).run_id;
 const user=f.db.prepare("SELECT content_json FROM ga_messages WHERE run_id=? AND role='user'").get(child);
 assert.match(user.content_json,/冻结步骤/);assert.match(user.content_json,/不得编辑父任务账本/);
 withImmediateTransaction(f.db,()=>{f.runs.appendAssistant(child,'Source material and remaining questions');f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(child);});
 f.workbench.reconcileBudgets();f.workbench.processMailbox();
 assert.equal(f.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).status,'completed');
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items[0].status,'running');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(f.runId).n,0);
 const messages=f.workbench.listMessages('alice','ws',undefined,f.occurrence.occurrence_id).items;
 assert.ok(messages.some(m=>m.text==='Source material and remaining questions'));
 assert.ok(!messages.some(m=>String(m.text).includes('subtask_id')));
});
