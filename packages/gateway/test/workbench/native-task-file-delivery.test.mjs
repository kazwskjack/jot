import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {NativeTaskIntents} from '../../src/workbench/native-task-intents.ts';
import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';
import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';
import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {currentTaskCompletionCandidate,prepareTaskPresentedFiles} from '../../src/persistent-tasks/completion-candidates.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {publishTaskOutputs} from '../../src/persistent-tasks/output-delivery.ts';

async function writeMember(f){
 const context=f.workbench.contextForRun(f.runId),member=f.workbench.createAgent('alice',{name:'File author',workspace_id:'ws',project_id:context.project_id});
 const team=f.workbench.createTeam('alice',{name:'File team',workspace_id:'ws',project_id:context.project_id,member_ids:[context.agent_id,member.agent_id]});
 const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));collaboration.save('alice',f.task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:1,max_active:1});
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Author report',acceptance:'The source report is accurate.'},f.runId),intents=new NativeTaskIntents(f.db,f.workbench,f.persistentTasks,collaboration);
 intents.prepare('alice',f.runId,{request_id:'file-author',subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id});
 const lease=f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(f.runId),reservation=new NativeChildReservations(f.db,collaboration,intents).reserve({run_id:f.runId,session_ref:'session-fixture',child_session_ref:'file-author-session',request_id:'file-author',role_ref:member.agent_id,expected_policy_version:1,execution_lease:lease}),child=f.workbench.prepareNativeChild('alice',reservation.reservation_id);
 const response=await f.internal('tool',{run_id:child.run_id,session_ref:child.session_ref,execution_lease:lease,call_id:'author-report',operation:'files.write',arguments:{path:'member-report.md',content:'Original member report',expected_version:0}});assert.equal(response.statusCode,200,response.body);const evidence=response.json().execution_receipt;assert.ok(evidence?.reference);
 f.workbench.closeNativeChild('alice',child.run_id,{protocol:1,session_ref:child.session_ref,parent_session_ref:'session-fixture',seq_exclusive:10,turn_end_seq:9,log_sha256:'a'.repeat(64),driver_nonresident:true,inbox_pending:0});
 return {child,reservation,step,evidence,project:context.project_id};
}
async function memberFixture(t){let member;const f=await fixture(t,'complete',{proposalFiles:[{path:'member-report.md'}],candidate:{text:'The member report is ready.'},prepare:async f=>{member=await writeMember(f);f.persistentTasks.upsertSubtask('alice',f.task.task_id,{subtask_id:member.step.subtask_id,expected_version:member.reservation.task_assignment.subtask_version,status:'completed',evidence:[member.evidence]},f.runId);}});return {...f,member};}

test('native member output is reviewed at its original version and delivered into the parent conversation once',async t=>{
 const f=await memberFixture(t),card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`;
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,0);f.workbench.writeFile('alice','ws',{project_id:f.member.project,path:'member-report.md',content:'Owner edited later',expected_version:1});
 const preview=await f.app.inject({url:base+'/0',headers:{'x-user-id':'alice'}});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.body,'Original member report');
 const accepted=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});assert.equal(accepted.statusCode,202,accepted.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,0);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}},intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}}));
 const delivered=f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),outputs=f.artifacts.listForRun(f.runId,'alice').items;assert.equal(outputs.length,1);assert.equal(f.artifacts.listForRun(f.member.child.run_id,'alice').items.length,0);
 const id=outputs[0].artifact_id;assert.equal(f.db.prepare('SELECT conversation_id FROM ga_artifacts WHERE id=?').get(id).conversation_id,f.occurrence.conversation_id);
 const snapshot=await f.app.inject({url:`/v1/conversations/${f.occurrence.conversation_id}/snapshot`,headers:{'x-user-id':'alice'}});assert.equal(snapshot.statusCode,200,snapshot.body);const final=snapshot.json().messages.filter(m=>m.role==='assistant');assert.equal(final.length,1);assert.deepEqual(final[0].attachments,[id]);assert.ok(snapshot.json().artifacts.some(a=>a.artifact_id===id));
 const file=await f.app.inject({url:`/v1/artifacts/${id}/download?version=1`,headers:{'x-user-id':'alice'}});assert.equal(file.statusCode,200);assert.equal(file.body,'Original member report');
 for(const url of [`/v1/artifacts/${id}/download?version=1`,`/v1/conversations/${f.occurrence.conversation_id}/snapshot`])assert.equal((await f.app.inject({url,headers:{'x-user-id':'bob'}})).statusCode,404);
 assert.deepEqual(f.coordinator.finalizeReviewedTask('alice',f.runId,intent.intent_id),delivered);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,1);
});

test('a native file receipt cannot verify a different task step even in the same occurrence',async t=>{
 await fixture(t,'wait_user',{prepare:async f=>{const member=await writeMember(f),proof=new TaskExecutionEvidence(f.db),other=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Unrelated criterion'},f.runId);
  assert.equal(proof.completionVerified('alice',f.task.task_id,[member.evidence],f.occurrence.occurrence_id,member.step.subtask_id),true);
  assert.equal(proof.completionVerified('alice',f.task.task_id,[member.evidence],f.occurrence.occurrence_id,other.subtask_id),false);
 }});
});

test('frozen file preparation and publication reject changed native scope or a reused wrong-step reference',async t=>{
 const f=await memberFixture(t),frozen=currentTaskCompletionCandidate(f.db,'alice',f.runId),scope=frozen.snapshot;
 const wrongSteps=[...scope.steps,{...scope.steps[0],subtask_id:'different-step'}];
 for(const change of [{owner_id:'bob'},{task_id:'other-task'},{occurrence_id:'other-occurrence'},{frozen_context:JSON.stringify({workspace_id:'other',project_id:f.member.project})},{steps:wrongSteps}]){
  assert.throws(()=>withImmediateTransaction(f.db,()=>prepareTaskPresentedFiles(f.db,{...scope,...change},[{path:'member-report.md'}],f.runId)),/task_completion_evidence_required/);
 }
 assert.throws(()=>withImmediateTransaction(f.db,()=>publishTaskOutputs(f.db,{...frozen,snapshot:{...scope,steps:wrongSteps}},f.runId,f.occurrence.conversation_id)),/task_output_source_unverified/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion({runId:f.member.child.run_id,receiptId:f.member.evidence.reference,content:'Original member report'})),/task_output_source_unverified/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,0);
});

test('native file artifact reuse rejects stale provenance even when stored bytes remain valid',async t=>{
 const f=await memberFixture(t),input={runId:f.member.child.run_id,receiptId:f.member.evidence.reference,deliveryRunId:f.runId,content:'Original member report'};
 const original=withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion(input));
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion(input)),original);
 for(const change of [{run_id:'other-child'},{receipt_id:'other-receipt'},{path:'other.md'},{version:7},{sha256:'c'.repeat(64)},{delivery_run_id:'other-parent'}]){
  f.db.exec('SAVEPOINT stale_artifact');
  try{
   const row=f.db.prepare('SELECT metadata_json FROM ga_artifact_versions WHERE artifact_id=? AND version=1').get(original.artifact_id),metadata=JSON.parse(row.metadata_json);
   // Deliberately emulate an imported legacy database with mismatched metadata.
   // The normal immutable trigger is restored by rolling back this savepoint.
   f.db.exec('DROP TRIGGER ga_task_output_no_content_update');
   metadata.task_file={...metadata.task_file,...change};f.db.prepare('UPDATE ga_artifact_versions SET metadata_json=? WHERE artifact_id=? AND version=1').run(JSON.stringify(metadata),original.artifact_id);
   assert.throws(()=>f.artifacts.registerTaskFileVersion(input),/task_output_artifact_conflict/);
  }finally{f.db.exec('ROLLBACK TO stale_artifact; RELEASE stale_artifact');}
 }
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion(input)),original);
});
