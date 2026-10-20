import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {execFileSync} from 'node:child_process';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitWorkbench} from '../../src/git/service.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {readFileSync,writeFileSync} from 'node:fs';
async function fixture(t,{commit=true}={}){
 const {GitIndexEffects}=await import('../../src/git/index-effects.ts'),parent=await mkdtemp(join(tmpdir(),'jot-git-index-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');await writeFile(join(root,'other.txt'),'other before\n');if(commit){git('add','.');git('commit','-m','Synthetic fixture');await writeFile(join(root,'note.txt'),'after\n');await writeFile(join(root,'other.txt'),'other after\n');}
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;CREATE TABLE ga_projects(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,is_default INTEGER,version INTEGER,created_at TEXT,updated_at TEXT)');db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Test',0,1,'now','now');const projects=new ProjectRepository(db),workbench=new GitWorkbench(projects,[{owner_id:'owner',project_id:'project',root}]),intents=new GitMutationIntents(db,projects,workbench),effects=new GitIndexEffects({root});let request=0;
 t.after(async()=>{db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())+sep));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const review=async(action,paths=['note.txt'])=>{const snapshot=await workbench.inspect('owner','project'),p=await intents.prepare('owner','project',{request_id:'prepare-'+(++request),action,paths,snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner','project',p.intent_id,{request_id:'approve-'+request,expected_version:1,action:'approve',review_sha256:p.review_sha256}),row=db.prepare('SELECT witness_json FROM wb_git_mutation_intents WHERE intent_id=?').get(p.intent_id);const authorize=()=>{const current=intents.get('owner','project',p.intent_id);if(current.state!=='approved'||current.version!==approved.version||current.review_sha256!==approved.review_sha256)throw Error('git_execution_revoked');};return{witness:JSON.parse(row.witness_json),approved,authorize,commit:publish=>withImmediateTransaction(db,()=>{authorize();return publish();})};};
 return{root,parent,db,git,workbench,intents,effects,review,GitIndexEffects};
}

test('native workspace placement retains the actual configured root identity without granting an effect',async t=>{
 const f=await fixture(t),index=await readFile(join(f.root,'.git/index'));
 assert.equal(typeof f.effects.retainNativeWorkspaceRoots,'function');
 const members=[{session_ref:'original',custody:'resident',cwd:f.root,header_sha256:'a'.repeat(64)},{session_ref:'absent',custody:'absent',cwd:null,header_sha256:null}];
 const current=f.effects.retainNativeWorkspaceRoots(members);current();members[0].cwd=f.parent;current();
 assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
 await rename(f.root,join(f.parent,'original-repo'));await mkdir(f.root);
 assert.throws(current,/git_native_workspace_changed/);
});

test('native workspace placement cannot equate another native directory or invented absent cwd with the repository',async t=>{
 const f=await fixture(t);assert.equal(typeof f.effects.retainNativeWorkspaceRoots,'function');
 for(const member of [
  {session_ref:'original',custody:'resident',cwd:f.parent,header_sha256:'a'.repeat(64)},
  {session_ref:'original',custody:'cold',cwd:null,header_sha256:'a'.repeat(64)},
  {session_ref:'absent',custody:'absent',cwd:f.root,header_sha256:null},
  {session_ref:'original',custody:'resident',cwd:f.root,header_sha256:null}
 ])assert.throws(()=>f.effects.retainNativeWorkspaceRoots([member]),/git_native_workspace_association_required/);
});
test('actual selected staging and unstaging publish exact index bytes without altering HEAD or worktree',async t=>{
 const f=await fixture(t),head=f.git('rev-parse','HEAD').trim(),original=await readFile(join(f.root,'.git/index')),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage');assert.deepEqual(await readFile(join(f.root,'.git/index')),original);assert.equal(plan.execution_authorized,false);
 const receipt=await f.effects.applyIndex(plan,r);assert.equal(receipt.action,'stage');assert.equal(receipt.index_sha256,plan.index_sha256);assert.equal(f.git('show',':note.txt'),'after\n');assert.equal(f.git('diff','--cached','--name-only').trim(),'note.txt');assert.equal(f.git('rev-parse','HEAD').trim(),head);assert.equal(await readFile(join(f.root,'other.txt'),'utf8'),'other after\n');assert.equal((await f.effects.observeIndex(plan)).state,'applied');
 await assert.rejects(f.effects.applyIndex(plan,r),/git_index_plan_consumed/);
 const undo=await f.review('unstage'),undoPlan=await f.effects.prepareIndex(undo.witness,'unstage');await f.effects.applyIndex(undoPlan,undo);assert.equal(f.git('diff','--cached','--name-only').trim(),'');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'after\n');
});
test('unborn repositories and new UTF8 filenames can be staged and unstaged without a fake HEAD',async t=>{
 const f=await fixture(t,{commit:false}),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage');await f.effects.applyIndex(plan,r);assert.equal(f.git('show',':note.txt'),'before\n');const undo=await f.review('unstage'),p=await f.effects.prepareIndex(undo.witness,'unstage');await f.effects.applyIndex(p,undo);assert.equal(f.git('ls-files').trim(),'');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'before\n');
 await writeFile(join(f.root,'资料.txt'),'合成内容\n');const unicode=await f.review('stage',['资料.txt']),u=await f.effects.prepareIndex(unicode.witness,'stage');await f.effects.applyIndex(u,unicode);assert.equal(f.git('show',':资料.txt'),'合成内容\n');
});
test('foreign plans, revoked approval and stale source cannot acquire an index effect',async t=>{
 const f=await fixture(t),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage'),index=await readFile(join(f.root,'.git/index'));
 await assert.rejects(f.effects.applyIndex({...plan},r),/git_index_plan_invalid/);
 await f.intents.control('owner','project',r.approved.intent_id,{request_id:'cancel',expected_version:2,action:'cancel',review_sha256:r.approved.review_sha256});await assert.rejects(f.effects.applyIndex(plan,r),/git_execution_revoked/);assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
 const fresh=await f.review('stage'),p=await f.effects.prepareIndex(fresh.witness,'stage');await writeFile(join(f.root,'note.txt'),'new unreviewed bytes\n');await assert.rejects(f.effects.applyIndex(p,fresh),/git_review_changed|git_snapshot_changed/);assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
});
test('existing Git locks are preserved and native competing Git commands cannot overwrite the reviewed index',async t=>{
 const f=await fixture(t),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage'),lock=join(f.root,'.git/index.lock');await writeFile(lock,'foreign lock');await assert.rejects(f.effects.applyIndex(plan,r),/git_repository_busy/);assert.equal(await readFile(lock,'utf8'),'foreign lock');await rm(lock);
 let called=0;await f.effects.applyIndex(plan,{authorize:r.authorize,commit:publish=>r.commit(()=>{called++;assert.throws(()=>f.git('add','other.txt'));return publish();})});assert.equal(called,1);assert.equal(f.git('diff','--cached','--name-only').trim(),'note.txt');
});
test('loss after physical index publication is observed without replaying the original plan',async t=>{
 const f=await fixture(t),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage');await assert.rejects(f.effects.applyIndex(plan,{authorize:r.authorize,commit:publish=>r.commit(()=>{publish();throw Error('test_ack_lost');})}),/test_ack_lost/);assert.equal((await f.effects.observeIndex(plan)).state,'applied');assert.equal(f.git('show',':note.txt'),'after\n');await assert.rejects(f.effects.applyIndex(plan,r),/git_index_plan_consumed/);
});
test('repository filters never execute and built-in line endings remain the reviewed Git representation',async t=>{
 const f=await fixture(t),marker=join(f.parent,'executed'),script=join(f.parent,'filter.sh');await writeFile(script,'#!/bin/sh\necho forbidden > "'+marker.replaceAll('\\','/')+'"\ncat\n');f.git('config','filter.fixture.clean',script.replaceAll('\\','/'));await writeFile(join(f.root,'.gitattributes'),'note.txt filter=fixture\n');const r=await f.review('stage');await assert.rejects(f.effects.prepareIndex(r.witness,'stage'),/git_filter_requires_explicit_support/);await assert.rejects(readFile(marker),{code:'ENOENT'});
 await writeFile(join(f.root,'.gitattributes'),'note.txt text eol=lf\n');await writeFile(join(f.root,'note.txt'),'normalized\r\n');const crlf=await f.review('stage'),plan=await f.effects.prepareIndex(crlf.witness,'stage');await f.effects.applyIndex(plan,crlf);assert.equal(f.git('show',':note.txt'),'normalized\n');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'normalized\r\n');
});
test('tampering with the owned index lock cannot publish unreviewed index bytes',async t=>{
 const f=await fixture(t),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage'),index=await readFile(join(f.root,'.git/index'));
 await assert.rejects(f.effects.applyIndex(plan,{authorize:r.authorize,commit:publish=>r.commit(()=>{writeFileSync(join(f.root,'.git/index.lock'),'unreviewed index bytes');return publish();})}));assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
});
test('matching bytes from an outside writer are not an original publication receipt',async t=>{
 const f=await fixture(t),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage');
 await assert.rejects(f.effects.applyIndex(plan,{authorize:r.authorize,commit:()=>{writeFileSync(join(f.root,'.git/index'),readFileSync(join(f.root,'.git/index.lock')));throw Error('test_external_replacement');}}),/test_external_replacement/);
 assert.equal((await f.effects.observeIndex(plan)).state,'unknown');
});
test('attributes are a frozen transformation dependency and cannot change between review and staging',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'.gitattributes'),'note.txt text eol=lf\n');const r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage'),index=await readFile(join(f.root,'.git/index'));await writeFile(join(f.root,'.gitattributes'),'note.txt -text\n');
 await assert.rejects(f.effects.applyIndex(plan,r),/git_review_changed/);assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
});

test('revocation at the final transaction fence leaves the original index untouched',async t=>{
 const f=await fixture(t),r=await f.review('stage'),plan=await f.effects.prepareIndex(r.witness,'stage'),index=await readFile(join(f.root,'.git/index'));let revoked=false;
 await assert.rejects(f.effects.applyIndex(plan,{authorize:()=>{r.authorize();if(revoked)throw Error('test_final_revocation');},commit:publish=>r.commit(()=>{revoked=true;return publish();})}),/test_final_revocation/);
 assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal((await f.effects.observeIndex(plan)).state,'not_observed');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'after\n');
});

test('deleted nested working directories can stage deletion and restore the index without restoring worktree files',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'nested'));await writeFile(join(f.root,'nested/gone.txt'),'synthetic deleted content\n');f.git('add','nested/gone.txt');f.git('commit','-m','Synthetic nested fixture');await rm(join(f.root,'nested'),{recursive:true});
 const r=await f.review('stage',['nested/gone.txt']),plan=await f.effects.prepareIndex(r.witness,'stage');await f.effects.applyIndex(plan,r);assert.equal(f.git('diff','--cached','--name-status').trim(),'D\tnested/gone.txt');
 const undo=await f.review('unstage',['nested/gone.txt']),p=await f.effects.prepareIndex(undo.witness,'unstage');await f.effects.applyIndex(p,undo);assert.equal(f.git('show',':nested/gone.txt'),'synthetic deleted content\n');await assert.rejects(readFile(join(f.root,'nested/gone.txt')),{code:'ENOENT'});
});

test('binary staging preserves exact bytes and held ref locks prevent a competing native ref update',async t=>{
 const f=await fixture(t),bytes=Buffer.from([0,255,128,13,10,0,42]);await writeFile(join(f.root,'asset.bin'),bytes);const r=await f.review('stage',['asset.bin']),plan=await f.effects.prepareIndex(r.witness,'stage'),head=f.git('rev-parse','HEAD').trim();
 await f.effects.applyIndex(plan,{authorize:r.authorize,commit:publish=>r.commit(()=>{assert.throws(()=>f.git('update-ref','refs/heads/main',head));return publish();})});
 const staged=execFileSync('git',['show',':asset.bin'],{cwd:f.root,stdio:['ignore','pipe','pipe']});assert.deepEqual(staged,bytes);assert.deepEqual(await readFile(join(f.root,'asset.bin')),bytes);assert.equal(f.git('rev-parse','HEAD').trim(),head);assert.equal((await f.effects.observeIndex(plan)).state,'applied');
});

test('ignored attributes are part of the original approval rather than execution-time assumptions',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'.git/info/exclude'),'.gitattributes\n');await writeFile(join(f.root,'.gitattributes'),'note.txt text eol=lf\n');const r=await f.review('stage');await writeFile(join(f.root,'.gitattributes'),'note.txt -text\n');
 await assert.rejects(f.effects.prepareIndex(r.witness,'stage'),/git_review_changed|git_snapshot_changed/);
});

test('a missing ignored attribute file cannot appear between preparation and approval',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'.git/info/exclude'),'.gitattributes\n');const snapshot=await f.workbench.inspect('owner','project'),p=await f.intents.prepare('owner','project',{request_id:'missing-attributes',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id});await writeFile(join(f.root,'.gitattributes'),'note.txt -text\n');
 await assert.rejects(f.intents.control('owner','project',p.intent_id,{request_id:'approve-missing-attributes',expected_version:1,action:'approve',review_sha256:p.review_sha256}),/git_review_changed|git_snapshot_changed/);
});
