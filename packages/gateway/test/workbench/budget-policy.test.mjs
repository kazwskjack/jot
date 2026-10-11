import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {maintainWorkbench} from '../../src/persistent-tasks/scheduler.ts';

const url=new URL('../../src/workbench/model-budget-policy.ts',import.meta.url);
const limit={tokens:5000,nano_usd:50000,model_calls:50};
const route={provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
const config=()=>({revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[structuredClone(route)],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(k=>[k,{...limit}]))});
async function fixture(t,custom=config()){
 const mod=await import(url.href).catch(()=>({}));assert.equal(typeof mod.WorkbenchBudgetPolicy,'function','shared server budget allocation policy must exist');
 const base=resolve('../../.test-tmp/budget-policy');assert.match(base.replaceAll('\\','/'),/^E:\/codex\//i);mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const db=openProductDatabase(join(root,'fixture.sqlite'));let now=new Date('2026-10-02T12:00:00Z');
 const policy=new mod.WorkbenchBudgetPolicy(db,custom,{now:()=>now});
 const service=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files'),modelBudgetPolicy:policy});
 const tasks=new PersistentTaskService(db,service,{now:()=>now});const runs=new RunRepository(db,new EventStore(db));
 t.after(()=>{db.close();const child=relative(base,resolve(root));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 const agent=(name='Reader',owner='alice')=>service.createAgent(owner,{name});
 const task=a=>tasks.create('alice',{title:'Watch source',agent_id:a.agent_id,objective:'Read controlled source',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 function settle(run,id='model-first'){
  db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run);
  const receipt=policy.ledger.reserve('alice',run,{attempt_id:id,provider:'fixture',model:'bounded',max_tokens:20});
  policy.ledger.dispatch('alice',run,id);policy.ledger.settle('alice',run,id,{inputTokens:20,outputTokens:5,totalTokens:25});
  return receipt;
 }
 const allocation=run=>policy.allocation('alice',run);
 const scope=(run,prefix)=>allocation(run).scopes.find(x=>x.key.startsWith(prefix)).scope_id;
 const balance=(run,prefix)=>policy.ledger.balance('alice',scope(run,prefix));
 return {mod,db,root,policy,service,tasks,runs,agent,task,settle,allocation,scope,balance,now:value=>{now=new Date(value);}};
}

test('task enqueue atomically holds the first call across owner, project, member, lifetime root and occurrence',async t=>{
 const f=await fixture(t),a=f.agent(),task=f.task(a),o=f.tasks.runNow('alice',task.task_id,'one');
 assert.equal(f.policy.ledger.isBound('alice',o.run_id),true);
 assert.deepEqual(f.allocation(o.run_id).scopes.map(s=>s.key.split(':')[0]).sort(),['agent-day','occurrence','owner-day','project-day','task-total']);
 assert.equal(f.balance(o.run_id,'owner-day:').held.tokens,'100');assert.equal(f.balance(o.run_id,'task-total:').held.model_calls,'1');
 assert.equal(f.tasks.runNow('alice',task.task_id,'one').run_id,o.run_id);assert.equal(f.balance(o.run_id,'owner-day:').held.tokens,'100');
 f.settle(o.run_id);assert.equal(f.balance(o.run_id,'owner-day:').held.tokens,'0');assert.equal(f.balance(o.run_id,'owner-day:').used.tokens,'25');
 const attempts=f.db.prepare('SELECT attempt_id,state FROM wb_model_budget_attempts WHERE run_id=? ORDER BY attempt_id').all(o.run_id);
 assert.equal(attempts.find(x=>x.attempt_id==='queue-admission').state,'released');assert.equal(attempts.filter(x=>x.state==='settled').length,1);
});

test('owner-authorized task mailbox charges member work to the original task and occurrence budgets',async t=>{
 const f=await fixture(t),lead=f.agent(),member=f.agent('Reviewer'),task=f.task(lead),o=f.tasks.runNow('alice',task.task_id,'team-root');f.settle(o.run_id);
 const msg=f.service.sendMessage('alice','ws',{sender_agent_id:lead.agent_id,recipient_agent_id:member.agent_id,text:'Review the source',client_message_id:'task-member-review',auto_reply:true,max_replies:1,task_run_id:o.run_id});
 f.service.processMailbox();const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).run_id;assert.ok(child);
 assert.equal(f.scope(child,'task-total:'),f.scope(o.run_id,'task-total:'));
 assert.equal(f.scope(child,'occurrence:'),f.scope(o.run_id,'occurrence:'));
 assert.notEqual(f.scope(child,'agent-day:'),f.scope(o.run_id,'agent-day:'));
 f.settle(child,'member-model');assert.equal(f.balance(o.run_id,'task-total:').used.tokens,'50');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_auxiliary_runs WHERE occurrence_id=?').get(o.occurrence_id).n,1);
 const root=f.db.prepare('SELECT * FROM wb_mailbox_task_roots WHERE thread_id=?').get(msg.thread_id);
 assert.equal(root.root_run_id,o.run_id);assert.equal(root.owner_id,'alice');
 assert.throws(()=>f.db.prepare('UPDATE wb_mailbox_task_roots SET root_run_id=? WHERE thread_id=?').run(child,msg.thread_id),/task_mailbox_binding_immutable/);
});

test('a paused task rejects pending member dispatch without creating a child model run',async t=>{
 const f=await fixture(t),lead=f.agent(),member=f.agent('Reviewer'),task=f.task(lead),o=f.tasks.runNow('alice',task.task_id,'paused-team');f.settle(o.run_id);
 const msg=f.service.sendMessage('alice','ws',{sender_agent_id:lead.agent_id,recipient_agent_id:member.agent_id,text:'Review later',client_message_id:'paused-team-message',auto_reply:true,task_run_id:o.run_id});
 f.tasks.pause('alice',task.task_id,1);f.service.processMailbox();
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).status,'task_revoked');
});

test('a task-linked member already queued loses execution permission when its root is paused',async t=>{
 const f=await fixture(t),lead=f.agent(),member=f.agent('Reviewer'),task=f.task(lead),o=f.tasks.runNow('alice',task.task_id,'guard-team');f.settle(o.run_id);
 const msg=f.service.sendMessage('alice','ws',{sender_agent_id:lead.agent_id,recipient_agent_id:member.agent_id,text:'Review now',client_message_id:'guard-team-message',auto_reply:true,task_run_id:o.run_id});f.service.processMailbox();
 const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).run_id;assert.ok(child);
 f.tasks.pause('alice',task.task_id,1);assert.throws(()=>f.service.assertRunActive(child),/task_mailbox_revoked/);
 f.service.processMailbox();assert.equal(f.runs.get(child,'alice').status,'cancelled');
 assert.equal(f.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).status,'task_revoked');
});

test('task mailbox cannot buy another model turn after the shared task allowance is exhausted',async t=>{
 const settings=config();settings.limits.task_total={tokens:5000,nano_usd:50000,model_calls:1};
 const f=await fixture(t,settings),lead=f.agent(),member=f.agent('Reviewer'),task=f.task(lead),o=f.tasks.runNow('alice',task.task_id,'one-call-team');f.settle(o.run_id);
 const msg=f.service.sendMessage('alice','ws',{sender_agent_id:lead.agent_id,recipient_agent_id:member.agent_id,text:'Review source',client_message_id:'exhausted-task-mailbox',auto_reply:true,task_run_id:o.run_id});
 f.service.processMailbox();assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).status,'budget_exhausted');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_auxiliary_runs').get().n,0);assert.equal(f.balance(o.run_id,'task-total:').used.model_calls,'1');
});

test('a second queued role cannot claim the same owner allowance; refusal rolls back run, conversation, outbox and occurrence',async t=>{
 const c=config();c.limits.owner_daily={tokens:100,nano_usd:1000,model_calls:1};const f=await fixture(t,c),a=f.agent(),b=f.agent('Writer'),first=f.task(a),second=f.task(b);
 f.tasks.runNow('alice',first.task_id,'first');const before={runs:f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,conversations:f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,outbox:f.db.prepare('SELECT count(*) n FROM ga_outbox').get().n};
 assert.throws(()=>f.tasks.runNow('alice',second.task_id,'second'),/model_budget_exhausted/);
 assert.deepEqual({runs:f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,conversations:f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,outbox:f.db.prepare('SELECT count(*) n FROM ga_outbox').get().n},before);
 assert.equal(f.tasks.get('alice',second.task_id).runs_used,0);assert.equal(f.tasks.occurrences('alice',second.task_id).items.length,0);
 const bob=f.agent('Other owner','bob');const other=f.service.enqueueAgentMessage('bob',bob.agent_id,{text:'Separate allowance',client_message_id:'bob'});assert.ok(other.run_id);
});

test('task root spend survives edits and repeated occurrences while independent tasks keep separate roots',async t=>{
 const c=config();c.limits.task_total={tokens:500,nano_usd:5000,model_calls:1};const f=await fixture(t,c),a=f.agent(),task=f.task(a),first=f.tasks.runNow('alice',task.task_id,'first');
 f.settle(first.run_id);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 const edited=f.tasks.update('alice',task.task_id,{expected_version:1,title:'Renamed root'});assert.equal(edited.version,2);
 assert.throws(()=>f.tasks.runNow('alice',task.task_id,'second'),/model_budget_exhausted/);assert.equal(f.tasks.get('alice',task.task_id).runs_used,1);
 const separate=f.task(a),second=f.tasks.runNow('alice',separate.task_id,'independent');
 assert.notEqual(f.scope(first.run_id,'task-total:'),f.scope(second.run_id,'task-total:'));
 assert.equal(f.scope(first.run_id,'owner-day:'),f.scope(second.run_id,'owner-day:'));
});

test('cancelled admissions are refunded but started and unknown calls are never automatically forgiven',async t=>{
 const f=await fixture(t),a=f.agent(),first=f.tasks.runNow('alice',f.task(a).task_id,'first');
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(first.run_id);
 await maintainWorkbench(f.service,f.tasks,false);assert.equal(f.balance(first.run_id,'owner-day:').held.tokens,'0');
 const second=f.tasks.runNow('alice',f.task(a).task_id,'second');f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(second.run_id);
 f.policy.ledger.reserve('alice',second.run_id,{attempt_id:'model-started',provider:'fixture',model:'bounded',max_tokens:20});f.policy.ledger.dispatch('alice',second.run_id,'model-started');
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(second.run_id);await maintainWorkbench(f.service,f.tasks,false);
 assert.equal(f.balance(second.run_id,'owner-day:').held.tokens,'100');
 f.policy.ledger.markUnknown('alice',second.run_id,'model-started','stream_incomplete');await maintainWorkbench(f.service,f.tasks,false);
 assert.equal(f.balance(second.run_id,'owner-day:').held.tokens,'100');
});

test('mailbox replies share one durable thread allowance and do not escape owner or member budgets',async t=>{
 const c=config();c.limits.mailbox_thread={tokens:500,nano_usd:5000,model_calls:1};const f=await fixture(t,c),a=f.agent('Observer'),b=f.agent('Writer');
 const message=f.service.sendMessage('alice','ws',{sender_agent_id:a.agent_id,recipient_agent_id:b.agent_id,text:'Discuss source',client_message_id:'thread',auto_reply:true,max_replies:4});
 assert.equal(f.service.processMailbox().queued,1);const first=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(message.message_id).run_id;
 assert.deepEqual(f.allocation(first).scopes.map(s=>s.key.split(':')[0]).sort(),['agent-day','mailbox-thread','owner-day','project-day']);
 f.settle(first);withImmediateTransaction(f.db,()=>f.runs.appendAssistant(first,'Controlled response'));f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first);
 const next=f.service.processMailbox();assert.equal(next.queued,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.balance(first,'mailbox-thread:').used.model_calls,'1');
 assert.ok(f.service.listMessages('alice','ws').items.some(x=>x.status==='budget_exhausted'));
});

test('day rollover starts new owner limits while preserving the task lifetime budget',async t=>{
 const f=await fixture(t),a=f.agent(),task=f.task(a),first=f.tasks.runNow('alice',task.task_id,'day-one');f.settle(first.run_id);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 f.now('2026-10-03T12:00:00Z');const second=f.tasks.runNow('alice',task.task_id,'day-two');
 assert.notEqual(f.scope(first.run_id,'owner-day:'),f.scope(second.run_id,'owner-day:'));assert.equal(f.scope(first.run_id,'task-total:'),f.scope(second.run_id,'task-total:'));
 assert.equal(f.balance(second.run_id,'task-total:').used.tokens,'25');assert.equal(f.balance(second.run_id,'owner-day:').used.tokens,'0');
});

test('API and worker policy revisions fail closed on mismatch, cannot roll back, and still allow old spent calls to settle',async t=>{
 const f=await fixture(t),a=f.agent(),r=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Controlled task',client_message_id:'one'});f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);
 f.policy.ledger.reserve('alice',r.run_id,{attempt_id:'model-old',provider:'fixture',model:'bounded'});f.policy.ledger.dispatch('alice',r.run_id,'model-old');
 const different=config();different.routes[0].rates.output=11;
 assert.throws(()=>new f.mod.WorkbenchBudgetPolicy(f.db,different),/budget_policy_conflict/);
 const upgraded=config();upgraded.revision=2;upgraded.routes[0].revision='rates-2';upgraded.routes[0].rates.output=11;
 new f.mod.WorkbenchBudgetPolicy(f.db,upgraded);
 assert.throws(()=>f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Stale process',client_message_id:'stale'}),/budget_policy_stale/);
 assert.throws(()=>new f.mod.WorkbenchBudgetPolicy(f.db,config()),/budget_policy_stale/);
 f.policy.ledger.settle('alice',r.run_id,'model-old',{inputTokens:20,outputTokens:5,totalTokens:25});assert.equal(f.balance(r.run_id,'chat-root:').used.nano_usd,'90');
});

test('configuration omission cannot restore free role dispatch after budgets were activated',async t=>{
 const f=await fixture(t),a=f.agent();const without=new WorkbenchService(f.db,{workspaceIds:['ws'],root:join(f.root,'files')});
 assert.throws(()=>without.enqueueAgentMessage('alice',a.agent_id,{text:'No policy',client_message_id:'missing'}),/budget_service_unavailable/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});

test('upgraded server limits reuse task and daily identities without resetting spent accounting',async t=>{
 const f=await fixture(t),a=f.agent(),task=f.task(a),first=f.tasks.runNow('alice',task.task_id,'before-upgrade');
 f.settle(first.run_id);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 const before=f.allocation(first.run_id).scopes.map(scope=>f.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE scope_id=?').get(scope.scope_id));
 const updated=config();updated.revision=2;for(const key of Object.keys(updated.limits))updated.limits[key]={tokens:6000,nano_usd:60000,model_calls:60};
 const current=new f.mod.WorkbenchBudgetPolicy(f.db,updated,{now:()=>new Date('2026-10-02T12:00:00Z')});
 const service=new WorkbenchService(f.db,{workspaceIds:['ws'],root:join(f.root,'files'),modelBudgetPolicy:current});
 const tasks=new PersistentTaskService(f.db,service,{now:()=>new Date('2026-10-02T12:00:00Z'),modelBudgetPolicy:current});
 const next=tasks.runNow('alice',task.task_id,'after-upgrade');
 const after=current.allocation('alice',next.run_id);
 for(const row of before.filter(row=>!row.scope_key.startsWith('occurrence:'))){
  assert.equal(after.scopes.find(scope=>scope.key===row.scope_key).scope_id,row.scope_id);
  const fresh=f.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE scope_id=?').get(row.scope_id);
  assert.equal(fresh.limits_json,row.limits_json);assert.equal(fresh.used_tokens,'25');assert.equal(fresh.used_nano_usd,'90');assert.equal(fresh.used_model_calls,'1');
  assert.deepEqual(current.ledger.balance('alice',row.scope_id).limits,{tokens:'6000',nano_usd:'60000',model_calls:'60'});
  assert.equal(fresh.held_tokens,'100');assert.equal(fresh.held_nano_usd,'1000');
 }
 assert.notEqual(after.scopes.find(scope=>scope.key.startsWith('occurrence:')).scope_id,f.scope(first.run_id,'occurrence:'));
 assert.throws(()=>f.policy.ledger.createScope('alice',before[0].scope_key,{tokens:7000,nano_usd:70000,model_calls:70},{starts_at:before[0].starts_at,ends_at:before[0].ends_at}),/budget_policy_stale/);
});

test('lowered server limits deny fresh occurrences using preserved usage and roll back new admission',async t=>{
 const f=await fixture(t),a=f.agent(),task=f.task(a),first=f.tasks.runNow('alice',task.task_id,'spent');
 f.settle(first.run_id);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 const updated=config();updated.revision=2;updated.limits.task_total.model_calls=1;
 const current=new f.mod.WorkbenchBudgetPolicy(f.db,updated,{now:()=>new Date('2026-10-02T12:00:00Z')});
 const service=new WorkbenchService(f.db,{workspaceIds:['ws'],root:join(f.root,'files'),modelBudgetPolicy:current});
 const tasks=new PersistentTaskService(f.db,service,{now:()=>new Date('2026-10-02T12:00:00Z')});
 const counts=()=>['ga_runs','wb_task_occurrences','wb_model_budget_scopes','wb_budget_allocations'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n),before=counts();
 assert.throws(()=>tasks.runNow('alice',task.task_id,'must-deny'),/model_budget_exhausted/);assert.deepEqual(counts(),before);
 assert.equal(current.ledger.balance('alice',f.scope(first.run_id,'task-total:')).used.model_calls,'1');
 assert.equal(current.ledger.balance('alice',f.scope(first.run_id,'task-total:')).held.model_calls,'0');
});

test('observed policy activations retain immutable audit history through restart and upgrade',async t=>{
 const f=await fixture(t);let rows;
 assert.doesNotThrow(()=>{rows=f.db.prepare('SELECT * FROM wb_model_budget_policy_history ORDER BY revision').all();},'activated policy configuration must be durable');
 assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].policy_json),config());
 new f.mod.WorkbenchBudgetPolicy(f.db,config());
 const updated=config();updated.revision=2;updated.limits.task_total.tokens=6000;new f.mod.WorkbenchBudgetPolicy(f.db,updated);
 rows=f.db.prepare('SELECT * FROM wb_model_budget_policy_history ORDER BY revision').all();assert.equal(rows.length,2);assert.deepEqual(JSON.parse(rows[1].policy_json),updated);
 assert.throws(()=>f.db.prepare("UPDATE wb_model_budget_policy_history SET policy_json='{}' WHERE revision=1").run(),/budget_policy_history_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_policy_history WHERE revision=1').run(),/budget_policy_history_immutable/);
 assert.throws(()=>new f.mod.WorkbenchBudgetPolicy(f.db,config()),/budget_policy_stale/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_policy_history').get().n,2);
});

test('checkpoint continuation consumes the original chat root; a new user message starts its own root',async t=>{
 const f=await fixture(t),a=f.agent();const first=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Original request',client_message_id:'first'});f.settle(first.run_id);
 f.db.prepare("UPDATE ga_runs SET status='failed',checkpoint_id='checkpoint-fixture' WHERE id=?").run(first.run_id);
 const commands=new RunCommandService(f.db,new EventStore(f.db));
 const resumed=withImmediateTransaction(f.db,()=>{const r=commands.resume(first.run_id,'alice',{expected_run_version:1,checkpoint_id:'checkpoint-fixture'},'resume');f.service.inheritChatRun('alice',first.run_id,r.run_id);return r;});
 assert.equal(f.scope(first.run_id,'chat-root:'),f.scope(resumed.run_id,'chat-root:'));
 assert.equal(f.balance(resumed.run_id,'chat-root:').used.tokens,'25');assert.equal(f.balance(resumed.run_id,'chat-root:').held.tokens,'100');
 const independent=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Independent request',client_message_id:'independent'});
 assert.notEqual(f.scope(first.run_id,'chat-root:'),f.scope(independent.run_id,'chat-root:'));
});

test('terminal steering fallback inherits the original root even without native continuation_of',async t=>{
 const c=config();c.limits.chat_root.model_calls=2;const f=await fixture(t,c),a=f.agent();
 const first=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Original',client_message_id:'first'});f.settle(first.run_id);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 function fallback(key){return withImmediateTransaction(f.db,()=>{const next=f.runs.enqueue(a.conversation_id,'alice',{client_message_id:key,content:[{type:'text',text:'Continue original task'}]});f.service.inheritChatRun('alice',first.run_id,next.run_id);return next;});}
 const next=fallback('fallback-one');assert.equal(f.db.prepare('SELECT continuation_of FROM ga_runs WHERE id=?').get(next.run_id).continuation_of,null);
 assert.equal(f.scope(first.run_id,'chat-root:'),f.scope(next.run_id,'chat-root:'));
 f.settle(next.run_id);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(next.run_id);
 assert.equal(f.balance(next.run_id,'chat-root:').used.model_calls,'2');
 const count=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 assert.throws(()=>fallback('fallback-two'),/model_budget_exhausted/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,count);
});

test('second database connection and restarted allocator preserve queue holds and immutable allocation history',async t=>{
 const c=config();c.limits.owner_daily={tokens:100,nano_usd:1000,model_calls:1};const f=await fixture(t,c),a=f.agent(),r=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'First',client_message_id:'one'});
 const db=openProductDatabase(join(f.root,'fixture.sqlite'));
 try{
  const policy=new f.mod.WorkbenchBudgetPolicy(db,c,{now:()=>new Date('2026-10-02T12:00:00Z')});const service=new WorkbenchService(db,{workspaceIds:['ws'],root:join(f.root,'files'),modelBudgetPolicy:policy});
  assert.deepEqual(policy.allocation('alice',r.run_id),f.allocation(r.run_id));
  assert.throws(()=>service.enqueueAgentMessage('alice',a.agent_id,{text:'Second',client_message_id:'two'}),/model_budget_exhausted/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
  assert.throws(()=>f.policy.allocation('bob',r.run_id),/budget_run_not_found/);
  assert.throws(()=>db.prepare("UPDATE wb_budget_allocations SET allocation_json='{}' WHERE run_id=?").run(r.run_id),/budget_allocation_immutable/);
  assert.throws(()=>db.prepare('DELETE FROM wb_budget_allocations WHERE run_id=?').run(r.run_id),/budget_allocation_immutable/);
 }finally{db.close();}
});

test('failed reservation transfer preserves admission; internal queue metadata cannot be changed or dispatched',async t=>{
 const c=config();c.routes.push({...route,provider:'secondary'});c.limits.chat_root.model_calls=1;
 const f=await fixture(t,c),a=f.agent(),r=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'First',client_message_id:'one'});f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);
 assert.throws(()=>f.policy.ledger.reserve('alice',r.run_id,{attempt_id:'auxiliary',provider:'secondary',model:'bounded'}),/model_budget_exhausted/);
 assert.throws(()=>f.policy.ledger.reserve('alice',r.run_id,{attempt_id:'queue-admission',provider:'fixture',model:'bounded'}),/budget_request_invalid/);
 assert.throws(()=>f.policy.ledger.dispatch('alice',r.run_id,'queue-admission'),/budget_dispatch_conflict/);
 assert.equal(f.balance(r.run_id,'owner-day:').held.tokens,'100');
 assert.throws(()=>f.db.prepare("UPDATE wb_model_budget_admissions SET attempt_id='forged' WHERE run_id=?").run(r.run_id),/budget_admission_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_admissions WHERE run_id=?').run(r.run_id),/budget_admission_immutable/);
 f.settle(r.run_id);assert.doesNotThrow(()=>f.service.assertRunActive(r.run_id),'using the last allowed call must not block publication of the earned response');
});

test('a higher priced route cannot drop the original admission when transfer fails',async t=>{
 const c=config();c.limits.owner_daily={tokens:100,nano_usd:1000,model_calls:1};const f=await fixture(t,c),a=f.agent();
 const run=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Original',client_message_id:'one'});f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const changed=config();changed.limits.owner_daily=c.limits.owner_daily;changed.revision=2;changed.routes[0].revision='rates-2';changed.routes[0].rates.output=11;
 const current=new f.mod.WorkbenchBudgetPolicy(f.db,changed,{now:()=>new Date('2026-10-02T12:00:00Z')});
 assert.throws(()=>current.ledger.reserve('alice',run.run_id,{attempt_id:'repriced',provider:'fixture',model:'bounded'}),/model_budget_exhausted/);
 assert.equal(f.balance(run.run_id,'owner-day:').held.nano_usd,'1000');assert.equal(f.balance(run.run_id,'owner-day:').held.model_calls,'1');
 assert.equal(f.db.prepare("SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='queue-admission'").get(run.run_id).state,'reserved');
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='repriced'").get(run.run_id).n,0);
});

test('maintenance drains stopped admissions in bounded batches without releasing active calls',async t=>{
 const c=config();for(const key of ['owner_daily','project_daily','agent_daily'])c.limits[key]={tokens:20000,nano_usd:200000,model_calls:200};
 const f=await fixture(t,c),a=f.agent();let active;
 for(let i=0;i<106;i++)active=f.service.enqueueAgentMessage('alice',a.agent_id,{text:'Controlled request',client_message_id:`queued-${i}`});
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id!=?").run(active.run_id);
 assert.equal(f.policy.ledger.reconcileUndispatched().released,100);assert.equal(f.balance(active.run_id,'owner-day:').held.tokens,'600');
 assert.equal(f.policy.ledger.reconcileUndispatched().released,5);assert.equal(f.balance(active.run_id,'owner-day:').held.tokens,'100');
 assert.equal(f.policy.ledger.reconcileUndispatched().released,0);
});

test('policy file loading is strict, bounded and shared by the API and worker readiness gate',async t=>{
 const f=await fixture(t),path=join(f.root,'policy.json');writeFileSync(path,JSON.stringify(config()));
 assert.deepEqual(f.mod.loadModelBudgetPolicy(path),config());
 const enabled=f.mod.workbenchExecutionConfiguration({GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'3',GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:path});
 assert.equal(enabled.workbenchExecutionReady,true);assert.deepEqual(enabled.modelBudgetPolicy,config());
 assert.equal(f.mod.workbenchExecutionConfiguration({GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'3'}).workbenchExecutionReady,false);
 const apiUrl=new URL('../../src/config.ts',import.meta.url).href;
 const script=`import {loadBffConfig} from ${JSON.stringify(apiUrl)};const c=loadBffConfig();console.log(JSON.stringify({ready:c.workbenchExecutionReady,policy:c.modelBudgetPolicy}));`;
 const env={GENERAL_AGENT_CSRF_TOKEN:'test-dcbf055943f33d8a',GENERAL_AGENT_ALLOWED_ORIGINS:'https://fixture.invalid',GENERAL_AGENT_WORKSPACES:'ws',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:'test-b99992d64419ae59',GENERAL_AGENT_WORKBENCH_EXECUTION_READY:'true',GENERAL_AGENT_WORKER_CONCURRENCY:'3',GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:path};
 const configured=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.root,env,encoding:'utf8'});assert.equal(configured.status,0,configured.stderr);
 assert.deepEqual(JSON.parse(configured.stdout),{ready:true,policy:config()});
 const missing=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.root,env:{...env,GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE:''},encoding:'utf8'});assert.equal(missing.status,0,missing.stderr);assert.deepEqual(JSON.parse(missing.stdout),{ready:false});
 for(const value of [{...config(),secret:'should not be returned'},{...config(),revision:0},{...config(),limits:{...config().limits,owner_daily:{tokens:-1,nano_usd:1,model_calls:1}}},{...config(),admission_route:{provider:'unpriced',model:'missing'}}]){
  writeFileSync(path,JSON.stringify(value));assert.throws(()=>f.mod.loadModelBudgetPolicy(path),/budget_policy_invalid/);
 }
 writeFileSync(path,' '.repeat(262145));assert.throws(()=>f.mod.loadModelBudgetPolicy(path),/budget_policy_invalid/);
 writeFileSync(path,'{bad json');assert.throws(()=>f.mod.loadModelBudgetPolicy(path),/budget_policy_invalid/);
});
