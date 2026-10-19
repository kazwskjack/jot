import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitWorkbench} from '../../src/git/service.ts';
async function fixture(t){
 const {GitMutationIntents}=await import('../../src/git/intents.ts');
 const parent=await mkdtemp(join(tmpdir(),'jot-git-intents-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic fixture');await writeFile(join(root,'note.txt'),'after\n');
 const databasePath=join(parent,'intent.sqlite');let db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON;CREATE TABLE ga_projects(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,is_default INTEGER,version INTEGER,created_at TEXT,updated_at TEXT)');db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Test',0,1,'now','now');
 const connect=()=>{const projects=new ProjectRepository(db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]);return {workbench,intents:new GitMutationIntents(db,projects,workbench)}};
 const service=connect();t.after(async()=>{db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())+requireSep()));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{...service,root,git,get db(){return db},async input(action='stage',extra={}){const snapshot=await service.workbench.inspect('owner','project');return{request_id:'prepare-1',action,paths:['note.txt'],snapshot_id:snapshot.snapshot_id,...extra}},restart(){db.close();db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON');return connect()}};
}
function requireSep(){return process.platform==='win32'?'\\':'/'}
test('review freezes exact original content without changing the index or granting execution',async t=>{
 const f=await fixture(t),before=await readFile(join(f.root,'.git/index')),input=await f.input();
 const prepared=await f.intents.prepare('owner','project',input);assert.equal(prepared.state,'prepared');assert.equal(prepared.version,1);assert.equal(prepared.execution_authorized,false);assert.match(prepared.review_sha256,/^[a-f0-9]{64}$/);assert.deepEqual(prepared.paths,['note.txt']);
 const original=f.db.prepare('SELECT witness_json FROM wb_git_mutation_intents').get();assert.match(original.witness_json,/sha256/);assert.equal(original.witness_json.includes('after\n'),false);assert.equal(JSON.stringify(prepared).includes(f.root),false);
 assert.deepEqual(await readFile(join(f.root,'.git/index')),before);assert.deepEqual(await f.intents.prepare('owner','project',input),prepared);
 await assert.rejects(f.intents.prepare('owner','project',{...input,action:'discard'}),/idempotency_conflict/);
});
test('exact approval and cancellation keep original command acknowledgements after restart',async t=>{
 const f=await fixture(t),prepared=await f.intents.prepare('owner','project',await f.input());
 const approval={request_id:'approve-1',expected_version:1,action:'approve',review_sha256:prepared.review_sha256};
 const approved=await f.intents.control('owner','project',prepared.intent_id,approval);assert.equal(approved.state,'approved');assert.equal(approved.execution_authorized,false);
 const recovered=f.restart();assert.deepEqual(recovered.intents.get('owner','project',prepared.intent_id),approved);assert.deepEqual(await recovered.intents.control('owner','project',prepared.intent_id,approval),approved);
 const cancelled=await recovered.intents.control('owner','project',prepared.intent_id,{request_id:'cancel-1',expected_version:2,action:'cancel',review_sha256:prepared.review_sha256});assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.version,3);
 assert.deepEqual(await recovered.intents.control('owner','project',prepared.intent_id,approval),approved);assert.equal(recovered.intents.get('owner','project',prepared.intent_id).state,'cancelled');
 await assert.rejects(recovered.intents.control('owner','project',prepared.intent_id,{...approval,request_id:'approve-again',expected_version:3}),/git_intent_closed/);
});
test('changed bytes, index or review hash cannot acquire approval',async t=>{
 const f=await fixture(t),p=await f.intents.prepare('owner','project',await f.input()),base={request_id:'approve',expected_version:1,action:'approve',review_sha256:p.review_sha256};
 await assert.rejects(f.intents.control('owner','project',p.intent_id,{...base,review_sha256:'0'.repeat(64)}),/git_review_changed/);
 await writeFile(join(f.root,'note.txt'),'new unreviewed content\n');await assert.rejects(f.intents.control('owner','project',p.intent_id,base),/git_snapshot_changed|git_review_changed/);assert.equal(f.intents.get('owner','project',p.intent_id).state,'prepared');
 const fresh=await f.intents.prepare('owner','project',await f.input('stage',{request_id:'prepare-2'}));f.git('add','note.txt');await assert.rejects(f.intents.control('owner','project',fresh.intent_id,{...base,review_sha256:fresh.review_sha256}),/git_snapshot_changed|git_review_changed/);
});
test('ownership, versions, command identity and input shape remain authoritative',async t=>{
 const f=await fixture(t),p=await f.intents.prepare('owner','project',await f.input()),base={request_id:'approve',expected_version:1,action:'approve',review_sha256:p.review_sha256};
 await assert.rejects(f.intents.control('other','project',p.intent_id,base),/project_not_found/);assert.throws(()=>f.intents.get('other','project',p.intent_id),/project_not_found/);
 await assert.rejects(f.intents.control('owner','project',p.intent_id,{...base,expected_version:2}),/version_conflict/);
 const approved=await f.intents.control('owner','project',p.intent_id,base);assert.equal(approved.version,2);
 await assert.rejects(f.intents.control('owner','project',p.intent_id,{...base,action:'cancel'}),/idempotency_conflict/);
 for(const extra of [{root:resolve('elsewhere')},{command:'reset'},{paths:['../escape']},{paths:['note.txt','note.txt']},{action:'push'}])await assert.rejects(f.intents.prepare('owner','project',{...await f.input(),...extra}),/git_intent_invalid|workspace_path_unsafe|git_path_unavailable/);
 f.db.prepare("UPDATE ga_projects SET owner_id='other'").run();assert.throws(()=>f.intents.get('owner','project',p.intent_id),/project_not_found/);
});
test('original review and command receipts are immutable at the database boundary',async t=>{
 const f=await fixture(t),p=await f.intents.prepare('owner','project',await f.input());
 for(const sql of ["UPDATE wb_git_mutation_intents SET action='discard'","DELETE FROM wb_git_mutation_intents","UPDATE wb_git_mutation_events SET state='approved'","DELETE FROM wb_git_mutation_events"])assert.throws(()=>f.db.exec(sql),/git_intent_immutable/);
 assert.equal(f.intents.get('owner','project',p.intent_id).state,'prepared');
});
test('local operation types are validated separately and never imply a Git command',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.intents.prepare('owner','project',await f.input('unstage')),/git_selection_invalid/);
 await assert.rejects(f.intents.prepare('owner','project',await f.input('delete-untracked')),/git_selection_invalid/);
 await assert.rejects(f.intents.prepare('owner','project',await f.input('commit')),/git_intent_invalid/);
 f.git('add','note.txt');const commit=await f.intents.prepare('owner','project',await f.input('commit',{message:'Reviewed change'}));assert.equal(commit.action,'commit');assert.equal(commit.execution_authorized,false);
 await writeFile(join(f.root,'new.txt'),'new\n');const deletion=await f.intents.prepare('owner','project',await f.input('delete-untracked',{request_id:'delete-1',paths:['new.txt']}));assert.equal(deletion.state,'prepared');assert.equal(await readFile(join(f.root,'new.txt'),'utf8'),'new\n');
});
test('commit review refuses hidden staged paths instead of approving an incomplete index',async t=>{
 const f=await fixture(t);f.git('add','note.txt');await writeFile(join(f.root,'.env'),'test-only-private-value');f.git('add','.env');
 await assert.rejects(f.intents.prepare('owner','project',await f.input('commit',{message:'Selected reviewed change'})),/git_selection_invalid/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_intents').get().count,0);
});
test('ownership revocation during asynchronous review leaves no intent or approval',async t=>{
 const f=await fixture(t),input=await f.input(),freeze=f.workbench.freeze.bind(f.workbench);
 f.workbench.freeze=async(...args)=>{const result=await freeze(...args);f.db.prepare("UPDATE ga_projects SET owner_id='other'").run();return result;};
 await assert.rejects(f.intents.prepare('owner','project',input),/project_not_found/);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_intents').get().count,0);
 f.db.prepare("UPDATE ga_projects SET owner_id='owner'").run();f.workbench.freeze=freeze;const p=await f.intents.prepare('owner','project',await f.input());
 f.workbench.freeze=async(...args)=>{const result=await freeze(...args);f.db.prepare("UPDATE ga_projects SET owner_id='other'").run();return result;};
 await assert.rejects(f.intents.control('owner','project',p.intent_id,{request_id:'approve',expected_version:1,action:'approve',review_sha256:p.review_sha256}),/project_not_found/);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_events').get().count,1);
});
test('concurrent repeated original commands publish one immutable event and cancellation needs no fresh file read',async t=>{
 const f=await fixture(t),input=await f.input(),[a,b]=await Promise.all([f.intents.prepare('owner','project',input),f.intents.prepare('owner','project',input)]);assert.deepEqual(a,b);
 const command={request_id:'approve',expected_version:1,action:'approve',review_sha256:a.review_sha256},[one,two]=await Promise.all([f.intents.control('owner','project',a.intent_id,command),f.intents.control('owner','project',a.intent_id,command)]);assert.deepEqual(one,two);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_events').get().count,2);
 await writeFile(join(f.root,'note.txt'),'changed after approval\n');const cancelled=await f.intents.control('owner','project',a.intent_id,{request_id:'cancel',expected_version:2,action:'cancel',review_sha256:a.review_sha256});assert.equal(cancelled.state,'cancelled');
 assert.throws(()=>f.db.prepare('INSERT INTO wb_git_mutation_events VALUES(?,?,?,?,?,?)').run(a.intent_id,4,'approved','forged-approval','0'.repeat(64),'now'),/git_intent_transition_invalid/);
});
