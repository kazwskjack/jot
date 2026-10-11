import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';

test('reviewed file output publishes after native confirmation, rolls back atomically and downloads its frozen bytes',async t=>{
 const f=await completionFixture(t,{candidate:{text:'Here is the reviewed report.',presented_files:[{path:'report.md'}]},prepare:f=>{
  const proof=withImmediateTransaction(f.db,()=>{
   const written=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Reviewed original',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'report-output','files.write',written);
  });
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Report file',acceptance:'Contains the reviewed report.',status:'completed',evidence:[proof]},f.runId);
 }});
 const card=(await f.list())[0];
 const initial=await f.app.inject({url:`/v1/conversations/${f.occurrence.conversation_id}/snapshot`,headers:{'x-user-id':'alice'}});
 assert.equal(initial.statusCode,200);assert.deepEqual(initial.json().interactions,[card]);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.equal(response.statusCode,202,response.body);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 assert.throws(()=>f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),/task_finalization_unconfirmed/);
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}}));
 const project=f.workbench.contextForRun(f.runId).project_id;
 f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'Later overwritten',expected_version:1});
 const events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 f.db.exec("CREATE TRIGGER file_publish_fault BEFORE INSERT ON wb_task_finalizations BEGIN SELECT RAISE(ABORT,'file_publish_failed'); END");
 assert.throws(()=>f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),/file_publish_failed/);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);
 f.db.exec('DROP TRIGGER file_publish_fault');
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id);
 const outputs=f.artifacts.listForRun(f.runId,'alice').items;assert.equal(outputs.length,1);
 const event=JSON.parse(f.db.prepare("SELECT payload_json FROM ga_events WHERE type='artifact.upsert'").get().payload_json);
 assert.equal(event.media_type,'text/markdown');assert.equal(event.artifact_id,outputs[0].artifact_id);
 assert.equal(event.preview_kind,'text');assert.equal(event.origin,'generated');
 const content=JSON.parse(f.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant'").get().content_json);
 assert.deepEqual(content.attachments,[outputs[0].artifact_id]);assert.equal(content.blocks[0].text,'Here is the reviewed report.');
 const download=await f.app.inject({url:`/v1/artifacts/${outputs[0].artifact_id}/download?version=1`,headers:{'x-user-id':'alice'}});
 assert.equal(download.statusCode,200);assert.equal(download.body,'Reviewed original');
 const finalEvents=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 assert.deepEqual(f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,finalEvents);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,1);
});

