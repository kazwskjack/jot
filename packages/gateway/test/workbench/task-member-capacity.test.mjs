import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {buildServer} from '../../src/server.ts';

async function members(f){
 const messages=[];
 for(let i=0;i<3;i++){
  const role=f.workbench.createAgent('alice',{name:`Member ${i}`,workspace_id:'ws',project_id:f.a.project_id});
  messages.push(f.workbench.sendMessage('alice','ws',{sender_agent_id:f.a.agent_id,recipient_agent_id:role.agent_id,text:'Review one independent source',client_message_id:`bounded-member-${i}`,auto_reply:true,max_replies:1,task_run_id:f.runId}));
 }
 return messages;
}
const message=(f,id)=>f.db.prepare('SELECT status,run_id FROM wb_agent_messages WHERE message_id=?').get(id);

test('a task starts at most two isolated member executions; repeated pumps keep the third queued without spending',async t=>{
 const f=await fixture(t),msgs=await members(f);
 assert.equal(f.workbench.processMailbox().queued,2);
 const pending=msgs.find(m=>message(f,m.message_id).status==='pending');assert.ok(pending);
 const snapshot=()=>({runs:f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,budgets:f.db.prepare('SELECT * FROM wb_mailbox_budgets').all(),threads:f.db.prepare('SELECT * FROM wb_message_threads ORDER BY thread_id').all()});
 const before=snapshot();
 for(let i=0;i<3;i++)assert.equal(f.workbench.processMailbox().queued,0);
 assert.equal(message(f,pending.message_id).run_id,null);assert.deepEqual(snapshot(),before);
 const active=msgs.filter(m=>message(f,m.message_id).status==='processing');
 for(const m of active){const child=message(f,m.message_id).run_id;const context=f.workbench.contextForRun(child);assert.equal(context.project_id,f.a.project_id);assert.equal(context.kind,'internal_mailbox');assert.notEqual(f.runs.get(child,'alice').conversation_id,f.occurrence.conversation_id);}
 f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(message(f,active[0].message_id).run_id);
 f.workbench.reconcileBudgets();assert.equal(f.workbench.processMailbox().queued,1);
 assert.equal(message(f,pending.message_id).status,'processing');
});

test('waiting and cancelling members retain capacity; unresolved terminal side effects cannot open another slot',async t=>{
 const f=await fixture(t),msgs=await members(f);assert.equal(f.workbench.processMailbox().queued,2);
 const active=msgs.filter(m=>message(f,m.message_id).status==='processing'),pending=msgs.find(m=>message(f,m.message_id).status==='pending');
 f.db.prepare("UPDATE ga_runs SET status='waiting_user' WHERE id=?").run(message(f,active[0].message_id).run_id);
 f.db.prepare("UPDATE ga_runs SET status='cancelling' WHERE id=?").run(message(f,active[1].message_id).run_id);
 assert.equal(f.workbench.processMailbox().queued,0);
 f.db.prepare("UPDATE ga_runs SET status='failed',reason_code='OUTCOME_UNKNOWN' WHERE id=?").run(message(f,active[0].message_id).run_id);
 assert.equal(f.workbench.processMailbox().queued,0);assert.equal(message(f,pending.message_id).status,'pending');
});

test('a second Gateway connection observes the same capacity while another occurrence has its own two slots',async t=>{
 const f=await fixture(t),msgs=await members(f);assert.equal(f.workbench.processMailbox().queued,2);
 const second=await buildServer(f.fixtureConfig);
 try{
  assert.equal(second.workbench.processMailbox().queued,0);
  const pending=msgs.find(m=>message(f,m.message_id).status==='pending');assert.ok(pending);
  const lead=f.workbench.createAgent('alice',{name:'Other lead',workspace_id:'ws',project_id:f.a.project_id});
  const task=f.persistentTasks.create('alice',{title:'Independent task',agent_id:lead.agent_id,objective:'Separate occurrence',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
  const occurrence=f.persistentTasks.runNow('alice',task.task_id,'independent');
  for(let i=0;i<2;i++){
   const recipient=f.workbench.createAgent('alice',{name:`Other member ${i}`,workspace_id:'ws',project_id:f.a.project_id});
   f.workbench.sendMessage('alice','ws',{sender_agent_id:lead.agent_id,recipient_agent_id:recipient.agent_id,text:'Independent work',client_message_id:`independent-${i}`,auto_reply:true,max_replies:1,task_run_id:occurrence.run_id});
  }
  assert.equal(second.workbench.processMailbox().queued,2);
  assert.equal(message(f,pending.message_id).status,'pending');
  const active=msgs.find(m=>message(f,m.message_id).status==='processing');
  second.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(message(f,active.message_id).run_id);
  second.workbench.reconcileBudgets();assert.equal(f.workbench.processMailbox().queued,1);
  assert.equal(second.workbench.processMailbox().queued,0);
 }finally{await second.app.close();second.db.close();}
});

test('temporary unknown member spend leaves queued work intact and trusted settlement admits it exactly once',async t=>{
 const f=await fixture(t),msgs=await members(f);assert.equal(f.workbench.processMailbox().queued,2);
 const pending=msgs.find(m=>message(f,m.message_id).status==='pending'),active=msgs.find(m=>message(f,m.message_id).status==='processing');
 const child=message(f,active.message_id).run_id;
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(child);
 f.modelBudgets.reserve('alice',child,{attempt_id:'unknown-cost',provider:'fixture',model:'bounded'});
 f.modelBudgets.dispatch('alice',child,'unknown-cost');f.modelBudgets.markUnknown('alice',child,'unknown-cost','usage_incomplete');
 f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(child);
 const before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 assert.equal(f.workbench.processMailbox().queued,0);assert.equal(message(f,pending.message_id).status,'pending');
 assert.equal(message(f,pending.message_id).run_id,null);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);
 f.modelBudgets.settle('alice',child,'unknown-cost',{inputTokens:5,outputTokens:5,totalTokens:10});
 assert.equal(f.workbench.processMailbox().queued,1);assert.equal(f.workbench.processMailbox().queued,0);
 assert.equal(message(f,pending.message_id).status,'processing');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before+1);
});
