import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {TaskCompletionPump} from '../../src/harness/task-completion-pump.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';
const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
const proof={host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}};
async function accepted(t){const f=await completionFixture(t),card=(await f.list())[0];
 assert.equal((await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))})).statusCode,202);return f;}
const client=f=>({goalStatus:async session=>{assert.equal(session,'session-fixture');return {state:before};},goalComplete:async(session,intentId)=>{
 assert.equal(session,'session-fixture');return withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intentId,proof));}});
test('the completion pump consumes accepted criteria and the authenticated persisted proof without executing another run',async t=>{
 const f=await accepted(t),pump=new TaskCompletionPump(f.db,f.coordinator,client(f),{workerId:'worker-1'});
 assert.equal((await pump.processNext()).status,'succeeded');assert.equal(await pump.processNext(),null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('lost host confirmation reply parks its intent and a replacement pump publishes from the committed proof without calling the host again',async t=>{
 const f=await accepted(t);let now=1000,calls=0;
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].completion_state,'awaiting_completion');
 const c=client(f);c.goalComplete=async(session,id)=>{calls++;withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,id,proof));throw new Error('lost reply');};
 const pump=new TaskCompletionPump(f.db,f.coordinator,c,{workerId:'worker-1',now:()=>now});
 assert.equal((await pump.processNext()).status,'pending');assert.equal(await pump.processNext(),null);
 const parked=f.persistentTasks.occurrences('alice',f.task.task_id).items[0];
 assert.equal(parked.business_state,'acceptance_confirmed');
 assert.equal(parked.completion_state,'reconciliation_pending');
 const validator=new ContractValidator();
 const op=validator.operationFor('GET','/v1/persistent-tasks/{task_id}/occurrences');
 assert.equal(validator.validateResponse(op,200,{items:[parked]}).valid,true);
 assert.equal(validator.validateResponse(op,200,{items:[{...parked,completion_state:'invented'}]}).valid,false);
 assert.throws(()=>f.persistentTasks.occurrences('bob',f.task.task_id),/task_not_found/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 now+=6000;
 const replacement=new TaskCompletionPump(f.db,f.coordinator,{goalStatus:async()=>{throw Error('no host retry');},goalComplete:async()=>{throw Error('no host retry');}},{workerId:'worker-2',now:()=>now});
 assert.equal((await replacement.processNext()).status,'succeeded');assert.equal(calls,1);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].completion_state,'completed');
});

test('completion display follows a live or expired claim without exposing private Worker identity or changing business authority',async t=>{
 const f=await accepted(t),pump=new TaskCompletionPump(f.db,f.coordinator,client(f),{workerId:'private-fixture-worker'});
 f.db.prepare('INSERT INTO wb_task_completion_claims VALUES(?,?,?,?,?,NULL)').run(f.runId,'private-fixture-worker','private-fixture-token',Date.now()+60000,0);
 const active=f.persistentTasks.occurrences('alice',f.task.task_id).items[0];
 assert.equal(active.completion_state,'finalizing');assert.equal(active.business_state,'acceptance_confirmed');
 assert.ok(!JSON.stringify(active).includes('private-fixture'));
 f.db.prepare('UPDATE wb_task_completion_claims SET lease_until=0 WHERE run_id=?').run(f.runId);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].completion_state,'reconciliation_pending');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_intents').get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('an overlapping pump cannot claim the same review; revocation during the host await prevents publication',async t=>{
 const f=await accepted(t);let release,started;const begin=new Promise(r=>{started=r;}),wait=new Promise(r=>{release=r;});
 const c=client(f),original=c.goalComplete;c.goalComplete=async(...args)=>{started();await wait;return original(...args);};
 const pump=new TaskCompletionPump(f.db,f.coordinator,c,{workerId:'worker-1'}),other=new TaskCompletionPump(f.db,f.coordinator,client(f),{workerId:'worker-2'});
 const processing=pump.processNext();await begin;assert.equal(await other.processNext(),null);
 f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);release();
 assert.equal((await processing).status,'pending');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('a claimed completion without a matching persisted host receipt never trusts a success-shaped return value',async t=>{
 const f=await accepted(t),pump=new TaskCompletionPump(f.db,f.coordinator,{...client(f),goalComplete:async()=>({confirmed:true,intent_id:'invented'})},{workerId:'worker-1'});
 assert.equal((await pump.processNext()).status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
});

test('an expired worker is fenced after another worker takes over, even when its old host request later succeeds',async t=>{
 const f=await accepted(t);let now=1000,release,started;
 const wait=new Promise(r=>{release=r;}),begin=new Promise(r=>{started=r;});
 const c=client(f),original=c.goalComplete;c.goalComplete=async(...args)=>{started();await wait;return original(...args);};
 const first=new TaskCompletionPump(f.db,f.coordinator,c,{workerId:'old-worker',now:()=>now});
 const pending=first.processNext();await begin;now+=60_001;
 const second=new TaskCompletionPump(f.db,f.coordinator,client(f),{workerId:'replacement-worker',now:()=>now});
 assert.equal((await second.processNext()).status,'succeeded');release();assert.equal((await pending).status,'pending');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_claims').get().n,0);
});

test('the pump restores the exact durable binding before completion and rechecks revoked authority after restore',async t=>{
 for(const revoke of [false,true]){
  const f=await accepted(t),c=client(f),calls=[],complete=c.goalComplete;
  c.goalRestore=async(session,run,id)=>{
   calls.push(id===undefined?'restore-read':'restore-intent');assert.equal(session,'session-fixture');assert.equal(run,f.runId);
   const saved=f.db.prepare('SELECT intent_id FROM wb_task_completion_intents WHERE run_id=?').get(f.runId);
   if(id===undefined)assert.equal(saved,undefined);else assert.equal(id,saved.intent_id);
   if(revoke)f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  };
  c.goalComplete=async(...args)=>{calls.push('complete');return complete(...args);};
  const pump=new TaskCompletionPump(f.db,f.coordinator,c,{workerId:'restoring-worker'});
  assert.equal((await pump.processNext()).status,revoke?'pending':'succeeded');
  assert.deepEqual(calls,revoke?['restore-read']:['restore-read','restore-intent','complete']);
 }
});
