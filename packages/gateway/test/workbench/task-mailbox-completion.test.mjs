import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {currentTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';

async function member(f,settled){
 const role=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:f.workbench.contextForRun(f.runId).project_id});
 const msg=f.workbench.sendMessage('alice','ws',{sender_agent_id:f.workbench.contextForRun(f.runId).agent_id,recipient_agent_id:role.agent_id,text:'Verify source',client_message_id:'completion-member',auto_reply:true,max_replies:1,task_run_id:f.runId});
 f.workbench.processMailbox();const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).run_id;
 if(settled){
  f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(child);
  f.modelBudgets.reserve('alice',child,{attempt_id:'member-spent',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',child,'member-spent');f.modelBudgets.settle('alice',child,'member-spent',{inputTokens:5,outputTokens:5,totalTokens:10});
  f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(child);
  f.workbench.processMailbox();
 }
 return child;
}
test('root completion cannot ignore a task-linked member with a queued model reservation',async t=>{
 await assert.rejects(completionFixture(t,{prepare:f=>member(f,false)}),/budget_usage_unknown|task_auxiliary_pending/);
});
test('root frozen business candidate includes settled member costs instead of losing them in another conversation',async t=>{
 let child;const f=await completionFixture(t,{prepare:async f=>{child=await member(f,true);}});
 assert.ok(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.budget_attempts.some(a=>a.run_id===child&&a.attempt_id==='member-spent'&&a.state==='settled'));
});
test('new member dispatch cannot invalidate an already frozen owner review',async t=>{
 const f=await completionFixture(t);
 await assert.rejects(member(f,false),/task_mailbox_binding_invalid/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_mailbox_task_roots').get().n,0);
});
