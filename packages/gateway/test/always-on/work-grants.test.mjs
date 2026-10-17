import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {TaskBudgetService} from '../../src/workbench/budget-public.ts';
import {workGrantFixture} from './work-grant-fixture.mjs';
const WorkGrants=(await import('../../src/always-on/work-grants.ts').catch(()=>({}))).WorkGrants;
test('work authorization has an internal immutable grant service',()=>assert.equal(typeof WorkGrants,'function'));
test('explicit work selection derives lineage from accepted planning and ready logical artifacts without execution',async t=>{
 const f=await workGrantFixture(t),before=f.counts(),changes=f.db.prepare('SELECT total_changes() n').get().n,grants=new WorkGrants(f.db,f.budget);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 const grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose-work');
 assert.equal(grant.cycle_id,f.cycle.cycle_id);assert.equal(grant.snapshot_id,f.input.snapshot_id);assert.equal(grant.source_sha256,f.input.source_sha256);assert.equal(grant.execution_authorized,false);assert.equal(grant.source_bytes_verified,false);assert.equal(grant.task_id,f.occurrence.task_id);assert.equal(grant.planning_occurrence_id,f.occurrence.occurrence_id);assert.equal(grant.planning_occurrence_generation,f.occurrence.generation);assert.equal(grant.planning_source_generation,f.occurrence.generation);assert.deepEqual(grant.plans,f.cycle.plans);assert.ok(grant.task_budget_scope_id);assert.ok(Object.isFrozen(grant));
 assert.equal(grants.guard('owner',f.scope,grant.grant_id).grant_id,grant.grant_id);assert.deepEqual(f.counts(),before);assert.equal(f.cycles.get('owner',f.scope,f.cycle.cycle_id).execution_authorized,false);
});
test('lost response and restart replay one historical receipt while exact key or cycle conflicts cannot mint a grant',async t=>{
 const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose'),db=new DatabaseSync(join(f.root,'db.sqlite'));db.exec('PRAGMA foreign_keys=ON');
 try{const restarted=new WorkGrants(db,f.budget);assert.deepEqual(restarted.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose'),grant);assert.deepEqual(restarted.get('owner',f.scope,grant.grant_id),grant);
 assert.throws(()=>restarted.authorize('owner',f.scope,f.cycle.cycle_id,{...f.input,expected_cycle_version:2},'choose'),/idempotency_conflict/);assert.throws(()=>restarted.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'other-key'),/work_grant_exists/);
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');assert.deepEqual(restarted.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose'),grant);assert.throws(()=>restarted.guard('owner',f.scope,grant.grant_id),/authority|work_cycle/);
 }finally{db.close();}
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_grants').get().n,1);
});
test('missing ready artifact, stale CAS and caller-supplied authority fields reject without grants',async t=>{
 const f=await workGrantFixture(t,{prepare:false}),grants=new WorkGrants(f.db,f.budget);
 assert.throws(()=>grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'not-ready'),/work_grant_artifact_required/);
 const p=await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,{signal:new AbortController().signal}),input={...f.input,snapshot_id:p.snapshot.receipt.snapshot_id,source_sha256:p.source_sha256};
 for(const field of ['expected_cycle_version','expected_policy_version','expected_role_version','expected_role_epoch'])assert.throws(()=>grants.authorize('owner',f.scope,f.cycle.cycle_id,{...input,[field]:99},field),/version_conflict/);
 for(const field of ['owner','root','plans','execution_authorized'])assert.throws(()=>grants.authorize('owner',f.scope,f.cycle.cycle_id,{...input,[field]:true},field),/work_grant_invalid/);
 assert.throws(()=>grants.authorize('owner',f.scope,f.cycle.cycle_id,{...input,source_sha256:'b'.repeat(64)},'wrong-source'),/work_grant_source_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_grants').get().n,0);
});
test('foreign owner and cross-scope cannot create, read or guard another owner selection',async t=>{
 const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose');
 for(const [owner,scope] of [['foreign',f.scope],['owner',{...f.scope,project_id:'foreign'}],['owner',{...f.scope,workspace_id:'foreign'}],['owner',{...f.scope,agent_id:'foreign'}]]){
 assert.throws(()=>grants.authorize(owner,scope,f.cycle.cycle_id,f.input,'foreign'),/not_found/);assert.throws(()=>grants.get(owner,scope,grant.grant_id),/not_found/);assert.throws(()=>grants.guard(owner,scope,grant.grant_id),/not_found/);
 }
});
test('fresh guards revoke closed policy role task occurrence source and budget changes while receipts stay historical',async t=>{
 for(const mode of ['close','pause','role','task','cancel','source','budget']){const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose');
 if(mode==='close')f.cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close');
 if(mode==='pause')f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');
 if(mode==='role')f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1 WHERE agent_id=?').run(f.scope.agent_id);
 if(mode==='task')f.db.prepare('UPDATE wb_persistent_tasks SET generation=generation+1 WHERE task_id=?').run(f.occurrence.task_id);
 if(mode==='cancel')f.db.prepare('UPDATE wb_task_occurrences SET generation=-1 WHERE occurrence_id=?').run(f.occurrence.occurrence_id);
 if(mode==='source')f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'new source',expected_version:1});
 if(mode==='budget'){const budgets=new TaskBudgetService(f.db,f.budget),view=budgets.get('owner',f.occurrence.task_id);budgets.update('owner',f.occurrence.task_id,{expected_version:view.version,limits:Object.fromEntries(Object.entries(view.root.used).map(([k,v])=>[k,Number(v)]))});}
 assert.throws(()=>grants.guard('owner',f.scope,grant.grant_id),/work_grant_|work_cycle_/);assert.deepEqual(grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose'),grant);assert.equal(grants.get('owner',f.scope,grant.grant_id).execution_authorized,false);
 }
});
test('SQL rows are immutable and journal or grant tampering is refused on fresh reads',async t=>{
 const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose');
 for(const table of ['wb_discovery_work_grants','wb_discovery_work_grant_commands']){assert.throws(()=>f.db.exec(`UPDATE ${table} SET created_at='tampered'`),/work_grant_immutable/);assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/work_grant_immutable/);assert.throws(()=>f.db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),/work_grant_immutable/);}
 const before=f.db.prepare('SELECT total_changes() n').get().n;grants.get('owner',f.scope,grant.grant_id);grants.guard('owner',f.scope,grant.grant_id);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 f.db.exec('DROP TRIGGER wb_discovery_workspace_records_no_update');f.db.prepare("UPDATE wb_discovery_workspace_records SET record_sha256=? WHERE cycle_id=?").run('0'.repeat(64),f.cycle.cycle_id);assert.throws(()=>grants.guard('owner',f.scope,grant.grant_id),/workspace_journal_corrupt/);
 f.db.exec('DROP TRIGGER wb_discovery_work_grants_no_update');f.db.prepare("UPDATE wb_discovery_work_grants SET grant_sha256=? WHERE grant_id=?").run('0'.repeat(64),grant.grant_id);assert.throws(()=>grants.get('owner',f.scope,grant.grant_id),/work_grant_corrupt/);
});

test('cancelled planning occurrence cannot produce the first grant and absent configured budget is unknown',async t=>{
 const f=await workGrantFixture(t);assert.throws(()=>new WorkGrants(f.db).authorize('owner',f.scope,f.cycle.cycle_id,f.input,'unknown-budget'),/work_grant_budget_unconfirmed/);
 f.db.prepare('UPDATE wb_task_occurrences SET generation=-1 WHERE occurrence_id=?').run(f.occurrence.occurrence_id);
 assert.throws(()=>new WorkGrants(f.db,f.budget).authorize('owner',f.scope,f.cycle.cycle_id,f.input,'cancelled'),/authority_revoked/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_grants').get().n,0);
});
test('constructor on an uninitialized database performs no DDL',()=>{
 const db=new DatabaseSync(':memory:');try{new WorkGrants(db);assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get().n,0);}finally{db.close();}
});
test('ready snapshot file facts must match the pinned logical source before first owner selection',async t=>{
 const f=await workGrantFixture(t),row=f.db.prepare('SELECT * FROM wb_discovery_workspace_records WHERE cycle_id=?').get(f.cycle.cycle_id),record=JSON.parse(row.record_json),{canonicalJson}=await import('../../src/db/canonical-json.ts'),{workspaceManifestHash}=await import('../../src/always-on/workspace-provider.ts'),{createHash}=await import('node:crypto');
 record.manifest.entries.find(e=>e.kind==='file').sha256='b'.repeat(64);record.receipt.manifest_sha256=workspaceManifestHash(record.manifest);const json=canonicalJson(record);
 f.db.exec('DROP TRIGGER wb_discovery_workspace_records_no_update');f.db.prepare('UPDATE wb_discovery_workspace_records SET record_json=?,record_sha256=? WHERE cycle_id=?').run(json,createHash('sha256').update(json).digest('hex'),f.cycle.cycle_id);
 assert.throws(()=>new WorkGrants(f.db,f.budget).authorize('owner',f.scope,f.cycle.cycle_id,f.input,'mismatch'),/work_grant_snapshot_source_mismatch/);
});

test('Unicode logical paths with different UTF8 and UTF16 ordering authorize the same ready snapshot',async t=>{
 const f=await workGrantFixture(t,{prepare:false}),paths=['\uE000.txt','\u{1F600}.txt'];
 for(const path of paths)f.workbench.writeFile('owner',f.scope.workspace_id,{project_id:f.scope.project_id,path,content:'Unicode file '+path,expected_version:0});
 const prepared=await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,{signal:new AbortController().signal}),{WorkCycleSources}=await import('../../src/always-on/work-cycle-sources.ts'),source=new WorkCycleSources(f.db).get('owner',f.scope,f.cycle.cycle_id);
 const sourcePaths=source.files.map(file=>file.path).filter(path=>paths.includes(path)),snapshotPaths=prepared.snapshot.manifest.entries.filter(entry=>entry.kind==='file').map(entry=>entry.path).filter(path=>paths.includes(path));
 assert.deepEqual(sourcePaths,paths);assert.deepEqual(snapshotPaths,[...paths].reverse());
 const grants=new WorkGrants(f.db,f.budget),input={...f.input,snapshot_id:prepared.snapshot.receipt.snapshot_id,source_sha256:prepared.source_sha256},grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,input,'unicode-selection');
 assert.equal(grant.source_sha256,prepared.source_sha256);assert.equal(grant.execution_authorized,false);assert.equal(grant.source_bytes_verified,false);assert.deepEqual(grants.guard('owner',f.scope,grant.grant_id),grant);
});
