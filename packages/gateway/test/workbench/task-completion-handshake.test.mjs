import test from 'node:test';
import assert from 'node:assert/strict';
import * as handshake from '../../src/persistent-tasks/completion-handshake.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {completionFixture} from './task-completion-fixture.mjs';
import {spawnSync} from 'node:child_process';
const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
const after={host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}};
const tx=(f,fn)=>withImmediateTransaction(f.db,fn);
async function approved(t){const f=await completionFixture(t),card=(await f.list())[0];
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.equal(response.statusCode,202,response.body);return f;
}

test('completion preparation and confirmation retain one immutable intent and receipt, without publishing or resetting the Goal',async t=>{
 const f=await approved(t);
 const intent=tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before));
 assert.deepEqual(tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before)),intent);
 assert.deepEqual(tx(f,()=>handshake.preparedTaskCompletion(f.db,'alice',f.runId)),intent);
 assert.equal(intent.session_ref,'session-fixture');assert.equal(intent.before.goal.max_goal_rounds,1);
 const receipt=tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after));
 assert.deepEqual(tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after)),receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_intents').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');
 assert.equal(f.db.prepare('SELECT goal_revision FROM wb_native_goal_bindings').get().goal_revision,8);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_native_completions').run(),/task_native_completion_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_completion_intents').run(),/task_completion_intent_immutable/);
});

test('a changed native ref, running or armed host, or already-completed Goal cannot prepare completion',async t=>{
 for(const kind of ['ref','running','armed','phase']){
  const f=await approved(t),input=structuredClone(before);
  if(kind==='ref')input.goal.goal_revision++;
  if(kind==='running')input.host_status='running';
  if(kind==='armed')input.goal.activation='armed';
  if(kind==='phase')input.goal.phase='complete';
  assert.throws(()=>tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,input)),/task_completion_handshake_invalid|task_completion_handshake_conflict/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_intents').get().n,0);
 }
});

test('only exact same Goal CAS completion, unchanged rounds, matching Session and durable new checkpoint may be confirmed',async t=>{
 for(const kind of ['goal','revision','phase','armed','running','rounds','cap','session','boundary','checkpoint-revision']){
  const f=await approved(t),intent=tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before)),proof=structuredClone(after);
  if(kind==='goal')proof.goal.goal_id='other-goal';
  if(kind==='revision')proof.goal.goal_revision=10;
  if(kind==='phase')proof.goal.phase='paused';
  if(kind==='armed')proof.goal.activation='armed';
  if(kind==='running')proof.host_status='running';
  if(kind==='rounds')proof.goal.rounds_started=0;
  if(kind==='cap')proof.goal.max_goal_rounds=2;
  if(kind==='session')proof.checkpoint.session_ref='other-session';
  if(kind==='boundary')proof.checkpoint.seq_exclusive=3;
  if(kind==='checkpoint-revision')proof.checkpoint.goal_revision=8;
  assert.throws(()=>tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,proof)),/task_completion_handshake_invalid|task_completion_handshake_conflict|checkpoint_invalid/,kind);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,0);
 }
});

test('preparation does not retain authority after task or owner changes, but an exact committed receipt can be read without executing again',async t=>{
 const f=await approved(t),intent=tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before));
 assert.throws(()=>tx(f,()=>handshake.confirmTaskCompletion(f.db,'mallory',f.runId,intent.intent_id,after)),/task_completion_handshake_not_found/);
 const receipt=tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after));
 f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
 assert.throws(()=>tx(f,()=>handshake.preparedTaskCompletion(f.db,'alice',f.runId)),/task_completion_state_conflict/);
 assert.deepEqual(tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after)),receipt);
 assert.throws(()=>tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before)),/task_completion_state_conflict/);
 const altered=structuredClone(after);altered.checkpoint.log_sha256='c'.repeat(64);
 assert.throws(()=>tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,altered)),/task_completion_handshake_conflict/);
});

test('a stale task after preparation or a receipt-write failure never records native completion',async t=>{
 for(const fault of ['stale','write']){
  const f=await approved(t),intent=tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before));
  if(fault==='stale')f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  else f.db.exec("CREATE TRIGGER native_receipt_fault BEFORE INSERT ON wb_task_native_completions BEGIN SELECT RAISE(ABORT,'native_receipt_save_failed'); END");
  assert.throws(()=>tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after)),/task_completion_state_conflict|native_receipt_save_failed/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_intents').get().n,1);
 }
});

test('a real process exit after committing native confirmation recovers the same receipt without repeating completion or publication',async t=>{
 const f=await approved(t),intent=tx(f,()=>handshake.prepareTaskCompletion(f.db,'alice',f.runId,before));
 const script=`import {DatabaseSync} from 'node:sqlite';
  import {withImmediateTransaction} from ${JSON.stringify(new URL('../../src/db/database.ts',import.meta.url).href)};
  import {confirmTaskCompletion} from ${JSON.stringify(new URL('../../src/persistent-tasks/completion-handshake.ts',import.meta.url).href)};
  const db=new DatabaseSync(${JSON.stringify(f.fixtureConfig.databasePath)});db.exec('PRAGMA foreign_keys=ON');
  withImmediateTransaction(db,()=>confirmTaskCompletion(db,'alice',${JSON.stringify(f.runId)},${JSON.stringify(intent.intent_id)},${JSON.stringify(after)}));
  process.exit(73);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:10000,encoding:'utf8'});
 assert.equal(child.status,73,child.stderr);assert.equal(child.error,undefined);
 const receipt=tx(f,()=>handshake.confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after));assert.equal(receipt.confirmed,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
