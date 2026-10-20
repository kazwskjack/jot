import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join,resolve,sep} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitWorkbench} from '../../src/git/service.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
async function fixture(t){
 const parent=await mkdtemp(join(tmpdir(),'jot-git-producer-')),root=join(parent,'repo'),database=join(parent,'state.sqlite');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic lifecycle fixture');await writeFile(join(root,'note.txt'),'after\n');
 let db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON;CREATE TABLE ga_projects(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,is_default INTEGER,version INTEGER,created_at TEXT,updated_at TEXT);CREATE TABLE ga_worker_leases(resource_id TEXT PRIMARY KEY,owner TEXT,generation INTEGER,expires_at TEXT,updated_at TEXT)');db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Synthetic',0,1,'now','now');
 let service;const connect=(options={})=>{const projects=new ProjectRepository(db),git=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]),intents=new GitMutationIntents(db,projects,git);return service={git,intents,executions:new GitIndexExecutions(db,projects,git,intents,options)}};connect();
 t.after(async()=>{db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())+sep));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20})});
 const snapshot=await service.git.inspect('owner','project'),review=await service.intents.prepare('owner','project',{request_id:'prepare',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await service.intents.control('owner','project',review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 const input={request_id:'execute',expected_version:approved.version,review_sha256:approved.review_sha256},accepted=withImmediateTransaction(db,()=>service.executions.admit('owner','project',approved.intent_id,input));
 return{root,database,input,accepted,get db(){return db},get service(){return service},restart(options){db.close();db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON');return connect(options)},run(signal){return service.executions.perform('owner','project',accepted.execution_id,signal)},producer(){return service.executions.producer('owner','project',accepted.execution_id)}};
}
test('admission is not producer activity and never holds an execution lease',async t=>{
 const f=await fixture(t);assert.equal(f.producer().state,'not_started');assert.equal(f.producer().execution_authorized,false);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
});
test('known preparation failure is durable, generic and never automatically retried',async t=>{
 const f=await fixture(t);let calls=0;f.service.git.indexEffects('owner','project').prepareIndex=async()=>{calls++;throw Error('private diagnostic must not enter the journal')};
 await assert.rejects(f.run());assert.equal(f.producer().state,'failed_before_preparation');assert.equal(JSON.stringify(f.producer()).includes('private diagnostic'),false);
 f.restart();await assert.rejects(f.run(),/git_execution_producer_closed/);assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.deepEqual(f.service.executions.getAdmission('owner','project','execute'),f.accepted);
 for(const table of ['wb_git_index_producers','wb_git_index_producer_finishes'])assert.throws(()=>f.db.exec('DELETE FROM '+table),/git_execution_immutable/);
});
test('live preparation, cancellation and current ownership keep distinct facts',async t=>{
 const f=await fixture(t),controller=new AbortController(),kernel=f.service.git.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel);let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve});kernel.prepareIndex=async(...args)=>{entered();await new Promise(resolve=>{release=resolve});return prepare(...args)};
 const pending=f.run(controller.signal);await waiting;assert.equal(f.producer().state,'running');await assert.rejects(f.run(),/git_execution_busy/);controller.abort();release();await assert.rejects(pending);assert.equal(f.producer().state,'cancelled_before_preparation');
 assert.throws(()=>f.service.executions.producer('foreign','project',f.accepted.execution_id),/project_not_found/);
 f.db.prepare("UPDATE ga_projects SET owner_id='replacement'").run();assert.throws(()=>f.producer(),/project_not_found/);
});
test('applied producer closes once while preserving original acceptance and result',async t=>{
 const f=await fixture(t),result=await f.run();assert.equal(result.state,'applied');assert.equal(f.producer().state,'applied');assert.deepEqual(await f.run(),result);f.restart();assert.equal(f.producer().state,'applied');assert.deepEqual(f.service.executions.getAdmission('owner','project','execute'),f.accepted);
});
test('process loss after producer admission is interrupted, not proof of a safe retry',async t=>{
 const f=await fixture(t),before=await readFile(join(f.root,'.git/index'));
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/producer-crash-worker.mjs',import.meta.url)),f.root,f.database,f.accepted.execution_id],{encoding:'utf8',env:{...process.env,TEMP:tmpdir(),TMP:tmpdir()},timeout:30000,windowsHide:true});assert.equal(child.status,73,child.stderr);assert.equal(f.producer().state,'running');
 f.restart({now:()=>Date.now()+60000});assert.equal(f.producer().state,'interrupted');await assert.rejects(f.run(),/git_execution_producer_unsettled/);assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
 const view=f.service.executions.inspect('owner','project',f.accepted.execution_id),closed=await f.service.executions.abandon('owner','project',f.accepted.execution_id,{request_id:'disposition',expected_state_sha256:view.state_sha256,acknowledge_unknown:true});assert.equal(closed.result.state,'not_dispatched');
});
test('revoked lease cannot append a false terminal producer fact',async t=>{
 const f=await fixture(t),kernel=f.service.git.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel);kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);f.db.prepare("UPDATE ga_worker_leases SET owner='replacement',generation=generation+1,expires_at=?").run(String(Date.now()+60000));return plan};await assert.rejects(f.run(),/workbench_execution_lease_revoked/);assert.equal(f.producer().state,'interrupted');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producer_finishes').get().n,0);assert.equal(f.db.prepare('SELECT owner FROM ga_worker_leases').get().owner,'replacement');
});
for(const phase of ['prepared','dispatch'])test('durable '+phase+' failure is separate from effect reconciliation',async t=>{
 const f=await fixture(t),kernel=f.service.git.indexEffects('owner','project'),apply=kernel.applyIndex.bind(kernel);
 kernel.applyIndex=(plan,authority,signal)=>apply(plan,{...authority,[phase]:raw=>{authority[phase](raw);throw Error('synthetic failure after durable '+phase)}},signal);
 await assert.rejects(f.run());assert.equal(f.producer().state,phase==='prepared'?'prepared':'unknown');assert.equal(f.service.executions.getAdmitted('owner','project',f.accepted.execution_id).state,'unknown');
 const count=f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n;await f.run();assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,count);f.restart();assert.equal(f.producer().state,phase==='prepared'?'prepared':'unknown');
});
test('pre-upgrade original admission keeps its receipt but cannot invent a producer identity',async t=>{
 const f=await fixture(t);f.db.exec('DROP TRIGGER wb_git_index_executions_no_update; UPDATE wb_git_index_executions SET protocol=3');f.restart();assert.equal(f.producer().state,'legacy_untracked');assert.deepEqual(f.service.executions.getAdmission('owner','project','execute'),f.accepted);await assert.rejects(f.run(),/git_execution_producer_legacy/);
});
test('producer persistence failure rolls back the claim before any kernel preparation',async t=>{
 const f=await fixture(t);let calls=0;f.service.git.indexEffects('owner','project').prepareIndex=async()=>{calls++;throw Error('must not dispatch')};f.db.exec("CREATE TRIGGER reject_producer BEFORE INSERT ON wb_git_index_producers BEGIN SELECT RAISE(ABORT,'synthetic_producer_persistence_failure'); END");await assert.rejects(f.run(),/synthetic_producer_persistence_failure/);assert.equal(calls,0);assert.equal(f.producer().state,'not_started');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
});
