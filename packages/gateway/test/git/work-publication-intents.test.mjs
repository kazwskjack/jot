import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {completedWorkFixture} from '../support/work-completion-source-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {GitWorkbench} from '../../src/git/service.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
const counters=db=>['ga_runs','ga_events','wb_task_occurrences','wb_budget_allocations','wb_model_budget_attempts'].map(table=>db.prepare('SELECT count(*) n FROM '+table).get().n);
async function fixture(t,{outputPath='source.md'}={}){
 const f=await completedWorkFixture(t,{outputPath}),root=join(f.root,'configured-target');await mkdir(root);const git=(...args)=>execFileSync('git',['--no-optional-locks','-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');const base=f.workbench.readFile('owner','ws',f.scope.project_id,'source.md').content;await writeFile(join(root,'source.md'),base);git('add','.');git('commit','-m','Synthetic reviewed base');
 const module=await import('../../src/persistent-tasks/work-publication-intents.ts');module.installWorkPublicationIntents(f.db);
 const workbench=new GitWorkbench(new ProjectRepository(f.db),[{owner_id:'owner',project_id:f.scope.project_id,root}]),service=new module.WorkPublicationIntents(f.db,workbench),source=new FinalizedWorkSources(f.db).summary('owner',f.admission.run_id);
 const input={request_id:'prepare-publication',source_run_id:f.admission.run_id,source_sha256:source.source_sha256,paths:[outputPath]};return {...f,rootTarget:root,base,git,source,service,workbench,input,module};
}

test('a distinct original publication intent binds reviewed source and actual clean target without writing files',async t=>{
 const f=await fixture(t),before=counters(f.db),index=await readFile(join(f.rootTarget,'.git/index')),prepared=await f.service.prepare('owner',f.scope.project_id,f.input);
 assert.equal(prepared.state,'prepared');assert.equal(prepared.version,1);assert.equal(prepared.execution_authorized,false);assert.equal(prepared.source.source_sha256,f.source.source_sha256);
 assert.equal(prepared.changes.length,1);assert.equal(prepared.changes[0].path,'source.md');assert.equal(prepared.changes[0].kind,'modify');assert.equal(prepared.changes[0].before_text,f.base);assert.equal(prepared.changes[0].after_text,'Exact reviewed work content');
 assert.equal(JSON.stringify(prepared).includes(f.rootTarget),false);assert.deepEqual(counters(f.db),before);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),index);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);
 assert.deepEqual(await f.service.prepare('owner',f.scope.project_id,f.input),prepared);await assert.rejects(()=>f.service.prepare('owner',f.scope.project_id,{...f.input,paths:['different.md']}),/idempotency_conflict/);
});

test('publication approval has its own version and can be revoked without dispatching task or file effects',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input),before=counters(f.db),approve={request_id:'approve-publication',action:'approve',expected_version:1,review_sha256:prepared.review_sha256};
 const approved=await f.service.control('owner',f.scope.project_id,prepared.intent_id,approve);assert.equal(approved.state,'approved');assert.equal(approved.version,2);assert.equal(approved.execution_authorized,false);
 const cancelled=await f.service.control('owner',f.scope.project_id,prepared.intent_id,{request_id:'cancel-publication',action:'cancel',expected_version:2,review_sha256:prepared.review_sha256});assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.version,3);
 assert.deepEqual(await f.service.control('owner',f.scope.project_id,prepared.intent_id,approve),approved,'replayed acknowledgement is historical, not fresh dispatch permission');assert.equal(f.service.get('owner',f.scope.project_id,prepared.intent_id).state,'cancelled');assert.deepEqual(counters(f.db),before);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);
});


test('control freezes its original command before any awaited target observation',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input),input={request_id:'freeze-approve',action:'approve',expected_version:1,review_sha256:prepared.review_sha256};
 const commit=await f.service.prepareControl('owner',f.scope.project_id,prepared.intent_id,input);input.action='cancel';
 assert.equal(commit().state,'approved','an external object mutation cannot change the accepted command');
});


test('new file publication reviews require actual absence and retain exact bytes without creating the file',async t=>{
 const f=await fixture(t,{outputPath:'created.md'}),prepared=await f.service.prepare('owner',f.scope.project_id,f.input);
 assert.equal(prepared.changes[0].kind,'add');assert.equal(prepared.changes[0].before,null);assert.equal(prepared.changes[0].before_text,null);assert.equal(prepared.changes[0].after_text,'Exact reviewed work content');
 await assert.rejects(readFile(join(f.rootTarget,'created.md')),{code:'ENOENT'});
 await writeFile(join(f.rootTarget,'created.md'),'Unrelated new file');await assert.rejects(()=>f.service.control('owner',f.scope.project_id,prepared.intent_id,{request_id:'approve-add',action:'approve',expected_version:1,review_sha256:prepared.review_sha256}),/work_publication_review_changed/);
 await assert.rejects(()=>f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'changed-base'}),/work_publication_target_base_changed/);
});

test('target drift, changed source and foreign or invalid requests cannot create approval',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input),approve={request_id:'approve-drift',action:'approve',expected_version:1,review_sha256:prepared.review_sha256};
 await writeFile(join(f.rootTarget,'source.md'),'Changed after review');await assert.rejects(()=>f.service.control('owner',f.scope.project_id,prepared.intent_id,approve),/work_publication_review_changed/);assert.equal(f.service.get('owner',f.scope.project_id,prepared.intent_id).state,'prepared');
 await assert.rejects(()=>f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'new-drift'}),/work_publication_target_base_changed/);
 assert.throws(()=>f.service.get('foreign',f.scope.project_id,prepared.intent_id),/project_not_found/);
 await assert.rejects(()=>f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'bad-source',source_sha256:'0'.repeat(64)}),/completed_work_source_conflict/);
 await assert.rejects(()=>f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'injected',root:f.rootTarget}),/work_publication_invalid/);
 const saved=f.db.prepare('SELECT inputs_sha256 FROM wb_discovery_work_inspections WHERE run_id=?').get(f.admission.run_id),trigger=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='wb_work_inspections_no_update'").get().sql;
 f.db.exec('DROP TRIGGER wb_work_inspections_no_update');try{f.db.prepare("UPDATE wb_discovery_work_inspections SET inputs_sha256='broken' WHERE run_id=?").run(f.admission.run_id);await assert.rejects(()=>f.service.control('owner',f.scope.project_id,prepared.intent_id,approve),/completed_work_source_unavailable/);}finally{f.db.prepare('UPDATE wb_discovery_work_inspections SET inputs_sha256=? WHERE run_id=?').run(saved.inputs_sha256,f.admission.run_id);f.db.exec(trigger)}
});

test('ownership revocation or cancellation during target observation leaves no new approval',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input),target=f.workbench.publicationTarget.bind(f.workbench);
 f.workbench.publicationTarget=async(...args)=>{const read=await target(...args);f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('foreign',f.scope.project_id);return read};
 await assert.rejects(()=>f.service.control('owner',f.scope.project_id,prepared.intent_id,{request_id:'approve-revoked',action:'approve',expected_version:1,review_sha256:prepared.review_sha256}),/project_not_found/);
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('owner',f.scope.project_id);f.workbench.publicationTarget=target;
 const controller=new AbortController();f.workbench.publicationTarget=async(...args)=>{const read=await target(...args);controller.abort();return read};
 await assert.rejects(()=>f.service.control('owner',f.scope.project_id,prepared.intent_id,{request_id:'approve-cancelled',action:'approve',expected_version:1,review_sha256:prepared.review_sha256},controller.signal),/abort|cancel/i);
 assert.equal(f.service.get('owner',f.scope.project_id,prepared.intent_id).version,1);
});

test('original read-only database retains review after restart and copied records do not become original identity',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input),{DatabaseSync}=await import('node:sqlite'),original=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});
 try{const changes=original.prepare('SELECT total_changes() n').get().n,schema=original.prepare('PRAGMA schema_version').get().schema_version,service=new f.module.WorkPublicationIntents(original,f.workbench);assert.deepEqual(service.get('owner',f.scope.project_id,prepared.intent_id),prepared);assert.equal(original.prepare('SELECT total_changes() n').get().n,changes);assert.equal(original.prepare('PRAGMA schema_version').get().schema_version,schema);}finally{original.close()}
 const copy=join(f.root,'copied.sqlite');f.db.exec("VACUUM INTO '"+copy.replaceAll("'","''")+"'");const cloned=new DatabaseSync(copy);cloned.exec('PRAGMA journal_mode=WAL');try{const service=new f.module.WorkPublicationIntents(cloned,f.workbench);assert.throws(()=>service.get('owner',f.scope.project_id,prepared.intent_id),/work_publication_database_changed/);}finally{cloned.close()}
});

test('publication journals reject mutation or replacement and actual async preparation never holds a transaction',async t=>{
 const f=await fixture(t),target=f.workbench.publicationTarget.bind(f.workbench);f.workbench.publicationTarget=async(...args)=>{assert.equal(f.db.isTransaction,false);return target(...args)};
 const prepared=await f.service.prepare('owner',f.scope.project_id,f.input);
 assert.throws(()=>f.db.prepare('UPDATE wb_work_publication_intents SET review_sha256=? WHERE intent_id=?').run('broken',prepared.intent_id),/immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_work_publication_events WHERE intent_id=?').run(prepared.intent_id),/immutable/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO wb_work_publication_intents SELECT * FROM wb_work_publication_intents WHERE intent_id=?').run(prepared.intent_id),/immutable/);
 f.db.exec('BEGIN');try{await assert.rejects(()=>f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'no-await-transaction'}),/work_publication_async_transaction/);}finally{f.db.exec('ROLLBACK')}
});


test('two original database connections resolve one immutable request and preserve the current control version',async t=>{
 const f=await fixture(t),{DatabaseSync}=await import('node:sqlite'),second=new DatabaseSync(join(f.root,'db.sqlite'));second.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=75');
 try{const service=new f.module.WorkPublicationIntents(second,f.workbench),[firstCommit,secondCommit]=await Promise.all([f.service.prepareChange('owner',f.scope.project_id,f.input),service.prepareChange('owner',f.scope.project_id,f.input)]),first=firstCommit();assert.deepEqual(secondCommit(),first);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_intents').get().n,1);
  const approved=await f.service.control('owner',f.scope.project_id,first.intent_id,{request_id:'approve-concurrent',action:'approve',expected_version:1,review_sha256:first.review_sha256});
  await assert.rejects(()=>service.control('owner',f.scope.project_id,first.intent_id,{request_id:'different-command',action:'cancel',expected_version:1,review_sha256:first.review_sha256}),/version_conflict/);assert.equal(service.get('owner',f.scope.project_id,first.intent_id).version,approved.version);
 }finally{second.close()}
});

test('replacement of the configured root conflicts before any approval',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input);await rename(f.rootTarget,f.rootTarget+'-original');await mkdir(f.rootTarget);f.git('init','--initial-branch=main');await writeFile(join(f.rootTarget,'source.md'),f.base);
 await assert.rejects(()=>f.service.control('owner',f.scope.project_id,prepared.intent_id,{request_id:'approve-replaced-root',action:'approve',expected_version:1,review_sha256:prepared.review_sha256}),/git_repository_changed/);
 assert.equal(f.service.get('owner',f.scope.project_id,prepared.intent_id).state,'prepared');
});

test('damaged original review contents cannot be trusted by a historical read',async t=>{
 const f=await fixture(t),prepared=await f.service.prepare('owner',f.scope.project_id,f.input);f.db.exec('SAVEPOINT publication_corruption');try{f.db.exec('DROP TRIGGER wb_work_publication_intent_no_update');f.db.prepare("UPDATE wb_work_publication_intents SET changes_json='[]' WHERE intent_id=?").run(prepared.intent_id);assert.throws(()=>f.service.get('owner',f.scope.project_id,prepared.intent_id),/work_publication_corrupt/);}finally{f.db.exec('ROLLBACK TO publication_corruption;RELEASE publication_corruption')}
 assert.deepEqual(f.service.get('owner',f.scope.project_id,prepared.intent_id),prepared);
});
