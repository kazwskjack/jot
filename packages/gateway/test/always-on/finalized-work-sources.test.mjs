import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {completedWorkFixture} from '../support/work-completion-source-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {TaskReviewOutputs} from '../../src/persistent-tasks/review-outputs.ts';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../src/db/canonical-json.ts';

const counters=db=>({changes:db.prepare('SELECT total_changes() n').get().n,schema:db.prepare('PRAGMA schema_version').get().schema_version,events:db.prepare('SELECT count(*) n FROM ga_events').get().n});
test('finalized original work exposes immutable inspected source and bytes without reusing pending authority',async t=>{
 const f=await completedWorkFixture(t),service=new FinalizedWorkSources(f.db),before=counters(f.db),source=service.summary('owner',f.admission.run_id);
 assert.equal(source.run_id,f.admission.run_id);assert.equal(source.final_message_id,f.finalization.message_id);assert.equal(source.execution_authorized,false);assert.equal(source.work_review.execution_authorized,false);
 assert.equal(source.files.length,1);assert.equal(source.files[0].path,'source.md');assert.equal(source.files[0].sha256,f.write.sha256);assert.equal(service.content('owner',f.admission.run_id,'source.md',source.source_sha256).toString(),'Exact reviewed work content');
 assert.deepEqual(counters(f.db),before,'historical read must not alter schema, data, events or renew any authority');assert.ok(Object.isFrozen(source.files));assert.ok(!JSON.stringify(source).includes(f.root));
 assert.throws(()=>new TaskReviewOutputs(f.db).list('owner',f.card.interaction_id),/task_review_output_unavailable/);
 await writeFile(join(f.prepared.snapshot.isolated_root,'source.md'),'Later mutable tree is different');
 assert.deepEqual(service.summary('owner',f.admission.run_id),source);assert.equal(service.content('owner',f.admission.run_id,'source.md',source.source_sha256).toString(),'Exact reviewed work content');
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-after-completed-source');assert.deepEqual(service.summary('owner',f.admission.run_id),source,'historical read does not restore or depend on current work execution permission');
});
test('unfinalized, foreign, missing and transferred sources never supply publication material',async t=>{
 const f=await completedWorkFixture(t,{finalize:false}),service=new FinalizedWorkSources(f.db);
 assert.throws(()=>service.summary('owner',f.admission.run_id),/completed_work_source_not_found/);f.complete();
 assert.throws(()=>service.summary('foreign',f.admission.run_id),/completed_work_source_not_found/);assert.throws(()=>service.summary('owner','missing-run'),/completed_work_source_not_found/);
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('foreign',f.scope.project_id);assert.throws(()=>service.summary('owner',f.admission.run_id),/completed_work_source_not_found/);
});
test('completed source refuses changed digests, unselected paths and original proof corruption',async t=>{
 const f=await completedWorkFixture(t),service=new FinalizedWorkSources(f.db),source=service.summary('owner',f.admission.run_id);
 assert.throws(()=>service.content('owner',f.admission.run_id,'source.md','0'.repeat(64)),/completed_work_source_conflict/);assert.throws(()=>service.content('owner',f.admission.run_id,'../secret',source.source_sha256),/completed_work_source_not_found/);
 const corruptions=[
  ['DROP TRIGGER wb_task_completion_candidates_no_update',"UPDATE wb_task_completion_candidates SET candidate_json='{}' WHERE run_id=?"],
  ['DROP TRIGGER wb_task_business_certificates_no_update',"UPDATE wb_task_business_certificates SET snapshot_hash='broken' WHERE run_id=?"],
  ['DROP TRIGGER wb_work_inspections_no_update',"UPDATE wb_discovery_work_inspections SET inputs_sha256='broken' WHERE run_id=?"],
  ['DROP TRIGGER wb_execution_receipt_no_update',"UPDATE wb_task_execution_receipts SET result_hash='broken' WHERE run_id=? AND operation='files.write'"],
 ];
 for(const [drop,sql] of corruptions){f.db.exec('SAVEPOINT source_fault');try{f.db.exec(drop);f.db.prepare(sql).run(f.admission.run_id);assert.throws(()=>service.summary('owner',f.admission.run_id),/completed_work_source_unavailable/);}finally{f.db.exec('ROLLBACK TO source_fault;RELEASE source_fault')}}
 assert.deepEqual(service.summary('owner',f.admission.run_id),source);
});
test('a second original version remains exact and tampering with either original BLOB is refused',async t=>{
 const f=await completedWorkFixture(t,{rewrite:true}),service=new FinalizedWorkSources(f.db),source=service.summary('owner',f.admission.run_id);
 assert.equal(source.files[0].version,2);assert.equal(service.content('owner',f.admission.run_id,'source.md',source.source_sha256).toString(),'Second exact reviewed content');
 assert.equal(source.unsupported_changes.length,0);
 for(const version of [1,2]){f.db.exec('SAVEPOINT blob_fault');try{
  f.db.exec('DROP TRIGGER wb_isolated_file_results_update');f.db.prepare('UPDATE wb_isolated_file_results SET bytes=? WHERE cycle_id=? AND path=? AND version=?').run(Buffer.from('Corrupt original bytes'),f.admission.cycle_id,'source.md',version);
  assert.throws(()=>service.summary('owner',f.admission.run_id),/completed_work_source_unavailable/);
 }finally{f.db.exec('ROLLBACK TO blob_fault;RELEASE blob_fault')}}
 assert.deepEqual(service.summary('owner',f.admission.run_id),source);
});
test('a rehashed native proof cannot replace the original completed checkpoint or revive live review',async t=>{
 const f=await completedWorkFixture(t),service=new FinalizedWorkSources(f.db),before=service.summary('owner',f.admission.run_id),saved=f.db.prepare('SELECT proof_json FROM wb_task_native_completions WHERE intent_id=?').get(f.finalization.intent_id);
 f.db.exec('SAVEPOINT native_fault');try{
  const proof=JSON.parse(saved.proof_json);proof.goal.goal_revision++;proof.checkpoint.goal_revision++;
  f.db.exec('DROP TRIGGER wb_task_native_completions_no_update');f.db.prepare('UPDATE wb_task_native_completions SET proof_json=?,proof_hash=? WHERE intent_id=?').run(canonicalJson(proof),createHash('sha256').update(canonicalJson(proof)).digest('hex'),f.finalization.intent_id);
  assert.throws(()=>service.summary('owner',f.admission.run_id),/completed_work_source_unavailable/);
 }finally{f.db.exec('ROLLBACK TO native_fault;RELEASE native_fault')}
 assert.deepEqual(service.summary('owner',f.admission.run_id),before);
});
test('a historical source read is supported by a physically read-only database without migrations',async t=>{
 const f=await completedWorkFixture(t),{DatabaseSync}=await import('node:sqlite'),readOnly=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});
 try{const before=counters(readOnly),service=new FinalizedWorkSources(readOnly),source=service.summary('owner',f.admission.run_id);
  assert.equal(service.content('owner',f.admission.run_id,'source.md',source.source_sha256).toString(),'Exact reviewed work content');assert.deepEqual(counters(readOnly),before);
 }finally{readOnly.close()}
});


test('accepted discovery completion is not an isolated publication source',async t=>{
 const {acceptedWorkCycleFixture}=await import('./work-cycle-fixture.mjs'),f=await acceptedWorkCycleFixture(t),service=new FinalizedWorkSources(f.db),before=counters(f.db);
 assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(f.run).status,'succeeded');
 assert.throws(()=>service.summary('owner',f.run),/completed_work_source_unsupported/);
 assert.deepEqual(counters(f.db),before);
});

test('historical reads retain the caller transaction and never commit unrelated writes',async t=>{
 const f=await completedWorkFixture(t),service=new FinalizedWorkSources(f.db),before=f.db.prepare('SELECT title FROM ga_conversations WHERE id=?').get(f.admission.conversation_id).title;
 f.db.exec('BEGIN IMMEDIATE');try{
  f.db.prepare('UPDATE ga_conversations SET title=? WHERE id=?').run('Synthetic uncommitted title',f.admission.conversation_id);
  const source=service.summary('owner',f.admission.run_id);assert.equal(source.files.length,1);assert.equal(f.db.isTransaction,true);
  assert.throws(()=>service.content('owner',f.admission.run_id,'source.md','0'.repeat(64)),/completed_work_source_conflict/);assert.equal(f.db.isTransaction,true);
 }finally{f.db.exec('ROLLBACK')}
 assert.equal(f.db.prepare('SELECT title FROM ga_conversations WHERE id=?').get(f.admission.conversation_id).title,before);
});


test('one read selection resolves exact immutable bytes in one original read boundary',async t=>{
 const f=await completedWorkFixture(t),service=new FinalizedWorkSources(f.db),source=service.summary('owner',f.admission.run_id),before=counters(f.db);
 assert.equal(typeof service.readSelection,'function');const selection=service.readSelection('owner',f.admission.run_id,['source.md'],source.source_sha256);
 assert.deepEqual(selection.summary,source);assert.equal(selection.files.get('source.md').toString(),'Exact reviewed work content');assert.deepEqual(counters(f.db),before);
 assert.throws(()=>service.readSelection('owner',f.admission.run_id,['source.md','../other'],source.source_sha256),/completed_work_source_not_found/);
});
