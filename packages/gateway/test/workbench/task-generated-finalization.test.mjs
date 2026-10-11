import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {completionFixture} from './task-completion-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';

test('generated document parts publish only after business and native completion with atomic retry and fixed downloads',async t=>{
 const candidate={text:'Two reviewed documents.',artifact_refs:[]};let group;
 const f=await completionFixture(t,{candidate,prepare:f=>{
  const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);mkdirSync(root,{recursive:true});
  const docs=['First generated report','Second generated report'].map((content,index)=>{
   const path=join(root,`document-${index}.md`);writeFileSync(path,content);return {path,display_name:`report-${index+1}.md`};
  });group=f.artifacts.registerGenerated(f.runId,'finalize-rendered-group',docs);candidate.artifact_refs.push(group.artifact_ref);
 }});
 const card=(await f.list())[0];assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifact_leases WHERE artifact_id=?').get(group.artifact_ref).n,1);
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.equal(response.statusCode,202,response.body);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 assert.throws(()=>f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),/task_finalization_unconfirmed/);
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}}));
 const events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 f.db.exec("CREATE TRIGGER generated_publish_fault BEFORE INSERT ON wb_task_finalizations BEGIN SELECT RAISE(ABORT,'generated_publish_failed'); END");
 assert.throws(()=>f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),/generated_publish_failed/);
 assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);f.db.exec('DROP TRIGGER generated_publish_fault');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifact_leases WHERE artifact_id=?').get(group.artifact_ref).n,1);
 const receipt=f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id);
 const files=f.artifacts.listForRun(f.runId,'alice').items;assert.equal(files.length,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifact_leases WHERE artifact_id=?').get(group.artifact_ref).n,0);
 const event=JSON.parse(f.db.prepare("SELECT payload_json FROM ga_events WHERE type='artifact.upsert' ORDER BY seq LIMIT 1").get().payload_json);
 assert.equal(event.preview_kind,'text');
 const message=JSON.parse(f.db.prepare("SELECT content_json FROM ga_messages WHERE role='assistant'").get().content_json);
 assert.equal(message.attachments.length,2);assert.ok(message.attachments.every(id=>id!==group.artifact_ref));
 for(const [index,id] of message.attachments.entries()){
  const result=await f.app.inject({url:`/v1/artifacts/${id}/download?version=1`,headers:{'x-user-id':'alice'}});
  assert.equal(result.statusCode,200);assert.equal(result.body,index===0?'First generated report':'Second generated report');
 }
 const physical=f.db.prepare('SELECT server_path FROM ga_artifact_parts WHERE artifact_id=? AND part_index=1').get(group.artifact_ref);
 writeFileSync(physical.server_path,'Changed original renderer file');
 assert.deepEqual(f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),receipt);
 const download=await f.app.inject({url:`/v1/artifacts/${message.attachments[0]}/download?version=1`,headers:{'x-user-id':'alice'}});
 assert.equal(download.body,'First generated report');assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,2);
});
