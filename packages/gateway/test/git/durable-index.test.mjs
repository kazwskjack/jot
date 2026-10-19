import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {GitIndexEffects} from '../../src/git/index-effects.ts';
async function fixture(t){
 const parent=await mkdtemp(join(tmpdir(),'jot-durable-index-')),root=join(parent,'repo'),database=join(parent,'journal.sqlite'),childTemp=join(parent,'child-temp');await mkdir(root);await mkdir(childTemp);const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'original\n');git('add','.');git('commit','-m','Synthetic crash fixture');await writeFile(join(root,'note.txt'),'reviewed content\n');
 const kernel=new GitIndexEffects({root}),snapshot=await kernel.inspect(),witness=await kernel.freeze(snapshot.snapshot_id,['note.txt']),before=await readFile(join(root,'.git/index')),db=new DatabaseSync(database);db.exec('CREATE TABLE original_source(witness_json TEXT);CREATE TABLE physical_evidence(evidence_json TEXT);CREATE TABLE physical_outcome(receipt_json TEXT)');db.prepare('INSERT INTO original_source VALUES(?)').run(JSON.stringify(witness));db.close();
 t.after(async()=>{assert.ok(resolve(parent).startsWith(resolve(tmpdir())+sep));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const crash=phase=>{const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/index-crash-worker.mjs',import.meta.url)),root,database,phase],{encoding:'utf8',env:{...process.env,TEMP:childTemp,TMP:childTemp},timeout:30000,windowsHide:true});assert.equal(child.error,undefined);assert.equal(child.status,73,child.stderr);const storage=new DatabaseSync(database);try{assert.equal(storage.prepare('SELECT COUNT(*) AS n FROM physical_outcome').get().n,0);return JSON.parse(storage.prepare('SELECT evidence_json FROM physical_evidence').get().evidence_json);}finally{storage.close();}};
 return{root,database,before,kernel,witness,git,crash};
}
test('a real process exit after physical publication is observed by a new kernel without replay',async t=>{
 const f=await fixture(t),evidence=f.crash('after_publication'),fresh=new GitIndexEffects({root:f.root});assert.equal((await fresh.observeEvidence(evidence)).state,'applied');assert.equal(f.git('show',':note.txt'),'reviewed content\n');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'reviewed content\n');assert.equal((await fresh.observeEvidence(evidence)).execution_authorized,false);
});
test('a real process exit before publication leaves the original index and cannot invent a receipt',async t=>{
 const f=await fixture(t),evidence=f.crash('before_publication'),fresh=new GitIndexEffects({root:f.root});assert.deepEqual(await readFile(join(f.root,'.git/index')),f.before);assert.equal((await fresh.observeEvidence(evidence)).state,'not_observed');assert.equal(f.git('diff','--cached','--name-only').trim(),'');
});
test('persisted evidence is strict and matching bytes on another index identity remain unknown',async t=>{
 const f=await fixture(t),evidence=f.crash('after_publication'),fresh=new GitIndexEffects({root:f.root});await assert.rejects(fresh.observeEvidence({...evidence,root:'/untrusted'}),/git_index_evidence_invalid/);await assert.rejects(fresh.observeEvidence({...evidence,protocol:0}),/git_index_evidence_invalid/);
 const index=join(f.root,'.git/index'),bytes=await readFile(index),replacement=join(f.root,'replacement-index');await writeFile(replacement,bytes);await rename(replacement,index);assert.equal((await fresh.observeEvidence(evidence)).state,'unknown');
});

test('recovery preserves a lock whose owned file has acquired unproven contents',async t=>{
 const f=await fixture(t),evidence=f.crash('after_publication'),fresh=new GitIndexEffects({root:f.root}),lock=join(f.root,'.git/HEAD.lock');await writeFile(lock,'foreign lock contents');
 await assert.rejects(fresh.cleanupEvidence(evidence,()=>{}),/git_index_lock_unverified/);assert.equal(await readFile(lock,'utf8'),'foreign lock contents');assert.equal(f.git('show',':note.txt'),'reviewed content\n');
});
