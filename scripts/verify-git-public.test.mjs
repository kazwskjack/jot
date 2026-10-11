import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
async function fixture(t){
 await mkdir('.test-tmp',{recursive:true});const root=await mkdtemp(resolve('.test-tmp/git-review-'));
 t.after(()=>{const child=relative(resolve('.test-tmp'),root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));return rm(root,{recursive:true,force:true});});
 const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,'-C',root,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Test author');git('config','user.email','test@example.test');
 return {root,git};
}
test('deleted historical credentials and private identities are still findings without printing their values',async t=>{
 const {scanGitPublic}=await import('./verify-git-public.mjs'),f=await fixture(t);
 const secret=['sk','-','a'.repeat(30)].join('');
 await writeFile(resolve(f.root,'old.txt'),`credential ${secret}\nhttps://private-site.example.test/`);f.git('add','.');f.git('commit','-qm','First');
 await rm(resolve(f.root,'old.txt'));await writeFile(resolve(f.root,'README.md'),'Public project');f.git('add','-A');f.git('commit','-qm','Remove old file');
 const result=await scanGitPublic(f.root,{privateIdentities:['private-site.example.test']});
 assert.ok(result.findings.some(x=>x.rule==='model_api_key'));assert.ok(result.findings.some(x=>x.rule==='private_identity'));
 assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(result).includes('private-site.example.test'));
});
test('staged content and binary blobs require review; identity patterns must not be empty',async t=>{
 const {scanGitPublic}=await import('./verify-git-public.mjs'),f=await fixture(t);
 await writeFile(resolve(f.root,'README.md'),'Public project');f.git('add','.');f.git('commit','-qm','First');
 await writeFile(resolve(f.root,'payload.bin'),Buffer.from([0,1,2,255]));await writeFile(resolve(f.root,'draft.md'),'PRIVATE_MARKER');f.git('add','.');
 const result=await scanGitPublic(f.root,{privateIdentities:['PRIVATE_MARKER']});
 assert.ok(result.findings.some(x=>x.file==='draft.md'&&x.rule==='private_identity'));assert.ok(result.findings.some(x=>x.file==='payload.bin'&&x.rule==='binary_requires_review'));
 await assert.rejects(scanGitPublic(f.root,{privateIdentities:['']}),/git_review_policy_invalid/);
});
test('a clean repository and clean staged edit pass without changing index or history',async t=>{
 const {scanGitPublic}=await import('./verify-git-public.mjs'),f=await fixture(t);
 await writeFile(resolve(f.root,'README.md'),'Public project');f.git('add','.');f.git('commit','-qm','First');
 await writeFile(resolve(f.root,'README.md'),'Public project, edited');f.git('add','.');
 const before=f.git('status','--porcelain'),head=f.git('rev-parse','HEAD');const result=await scanGitPublic(f.root,{privateIdentities:['PRIVATE_MARKER']});
 assert.deepEqual(result.findings,[]);assert.ok(result.blobs>=2);assert.equal(f.git('status','--porcelain'),before);assert.equal(f.git('rev-parse','HEAD'),head);
});
