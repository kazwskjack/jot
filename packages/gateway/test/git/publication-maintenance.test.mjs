import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,lstat,link} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {openProductDatabase} from '../../src/db/database.ts';
import {workspacePublicationSchema,upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {installWorkPublicationIntents} from '../../src/persistent-tasks/work-publication-intents.ts';
import {completedWorkFixture} from '../support/work-completion-source-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
const packageRoot=fileURLToPath(new URL('../../',import.meta.url));
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jot-publication-maintenance-')),path=join(root,'db.sqlite'),db=openProductDatabase(path);t.after(async()=>{db.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:30})});return{root,path,db}}
const maintenance=()=>import('../../src/maintenance/publication-maintenance.ts');

test('offline inspection reads the existing original WAL database without bootstrapping or leaking its path',async t=>{
 const f=await fixture(t),before=schema(f.db),m=await maintenance(),view=m.inspectPublicationMaintenance(f.path);
 assert.equal(view.coordination,'legacy');assert.equal(view.publication_schema,'absent');assert.equal(view.execution_authorized,false);assert.equal(view.offline_pool_drain_observed,false);assert.match(view.database_sha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(view).includes(f.root),false);assert.deepEqual(schema(f.db),before);
 assert.throws(()=>m.inspectPublicationMaintenance(join(f.root,'missing.sqlite')),/publication_maintenance_/);await assert.rejects(lstat(join(f.root,'missing.sqlite')),/ENOENT/);
});

test('offline apply requires the exact inspected database and explicit stopped-pool acknowledgement',async t=>{
 const f=await fixture(t),m=await maintenance(),view=m.inspectPublicationMaintenance(f.path),before=schema(f.db);
 for(const command of [{expected_database_sha256:view.database_sha256},{expected_database_sha256:'0'.repeat(64),offline:true},{expected_database_sha256:view.database_sha256,offline:false},{expected_database_sha256:view.database_sha256,offline:true,force:true}]){assert.throws(()=>m.applyPublicationMaintenance(f.path,command),/publication_maintenance_/);assert.deepEqual(schema(f.db),before)}
 const receipt=m.applyPublicationMaintenance(f.path,{expected_database_sha256:view.database_sha256,offline:true});assert.equal(receipt.coordination,'publication');assert.equal(receipt.publication_schema,'current');assert.equal(receipt.execution_authorized,false);assert.equal(receipt.offline_pool_drain_observed,false);assert.equal(workspacePublicationSchema(f.db),'publication');assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 const done=schema(f.db);assert.equal(m.applyPublicationMaintenance(f.path,{expected_database_sha256:view.database_sha256,offline:true}).state,'already_current');assert.deepEqual(schema(f.db),done);
});

test('current coordination still refuses live original leases before storage bootstrap',async t=>{
 const f=await fixture(t),m=await maintenance();upgradeWorkspacePublicationCoordination(f.db);f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run('synthetic-live-worker','test-worker','0',1,'now');const before=schema(f.db),view=m.inspectPublicationMaintenance(f.path);
 assert.throws(()=>m.applyPublicationMaintenance(f.path,{expected_database_sha256:view.database_sha256,offline:true}),/workspace_publication_upgrade_busy/);assert.deepEqual(schema(f.db),before);
});

test('partial original storage can resume but incompatible or extra immutable triggers cannot be repaired',async t=>{
 const f=await fixture(t),m=await maintenance();installWorkPublicationIntents(f.db);const partial=m.inspectPublicationMaintenance(f.path);assert.equal(partial.publication_schema,'partial');
 m.applyPublicationMaintenance(f.path,{expected_database_sha256:partial.database_sha256,offline:true});f.db.exec('CREATE TRIGGER synthetic_extra_publication_trigger BEFORE UPDATE ON wb_work_publication_intents BEGIN SELECT 1; END');const before=schema(f.db),view=m.inspectPublicationMaintenance(f.path);assert.equal(view.publication_schema,'unsupported');assert.throws(()=>m.applyPublicationMaintenance(f.path,{expected_database_sha256:view.database_sha256,offline:true}),/publication_maintenance_schema_unsupported/);assert.deepEqual(schema(f.db),before);
});

test('administrator CLI inspects and bootstraps only the original database without echoing arguments',async t=>{
 const f=await fixture(t),main='src/maintenance/publication-maintenance-main.ts',run=(...args)=>execFileSync(process.execPath,[main,...args],{cwd:packageRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}),view=JSON.parse(run('inspect',f.path));
 const output=run('apply',f.path,view.database_sha256,'--confirm-offline');assert.equal(output.includes(f.root),false);assert.equal(JSON.parse(output).publication_schema,'current');
 for(const args of [['apply',f.path,view.database_sha256],['apply',f.path,view.database_sha256,'--force'],['inspect',f.path,'extra']]){let error;try{run(...args)}catch(e){error=e}assert.ok(error);assert.equal(error.stderr.toString().includes(f.root),false)}
});

test('maintenance refuses memory, hard-linked and non-WAL inputs rather than changing connection storage',async t=>{
 const f=await fixture(t),m=await maintenance();assert.throws(()=>m.inspectPublicationMaintenance(':memory:'),/publication_maintenance_database_invalid/);const alias=join(f.root,'alias.sqlite');await link(f.path,alias);assert.throws(()=>m.inspectPublicationMaintenance(alias),/publication_maintenance_database_invalid/);
 const other=join(f.root,'non-wal.sqlite'),db=new DatabaseSync(other);db.exec('CREATE TABLE synthetic_note(value TEXT)');db.close();assert.throws(()=>m.inspectPublicationMaintenance(other),/native_git_database_changed/);const read=new DatabaseSync(other,{readOnly:true});try{assert.equal(read.prepare('PRAGMA journal_mode').get().journal_mode,'delete')}finally{read.close()}
});

test('the actual administrator process preserves finalized source proof, versions, bytes and original task records',async t=>{
 const f=await completedWorkFixture(t),path=join(f.root,'db.sqlite'),sources=new FinalizedWorkSources(f.db),before=sources.summary('owner',f.admission.run_id),content=sources.content('owner',f.admission.run_id,'source.md',before.source_sha256);
 const tables=['ga_runs','wb_persistent_tasks','wb_task_run_occurrences','wb_file_versions'];
 const saved=Object.fromEntries(tables.map(name=>[name,f.db.prepare('SELECT * FROM '+name).all()]));
 const run=(...args)=>JSON.parse(execFileSync(process.execPath,['src/maintenance/publication-maintenance-main.ts',...args],{cwd:packageRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']})),inspection=run('inspect',path),result=run('apply',path,inspection.database_sha256,'--confirm-offline');
 assert.equal(result.publication_schema,'current');assert.equal(result.offline_pool_drain_observed,false);assert.deepEqual(sources.summary('owner',f.admission.run_id),before);assert.deepEqual(sources.content('owner',f.admission.run_id,'source.md',before.source_sha256),content);for(const name of tables)assert.deepEqual(f.db.prepare('SELECT * FROM '+name).all(),saved[name]);
});
