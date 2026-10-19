import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

async function fixture(t,{commit=true,options={}}={}){
 const {GitRepositoryInspection}=await import('../../src/git/inspection.ts');
 const parent=await mkdtemp(join(tmpdir(),'jot-git-inspect-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'original\n');
 if(commit){git('add','--','note.txt');git('commit','-m','Synthetic fixture');}
 t.after(async()=>{assert.ok(resolve(parent).startsWith(resolve(tmpdir())));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{root,parent,git,repository:new GitRepositoryInspection({root,...options}),GitRepositoryInspection};
}

test('actual status and selected staged/working diffs retain exact repository and index identity',async t=>{
 const f=await fixture(t),index=await readFile(join(f.root,'.git','index'));
 await writeFile(join(f.root,'note.txt'),'changed\n');await writeFile(join(f.root,'new.txt'),'new content\n');
 const state=await f.repository.inspect();assert.equal(state.head.branch,'main');assert.match(state.head.oid,/^[a-f0-9]{40,64}$/);
 assert.deepEqual(state.entries.map(row=>[row.path,row.index_status,row.worktree_status]),[['new.txt','?','?'],['note.txt',' ','M']]);
 assert.equal(state.execution_authorized,false);assert.equal(state.read_only,true);
 const patch=await f.repository.diff({snapshot_id:state.snapshot_id,path:'note.txt',stage:'working'});assert.match(patch.patch,/-original\n\+changed/);
 const untracked=await f.repository.diff({snapshot_id:state.snapshot_id,path:'new.txt',stage:'working'});assert.match(untracked.patch,/\+new content/);
 assert.deepEqual(await readFile(join(f.root,'.git','index')),index);
 f.git('add','--','note.txt');const staged=await f.repository.inspect();assert.notEqual(staged.snapshot_id,state.snapshot_id);
 assert.match((await f.repository.diff({snapshot_id:staged.snapshot_id,path:'note.txt',stage:'staged'})).patch,/\+changed/);
 assert.equal(JSON.stringify(state).includes(f.root),false);
});

test('same porcelain status with changed file content invalidates a previously reviewed snapshot',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'note.txt'),'first edit\n');const state=await f.repository.inspect();
 await writeFile(join(f.root,'note.txt'),'second edit with same M status\n');
 await assert.rejects(f.repository.diff({snapshot_id:state.snapshot_id,path:'note.txt',stage:'working'}),/git_snapshot_changed/);
});

test('prototype-like literal filenames retain independent content witnesses',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'__proto__'),'first\n');const state=await f.repository.inspect();await writeFile(join(f.root,'__proto__'),'changed\n');
 await assert.rejects(f.repository.diff({snapshot_id:state.snapshot_id,path:'__proto__',stage:'working'}),/git_snapshot_changed/);
});

test('unborn and detached HEAD are explicit rather than fake branches or commits',async t=>{
 const f=await fixture(t,{commit:false});let state=await f.repository.inspect();assert.equal(state.head.oid,null);assert.equal(state.head.branch,'main');assert.equal(state.head.detached,false);
 f.git('add','--','note.txt');f.git('commit','-m','Synthetic fixture');f.git('checkout','--detach');state=await f.repository.inspect();assert.equal(state.head.branch,null);assert.equal(state.head.detached,true);
});

test('staged rename, deletion, conflict and binary input remain inspectable without text conversion',async t=>{
 const f=await fixture(t);f.git('mv','--','note.txt','renamed.txt');let state=await f.repository.inspect();const renamed=state.entries.find(row=>row.path==='renamed.txt');assert.equal(renamed.index_status,'R');assert.equal(renamed.original_path,'note.txt');
 f.git('commit','-m','Synthetic rename');await rm(join(f.root,'renamed.txt'));state=await f.repository.inspect();assert.equal(state.entries[0].worktree_status,'D');
 await writeFile(join(f.root,'bytes.bin'),Buffer.from([0,1,2,3]));state=await f.repository.inspect();const binary=await f.repository.diff({snapshot_id:state.snapshot_id,path:'bytes.bin',stage:'working'});assert.equal(binary.kind,'binary');assert.equal(binary.patch,'');
 f.git('reset','--hard','HEAD');f.git('checkout','-b','side');await writeFile(join(f.root,'renamed.txt'),'side\n');f.git('commit','-am','Synthetic side');f.git('checkout','main');await writeFile(join(f.root,'renamed.txt'),'main\n');f.git('commit','-am','Synthetic main');assert.throws(()=>f.git('merge','side'));
 state=await f.repository.inspect();assert.equal(state.entries.find(row=>row.path==='renamed.txt').conflicted,true);
});

test('unsafe paths and symlinks never become diff selectors or private file bodies',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'.env'),'SYNTHETIC_PRIVATE_FIXTURE');await writeFile(join(f.root,'safe.txt'),'safe\n');
 const state=await f.repository.inspect();assert.equal(state.omitted_count,1);assert.equal(JSON.stringify(state).includes('.env'),false);
 for(const path of ['.env','../note.txt',':(top)note.txt','--output=escaped','missing.txt'])await assert.rejects(f.repository.diff({snapshot_id:state.snapshot_id,path,stage:'working'}));
 if(process.platform==='win32'){
  const outside=join(f.parent,'outside');await mkdir(outside);await writeFile(join(outside,'hidden.txt'),'outside fixture');await symlink(outside,join(f.root,'linked'),'junction');
  await assert.rejects(f.repository.inspect(),/git_path_unavailable/);
 }else{
  await symlink(join(f.root,'safe.txt'),join(f.root,'link.txt'),'file');const linked=await f.repository.inspect();assert.equal(linked.entries.find(row=>row.path==='link.txt').kind,'symlink');
  await assert.rejects(f.repository.diff({snapshot_id:linked.snapshot_id,path:'link.txt',stage:'working'}),/git_path_unavailable/);
 }
});

test('a replaced physical root or linked Git metadata never inherits the original inspection identity',async t=>{
 const f=await fixture(t);await f.repository.inspect();await rename(f.root,join(f.parent,'old'));await mkdir(f.root);f.git('init','--initial-branch=main');
 await assert.rejects(f.repository.inspect(),/git_repository_changed/);
 const other=await fixture(t);await other.repository.inspect();await rename(join(other.root,'.git'),join(other.parent,'metadata'));await symlink(join(other.parent,'metadata'),join(other.root,'.git'),'junction');await assert.rejects(other.repository.inspect());
});

test('linked worktrees require an explicit operator-owned Git/common directory binding',async t=>{
 const f=await fixture(t),linked=join(f.parent,'linked');f.git('worktree','add','-b','linked',linked);
 await assert.rejects(new f.GitRepositoryInspection({root:linked}).inspect());
 const gitDirectory=f.git('-C',linked,'rev-parse','--absolute-git-dir').trim(),repository=new f.GitRepositoryInspection({root:linked,gitDirectory,commonDirectory:join(f.root,'.git')});
 const state=await repository.inspect();assert.equal(state.head.branch,'linked');assert.equal(state.entries.length,0);
});

test('local fsmonitor, external diff and textconv settings cannot execute during inspection',async t=>{
 const f=await fixture(t),marker=join(f.parent,'executed'),script=join(f.parent,'forbidden.sh');await writeFile(script,'#!/bin/sh\necho forbidden > "'+marker.replaceAll('\\','/')+'"\n');
 f.git('config','core.fsmonitor',script.replaceAll('\\','/'));f.git('config','diff.external',script.replaceAll('\\','/'));f.git('config','diff.fixture.textconv',script.replaceAll('\\','/'));
 await writeFile(join(f.root,'.gitattributes'),'note.txt diff=fixture\n');await writeFile(join(f.root,'note.txt'),'changed\n');
 const state=await f.repository.inspect();assert.match((await f.repository.diff({snapshot_id:state.snapshot_id,path:'note.txt',stage:'working'})).patch,/changed/);
 await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('repository clean filters cannot run while comparing an edited working file',async t=>{
 const f=await fixture(t),marker=join(f.parent,'clean-executed'),script=join(f.parent,'clean.sh');
 await writeFile(script,'#!/bin/sh\necho forbidden > "'+marker.replaceAll('\\','/')+'"\ncat\n');
 f.git('config','filter.fixture.clean','echo forbidden > '+JSON.stringify(marker.replaceAll('\\','/')));f.git('config','filter.fixture.required','true');
 await writeFile(join(f.root,'.gitattributes'),'note.txt filter=fixture\n');await writeFile(join(f.root,'note.txt'),'changed\n');
 const state=await f.repository.inspect();await assert.rejects(readFile(marker),{code:'ENOENT'});await f.repository.diff({snapshot_id:state.snapshot_id,path:'note.txt',stage:'working'});
 await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('remote projection contains only safe host metadata, never credentials or paths',async t=>{
 const f=await fixture(t),remote=new URL('https://example.invalid/private/repo.git?token=test-query#fragment');remote.username='test-user';remote.password='test-password';
 f.git('remote','add','origin',remote.href);f.git('remote','add','mirror','git@example.invalid:private/repo.git');f.git('remote','add','local','../private-repo');
 const state=await f.repository.inspect(),encoded=JSON.stringify(state.remotes);assert.ok(state.remotes.some(row=>row.name==='origin'&&row.host==='example.invalid'));
 for(const privateValue of ['test-user','test-password','private/','test-query','../private-repo'])assert.equal(encoded.includes(privateValue),false);
});

test('excess remote metadata refuses a partial or contract-invalid snapshot',async t=>{
 const f=await fixture(t),path=join(f.root,'.git','config');await writeFile(path,(await readFile(path,'utf8'))+Array.from({length:101},(_,index)=>'\n[remote "fixture-'+index+'"]\n url = https://example.invalid/repo.git\n').join(''));
 await assert.rejects(f.repository.inspect(),/git_entry_limit/);
});

test('cancelled and oversized inspections do not return a misleading partial snapshot',async t=>{
 const f=await fixture(t);const abort=new AbortController();abort.abort();await assert.rejects(f.repository.inspect(abort.signal));
 await writeFile(join(f.root,'note.txt'),'changed\n');await assert.rejects(new f.GitRepositoryInspection({root:f.root,limits:{maxOutputBytes:8}}).inspect(),/git_output_limit/);
});

test('untracked multi-line and non-newline content produces an accurate unified hunk',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'new.txt'),'one\ntwo');const state=await f.repository.inspect();
 const patch=await f.repository.diff({snapshot_id:state.snapshot_id,path:'new.txt',stage:'working'});
 assert.match(patch.patch,/@@ -0,0 \+1,2 @@\n\+one\n\+two\n\\ No newline at end of file\n$/);
});
