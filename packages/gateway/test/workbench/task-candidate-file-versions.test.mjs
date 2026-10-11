import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {currentTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {configureTaskOutputReader} from '../../src/persistent-tasks/output-content.ts';

test('candidate file output pins its owned occurrence receipt and version instead of following the latest logical file',async t=>{
 const f=await completionFixture(t,{candidate:{text:'Review this report',presented_files:[{path:'report.md'}]},prepare:f=>{
  const proof=withImmediateTransaction(f.db,()=>{
   const written=f.workbench.writeFile('alice','ws',{project_id:f.task.project_id??f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Original report',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'file-output','files.write',written);
  });
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Write output',acceptance:'The file contains the reviewed report.',status:'completed',evidence:[proof]},f.runId);
 }});
 const frozen=currentTaskCompletionCandidate(f.db,'alice',f.runId);
 const output=frozen.snapshot.file_outputs[0];assert.equal(output.path,'report.md');assert.equal(output.version,1);assert.equal(output.verified,true);assert.match(output.receipt_id,/^proof-/);
 assert.equal(output.content_verified,true);
 const unconfigured=openProductDatabase(f.fixtureConfig.databasePath);
 try{assert.throws(()=>currentTaskCompletionCandidate(unconfigured,'alice',f.runId),/task_output_reader_unavailable/);}finally{unconfigured.close();}
 assert.throws(()=>configureTaskOutputReader(f.db,()=>{throw new Error('must not replace trusted reader');}),/task_output_reader_already_configured/);
 const project=f.workbench.contextForRun(f.runId).project_id;
 f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'Later replacement',expected_version:1});
 assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.file_outputs,[output]);
 const card=(await f.list())[0];
 assert.match(card.questions[0].description,/report.md · v1 · SHA256/);
 const blob=f.db.prepare('SELECT blob_name FROM wb_file_versions WHERE owner_id=? AND project_id=? AND path=? AND version=1').get('alice',project,'report.md');
 writeFileSync(join(f.workbench.projectRoot('alice','ws',project),'blobs',blob.blob_name),'Tampered original output');
 assert.throws(()=>currentTaskCompletionCandidate(f.db,'alice',f.runId),/task_completion_output_integrity_failed/);
 const accepted=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.notEqual(accepted.statusCode,202,'changed original bytes cannot be accepted');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
});

test('an owner manual file without this occurrence write receipt stays unverified and cannot be grandfathered into a bound output',async t=>{
 const f=await completionFixture(t,{candidate:{text:'Review',presented_files:[{path:'manual.md'}]},prepare:f=>{
  f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'manual.md',content:'Manual file',expected_version:0});
 }});
 assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.file_outputs,[{path:'manual.md',verified:false}]);
 const card=(await f.list())[0];assert.match(card.questions[0].description,/未绑定任务文件版本/);
 const accepted=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.equal(accepted.statusCode,409);
 f.db.exec('DROP TRIGGER wb_task_completion_candidates_no_update');
 const saved=JSON.parse(f.db.prepare('SELECT snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(f.runId).snapshot_json);delete saved.file_outputs;
 f.db.prepare('UPDATE wb_task_completion_candidates SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(saved),f.runId);
 assert.throws(()=>currentTaskCompletionCandidate(f.db,'alice',f.runId),/task_completion_state_conflict/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
});
