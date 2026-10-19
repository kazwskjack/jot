import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {linkSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,rename} from 'node:fs/promises';import {lstatSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve,sep,dirname} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitWorkbench} from '../../src/git/service.ts';import {GitMutationIntents} from '../../src/git/intents.ts';
async function fixture(t,{legacy=false}={}){
 const {GitIndexExecutions}=await import('../../src/git/index-executions.ts'),parent=await mkdtemp(join(tmpdir(),'jot-git-execution-')),root=join(parent,'repo'),database=join(parent,'journal.sqlite'),childTemp=join(parent,'child-temp');await mkdir(root);await mkdir(childTemp);const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic execution fixture');await writeFile(join(root,'note.txt'),'after\n');
 let db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON;CREATE TABLE ga_projects(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,is_default INTEGER,version INTEGER,created_at TEXT,updated_at TEXT);CREATE TABLE ga_worker_leases(resource_id TEXT PRIMARY KEY,owner TEXT,generation INTEGER,expires_at TEXT,updated_at TEXT)');db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Test',0,1,'now','now');
 if(legacy)db.exec(`CREATE TABLE wb_git_index_executions(execution_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,intent_id TEXT NOT NULL UNIQUE REFERENCES wb_git_mutation_intents(intent_id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('stage','unstage')),witness_sha256 TEXT NOT NULL,repository_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner_id,project_id,request_id))`);
 let serviceOptions={};const connect=()=>{const projects=new ProjectRepository(db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]),intents=new GitMutationIntents(db,projects,workbench),executions=new GitIndexExecutions(db,projects,workbench,intents,serviceOptions);return{projects,workbench,intents,executions};};let current=connect(),seq=0;
 t.after(async()=>{db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())+sep));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{root,database,childTemp,git,get db(){return db},get current(){return current},restart(options={}){db.close();db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON');serviceOptions=options;current=connect();return current;},async review(){const s=await current.workbench.inspect('owner','project'),p=await current.intents.prepare('owner','project',{request_id:'prepare-'+(++seq),action:'stage',paths:['note.txt'],snapshot_id:s.snapshot_id}),approved=await current.intents.control('owner','project',p.intent_id,{request_id:'approve-'+seq,action:'approve',expected_version:1,review_sha256:p.review_sha256});return{approved,input:{request_id:'execute-'+seq,expected_version:approved.version,review_sha256:approved.review_sha256}};}};
}

for(const phase of ['before-record','before-link-1',...Array.from({length:4},(_,i)=>['after-link-'+(i+1),'after-unlink-'+(i+1)]).flat()])test('lock acquisition process loss: '+phase,async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),before=await readFile(join(f.root,'.git/index'));
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/lock-acquisition-crash-worker.mjs',import.meta.url)),f.root,f.database,approved.intent_id,input.request_id,phase],{encoding:'utf8',env:{...process.env,TEMP:f.childTemp,TMP:f.childTemp},timeout:30000,windowsHide:true});
 assert.equal(child.error,undefined);assert.equal(child.status,73,child.stderr);
 f.db.exec('DROP TRIGGER IF EXISTS crash_before_preparation');
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get();assert.equal(row.protocol,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispatches').get().n,0);
 assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
 const names=await readdir(join(f.root,'.git')),pending=names.filter(name=>/^jot-index-lock-/.test(name));
 if(phase==='before-record'){
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_preparations').get().n,0);
  assert.equal(names.some(name=>name.endsWith('.lock')),false);assert.equal(pending.length,4);
 }else{
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_preparations').get().n,1);
  assert.equal(f.current.executions.get('owner','project',row.execution_id).state,'unknown');
  await assert.rejects(f.current.executions.reconcile('owner','project',row.execution_id),/git_execution_busy/);
  const result=await f.restart({now:()=>Date.now()+60000}).executions.reconcile('owner','project',row.execution_id);
  assert.equal(result.state,'unknown');assert.equal(result.observation,'not_dispatched');
  assert.equal((await readdir(join(f.root,'.git'))).some(name=>name.endsWith('.lock')||name.startsWith('jot-index-lock-')),false);
 }
 const head=f.git('rev-parse','HEAD').trim();assert.doesNotThrow(()=>f.git('update-ref','refs/heads/main',head));
 assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
});
test('original execution publishes once, reopens its immutable result and never revives a cancelled approval',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),result=await f.current.executions.execute('owner','project',approved.intent_id,input);assert.equal(result.state,'applied');assert.equal(f.git('show',':note.txt'),'after\n');assert.equal(result.execution_authorized,false);assert.equal(JSON.stringify(result).includes(f.root),false);
 const reopened=f.restart();assert.deepEqual(reopened.executions.get('owner','project',result.execution_id),result);await reopened.intents.control('owner','project',approved.intent_id,{request_id:'cancel-after-result',expected_version:2,action:'cancel',review_sha256:approved.review_sha256});assert.deepEqual(await reopened.executions.execute('owner','project',approved.intent_id,input),result);
 await assert.rejects(reopened.executions.execute('owner','project',approved.intent_id,{...input,expected_version:3}),/idempotency_conflict/);await assert.rejects(reopened.executions.execute('foreign','project',approved.intent_id,input),/project_not_found/);
 for(const table of ['wb_git_index_executions','wb_git_index_dispatches','wb_git_index_outcomes'])assert.throws(()=>f.db.exec('DELETE FROM '+table),/git_execution_immutable/);
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('new-owner','project');assert.throws(()=>reopened.executions.get('owner','project',result.execution_id),/project_not_found/);await assert.rejects(reopened.executions.execute('owner','project',approved.intent_id,input),/project_not_found/);
});
test('an outcome write failure after physical publication recovers the same execution without another index effect',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER fail_index_outcome BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_outcome_failure'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_outcome_failure/);f.db.exec('DROP TRIGGER fail_index_outcome');const row=f.db.prepare('SELECT execution_id FROM wb_git_index_executions').get(),index=join(f.root,'.git/index'),identity=lstatSync(index).ino,bytes=await readFile(index);assert.equal(f.current.executions.get('owner','project',row.execution_id).state,'unknown');
 const result=await f.restart().executions.reconcile('owner','project',row.execution_id);assert.equal(result.state,'applied');assert.equal(lstatSync(index).ino,identity);assert.deepEqual(await readFile(index),bytes);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispatches').get().n,1);assert.deepEqual(await f.current.executions.execute('owner','project',approved.intent_id,input),result);
});
test('approval cancelled during asynchronous preparation cannot dispatch an original effect',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),engine=f.current.workbench.indexEffects('owner','project'),prepare=engine.prepareIndex.bind(engine),before=await readFile(join(f.root,'.git/index'));engine.prepareIndex=async(...args)=>{const plan=await prepare(...args);await f.current.intents.control('owner','project',approved.intent_id,{request_id:'cancel-during-prepare',expected_version:2,action:'cancel',review_sha256:approved.review_sha256});return plan;};
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/git_execution_revoked/);assert.deepEqual(await readFile(join(f.root,'.git/index')),before);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispatches').get().n,0);
});
test('the existing Worker lease excludes another process and caller overrides cannot become authority',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run('git-index-binding:'+f.current.workbench.executionBinding('owner','project'),'another-worker',4,String(Date.now()+60000),'now');
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/git_execution_busy/);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_executions').get().n,0);await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,{...input,root:'/untrusted'}),/git_execution_invalid/);
});

test('a real executor crash retains original dispatch, fences its old Worker and releases only proven owned locks',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/execution-crash-worker.mjs',import.meta.url)),f.root,f.database,approved.intent_id,input.request_id],{encoding:'utf8',env:{...process.env,TEMP:f.childTemp,TMP:f.childTemp},timeout:30000,windowsHide:true});assert.equal(child.error,undefined);assert.equal(child.status,73,child.stderr);f.db.exec('DROP TRIGGER crash_before_outcome');const original=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),lease=f.db.prepare('SELECT * FROM ga_worker_leases').get(),index=join(f.root,'.git/index'),identity=lstatSync(index).ino;
 await assert.rejects(f.current.executions.reconcile('owner','project',original.execution_id),/git_execution_busy/);const reopened=f.restart({now:()=>Date.now()+60000}),result=await reopened.executions.reconcile('owner','project',original.execution_id);assert.equal(result.state,'applied');assert.equal(lstatSync(index).ino,identity);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispatches').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_outcomes').get().n,1);assert.ok(Number(lease.generation)>0);
 const head=f.git('rev-parse','HEAD').trim();assert.doesNotThrow(()=>f.git('update-ref','refs/heads/main',head));assert.deepEqual(await reopened.executions.execute('owner','project',approved.intent_id,input),result);
});

test('an unresolved original dispatch blocks a fresh request until its original outcome is reconciled',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER unknown_index_outcome BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_unknown_outcome'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_unknown_outcome/);f.db.exec('DROP TRIGGER unknown_index_outcome');
 const s=await f.current.workbench.inspect('owner','project'),p=await f.current.intents.prepare('owner','project',{request_id:'prepare-unstage',action:'unstage',paths:['note.txt'],snapshot_id:s.snapshot_id}),a=await f.current.intents.control('owner','project',p.intent_id,{request_id:'approve-unstage',expected_version:1,action:'approve',review_sha256:p.review_sha256}),next={request_id:'execute-unstage',expected_version:a.version,review_sha256:a.review_sha256};
 await assert.rejects(f.current.executions.execute('owner','project',a.intent_id,next),/git_execution_reconciliation_required/);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_executions').get().n,1);const original=f.db.prepare('SELECT execution_id FROM wb_git_index_executions').get();await f.current.executions.reconcile('owner','project',original.execution_id);assert.equal((await f.current.executions.execute('owner','project',a.intent_id,next)).state,'applied');assert.equal(f.git('show',':note.txt'),'before\n');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'after\n');
});

test('a former Worker cannot publish after its original lease is replaced during preparation',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),engine=f.current.workbench.indexEffects('owner','project'),prepare=engine.prepareIndex.bind(engine),before=await readFile(join(f.root,'.git/index'));engine.prepareIndex=async(...args)=>{const plan=await prepare(...args);f.db.prepare('UPDATE ga_worker_leases SET owner=?,generation=generation+1,expires_at=?').run('replacement-worker',String(Date.now()+60000));return plan;};
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/workbench_execution_lease_revoked/);assert.deepEqual(await readFile(join(f.root,'.git/index')),before);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispatches').get().n,0);assert.equal(f.db.prepare('SELECT owner FROM ga_worker_leases').get().owner,'replacement-worker');
});

test('failed preparation persistence creates no conventional lock or source object dispatch',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),before=await readFile(join(f.root,'.git/index'));
 f.db.exec("CREATE TRIGGER fail_preparation BEFORE INSERT ON wb_git_index_preparations BEGIN SELECT RAISE(ABORT,'test_preparation_failure'); END");
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_preparation_failure/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_preparations').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispatches').get().n,0);
 assert.equal((await readdir(join(f.root,'.git'))).some(name=>name.endsWith('.lock')||name.startsWith('jot-index-lock-')),false);assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
});

test('in-process cleanup also preserves an owned lock whose contents were changed externally',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),engine=f.current.workbench.indexEffects('owner','project'),apply=engine.applyIndex.bind(engine);
 engine.applyIndex=(plan,authority,signal)=>apply(plan,{...authority,commit:(publish,proof)=>{const fs=process.getBuiltinModule('fs');fs.writeFileSync(join(f.root,'.git/HEAD.lock'),'outside writer bytes');return authority.commit(publish,proof);}},signal);
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input));
 assert.equal(await readFile(join(f.root,'.git/HEAD.lock'),'utf8'),'outside writer bytes');
 assert.equal(f.git('show',':note.txt'),'before\n');
});

test('preparation cleanup preserves changed bytes, foreign files and unknown hard links',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/lock-acquisition-crash-worker.mjs',import.meta.url)),f.root,f.database,approved.intent_id,input.request_id,'after-link-2'],{encoding:'utf8',env:{...process.env,TEMP:f.childTemp,TMP:f.childTemp},timeout:30000,windowsHide:true});assert.equal(child.status,73,child.stderr);
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),record=f.db.prepare('SELECT evidence_json FROM wb_git_index_preparations').get(),preparation=JSON.parse(record.evidence_json),index=join(f.root,'.git/index'),before=await readFile(index),kernel=f.current.workbench.indexEffects('owner','project');
 const {indexPreparation}=await import('../../src/git/index-evidence.ts');
 for(const mutate of [p=>p.pending[0].path='../index',p=>p.pending[0].target='config.lock',p=>p.pending[0].identity='0:0',p=>p.pending[0].root=f.root,p=>p.pending.push(p.pending[0])]){const p=structuredClone(preparation);mutate(p);assert.throws(()=>indexPreparation(p),/git_index_preparation_invalid/);}
 const unknown=join(f.root,'unproven-hard-link'),head=join(f.root,'.git/HEAD.lock');linkSync(head,unknown);
 const restarted=f.restart({now:()=>Date.now()+60000});await assert.rejects(restarted.executions.reconcile('owner','project',row.execution_id),/git_path_unavailable|git_index_lock_unverified/);assert.ok(lstatSync(head));assert.ok(lstatSync(unknown));await rm(unknown);
 await writeFile(head,'changed owned bytes');await assert.rejects(restarted.executions.reconcile('owner','project',row.execution_id),/git_index_lock_unverified/);assert.equal(await readFile(head,'utf8'),'changed owned bytes');assert.deepEqual(await readFile(index),before);
 await rm(head);await writeFile(head,'foreign conventional lock');await assert.rejects(restarted.executions.reconcile('owner','project',row.execution_id),/git_index_lock_unverified/);assert.equal(await readFile(head,'utf8'),'foreign conventional lock');
 await assert.rejects(kernel.cleanupPreparation({...preparation,root:f.root},()=>{}),/git_index_preparation_invalid/);
});

test('preparation journal is immutable and an unresolved preparation cannot be replayed',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/lock-acquisition-crash-worker.mjs',import.meta.url)),f.root,f.database,approved.intent_id,input.request_id,'before-link-1'],{encoding:'utf8',env:{...process.env,TEMP:f.childTemp,TMP:f.childTemp},timeout:30000,windowsHide:true});assert.equal(child.status,73,child.stderr);
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get();assert.throws(()=>f.db.exec('DELETE FROM wb_git_index_preparations'),/git_execution_immutable/);assert.throws(()=>f.db.exec("UPDATE wb_git_index_preparations SET evidence_json='{}'"),/git_execution_immutable/);
 const current=await f.current.executions.execute('owner','project',approved.intent_id,input);assert.equal(current.state,'unknown');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_executions').get().n,1);
 await f.restart({now:()=>Date.now()+60000}).executions.reconcile('owner','project',row.execution_id);
 const next=await f.review();await assert.rejects(f.current.executions.execute('owner','project',next.approved.intent_id,next.input),/git_execution_reconciliation_required/);
});

test('legacy executions without dispatch remain unknown and cannot gain new-protocol authority',async t=>{
 const f=await fixture(t,{legacy:true}),{approved,input}=await f.review(),witness=JSON.parse(f.db.prepare('SELECT witness_json FROM wb_git_mutation_intents').get().witness_json),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 f.db.prepare('INSERT INTO wb_git_index_executions(execution_id,owner_id,project_id,intent_id,request_id,request_sha256,review_version,review_sha256,action,witness_sha256,repository_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-execution','owner','project',approved.intent_id,input.request_id,hash({intent_id:approved.intent_id,...input}),input.expected_version,input.review_sha256,'stage',hash(witness),witness.repository_sha256,'now');
 const restarted=f.restart();assert.equal(f.db.prepare('SELECT protocol FROM wb_git_index_executions').get().protocol,1);assert.equal(restarted.executions.get('owner','project','legacy-execution').state,'unknown');await assert.rejects(restarted.executions.reconcile('owner','project','legacy-execution'),/git_execution_legacy_unknown/);assert.equal((await restarted.executions.execute('owner','project',approved.intent_id,input)).state,'unknown');
 const next=await f.review();await assert.rejects(restarted.executions.execute('owner','project',next.approved.intent_id,next.input),/git_execution_reconciliation_required/);
});

for(const alias of [false,true])test('an actual changed repository stamp cannot bypass unresolved execution'+(alias?' through project reconfiguration':''),async t=>{
 const f=await fixture(t),{approved,input}=await f.review();
 f.db.exec("CREATE TRIGGER fail_original_outcome BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_original_unknown'); END");
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_original_unknown/);f.db.exec('DROP TRIGGER fail_original_outcome');
 const original=f.db.prepare('SELECT * FROM wb_git_index_executions').get();
 // Change the actual configured directory identity, not a mocked hash or a
 // legacy schema populated entirely with newly generated binding witnesses.
 await rename(f.root,join(dirname(f.root),'retired-repo'));await mkdir(f.root);f.git('init','--initial-branch=main');f.git('config','core.autocrlf','false');await writeFile(join(f.root,'note.txt'),'before\n');f.git('add','.');f.git('commit','-m','Synthetic replacement repository');await writeFile(join(f.root,'note.txt'),'after\n');
 const {GitIndexExecutions}=await import('../../src/git/index-executions.ts'),project=alias?'replacement-project':'project';
 if(alias)f.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run(project,'owner','Replacement',0,1,'now','now');
 const projects=new ProjectRepository(f.db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:project,root:f.root}]),intents=new GitMutationIntents(f.db,projects,workbench),executions=new GitIndexExecutions(f.db,projects,workbench,intents),snapshot=await workbench.inspect('owner',project);
 assert.notEqual(snapshot.repository_sha256,original.repository_sha256);
 const p=await intents.prepare('owner',project,{request_id:'replacement-review',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),a=await intents.control('owner',project,p.intent_id,{request_id:'replacement-approve',action:'approve',expected_version:1,review_sha256:p.review_sha256});
 await assert.rejects(executions.execute('owner',project,a.intent_id,{request_id:'replacement-execution',expected_version:a.version,review_sha256:a.review_sha256}),/git_execution_reconciliation_required/);
 assert.equal(f.git('show',':note.txt'),'before\n');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_executions').get().n,1);
 const before=await readFile(join(f.root,'.git/index')),view=f.current.executions.inspect('owner','project',original.execution_id),receipt=await f.current.executions.abandon('owner','project',original.execution_id,{request_id:'acknowledge-old-binding',expected_state_sha256:view.state_sha256,acknowledge_unknown:true});
 assert.equal(receipt.result.state,'abandoned_unknown');assert.equal(receipt.cleanup,'unverified');assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
 assert.equal((await executions.execute('owner',project,a.intent_id,{request_id:'replacement-execution',expected_version:a.version,review_sha256:a.review_sha256})).state,'applied');
});

async function interruptedPreparation(f){
 const {approved,input}=await f.review(),child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/lock-acquisition-crash-worker.mjs',import.meta.url)),f.root,f.database,approved.intent_id,input.request_id,'before-link-1'],{encoding:'utf8',env:{...process.env,TEMP:f.childTemp,TMP:f.childTemp},timeout:30000,windowsHide:true});assert.equal(child.status,73,child.stderr);
 return{approved,input,row:f.db.prepare('SELECT * FROM wb_git_index_executions').get()};
}

test('explicit original disposition fences the old Worker, persists its control receipt and never retries the index',async t=>{
 const f=await fixture(t),before=await readFile(join(f.root,'.git/index')),{approved,input,row}=await interruptedPreparation(f),view=f.current.executions.inspect('owner','project',row.execution_id),control={request_id:'abandon-original',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};
 assert.equal(view.execution.state,'unknown');assert.equal(view.execution_authorized,false);
 await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,control),/git_execution_busy/);
 const restarted=f.restart({now:()=>Date.now()+60000}),receipt=await restarted.executions.abandon('owner','project',row.execution_id,control);
 assert.equal(receipt.result.state,'not_dispatched');assert.equal(receipt.cleanup,'verified');assert.equal(receipt.request_id,control.request_id);assert.equal(receipt.result.request_id,input.request_id);
 assert.deepEqual(await readFile(join(f.root,'.git/index')),before);assert.equal((await readdir(join(f.root,'.git'))).some(name=>name.endsWith('.lock')||name.startsWith('jot-index-lock-')),false);
 const again=f.restart();assert.deepEqual(again.executions.getControl('owner','project',row.execution_id,control.request_id),receipt);assert.deepEqual(await again.executions.abandon('owner','project',row.execution_id,control),receipt);assert.deepEqual(await again.executions.execute('owner','project',approved.intent_id,input),receipt.result);
 await assert.rejects(again.executions.abandon('owner','project',row.execution_id,{...control,expected_state_sha256:'0'.repeat(64)}),/idempotency_conflict/);
 assert.throws(()=>again.executions.getControl('foreign','project',row.execution_id,control.request_id),/project_not_found/);
 const next=await f.review();assert.equal((await f.current.executions.execute('owner','project',next.approved.intent_id,next.input)).state,'applied');
});

test('an explicit abandon observes original publication instead of claiming an unknown effect was undone',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER lost_original_outcome BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_lost_outcome'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_lost_outcome/);f.db.exec('DROP TRIGGER lost_original_outcome');
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),before=await readFile(join(f.root,'.git/index')),inode=lstatSync(join(f.root,'.git/index'),{bigint:true}).ino,view=f.current.executions.inspect('owner','project',row.execution_id),control={request_id:'observe-original-before-abandon',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};
 const receipt=await f.current.executions.abandon('owner','project',row.execution_id,control);assert.equal(receipt.result.state,'applied');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,0);assert.equal(lstatSync(join(f.root,'.git/index'),{bigint:true}).ino,inode);assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
 assert.deepEqual(await f.restart().executions.abandon('owner','project',row.execution_id,control),receipt);assert.deepEqual(f.current.executions.get('owner','project',row.execution_id),receipt.result);
});

test('failed disposition acknowledgement cannot close admission or make the original index mutation repeat',async t=>{
 const f=await fixture(t),{row}=await interruptedPreparation(f),current=f.restart({now:()=>Date.now()+60000}),view=current.executions.inspect('owner','project',row.execution_id),control={request_id:'recover-disposition-ack',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};
 f.db.exec("CREATE TRIGGER fail_control_receipt BEFORE INSERT ON wb_git_index_control_receipts BEGIN SELECT RAISE(ABORT,'test_control_receipt_failure'); END");await assert.rejects(current.executions.abandon('owner','project',row.execution_id,control),/test_control_receipt_failure/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,0);assert.equal(current.executions.get('owner','project',row.execution_id).state,'unknown');assert.equal(current.executions.getControl('owner','project',row.execution_id,control.request_id).state,'pending');
 assert.equal(f.git('show',':note.txt'),'before\n');f.db.exec('DROP TRIGGER fail_control_receipt');
 const receipt=await f.restart().executions.abandon('owner','project',row.execution_id,control);assert.equal(receipt.result.state,'not_dispatched');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_controls').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_control_receipts').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,1);
 assert.equal(f.git('show',':note.txt'),'before\n');
});

test('a failed observed-outcome write cannot turn a proven publication into abandoned unknown',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER fail_observed_outcome BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_observed_outcome_failure'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_observed_outcome_failure/);
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),view=f.current.executions.inspect('owner','project',row.execution_id),control={request_id:'retain-observed-applied',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};
 await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,control),/test_observed_outcome_failure/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,0);assert.equal(f.current.executions.getControl('owner','project',row.execution_id,control.request_id).state,'pending');f.db.exec('DROP TRIGGER fail_observed_outcome');assert.equal((await f.current.executions.abandon('owner','project',row.execution_id,control)).result.state,'applied');
});

for(const phase of ['before-receipt','after-receipt'])test('original disposition survives actual process exit '+phase,async t=>{
 const f=await fixture(t),{row}=await interruptedPreparation(f),before=await readFile(join(f.root,'.git/index')),view=f.current.executions.inspect('owner','project',row.execution_id),control={request_id:'original-control-crash',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/control-crash-worker.mjs',import.meta.url)),f.root,f.database,row.execution_id,control.request_id,control.expected_state_sha256,phase],{encoding:'utf8',env:{...process.env,TEMP:f.childTemp,TMP:f.childTemp},timeout:30000,windowsHide:true});assert.equal(child.error,undefined);assert.equal(child.status,73,child.stderr);f.db.exec('DROP TRIGGER IF EXISTS crash_before_control_receipt');
 assert.deepEqual(await readFile(join(f.root,'.git/index')),before);assert.equal((await readdir(join(f.root,'.git'))).some(name=>name.endsWith('.lock')||name.startsWith('jot-index-lock-')),false);
 if(phase==='before-receipt'){assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,0);assert.equal(f.current.executions.getControl('owner','project',row.execution_id,control.request_id).state,'pending');await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,control),/git_execution_busy/);}
 const current=f.restart({now:()=>Date.now()+120000}),receipt=await current.executions.abandon('owner','project',row.execution_id,control);assert.equal(receipt.result.state,'not_dispatched');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_controls').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_control_receipts').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,1);assert.deepEqual(current.executions.getControl('owner','project',row.execution_id,control.request_id),receipt);
 assert.deepEqual(await readFile(join(f.root,'.git/index')),before);
});

test('disposition validates explicit acknowledgement, original state, ownership and cancellation before closing anything',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER fail_for_control_validation BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_validation_unknown'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_validation_unknown/);f.db.exec('DROP TRIGGER fail_for_control_validation');
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),view=f.current.executions.inspect('owner','project',row.execution_id),control={request_id:'validated-control',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};
 for(const body of [{...control,acknowledge_unknown:false},{...control,root:f.root},{request_id:control.request_id,expected_state_sha256:view.state_sha256}])await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,body),/git_execution_control_invalid/);
 await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,{...control,expected_state_sha256:'0'.repeat(64)}),/version_conflict/);await assert.rejects(f.current.executions.abandon('foreign','project',row.execution_id,control),/project_not_found/);
 const abort=new AbortController();abort.abort();await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,control,abort.signal));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_controls').get().n,0);
 await f.current.intents.control('owner','project',approved.intent_id,{request_id:'cancel-before-disposition',action:'cancel',expected_version:2,review_sha256:approved.review_sha256});const receipt=await f.current.executions.abandon('owner','project',row.execution_id,control);assert.equal(receipt.result.state,'applied');
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('new-owner','project');assert.throws(()=>f.current.executions.getControl('owner','project',row.execution_id,control.request_id),/project_not_found/);
});

test('a replacement lease revokes a delayed disposition before it can publish its acknowledgement',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER fail_for_lease_control BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_lease_unknown'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_lease_unknown/);f.db.exec('DROP TRIGGER fail_for_lease_control');
 const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),view=f.current.executions.inspect('owner','project',row.execution_id),engine=f.current.workbench.indexEffects('owner','project'),observe=engine.observeEvidence.bind(engine);engine.observeEvidence=async(...args)=>{const observation=await observe(...args);f.db.prepare('UPDATE ga_worker_leases SET owner=?,generation=generation+1,expires_at=?').run('replacement-control-worker',String(Date.now()+60000));return observation;};
 await assert.rejects(f.current.executions.abandon('owner','project',row.execution_id,{request_id:'lease-fenced-control',expected_state_sha256:view.state_sha256,acknowledge_unknown:true}),/workbench_execution_lease_revoked/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_control_receipts').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_dispositions').get().n,0);assert.equal(f.db.prepare('SELECT owner FROM ga_worker_leases').get().owner,'replacement-control-worker');
});

test('legacy unknown disposition preserves every unproven file and original control rows are immutable',async t=>{
 const f=await fixture(t,{legacy:true}),{approved,input}=await f.review(),witness=JSON.parse(f.db.prepare('SELECT witness_json FROM wb_git_mutation_intents').get().witness_json),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 f.db.prepare('INSERT INTO wb_git_index_executions(execution_id,owner_id,project_id,intent_id,request_id,request_sha256,review_version,review_sha256,action,witness_sha256,repository_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-control-execution','owner','project',approved.intent_id,input.request_id,hash({intent_id:approved.intent_id,...input}),input.expected_version,input.review_sha256,'stage',hash(witness),witness.repository_sha256,'now');
 f.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('legacy-alias','owner','Alias',0,1,'now','now');const {GitIndexExecutions}=await import('../../src/git/index-executions.ts'),projects=new ProjectRepository(f.db),alias=new GitWorkbench(projects,[{owner_id:'owner',project_id:'legacy-alias',root:f.root}]),intents=new GitMutationIntents(f.db,projects,alias),executions=new GitIndexExecutions(f.db,projects,alias,intents),snapshot=await alias.inspect('owner','legacy-alias'),p=await intents.prepare('owner','legacy-alias',{request_id:'legacy-alias-review',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),a=await intents.control('owner','legacy-alias',p.intent_id,{request_id:'legacy-alias-approve',action:'approve',expected_version:1,review_sha256:p.review_sha256});
 await assert.rejects(executions.execute('owner','legacy-alias',a.intent_id,{request_id:'legacy-alias-execute',expected_version:a.version,review_sha256:a.review_sha256}),/git_execution_reconciliation_required/);
 await writeFile(join(f.root,'.git/index.lock'),'unproven legacy index lock');await writeFile(join(f.root,'.git/HEAD.lock'),'unproven legacy head lock');
 const view=f.current.executions.inspect('owner','project','legacy-control-execution'),control={request_id:'legacy-explicit-ack',expected_state_sha256:view.state_sha256,acknowledge_unknown:true},receipt=await f.current.executions.abandon('owner','project','legacy-control-execution',control);
 assert.equal(receipt.result.state,'abandoned_unknown');assert.equal(receipt.cleanup,'not_recorded');assert.equal(await readFile(join(f.root,'.git/index.lock'),'utf8'),'unproven legacy index lock');assert.equal(await readFile(join(f.root,'.git/HEAD.lock'),'utf8'),'unproven legacy head lock');assert.notEqual(f.current.executions.inspect('owner','project','legacy-control-execution').state_sha256,view.state_sha256);
 for(const table of ['wb_git_index_controls','wb_git_index_dispositions','wb_git_index_control_receipts']){assert.throws(()=>f.db.exec('DELETE FROM '+table),/git_execution_immutable/);assert.throws(()=>f.db.exec('UPDATE '+table+' SET '+(table==='wb_git_index_dispositions'?'kind=kind':table==='wb_git_index_controls'?'request_id=request_id':'receipt_json=receipt_json')),/git_execution_immutable/);}
 assert.throws(()=>f.db.prepare('INSERT INTO wb_git_index_dispatches VALUES(?,?,?,?,?,?)').run('legacy-control-execution','{}','0'.repeat(64),'test-late-worker',1,'now'),/git_execution_closed/);
 assert.deepEqual(await f.current.executions.reconcile('owner','project','legacy-control-execution'),receipt.result);assert.deepEqual(f.current.executions.getControl('owner','project','legacy-control-execution',control.request_id),receipt);
 // Only the fixture owner removes its deliberately created unproven files.
 // The production control above preserved both, including their exact bytes.
 await rm(join(f.root,'.git/index.lock'));await rm(join(f.root,'.git/HEAD.lock'));
 const fresh=await alias.inspect('owner','legacy-alias'),next=await intents.prepare('owner','legacy-alias',{request_id:'legacy-alias-fresh-review',action:'stage',paths:['note.txt'],snapshot_id:fresh.snapshot_id}),approvedNext=await intents.control('owner','legacy-alias',next.intent_id,{request_id:'legacy-alias-fresh-approve',action:'approve',expected_version:1,review_sha256:next.review_sha256});
 assert.equal((await executions.execute('owner','legacy-alias',approvedNext.intent_id,{request_id:'legacy-alias-fresh-execute',expected_version:approvedNext.version,review_sha256:approvedNext.review_sha256})).state,'applied');
});

test('a bound unknown execution does not block an unrelated configured project',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER unrelated_unknown BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_unrelated_unknown'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_unrelated_unknown/);f.db.exec('DROP TRIGGER unrelated_unknown');
 const other=join(dirname(f.root),'unrelated-repo');await mkdir(other);const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:other,encoding:'utf8',stdio:['ignore','pipe','pipe']});git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(other,'note.txt'),'original\n');git('add','.');git('commit','-m','Synthetic independent repository');await writeFile(join(other,'note.txt'),'changed\n');
 f.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('other-project','owner','Other',0,1,'now','now');const {GitIndexExecutions}=await import('../../src/git/index-executions.ts'),projects=new ProjectRepository(f.db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:'other-project',root:other}]),intents=new GitMutationIntents(f.db,projects,workbench),executions=new GitIndexExecutions(f.db,projects,workbench,intents),snapshot=await workbench.inspect('owner','other-project'),p=await intents.prepare('owner','other-project',{request_id:'other-review',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),a=await intents.control('owner','other-project',p.intent_id,{request_id:'other-approve',action:'approve',expected_version:1,review_sha256:p.review_sha256});
 assert.notEqual(workbench.executionBinding('owner','other-project'),f.current.workbench.executionBinding('owner','project'));assert.equal((await executions.execute('owner','other-project',a.intent_id,{request_id:'other-execute',expected_version:a.version,review_sha256:a.review_sha256})).state,'applied');assert.equal(git('show',':note.txt'),'changed\n');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wb_git_index_executions').get().n,2);
});

test('a fenced original executor cannot clean lock files after another Worker takes ownership',async t=>{
 const f=await fixture(t),{approved,input}=await f.review(),engine=f.current.workbench.indexEffects('owner','project'),apply=engine.applyIndex.bind(engine);
 engine.applyIndex=(plan,authority,signal)=>apply(plan,{...authority,dispatch:evidence=>{authority.dispatch(evidence);f.db.prepare('UPDATE ga_worker_leases SET owner=?,generation=generation+1,expires_at=?').run('new-lease-owner',String(Date.now()+60000));}},signal);
 await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/workbench_execution_lease_revoked/);
 assert.equal(await readFile(join(f.root,'.git/HEAD.lock'),'utf8'),'');assert.ok(lstatSync(join(f.root,'.git/index.lock')));assert.equal(f.db.prepare('SELECT owner FROM ga_worker_leases').get().owner,'new-lease-owner');
});

test('a cached applied control receipt cannot conceal a corrupted original request digest',async t=>{
 const f=await fixture(t),{approved,input}=await f.review();f.db.exec("CREATE TRIGGER corrupt_receipt_setup BEFORE INSERT ON wb_git_index_outcomes BEGIN SELECT RAISE(ABORT,'test_corrupt_receipt_setup'); END");await assert.rejects(f.current.executions.execute('owner','project',approved.intent_id,input),/test_corrupt_receipt_setup/);f.db.exec('DROP TRIGGER corrupt_receipt_setup');const row=f.db.prepare('SELECT * FROM wb_git_index_executions').get(),view=f.current.executions.inspect('owner','project',row.execution_id),control={request_id:'cached-original-control',expected_state_sha256:view.state_sha256,acknowledge_unknown:true};await f.current.executions.abandon('owner','project',row.execution_id,control);
 f.db.exec('DROP TRIGGER wb_git_index_controls_no_update');f.db.prepare('UPDATE wb_git_index_controls SET request_sha256=?').run('0'.repeat(64));assert.throws(()=>f.current.executions.getControl('owner','project',row.execution_id,control.request_id),/git_execution_evidence_corrupt/);
});
