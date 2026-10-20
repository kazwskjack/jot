import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {completedWorkFixture} from '../support/work-completion-source-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {withImmediateTransaction,openProductDatabase} from '../../src/db/database.ts';
import {reserveWorkspaceOperation,releaseUnstartedWorkspaceOperation,sealWorkspaceFamily,readReservedWorkspaceFamily,settleWorkspaceOperation,installWorkspaceCoordination} from '../../src/workbench/workspace-coordination.ts';
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const original=(f,id='history')=>({owner_id:'owner',project_id:f.scope.project_id,operation_kind:'git_index',operation_id:id,binding_sha256:'a'.repeat(64)});
const pending=(f,id='publication')=>({...original(f,id),operation_kind:'work_publication'});
async function module(){return import('../../src/workbench/workspace-coordination-upgrade.ts')}

test('explicit original-schema upgrade preserves released receipts, native family, triggers and accepted work bytes',async t=>{
 const f=await completedWorkFixture(t),source=new FinalizedWorkSources(f.db),beforeSource=source.summary('owner',f.admission.run_id),old=original(f);
 withImmediateTransaction(f.db,()=>{reserveWorkspaceOperation(f.db,old);sealWorkspaceFamily(f.db,old);releaseUnstartedWorkspaceOperation(f.db,old)});
 const beforeTables=['wb_workspace_reservations','wb_workspace_reservation_releases','wb_workspace_reservation_families','wb_workspace_reservation_settlements'],before=Object.fromEntries(beforeTables.map(table=>[table,f.db.prepare('SELECT * FROM '+table+' ORDER BY reservation_id').all()]));
 const upgrade=await module();assert.equal(upgrade.workspacePublicationSchema(f.db),'legacy');
 const result=upgrade.upgradeWorkspacePublicationCoordination(f.db);assert.equal(result.state,'upgraded');assert.equal(result.execution_authorized,false);assert.equal(result.offline_pool_drain_observed,false);
 assert.equal(upgrade.workspacePublicationSchema(f.db),'publication');for(const table of beforeTables)assert.deepEqual(f.db.prepare('SELECT * FROM '+table+' ORDER BY reservation_id').all(),before[table]);
 assert.deepEqual(source.summary('owner',f.admission.run_id),beforeSource);assert.equal(source.content('owner',f.admission.run_id,'source.md',beforeSource.source_sha256).toString(),'Exact reviewed work content');
 assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.throws(()=>f.db.exec("UPDATE wb_workspace_reservations SET record_sha256='changed'"),/immutable/);
 const version=f.db.prepare('PRAGMA schema_version').get().schema_version,changes=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(upgrade.upgradeWorkspacePublicationCoordination(f.db).state,'already_current');assert.equal(f.db.prepare('PRAGMA schema_version').get().schema_version,version);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 const second=openProductDatabase(join(f.root,'db.sqlite'));try{assert.equal(upgrade.workspacePublicationSchema(second),'publication');assert.deepEqual(second.prepare('PRAGMA foreign_key_check').all(),[]);}finally{second.close()}
});

test('publication uses the same original project hold and can never settle with index-only proof',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module(),source=pending(f);
 assert.throws(()=>withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,source)),/workspace_publication_upgrade_required/);
 upgrade.upgradeWorkspacePublicationCoordination(f.db);const reservation=withImmediateTransaction(f.db,()=>{const value=reserveWorkspaceOperation(f.db,source);sealWorkspaceFamily(f.db,source);return value});
 assert.equal(reservation.execution_authorized,false);assert.equal(withImmediateTransaction(f.db,()=>readReservedWorkspaceFamily(f.db,source)).reservation_id,reservation.reservation_id);
 assert.throws(()=>f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'Must remain blocked',expected_version:1}),/workspace_coordination_required/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,original(f,'concurrent-index'))),/workspace_coordination_required/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>settleWorkspaceOperation(f.db,source)),/workspace_publication_producer_unsettled/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases WHERE reservation_id=?').get(reservation.reservation_id).n,0);
 withImmediateTransaction(f.db,()=>releaseUnstartedWorkspaceOperation(f.db,source));
});

test('held workspaces and even expired recorded Workers prevent migration before any schema change',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module(),old=original(f);withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,old));let before=schema(f.db);
 assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db),/workspace_publication_upgrade_busy/);assert.deepEqual(schema(f.db),before);
 withImmediateTransaction(f.db,()=>releaseUnstartedWorkspaceOperation(f.db,old));f.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,expires_at,generation,updated_at) VALUES(?,?,?,?,?)').run('old-worker','test-worker','0',1,'now');before=schema(f.db);
 assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db),/workspace_publication_upgrade_busy/);assert.deepEqual(schema(f.db),before);
});


test('a final observer cannot remove an original fence and still commit the upgrade',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module(),before=schema(f.db);
 assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db,{onPhase:phase=>{if(phase==='verified')f.db.exec('DROP TRIGGER wb_workspace_run_insert')}}),/workspace_publication_upgrade_integrity|workspace_publication_upgrade_schema_changed/);
 assert.deepEqual(schema(f.db),before);assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
});

test('asynchronous maintenance observers are refused before invocation',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module(),before=schema(f.db);let invoked=false;
 assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db,{onPhase:async()=>{invoked=true}}),/workspace_publication_upgrade_invalid|workspace_publication_upgrade_async_callback/);
 assert.equal(invoked,false);assert.deepEqual(schema(f.db),before);
});


test('a maintenance connection with temporary fences is not silently rebuilt',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module();f.db.exec("CREATE TEMP TRIGGER private_temporary_fence BEFORE UPDATE ON main.wb_workspace_reservations BEGIN SELECT RAISE(ABORT,'temporary_fence'); END");const before=f.db.prepare('SELECT name,sql FROM sqlite_temp_schema').all();
 assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db),/workspace_publication_upgrade_connection_unconfirmed/);assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_temp_schema').all(),before);
});

test('schema readiness never folds case-sensitive operation literals into an accepted old schema',async t=>{
 const upgrade=await module(),db=new DatabaseSync(':memory:');try{db.exec(`CREATE TABLE wb_workspace_reservations(
 reservation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN('GIT_INDEX')),operation_id TEXT NOT NULL,
 binding_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,record_sha256 TEXT NOT NULL,UNIQUE(operation_kind,operation_id))`);
 assert.equal(upgrade.workspacePublicationSchema(db),'unsupported');
 }finally{db.close()}
});


test('copy/recreate faults restore the actual complete schema, dependent view and FK enforcement',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module();f.db.exec('CREATE VIEW original_hold_projection AS SELECT reservation_id,operation_kind FROM wb_workspace_reservations');
 const before=schema(f.db),beforeSource=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id);
 for(const fault of ['copied','recreated','verified']){
  assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db,{onPhase:phase=>{if(phase===fault)throw Error('Controlled schema failure')}}),/Controlled schema failure/);
  assert.deepEqual(schema(f.db),before);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),beforeSource);
 }
 upgrade.upgradeWorkspacePublicationCoordination(f.db);assert.deepEqual(f.db.prepare('SELECT * FROM original_hold_projection').all(),[]);
});

test('real orphaned dependency injection cannot commit and restores every original trigger',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module(),before=schema(f.db);
 assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db,{onPhase:phase=>{if(phase==='recreated')f.db.prepare('INSERT INTO wb_workspace_reservation_releases VALUES(?,?)').run('missing-reservation','now')}}),/workspace_publication_upgrade_integrity/);
 assert.deepEqual(schema(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
});

test('publication schema readiness and idempotent upgrade work on an original physically read-only DB',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module();upgrade.upgradeWorkspacePublicationCoordination(f.db);const db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});
 try{const before=schema(db),changes=db.prepare('SELECT total_changes() n').get().n;assert.equal(upgrade.workspacePublicationSchema(db),'publication');assert.equal(upgrade.upgradeWorkspacePublicationCoordination(db).state,'already_current');assert.deepEqual(schema(db),before);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);}finally{db.close()}
});


test('an actual maintenance process loss rolls back original schema and receipts before publication',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module(),before=schema(f.db),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),worker=fileURLToPath(new URL('./fixtures/workspace-upgrade-worker.mjs',import.meta.url));
 for(const phase of ['copied','recreated']){
  let status;try{execFileSync(process.execPath,[worker,join(f.root,'db.sqlite'),phase],{stdio:['ignore','pipe','pipe']})}catch(error){status=error.status}assert.equal(status,88);
  assert.deepEqual(schema(f.db),before);assert.equal(upgrade.workspacePublicationSchema(f.db),'legacy');assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id),source);
 }
 assert.equal(upgrade.upgradeWorkspacePublicationCoordination(f.db).state,'upgraded');
});

test('an unrecognized original table constraint refuses rather than rewriting frozen schema',async t=>{
 const f=await completedWorkFixture(t),upgrade=await module();f.db.exec('ALTER TABLE wb_workspace_reservations ADD COLUMN unknown_extension TEXT');const before=schema(f.db);
 assert.equal(upgrade.workspacePublicationSchema(f.db),'unsupported');assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db),/workspace_publication_upgrade_schema_unsupported/);assert.deepEqual(schema(f.db),before);
});


test('a pending original Git admission blocks migration even before it acquires a workspace or Worker',async t=>{
 const {publicationReviewFixture}=await import('../support/work-publication-fixture.mjs'),{GitMutationIntents}=await import('../../src/git/intents.ts'),{GitIndexExecutions}=await import('../../src/git/index-executions.ts'),{ProjectRepository}=await import('../../src/projects/repository.ts'),{writeFile}=await import('node:fs/promises');
 const f=await publicationReviewFixture(t),upgrade=await module();await writeFile(join(f.rootTarget,'source.md'),'Synthetic pending Git edit');
 const intents=new GitMutationIntents(f.db,new ProjectRepository(f.db),f.workbench),executions=new GitIndexExecutions(f.db,new ProjectRepository(f.db),f.workbench,intents),snapshot=await f.workbench.inspect('owner',f.scope.project_id),review=await intents.prepare('owner',f.scope.project_id,{request_id:'pending-index-review',action:'stage',paths:['source.md'],snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve-index',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:'pending-index-execution',expected_version:approved.version,review_sha256:approved.review_sha256}));
 const before=schema(f.db);assert.throws(()=>upgrade.upgradeWorkspacePublicationCoordination(f.db),/workspace_publication_upgrade_busy/);assert.deepEqual(schema(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations').get().n,0);
});


test('schema readiness preserves whitespace inside operation literals',async t=>{
 const upgrade=await module();for(const value of ['git_ index','git_index ']){const db=new DatabaseSync(':memory:');try{db.exec(`CREATE TABLE wb_workspace_reservations(
 reservation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN('${value}')),operation_id TEXT NOT NULL,
 binding_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,record_sha256 TEXT NOT NULL,UNIQUE(operation_kind,operation_id))`);assert.equal(upgrade.workspacePublicationSchema(db),'unsupported');}finally{db.close()}}
});
