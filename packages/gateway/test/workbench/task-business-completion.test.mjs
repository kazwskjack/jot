import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {currentTaskCompletionCandidate,freezeTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

const candidate={text:'The report is ready. This still needs the user to verify its criteria.',blocks:[{kind:'text',text:'The report is ready. This still needs the user to verify its criteria.'}]};
const prepare=async f=>{
 const proof=new TaskExecutionEvidence(f.db).record(f.runId,'observed-read','universe_read_page',{url:'https://fixture.invalid/report',title:'Observed report'});
 f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Read report',acceptance:'The source supports the report conclusion.',status:'completed',evidence:[proof]},f.runId);
};

test('a task Runner saying completed with a nonempty answer cannot publish or notify without business acceptance',async t=>{
 const f=await fixture(t),card=(await f.list())[0];
 const reply=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Use Markdown.'}]});assert.equal(reply.statusCode,202,reply.body);
 let notified=0;
 const worker=new HarnessWorker(f.db,f.coordinator,{run:async()=>({observed:true,completed:true,final_text:'A claimed completed answer',runtime_status:'completed',reason_code:'COMPLETED'})},
  {workerId:'completion-review-worker',leaseMs:30000,executionGuard:f.workbench,sessionResolver:()=> 'session-fixture',channelDelivery:{enqueueText(){notified++;return {};}}});
 const result=await worker.processNext();assert.ok(result);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.notEqual(f.runs.get(result.run_id,'alice').status,'succeeded');assert.equal(notified,0);
 assert.equal(f.runs.get(result.run_id,'alice').error_code,'TASK_BUSINESS_REVIEW_REQUIRED');
});

test('Worker preserves a stopped native candidate through the real checkpoint and waiting transaction',async t=>{
 const f=await fixture(t),card=(await f.list())[0];
 const answer=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Use the original report criteria.'}]});assert.equal(answer.statusCode,202,answer.body);
 let child;
 const runner={run:async input=>{
  child=input.taskRequestId;
  // This scripted Runner still consumes and settles its inherited admission
  // hold; an untouched reservation is not proof that a task is quiescent.
  f.modelBudgets.reserve('alice',child,{attempt_id:'candidate-call',provider:'fixture',model:'bounded'});
  f.modelBudgets.dispatch('alice',child,'candidate-call');
  f.modelBudgets.settle('alice',child,'candidate-call',{inputTokens:5,outputTokens:5,totalTokens:10});
  const internal=(name,payload)=>f.app.inject({method:'POST',url:`/internal/v1/workbench/${name}`,headers:{authorization:'Bearer test-b99992d64419ae59'},payload});
  const identity={run_id:child,session_ref:'session-fixture'},goal={goal_id:'goal-fixture',goal_revision:8};
  await prepare({...f,runId:child});
  const proposal=await internal('goal-proposal',{...identity,...goal,call_id:'child-complete',intent:'complete',summary:'The report is ready for review.'});assert.equal(proposal.statusCode,200,proposal.body);assert.equal(proposal.json().proposal.accepted,true);
  const saved=await internal('goal-binding',{...identity,...goal,goal_revision:9,action:'save'});assert.equal(saved.statusCode,200,saved.body);
  await input.onCheckpoint({session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:3,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)});
  return {observed:true,completed:false,runtime_status:'runtime_observed',reason_code:'SESSION_GOAL_WAITING_APPROVAL',
   task_stop:{goal_id:'goal-fixture',goal_revision:9,phase:'paused',turn_end_seq:3},task_candidate:candidate};
 }};
 const worker=new HarnessWorker(f.db,f.coordinator,runner,{workerId:'candidate-worker',leaseMs:30000,executionGuard:f.workbench,sessionResolver:()=> 'session-fixture'});
 await worker.processNext();
 assert.equal(currentTaskCompletionCandidate(f.db,'alice',child).candidate.text,candidate.text);
 assert.equal(f.runs.get(child,'alice').status,'waiting_approval');
 assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(child).n,0);
});

test('a changed proposal or failed candidate save rolls waiting state, card and lease release back together',async t=>{
 for(const fault of ['changed-criteria','save-failed']){
  let observed;
  await assert.rejects(fixture(t,'complete',{prepare,candidate,afterProposal:async f=>{
   observed=f;
   if(fault==='changed-criteria'){
    const step=f.persistentTasks.subtasks('alice',f.task.task_id).items[0];
    f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,acceptance:'A requirement changed after the complete proposal.'},f.runId);
   }else f.db.exec("CREATE TRIGGER candidate_save_fault BEFORE INSERT ON wb_task_completion_candidates BEGIN SELECT RAISE(ABORT,'candidate_save_failed'); END");
  }}),/task_completion_state_conflict|candidate_save_failed/);
  assert.equal(observed.runs.get(observed.runId,'alice').status,'running');
  assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_completion_candidates').get().n,0);
  assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_wait_interactions').get().n,0);
  assert.equal(observed.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(observed.runId).n,1);
 }
});

test('owner review cannot use a frozen candidate after criteria, proof or task authority changes',async t=>{
 for(const change of ['criteria','proof','task','role']){
  const f=await fixture(t,'complete',{prepare,candidate});
  assert.equal(currentTaskCompletionCandidate(f.db,'alice',f.runId).candidate.text,candidate.text);
  assert.throws(()=>currentTaskCompletionCandidate(f.db,'mallory',f.runId),/task_completion_candidate_not_found/);
  const step=f.persistentTasks.subtasks('alice',f.task.task_id).items[0];
  if(change==='criteria')f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,acceptance:'A changed requirement.'},f.runId);
  if(change==='proof')f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,evidence:[{kind:'tool_receipt',reference:'unobserved-proof'}]},f.runId);
  if(change==='task')f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  if(change==='role')f.workbench.updateAgent('alice',f.a.agent_id,{expected_version:f.a.version,status:'disabled'});
  assert.throws(()=>currentTaskCompletionCandidate(f.db,'alice',f.runId),/task_completion_state_conflict|task_completion_evidence_required/);
 }
});

test('a confirmed complete proposal freezes criteria and candidate together without treating receipts as business acceptance',async t=>{
 const f=await fixture(t,'complete',{prepare,candidate});
 const frozen=f.db.prepare('SELECT * FROM wb_task_completion_candidates WHERE run_id=?').get(f.runId);assert.ok(frozen);
 assert.equal(frozen.occurrence_id,f.occurrence.occurrence_id);assert.equal(frozen.checkpoint_id,f.checkpointId);
 assert.equal(JSON.parse(frozen.candidate_json).text,candidate.text);
 const snapshot=JSON.parse(frozen.snapshot_json);assert.equal(snapshot.objective,'Produce the authorized report');assert.equal(snapshot.steps.length,1);
 assert.equal(snapshot.steps[0].acceptance,'The source supports the report conclusion.');
 assert.equal(snapshot.steps[0].evidence.length,1);assert.equal(snapshot.steps[0].business_verdict,'unreviewed');
 assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');assert.equal(frozen.status,undefined);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 const id=withImmediateTransaction(f.db,()=>freezeTaskCompletionCandidate(f.db,f.runId,candidate));assert.equal(id,frozen.candidate_id);
 assert.throws(()=>withImmediateTransaction(f.db,()=>freezeTaskCompletionCandidate(f.db,f.runId,{text:'Another answer.'})),/task_completion_state_conflict/);
 assert.throws(()=>f.db.prepare('UPDATE wb_task_completion_candidates SET candidate_json=? WHERE run_id=?').run('{}',f.runId),/task_completion_candidate_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_completion_candidates WHERE run_id=?').run(f.runId),/task_completion_candidate_immutable/);
});
