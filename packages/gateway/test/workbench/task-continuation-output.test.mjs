import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './task-wait-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';

for(const generated of [false,true])test(`${generated?'generated document':'workspace file'} survives task-input continuation and publishes under the final leaf once`,async t=>{
 let group;
 const f=await fixture(t,'wait_user',{prepare:f=>{
  const project=f.workbench.contextForRun(f.runId).project_id;
  const proof=withImmediateTransaction(f.db,()=>{
   const file=f.workbench.writeFile('alice','ws',{project_id:project,path:'continued-report.md',content:'Original before continuation',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'original-file','files.write',file);
  });
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Produce report',acceptance:'The reviewed original report is delivered.',status:'completed',evidence:[proof]},f.runId);
  if(generated){
   const root=f.workbench.projectRoot('alice','ws',project);mkdirSync(root,{recursive:true});const path=join(root,'rendered.md');writeFileSync(path,'Original before continuation');
   group=f.artifacts.registerGenerated(f.runId,'continuation-original-renderer',[{path,display_name:'continued-report.md'}]);
  }
 }});
 const card=(await f.list())[0],answer=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Use the original report.'}]});
 assert.equal(answer.statusCode,202,answer.body);const next=f.persistentTasks.occurrences('alice',f.task.task_id).items[0].run_id;
 assert.notEqual(next,f.runId);const lease=f.coordinator.claimNext('continuation-output-worker',30000);assert.equal(lease.run_id,next);f.coordinator.start(lease);
 f.modelBudgets.reserve('alice',next,{attempt_id:'continued-model',provider:'fixture',model:'bounded'});
 f.modelBudgets.dispatch('alice',next,'continued-model');f.modelBudgets.settle('alice',next,'continued-model',{inputTokens:5,outputTokens:5,totalTokens:10});
 const identity={run_id:next,session_ref:'session-fixture',goal_id:'goal-fixture',goal_revision:8};
 const internal=(name,payload)=>f.app.inject({method:'POST',url:`/internal/v1/workbench/${name}`,headers:{authorization:'Bearer test-b99992d64419ae59'},payload});
 const proposal=await internal('goal-proposal',{...identity,call_id:'continued-complete',intent:'complete',summary:'Deliver the original report'});assert.equal(proposal.statusCode,200,proposal.body);assert.equal(proposal.json().proposal.accepted,true);
 const saved=await internal('goal-binding',{...identity,action:'save',goal_revision:9});assert.equal(saved.statusCode,200,saved.body);
 f.coordinator.recordCheckpoint(lease,'session-fixture',{session_ref:'session-fixture',seq_exclusive:5,turn_end_seq:4,goal_id:'goal-fixture',goal_revision:9,log_sha256:'c'.repeat(64)});
 f.coordinator.waitForTask(lease,{goal_id:'goal-fixture',goal_revision:9,phase:'paused',turn_end_seq:4},'SESSION_GOAL_WAITING_APPROVAL',{
  text:'The original report is ready.',...(generated?{artifact_refs:[group.artifact_ref]}:{presented_files:[{path:'continued-report.md'}]})});
 const review=(await f.list())[0];assert.equal(review.run_id,next);assert.match(review.questions[0].description,/continued-report\.md.*v1/);
 const accepted=await f.send(`/v1/interactions/${review.interaction_id}/response`,{expected_version:review.version,answers:review.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))},{'idempotency-key':'continuation-review'});assert.equal(accepted.statusCode,202,accepted.body);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:9,phase:'paused',activation:'disarmed',rounds_started:2,max_goal_rounds:2}};
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',next,before));
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',next,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:10,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:6,turn_end_seq:4,goal_id:'goal-fixture',goal_revision:10,log_sha256:'d'.repeat(64)}}));
 const receipt=f.coordinator.finalizeReviewedTask('alice',next,intent.intent_id);assert.equal(receipt.status,'succeeded');
 const outputs=f.artifacts.listForRun(next,'alice').items;assert.equal(outputs.length,1);assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 const result=await f.app.inject({url:`/v1/artifacts/${outputs[0].artifact_id}/download?version=1`,headers:{'x-user-id':'alice'}});assert.equal(result.statusCode,200);assert.equal(result.body,'Original before continuation');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);assert.deepEqual(f.coordinator.finalizeReviewedTask('alice',next,intent.intent_id),receipt);
});
