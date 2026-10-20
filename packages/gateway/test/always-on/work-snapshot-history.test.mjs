import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {rename} from 'node:fs/promises';
import {join} from 'node:path';
import {completedWorkFixture} from '../support/work-completion-source-fixture.mjs';
import {WorkCycles} from '../../src/always-on/work-cycles.ts';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {WorkspaceJournal} from '../../src/always-on/workspace-journal.ts';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
const module=await import('../../src/always-on/work-snapshot-history.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error});
const read=(...args)=>{assert.equal(typeof module.readHistoricalWorkSnapshot,'function','original immutable snapshot history needs a separate read path');return module.readHistoricalWorkSnapshot(...args)};
const counters=db=>({schema:db.prepare('PRAGMA schema_version').get().schema_version,changes:db.prepare('SELECT total_changes() n').get().n});

test('two original work admissions retain distinct closed snapshots, including failed work, without renewing execution or output eligibility',async t=>{
 assert.equal(typeof module.readHistoricalWorkSnapshot,'function');
 const f=await completedWorkFixture(t),cycles=new WorkCycles(f.db);
 cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close-history');
 const second=cycles.create('owner',f.scope,{admission_id:f.cycle.admission_id,report_sha256:f.cycle.report_sha256,plan_ids:f.cycle.plans.map(p=>p.plan_id),expected_policy_version:2,expected_role_version:1,expected_role_epoch:1},'second-history');
 const prepared=await f.manager.prepare('owner',f.scope,second.cycle_id,{signal:new AbortController().signal});
 const grant=new WorkGrants(f.db,f.budget).authorize('owner',f.scope,second.cycle_id,{expected_cycle_version:1,expected_policy_version:2,expected_role_version:1,expected_role_epoch:1,snapshot_id:prepared.snapshot.receipt.snapshot_id,source_sha256:prepared.source_sha256},'second-grant');
 const admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()}));
 const before=counters(f.db),old=read(f.db,'owner',f.admission.run_id),current=read(f.db,'owner',admission.run_id);
 assert.notEqual(old.admission.snapshot_id,current.admission.snapshot_id);assert.equal(old.record.isolated_root.path,f.prepared.snapshot.isolated_root);assert.equal(current.record.isolated_root.path,prepared.snapshot.isolated_root);
 assert.equal(old.execution_authorized,false);assert.equal(current.execution_authorized,false);assert.ok(Object.isFrozen(old.record.isolated_root));assert.deepEqual(counters(f.db),before);
 assert.throws(()=>new WorkspaceJournal(f.db).intent('owner',f.scope,f.cycle.cycle_id),/work_cycle_closed/);
 assert.throws(()=>f.resolver.context(f.admission.run_id,f.lease),/run_not_active|execution_lease|work_cycle_closed|not_active/);
 assert.equal(cycles.get('owner',f.scope,f.cycle.cycle_id).state,'closed');
 const lease=f.coordinator.claimNext('history-failure-worker',60000);assert.equal(lease.run_id,admission.run_id);f.coordinator.start(lease);
 f.coordinator.finalizePublication(lease,'failed','SYNTHETIC_HISTORY_FAILURE');cycles.close('owner',f.scope,second.cycle_id,{expected_version:1},'close-failed-history');
 const failedBefore=counters(f.db);assert.deepEqual(read(f.db,'owner',admission.run_id),current);assert.deepEqual(counters(f.db),failedBefore);
 assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(admission.run_id).status,'failed');
 assert.throws(()=>new FinalizedWorkSources(f.db).summary('owner',admission.run_id),/completed_work_source_not_found/);
});

test('historical snapshot read works on the original read-only database and does not inspect or repair missing physical roots',async t=>{
 assert.equal(typeof module.readHistoricalWorkSnapshot,'function');
 const f=await completedWorkFixture(t),expected=read(f.db,'owner',f.admission.run_id);
 new WorkCycles(f.db).close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close-before-restart');
 await rename(expected.record.isolated_root.path,expected.record.isolated_root.path+'-moved');
 const db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});try{
  const before=counters(db);assert.deepEqual(read(db,'owner',f.admission.run_id),expected);assert.deepEqual(counters(db),before);
 }finally{db.close()}
});

test('historical roots remain bound to the original owner, admission and immutable snapshot grant despite a rehashed replacement',async t=>{
 assert.equal(typeof module.readHistoricalWorkSnapshot,'function');
 const f=await completedWorkFixture(t),expected=read(f.db,'owner',f.admission.run_id);
 assert.throws(()=>read(f.db,'foreign',f.admission.run_id),/work_snapshot_history_not_found/);
 assert.throws(()=>read(f.db,'owner','missing-run'),/work_snapshot_history_not_found/);
 f.db.exec('SAVEPOINT synthetic_history_fault');try{
  const saved=f.db.prepare('SELECT * FROM wb_discovery_workspace_records WHERE cycle_id=?').get(f.admission.cycle_id),record=JSON.parse(saved.record_json);record.isolated_root.ino=String(BigInt(record.isolated_root.ino)+1n);
  f.db.exec('DROP TRIGGER wb_discovery_workspace_records_no_update');const json=canonicalJson(record);
  f.db.prepare('UPDATE wb_discovery_workspace_records SET record_json=?,record_sha256=? WHERE cycle_id=?').run(json,createHash('sha256').update(json).digest('hex'),f.admission.cycle_id);
  assert.throws(()=>read(f.db,'owner',f.admission.run_id),/work_snapshot_history_unavailable/);
 }finally{f.db.exec('ROLLBACK TO synthetic_history_fault; RELEASE synthetic_history_fault')}
 assert.deepEqual(read(f.db,'owner',f.admission.run_id),expected);
});
