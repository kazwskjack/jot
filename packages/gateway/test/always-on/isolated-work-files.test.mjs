import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotCopyWorkspaceProvider} from '../../src/always-on/snapshot-provider.ts';
import {IsolatedWorkFiles} from '../../src/always-on/isolated-work-files.ts';
import {installIsolatedWorkFiles} from '../../src/always-on/isolated-work-file-schema.ts';

async function fixture(t){
 const root=mkdtempSync(join(process.env.JOT_TEST_TMP??tmpdir(),'isolated-files-'));
 const sourceRoot=join(root,'source'),storageRoot=join(root,'storage');mkdirSync(sourceRoot);mkdirSync(storageRoot);mkdirSync(join(sourceRoot,'src'));writeFileSync(join(sourceRoot,'src/out.txt'),'base');writeFileSync(join(sourceRoot,'src/context.txt'),'context');
 let record;const snapshot=await new SnapshotCopyWorkspaceProvider({recoveryStore:{commit:async r=>{record=r;},read:async()=>record}}).create({sourceRoot,storageRoot,paths:['src'],guard:()=>{},signal:new AbortController().signal});
 const db=new DatabaseSync(join(root,'io.sqlite'));t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});installIsolatedWorkFiles(db);
 const identity={owner_id:'owner',workspace_id:'workspace',project_id:'project',agent_id:'agent',cycle_id:'cycle',snapshot_id:snapshot.receipt.snapshot_id,run_id:'run',occurrence_id:'occurrence',call_id:'call'};
 let guard=()=>{};const workspace={cycle:{cycle_id:'cycle',owner_id:'owner',workspace_id:'workspace',project_id:'project',agent_id:'agent'},snapshot,plan_paths:['src/out.txt','src/new.txt']};
 const options={db,resolve:async()=>({workspace,record,binding:Object.fromEntries(Object.entries(identity).filter(([k])=>k!=='call_id')),guard:()=>guard()}),commitReceipt:()=>{}};const service=new IsolatedWorkFiles(options);
 return {root,db,identity,workspace,record,options,service,setGuard:g=>{guard=g;}};
}
const write=(content='next',expected_version=0)=>({operation:'files.write',path:'src/out.txt',content,expected_version});
test('isolated bytes, immutable version and exact lost-response replay preserve producer identity',async t=>{
 const f=await fixture(t),r=await f.service.execute(f.identity,write());assert.equal(readFileSync(join(f.workspace.snapshot.isolated_root,'src/out.txt'),'utf8'),'next');assert.equal(r.run_id,'run');assert.equal(r.occurrence_id,'occurrence');assert.equal(r.version,1);
 const r2=await f.service.execute({...f.identity,call_id:'second'},write('later',1));assert.equal(r2.version,2);assert.deepEqual(await f.service.execute(f.identity,write()),r);assert.equal(f.service.version(r.receipt_id).content,'next');
 await assert.rejects(()=>f.service.execute(f.identity,write('changed')),/identity_conflict/);
});
test('exact plan paths exclude context, ancestor and descendants; changed context blocks all IO',async t=>{
 const f=await fixture(t);for(const path of ['src','src/context.txt','src/out.txt/child','../escape'])await assert.rejects(()=>f.service.execute({...f.identity,call_id:path},{...write(),path}),/path|grant/);
 writeFileSync(join(f.workspace.snapshot.isolated_root,'src/context.txt'),'drift');await assert.rejects(()=>f.service.execute(f.identity,write()),/context_changed/);assert.equal(readFileSync(join(f.workspace.snapshot.isolated_root,'src/out.txt'),'utf8'),'base');
});
test('unknown replacement remains held after host receipt failure and never replays IO',async t=>{
 const f=await fixture(t),s=new IsolatedWorkFiles({...f.options,commitReceipt:()=>{throw Error('lost_commit');}});await assert.rejects(()=>s.execute(f.identity,write()),/lost_commit/);
 assert.equal(readFileSync(join(f.workspace.snapshot.isolated_root,'src/out.txt'),'utf8'),'next');await assert.rejects(()=>f.service.execute(f.identity,write()),/uncertain/);await assert.rejects(()=>f.service.execute({...f.identity,call_id:'other'},write('other')),/pending/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,0);
});
test('reject hardlink substitution and wrong snapshot host binding',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.service.execute({...f.identity,snapshot_id:'wrong'},write()),/binding/);
 const target=join(f.workspace.snapshot.isolated_root,'src/out.txt');linkSync(target,join(f.root,'hardlink'));await assert.rejects(()=>f.service.execute(f.identity,write()),/unsafe/);
});
test('async final authority callback is refused and read/list preserve real isolated bytes',async t=>{
 const f=await fixture(t);const read=await f.service.execute(f.identity,{operation:'files.read',path:'src/out.txt'});assert.equal(read.content,'base');
 const list=await f.service.execute({...f.identity,call_id:'list'},{operation:'files.list'});assert.ok(list.files.some(x=>x.path==='src/context.txt'));
 f.setGuard(()=>Promise.resolve());await assert.rejects(()=>f.service.execute({...f.identity,call_id:'write'},write()),/synchronous/);
});



test('separate process crash after replacement leaves durable pending CAS across connections',async t=>{
 const f=await fixture(t);const {spawnSync}=await import('node:child_process');
 const moduleUrl=new URL('../../src/always-on/isolated-work-files.ts',import.meta.url).href;
 const config={workspace:f.workspace,record:f.record,binding:Object.fromEntries(Object.entries(f.identity).filter(([k])=>k!=='call_id'))};
 const code=`import {DatabaseSync} from 'node:sqlite';import {IsolatedWorkFiles} from ${JSON.stringify(moduleUrl)};const c=JSON.parse(process.argv[1]);const db=new DatabaseSync(process.argv[2]);const s=new IsolatedWorkFiles({db,resolve:async()=>({...c,guard:()=>{}}),commitReceipt:()=>process.exit(31)});await s.execute(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));`;
 const crashed=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify(config),join(f.root,'io.sqlite'),JSON.stringify(f.identity),JSON.stringify(write())],{encoding:'utf8',env:{...process.env,TEMP:process.env.JOT_TEST_TMP??tmpdir(),TMP:process.env.JOT_TEST_TMP??tmpdir()}});
 assert.equal(crashed.status,31,crashed.stderr);assert.equal(readFileSync(join(f.workspace.snapshot.isolated_root,'src/out.txt'),'utf8'),'next');
 const second=new DatabaseSync(join(f.root,'io.sqlite'));try{const s=new IsolatedWorkFiles({...f.options,db:second});await assert.rejects(()=>s.execute(f.identity,write()),/uncertain/);await assert.rejects(()=>s.execute({...f.identity,call_id:'competing'},write('conflict')),/pending/);}finally{second.close();}
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_pending').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,0);
});
test('context substitution after intent cannot publish a receipt',async t=>{
 const f=await fixture(t);let changed=false;f.setGuard(()=>{if(!changed&&f.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n){changed=true;writeFileSync(join(f.workspace.snapshot.isolated_root,'src/context.txt'),'substituted');}});await assert.rejects(()=>f.service.execute(f.identity,write()),/context_changed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,0);
});
test('immutable journal rejects SQL changes and write size/version errors cannot succeed',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.service.execute(f.identity,write('x',1)),/version_conflict/);await assert.rejects(()=>f.service.execute(f.identity,write('x'.repeat(1_048_577))),/operation_invalid/);
 await f.service.execute(f.identity,write());assert.throws(()=>f.db.exec('UPDATE wb_isolated_file_results SET version=2'),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM wb_isolated_file_intents'),/immutable/);
});


test('replaced physical root and junction ancestor are refused before any new operation',async t=>{
 const {renameSync,symlinkSync}=await import('node:fs');const f=await fixture(t),root=f.workspace.snapshot.isolated_root;renameSync(root,root+'-old');mkdirSync(root);await assert.rejects(()=>f.service.execute(f.identity,write()),/root_changed/);
 const g=await fixture(t),src=join(g.workspace.snapshot.isolated_root,'src');renameSync(src,src+'-old');symlinkSync(src+'-old',src,'junction');await assert.rejects(()=>g.service.execute(g.identity,write()),/unsafe/);
 assert.equal(g.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n,0);
});
test('new nested exact target creates only structural directories and immutable output',async t=>{
 const f=await fixture(t);f.workspace.plan_paths.push('src/newdeep/new.txt');const r=await f.service.execute(f.identity,{...write('new'),path:'src/newdeep/new.txt'});assert.equal(r.version,1);assert.equal(readFileSync(join(f.workspace.snapshot.isolated_root,'src/newdeep/new.txt'),'utf8'),'new');assert.equal(readFileSync(join(f.root,'source/src/out.txt'),'utf8'),'base');
});

test('external changes to an exact writable file do not become an accepted expected version',async t=>{
 const f=await fixture(t);writeFileSync(join(f.workspace.snapshot.isolated_root,'src/out.txt'),'external');await assert.rejects(()=>f.service.execute(f.identity,write()),/file_changed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n,0);
});
test('replacement through a receipt identity collision cannot delete immutable historical bytes',async t=>{
 const f=await fixture(t),one=await f.service.execute(f.identity,write());await f.service.execute({...f.identity,call_id:'second'},write('next',1));
 f.db.exec("INSERT INTO wb_isolated_file_intents SELECT 'unresolved',cycle_id,snapshot_id,identity_json,operation_json,digest,before_json,created_at FROM wb_isolated_file_intents LIMIT 1");assert.throws(()=>f.db.prepare("INSERT OR REPLACE INTO wb_isolated_file_results SELECT 'unresolved',?,cycle_id,snapshot_id,path,99,sha256,bytes,response_json FROM wb_isolated_file_results LIMIT 1").run(one.receipt_id),/immutable/);assert.equal(f.service.version(one.receipt_id).content,'next');
});


test('two concurrent processes admit at most one same-version write through the cycle CAS',async t=>{
 const f=await fixture(t),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile);
 const config={workspace:f.workspace,record:f.record,binding:Object.fromEntries(Object.entries(f.identity).filter(([k])=>k!=='call_id'))};
 const moduleUrl=new URL('../../src/always-on/isolated-work-files.ts',import.meta.url).href;
 const code=`import {DatabaseSync} from 'node:sqlite';import {IsolatedWorkFiles} from ${JSON.stringify(moduleUrl)};const c=JSON.parse(process.argv[1]),db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA busy_timeout=5000');const s=new IsolatedWorkFiles({db,resolve:async()=>({...c,guard:()=>{}}),commitReceipt:()=>{}});try{await s.execute(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));console.log('committed');}catch(e){console.log(e.message);}finally{db.close();}`;
 const outcomes=await Promise.all(['racer-a','racer-b'].map(call_id=>exec(process.execPath,['--input-type=module','-e',code,JSON.stringify(config),join(f.root,'io.sqlite'),JSON.stringify({...f.identity,call_id}),JSON.stringify(write())],{env:{...process.env,TEMP:process.env.JOT_TEST_TMP??tmpdir(),TMP:process.env.JOT_TEST_TMP??tmpdir()}})));
 const states=outcomes.map(x=>x.stdout.trim());assert.equal(states.filter(x=>x==='committed').length,1);assert.match(states.find(x=>x!=='committed'),/^isolated_file_(pending|version_conflict|file_changed)$/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,1);assert.equal(readFileSync(join(f.workspace.snapshot.isolated_root,'src/out.txt'),'utf8'),'next');
});

test('same-content directory replacement after intent cannot redirect a successful write',async t=>{
 const f=await fixture(t),{renameSync}=await import('node:fs');let changed=false;f.setGuard(()=>{if(!changed&&f.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n){changed=true;const src=join(f.workspace.snapshot.isolated_root,'src');renameSync(src,src+'-old');mkdirSync(src);writeFileSync(join(src,'context.txt'),'context');writeFileSync(join(src,'out.txt'),'base');}});
 await assert.rejects(()=>f.service.execute(f.identity,write()),/ancestor_changed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,0);
});


test('ancestor replacement preserving original file identities cannot commit a write',async t=>{
 const f=await fixture(t),{renameSync,rmdirSync}=await import('node:fs');let changed=false;f.setGuard(()=>{if(!changed&&f.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n){changed=true;const src=join(f.workspace.snapshot.isolated_root,'src'),old=join(f.root,'moved-src');renameSync(src,old);mkdirSync(src);for(const name of ['out.txt','context.txt'])renameSync(join(old,name),join(src,name));rmdirSync(old);}});
 await assert.rejects(()=>f.service.execute(f.identity,{...write(),path:'src/new.txt'}),/ancestor_changed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,0);
});

