import test from 'node:test';
import assert from 'node:assert/strict';
import {completedWorkFixture} from '../support/work-completion-source-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {captureFinalizedTaskReportForDatabase} from '../../src/workbench/memory-capture.ts';
import {TaskCompletionPump} from '../../src/harness/task-completion-pump.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {InteractionService} from '../../src/interactions/service.ts';
import {TaskWaitResponder} from '../../src/persistent-tasks/task-wait.ts';
import {RunCommandService} from '../../src/runs/commands.ts';

test('a stale watching capture cannot block certified task completion or rewrite its original batch',async t=>{
 const f=await completedWorkFixture(t,{finalize:false}),agentId=f.agent.agent_id,runId=f.admission.run_id;
 f.workbench.memoryCapture.setPolicy('owner',agentId,{expected_version:0,mode:'suggest',include_automation:true});
 withImmediateTransaction(f.db,()=>f.workbench.memoryCapture.register('owner',agentId,runId));
 const original=f.db.prepare('SELECT capture_id,status,version,policy_version,epoch FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND source_run_id=?').get('owner',agentId,runId);
 assert.deepEqual(original&&{status:original.status,version:original.version,policy_version:original.policy_version,epoch:original.epoch},{status:'watching',version:1,policy_version:1,epoch:1});
 f.workbench.memoryCapture.setPolicy('owner',agentId,{expected_version:1,mode:'suggest',include_automation:true});
 const interactions=new InteractionService(f.db,f.events,new TaskWaitResponder(f.db,f.workbench,new RunCommandService(f.db)));
 interactions.respond(f.card.interaction_id,'owner',{expected_version:f.card.version,answers:f.card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))},'source-owner-review');
 const proof={host_status:'idle',goal:{goal_id:'source-goal',goal_revision:3,phase:'complete',activation:'disarmed',rounds_started:1,max_goal_rounds:1},checkpoint:{session_ref:'work-test-session',seq_exclusive:4,turn_end_seq:2,goal_id:'source-goal',goal_revision:3,log_sha256:'b'.repeat(64)}};
 const pump=new TaskCompletionPump(f.db,f.coordinator,{goalStatus:async session=>{assert.equal(session,'work-test-session');return {state:{host_status:'idle',goal:{goal_id:'source-goal',goal_revision:2,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}}};},goalComplete:async(session,intentId)=>{assert.equal(session,'work-test-session');withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'owner',runId,intentId,proof));}},{workerId:'stale-capture-worker'});
 assert.deepEqual(await pump.processNext(),{run_id:runId,status:'succeeded'});
 const source=new FinalizedWorkSources(f.db).summary('owner',runId),capture=f.db.prepare('SELECT capture_id,status,version,policy_version,epoch FROM wb_memory_captures WHERE owner_id=? AND agent_id=? AND source_run_id=?').get('owner',agentId,runId);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations WHERE run_id=?').get(runId).n,1);
 assert.equal(source.agent_id,agentId);assert.equal(source.run_id,runId);assert.ok(source.certificate_id);assert.equal(source.source_sha256.length,64);
 assert.deepEqual(capture&&{capture_id:capture.capture_id,status:capture.status,version:capture.version,policy_version:capture.policy_version,epoch:capture.epoch},{capture_id:original.capture_id,status:'watching',version:1,policy_version:1,epoch:1});
 assert.equal(f.workbench.listMemory('owner','ws',{agent_id:agentId}).items.length,0);
});

test('task report capture rejects a stale summary digest and an agent outside its pinned scope',async t=>{
 const f=await completedWorkFixture(t),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),agentId=source.agent_id;
 f.workbench.memoryCapture.setPolicy('owner',agentId,{expected_version:0,mode:'suggest'});
 assert.throws(()=>f.workbench.memoryCapture.captureTaskReport('owner',agentId,f.admission.run_id,'0'.repeat(64)),/completed_work_source_conflict/);
 const other=f.workbench.createAgent('owner',{name:'Other task report owner'});
 f.workbench.memoryCapture.setPolicy('owner',other.agent_id,{expected_version:0,mode:'suggest'});
 assert.throws(()=>f.workbench.memoryCapture.captureTaskReport('owner',other.agent_id,f.admission.run_id,source.source_sha256),/memory_scope_forbidden/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM wb_memory_captures').get().n,0);
});

test('task report capture is idempotent, uses owner rejection, and needs a finalized certificate',async t=>{
 const f=await completedWorkFixture(t),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),agentId=source.agent_id;
 f.workbench.memoryCapture.setPolicy('owner',agentId,{expected_version:0,mode:'suggest'});
 const first=f.workbench.memoryCapture.captureTaskReport('owner',agentId,f.admission.run_id,source.source_sha256),again=f.workbench.memoryCapture.captureTaskReport('owner',agentId,f.admission.run_id,source.source_sha256);
 assert.equal(again.capture_id,first.capture_id);assert.equal(again.version,first.version);
 const rejected=f.workbench.memoryCapture.reject('owner',agentId,first.capture_id,first.version);
 assert.equal(rejected.status,'rejected');assert.equal(f.workbench.listMemory('owner','ws',{agent_id:agentId}).items.length,0);
 const unfinished=await completedWorkFixture(t,{finalize:false}),unfinishedAgent=unfinished.agent.agent_id;
 unfinished.workbench.memoryCapture.setPolicy('owner',unfinishedAgent,{expected_version:0,mode:'suggest'});
 assert.throws(()=>unfinished.workbench.memoryCapture.captureTaskReport('owner',unfinishedAgent,unfinished.admission.run_id,'a'.repeat(64)),/completed_work_source_not_found/);
});

test('a private final-message block cannot enter the task-report memory source',async t=>{
 const f=await completedWorkFixture(t),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id);
 f.workbench.memoryCapture.setPolicy('owner',source.agent_id,{expected_version:0,mode:'suggest'});
 const message=f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(source.final_message_id),content=JSON.parse(message.content_json);
 content.blocks[0].exposure='private';f.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run(JSON.stringify(content),source.final_message_id);
 assert.throws(()=>f.workbench.memoryCapture.captureTaskReport('owner',source.agent_id,f.admission.run_id,source.source_sha256),/completed_work_source_unavailable/);
});

test('a finalized certified task report enters owner review under the current suggest policy without applying memory',async t=>{
 const f=await completedWorkFixture(t),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),agentId=source.agent_id;
 f.workbench.memoryCapture.setPolicy('owner',agentId,{expected_version:0,mode:'suggest'});
 const result=captureFinalizedTaskReportForDatabase(f.db,'owner',f.admission.run_id);
 assert.equal(result.status,'ready');assert.equal(result.run_kind,'task');
 const report=f.workbench.memoryCapture.get('owner',agentId,result.capture_id).sources[0];
 assert.equal(report.kind,'task_report');assert.equal(report.certificate_id,source.certificate_id);assert.equal(report.source_sha256,source.source_sha256);
 assert.equal(f.workbench.listMemory('owner','ws',{agent_id:agentId}).items.length,0);
});

test('a finalized task report is skipped when memory capture is off or its suggest policy is stale',async t=>{
 for(const stale of [false,true]){
  const f=await completedWorkFixture(t),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),agentId=source.agent_id;
  if(stale){f.workbench.memoryCapture.setPolicy('owner',agentId,{expected_version:0,mode:'suggest'});f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1 WHERE agent_id=?').run(agentId);}
  assert.equal(captureFinalizedTaskReportForDatabase(f.db,'owner',f.admission.run_id),null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_captures WHERE owner_id=? AND agent_id=?').get('owner',agentId).n,0);
 }
});
