import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {writeFileSync} from 'node:fs';

test('a copied task file artifact stays bound to the original version and fails closed on changed delivery bytes',async t=>{
 let receipt;
 const f=await completionFixture(t,{prepare:f=>{
  receipt=withImmediateTransaction(f.db,()=>{
   const file=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Reviewed report',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'write-report','files.write',file);
  });
 }});
 const input={runId:f.runId,receiptId:receipt.reference,content:'Reviewed report'};
 assert.throws(()=>f.artifacts.registerTaskFileVersion(input),/task_output_transaction_required/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>{f.artifacts.registerTaskFileVersion(input);throw new Error('fixture-publication-rollback');}),/fixture-publication-rollback/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_artifacts WHERE kind='task_output_file'").get().n,0);
 const artifact=withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion(input));
 assert.equal(artifact.origin,'generated');assert.equal(artifact.file_name,'report.md');assert.equal(artifact.version,1);
 const project=f.workbench.contextForRun(f.runId).project_id;
 f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'New logical file',expected_version:1});
 assert.equal(f.artifacts.download(artifact.artifact_id,'alice',1).verified_content.toString(),'Reviewed report');
 const http=await f.app.inject({url:`/v1/artifacts/${artifact.artifact_id}/download?version=1`,headers:{'x-user-id':'alice'}});
 assert.equal(http.statusCode,200);assert.equal(http.body,'Reviewed report');
 assert.equal(f.artifacts.preview(artifact.artifact_id,'alice',1).text,'Reviewed report');
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion(input)),artifact);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.artifacts.registerTaskFileVersion({...input,content:'Fake report'})),/task_output_content_mismatch/);
 assert.throws(()=>f.artifacts.download(artifact.artifact_id,'bob',1),/artifact_not_found/);
 assert.throws(()=>f.db.prepare('UPDATE ga_artifacts SET current_version=2 WHERE id=?').run(artifact.artifact_id),/task_output_artifact_immutable/);
 const row=f.db.prepare('SELECT server_path FROM ga_artifact_versions WHERE artifact_id=?').get(artifact.artifact_id);writeFileSync(row.server_path,'Tampered copy');
 assert.throws(()=>f.artifacts.download(artifact.artifact_id,'alice',1),/task_output_content_mismatch/);
 assert.throws(()=>f.artifacts.preview(artifact.artifact_id,'alice',1),/task_output_content_mismatch/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
