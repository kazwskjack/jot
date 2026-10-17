import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,rmdirSync,existsSync,symlinkSync,renameSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SnapshotCopyWorkspaceProvider} from '../../src/always-on/snapshot-provider.ts';
import {validateWorkspaceManifest,workspaceManifestHash} from '../../src/always-on/workspace-provider.ts';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){const base=resolve('.test-tmp');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'snapshot-provider-')),sourceRoot=join(root,'source'),storageRoot=join(root,'storage');mkdirSync(sourceRoot);mkdirSync(storageRoot);t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));return {root,sourceRoot,storageRoot};}
function input(f,options={}){return {...f,paths:['src'],guard:()=>{},signal:new AbortController().signal,...options};}

test('snapshot copies explicit binary and empty directory scope, hashes bytes, and keeps receipt paths relative',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src/empty'),{recursive:true});const binary=Buffer.from([0,255,1,128,13,10]);writeFileSync(join(f.sourceRoot,'src/binary.bin'),binary);writeFileSync(join(f.sourceRoot,'not-selected.txt'),'outside selection');
 const phases=[];const result=await new SnapshotCopyWorkspaceProvider().create(input(f,{guard:context=>phases.push(context.phase)}));
 assert.deepEqual(readFileSync(join(result.isolated_root,'src/binary.bin')),binary);assert.equal(existsSync(join(result.isolated_root,'src/empty')),true);assert.equal(existsSync(join(result.isolated_root,'not-selected.txt')),false);
 assert.deepEqual(result.manifest.entries.find(entry=>entry.path==='src/binary.bin'),{path:'src/binary.bin',kind:'file',sha256:sha(binary),bytes:binary.length,executable:false});
 assert.equal(result.receipt.status,'ready');assert.equal(result.receipt.execution_authorized,false);assert.equal(result.receipt.total_bytes,binary.length);assert.equal(result.receipt.file_count,1);assert.equal(result.receipt.directory_count,2);
 assert.ok(Object.isFrozen(result.manifest));assert.ok(Object.isFrozen(result.manifest.entries));assert.ok(Object.isFrozen(result.manifest.entries[0]));
 assert.equal(JSON.stringify([result.manifest,result.receipt]).includes(f.root),false);assert.equal(JSON.stringify([result.manifest,result.receipt]).includes('sourceRoot'),false);
 for(const phase of ['prepare','copy','verify','publish'])assert.ok(phases.includes(phase));
 const again=await new SnapshotCopyWorkspaceProvider().create(input(f));assert.notEqual(again.isolated_root,result.isolated_root);assert.equal(again.receipt.manifest_sha256,result.receipt.manifest_sha256);
});

test('snapshot streams a multi-megabyte file with matching source and target digest',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));const block=Buffer.alloc(3*1024*1024+17,83);writeFileSync(join(f.sourceRoot,'src/large.bin'),block);
 const result=await new SnapshotCopyWorkspaceProvider().create(input(f));assert.equal(result.manifest.entries.find(entry=>entry.kind==='file').sha256,sha(block));assert.equal(sha(readFileSync(join(result.isolated_root,'src/large.bin'))),sha(block));
});

test('snapshot rejects missing guard/signal, overlapping roots and unsafe explicit paths before creating output',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));const provider=new SnapshotCopyWorkspaceProvider();
 for(const options of [{guard:undefined},{signal:undefined},{storageRoot:f.sourceRoot},{storageRoot:join(f.sourceRoot,'src')},{sourceRoot:f.storageRoot},{paths:['../source']},{paths:['/absolute']},{paths:['C:/private']},{paths:['src\\private']},{paths:['src','src/a']},{paths:['src','SRC']},{paths:['src/con']},{paths:['src/trailing.']}])await assert.rejects(()=>provider.create(input(f,options)),/workspace_/);
 assert.deepEqual(readdirSync(f.storageRoot),[]);
});

test('snapshot refuses known private configuration even within an explicitly selected directory',async t=>{
 for(const name of ['.env','.env.local','.git','.ssh','.aws','id_rsa','secret.key','Cookies','Login Data','browser-profile']){
  const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src',name),'private fixture');
  await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f)),/workspace_private_path/);assert.deepEqual(readdirSync(f.storageRoot),[]);
 }
});

test('snapshot rejects symbolic links or junctions and case-colliding selected trees',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));mkdirSync(join(f.root,'outside'));symlinkSync(join(f.root,'outside'),join(f.sourceRoot,'src/escape'),'junction');
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f)),/workspace_path_unsafe/);assert.deepEqual(readdirSync(f.storageRoot),[]);
});

test('guard revocation, source changes, inode replacement, target tampering and abort never return ready and keep isolated residuals',async t=>{
 for(const mode of ['revoke','change','replace','target','abort']){
  const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a.txt'),'original');const controller=new AbortController();let changed=false;
  const guard=context=>{if(changed||context.phase!=='verify')return;changed=true;
   if(mode==='revoke')throw Error('revoked');if(mode==='change')writeFileSync(join(f.sourceRoot,'src/a.txt'),'changed');
   if(mode==='replace'){renameSync(join(f.sourceRoot,'src/a.txt'),join(f.sourceRoot,'src/old.txt'));writeFileSync(join(f.sourceRoot,'src/a.txt'),'original');}
   if(mode==='target')writeFileSync(join(f.storageRoot,readdirSync(f.storageRoot)[0],'src/a.txt'),'tampered');if(mode==='abort')controller.abort();};
  await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f,{guard,signal:controller.signal})),/workspace_/);
  assert.equal(readdirSync(f.storageRoot).length,1);assert.equal(readFileSync(join(f.sourceRoot,'src/a.txt'),'utf8'),mode==='change'?'changed':'original');
 }
});

test('bounded copy and cancellation stop mid-file without deleting caller roots or returning a ready snapshot',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a.bin'),Buffer.alloc(2*1024*1024,7));const controller=new AbortController();let copying=0;
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f,{signal:controller.signal,guard:context=>{if(context.phase==='copy'&&++copying===5)controller.abort();}})),/workspace_/);
 assert.equal(readdirSync(f.storageRoot).length,1);assert.equal(existsSync(f.sourceRoot),true);
 const partial=statSync(join(f.storageRoot,readdirSync(f.storageRoot)[0],'src/a.bin')).size;assert.ok(partial>0&&partial<2*1024*1024);
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f,{limits:{max_file_bytes:1024}})),/workspace_limit/);
});

test('inspection discovers scoped edits, additions, deletions and empty directories without mutating base',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a.txt'),'before');writeFileSync(join(f.sourceRoot,'selected.txt'),'selected');
 const provider=new SnapshotCopyWorkspaceProvider(),snapshot=await provider.create(input(f,{paths:['src','selected.txt']}));
 writeFileSync(join(snapshot.isolated_root,'src/a.txt'),'after');writeFileSync(join(snapshot.isolated_root,'src/b.bin'),Buffer.from([0,255]));mkdirSync(join(snapshot.isolated_root,'src/empty'));rmSync(join(snapshot.isolated_root,'selected.txt'));
 const result=await provider.inspect({snapshot,guard:()=>{},signal:new AbortController().signal});
 assert.equal(result.execution_authorized,false);assert.equal(result.snapshot_id,snapshot.receipt.snapshot_id);assert.equal(result.manifest.entries.some(e=>e.path==='selected.txt'),false);assert.equal(result.manifest.entries.find(e=>e.path==='src/a.txt').sha256,sha('after'));assert.equal(result.manifest.entries.some(e=>e.path==='src/empty'&&e.kind==='directory'),true);
 assert.notEqual(result.manifest_sha256,snapshot.receipt.manifest_sha256);assert.equal(snapshot.manifest.entries.find(e=>e.path==='src/a.txt').sha256,sha('before'));assert.equal(workspaceManifestHash(result.manifest),result.manifest_sha256);
});

test('inspection rejects forged snapshots, another provider, outside additions, private paths and links',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a.txt'),'before');const provider=new SnapshotCopyWorkspaceProvider(),snapshot=await provider.create(input(f));const options={guard:()=>{},signal:new AbortController().signal};
 await assert.rejects(()=>provider.inspect({snapshot:{...snapshot},...options}),/workspace_snapshot_untrusted/);await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().inspect({snapshot,...options}),/workspace_snapshot_untrusted/);
 writeFileSync(join(snapshot.isolated_root,'outside.txt'),'outside');await assert.rejects(()=>provider.inspect({snapshot,...options}),/workspace_scope_changed/);rmSync(join(snapshot.isolated_root,'outside.txt'));
 writeFileSync(join(snapshot.isolated_root,'src/.env'),'private');await assert.rejects(()=>provider.inspect({snapshot,...options}),/workspace_private_path/);rmSync(join(snapshot.isolated_root,'src/.env'));
 symlinkSync(f.sourceRoot,join(snapshot.isolated_root,'src/link'),'junction');await assert.rejects(()=>provider.inspect({snapshot,...options}),/workspace_path_unsafe/);
});

test('manifest validator canonicalizes ordering but rejects duplicates, escapes, missing parents and malformed entries',()=>{
 const base={protocol:1,provider:'snapshot-copy',paths:['src'],entries:[{path:'src/a',kind:'file',bytes:1,sha256:sha('x'),executable:false},{path:'src',kind:'directory'}]};
 assert.deepEqual(validateWorkspaceManifest(base).entries.map(e=>e.path),['src','src/a']);
 assert.equal(workspaceManifestHash(base),workspaceManifestHash({...base,entries:[...base.entries].reverse()}));
 for(const entries of [[base.entries[0]],[...base.entries,{...base.entries[0],path:'src/A'}],[...base.entries,{path:'outside',kind:'directory'}],[{path:'src',kind:'directory',extra:true}],[{...base.entries[0],bytes:-1},base.entries[1]],[{...base.entries[0],path:'src/../escape'},base.entries[1]]])assert.throws(()=>validateWorkspaceManifest({...base,entries}),/workspace_/);
});

test('entry, total byte and depth bounds plus pre-cancel refuse before allocation',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src/deep'),{recursive:true});writeFileSync(join(f.sourceRoot,'src/a'),'1234');writeFileSync(join(f.sourceRoot,'src/deep/b'),'5678');
 const aborted=new AbortController();aborted.abort();
 for(const options of [{limits:{max_entries:2}},{limits:{max_total_bytes:7}},{limits:{max_depth:2}},{signal:aborted.signal}])await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f,options)),/workspace_/);
 assert.deepEqual(readdirSync(f.storageRoot),[]);
});

test('private root and substituted root are refused; source mutations during target verification remain detected',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'.ssh'));writeFileSync(join(f.sourceRoot,'.ssh/config'),'private');await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f,{sourceRoot:join(f.sourceRoot,'.ssh'),paths:['config']})),/workspace_private_path/);
 mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'first');let published=false,changed=false;
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().create(input(f,{guard:context=>{if(context.phase==='publish')published=true;if(published&&!changed&&context.phase==='verify'&&context.relative_path==='src/a'){changed=true;writeFileSync(join(f.sourceRoot,'src/a'),'later');}}})),/workspace_source_changed/);
 assert.equal(changed,true);
});

test('inspection catches directory-root replacement, cancellation and source changes during observed hashing',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const provider=new SnapshotCopyWorkspaceProvider(),snapshot=await provider.create(input(f));
 const controller=new AbortController();controller.abort();await assert.rejects(()=>provider.inspect({snapshot,guard:()=>{},signal:controller.signal}),/workspace_cancelled/);
 let changed=false;await assert.rejects(()=>provider.inspect({snapshot,signal:new AbortController().signal,guard:context=>{if(!changed&&context.phase==='verify'&&context.relative_path==='src/a'){changed=true;writeFileSync(join(snapshot.isolated_root,'src/a'),'during');}}}),/workspace_source_changed/);
 renameSync(snapshot.isolated_root,snapshot.isolated_root+'-old');mkdirSync(snapshot.isolated_root);await assert.rejects(()=>provider.inspect({snapshot,guard:()=>{},signal:new AbortController().signal}),/workspace_root_changed/);
});

test('a structural selection ancestor cannot become a file in a validated result manifest',()=>{
 const manifest={protocol:1,provider:'snapshot-copy',paths:['src/selected.txt'],entries:[{path:'src',kind:'file',sha256:sha('replacement'),bytes:11,executable:false}]};
 assert.throws(()=>validateWorkspaceManifest(manifest),/workspace_/);
 assert.deepEqual(validateWorkspaceManifest({...manifest,entries:[]}).entries,[],'deleting the selected file does not grant authority to its missing parent');
});

test('real inspection rejects replacing an unselected structural parent with a file but permits its absence',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/selected.txt'),'selected');writeFileSync(join(f.sourceRoot,'src/untouched.txt'),'unselected sibling');
 const provider=new SnapshotCopyWorkspaceProvider(),snapshot=await provider.create(input(f,{paths:['src/selected.txt']})),controls={guard:()=>{},signal:new AbortController().signal};
 rmSync(join(snapshot.isolated_root,'src/selected.txt'));rmdirSync(join(snapshot.isolated_root,'src'));
 const removed=await provider.inspect({snapshot,...controls});assert.deepEqual(removed.manifest.entries,[]);assert.deepEqual(removed.manifest.paths,['src/selected.txt']);
 writeFileSync(join(snapshot.isolated_root,'src'),'replacement');await assert.rejects(()=>provider.inspect({snapshot,...controls}),/workspace_/);
 assert.equal(readFileSync(join(f.sourceRoot,'src/untouched.txt'),'utf8'),'unselected sibling');
});

function recoveryStore(){const records=new Map();let commits=0;return {records,get commits(){return commits;},commit:async record=>{commits++;records.set(record.snapshot_id,structuredClone(record));},read:async id=>records.get(id)};}

test('a new provider recovers a committed snapshot and inspects legitimate edits without copying or changing base',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const store=recoveryStore(),first=new SnapshotCopyWorkspaceProvider({recoveryStore:store}),snapshot=await first.create(input(f));
 writeFileSync(join(snapshot.isolated_root,'src/a'),'after');writeFileSync(join(snapshot.isolated_root,'src/new'),'added');const before=readdirSync(f.storageRoot),second=new SnapshotCopyWorkspaceProvider({recoveryStore:store});
 const restored=await second.recover({snapshot_id:snapshot.receipt.snapshot_id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal}),result=await second.inspect({snapshot:restored,guard:()=>{},signal:new AbortController().signal});
 assert.equal(restored.receipt.manifest_sha256,snapshot.receipt.manifest_sha256);assert.equal(restored.isolated_root,snapshot.isolated_root);assert.equal(restored.manifest.entries.find(e=>e.path==='src/a').sha256,sha('before'));
 assert.equal(result.manifest.entries.find(e=>e.path==='src/a').sha256,sha('after'));assert.ok(result.manifest.entries.some(e=>e.path==='src/new'));assert.deepEqual(readdirSync(f.storageRoot),before);assert.equal(store.commits,1);assert.equal(restored.receipt.execution_authorized,false);
});

test('lost recovery-store commit response cannot return ready but committed identity can be recovered once without recopy',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'ready bytes');const store=recoveryStore(),commit=store.commit;store.commit=async record=>{await commit(record);throw Error('synthetic lost response');};
 let snapshotId;await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore:store}).create(input(f,{guard:context=>{snapshotId??=context.snapshot_id;}})),/workspace_recovery_commit_unknown/);
 assert.equal(store.records.size,1);assert.equal(readdirSync(f.storageRoot).length,1);const provider=new SnapshotCopyWorkspaceProvider({recoveryStore:store}),recovered=await provider.recover({snapshot_id:snapshotId,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal});
 assert.equal(recovered.receipt.status,'ready');assert.equal(store.commits,1);assert.equal(readdirSync(f.storageRoot).length,1);
});

test('recovery refuses unrecorded leftovers, wrong storage, forged metadata, root replacement, revoked guard and cancellation',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const store=recoveryStore(),provider=new SnapshotCopyWorkspaceProvider({recoveryStore:store}),snapshot=await provider.create(input(f)),id=snapshot.receipt.snapshot_id;
 const recover=(options={},using=store)=>new SnapshotCopyWorkspaceProvider({recoveryStore:using}).recover({snapshot_id:id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal,...options});
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().recover({snapshot_id:id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal}),/workspace_recovery_unavailable/);
 await assert.rejects(()=>recover({},recoveryStore()),/workspace_recovery_not_found/);
 mkdirSync(join(f.root,'other'));await assert.rejects(()=>recover({storageRoot:join(f.root,'other')}),/workspace_recovery_/);
 for(const modify of [r=>r.snapshot_id='workspace-snapshot-forged',r=>r.receipt.manifest_sha256='0'.repeat(64),r=>r.isolated_root.ino='0',r=>r.selection=[{path:'outside',kind:'directory'}],r=>r.limits={max_entries:1},r=>r.isolated_root.path=f.sourceRoot]){
  const forged=structuredClone(store.records.get(id));modify(forged);await assert.rejects(()=>recover({},{...store,read:async()=>forged}),/workspace_/);
 }
 await assert.rejects(()=>recover({guard:()=>{throw Error('revoked');}}),/workspace_guard_rejected/);const aborted=new AbortController();aborted.abort();await assert.rejects(()=>recover({signal:aborted.signal}),/workspace_cancelled/);
 renameSync(snapshot.isolated_root,snapshot.isolated_root+'-old');mkdirSync(snapshot.isolated_root);await assert.rejects(()=>recover(),/workspace_/);assert.equal(store.commits,1);
});

test('recovery validates real result scope, private files and partial preparation without modifying artifacts',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const store=recoveryStore(),snapshot=await new SnapshotCopyWorkspaceProvider({recoveryStore:store}).create(input(f)),id=snapshot.receipt.snapshot_id;
 const recover=()=>new SnapshotCopyWorkspaceProvider({recoveryStore:store}).recover({snapshot_id:id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal});
 for(const path of ['outside','src/.env']){writeFileSync(join(snapshot.isolated_root,path),'forbidden');await assert.rejects(recover,/workspace_/);assert.equal(readFileSync(join(snapshot.isolated_root,path),'utf8'),'forbidden');rmSync(join(snapshot.isolated_root,path));}
 const partialStore=recoveryStore();await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore:partialStore}).create(input(f,{guard:context=>{if(context.phase==='copy')throw Error('stop before copy');}})),/workspace_guard_rejected/);assert.equal(partialStore.records.size,0);
 assert.equal(store.commits,1);assert.equal((await recover()).receipt.status,'ready');
});

test('another Node process reconstructs the provider from its trusted host record without writing metadata',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const store=recoveryStore(),snapshot=await new SnapshotCopyWorkspaceProvider({recoveryStore:store}).create(input(f)),id=snapshot.receipt.snapshot_id,recordPath=join(f.root,'trusted-record.json');writeFileSync(recordPath,JSON.stringify(store.records.get(id)));writeFileSync(join(snapshot.isolated_root,'src/a'),'edited');
 const source=`import {readFileSync} from 'node:fs';import {SnapshotCopyWorkspaceProvider} from ${JSON.stringify(new URL('../../src/always-on/snapshot-provider.ts',import.meta.url).href)};const record=JSON.parse(readFileSync(process.argv[1],'utf8'));let commits=0;const provider=new SnapshotCopyWorkspaceProvider({recoveryStore:{read:async()=>record,commit:async()=>{commits++;throw Error('must not write');}}});const snapshot=await provider.recover({snapshot_id:record.snapshot_id,storageRoot:process.argv[2],guard:()=>{},signal:new AbortController().signal});const result=await provider.inspect({snapshot,guard:()=>{},signal:new AbortController().signal});console.log(JSON.stringify({commits,sha256:result.manifest.entries.find(e=>e.kind==='file').sha256,base:snapshot.receipt.manifest_sha256}));`;
 const before=readFileSync(recordPath,'utf8'),result=await promisify(execFile)(process.execPath,['--input-type=module','-e',source,recordPath,f.storageRoot]);assert.deepEqual(JSON.parse(result.stdout),{commits:0,sha256:sha('edited'),base:snapshot.receipt.manifest_sha256});assert.equal(readFileSync(recordPath,'utf8'),before);assert.equal(readdirSync(f.storageRoot).length,1);
});

test('recovery refuses replacement of the storage directory and does not initialize a missing configured root',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const store=recoveryStore(),snapshot=await new SnapshotCopyWorkspaceProvider({recoveryStore:store}).create(input(f));
 renameSync(f.storageRoot,f.storageRoot+'-original');mkdirSync(f.storageRoot);const provider=new SnapshotCopyWorkspaceProvider({recoveryStore:store}),recover=storageRoot=>provider.recover({snapshot_id:snapshot.receipt.snapshot_id,storageRoot,guard:()=>{},signal:new AbortController().signal});
 await assert.rejects(()=>recover(f.storageRoot),/workspace_recovery_storage_changed/);assert.deepEqual(readdirSync(f.storageRoot),[]);
 const missing=join(f.root,'missing');await assert.rejects(()=>recover(missing),/workspace_recovery_failed/);assert.equal(existsSync(missing),false);assert.equal(store.commits,1);
});

test('recovery rechecks links and structural scope and preserves exact bytes and metadata on a valid read',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/selected'),'before');const store=recoveryStore(),snapshot=await new SnapshotCopyWorkspaceProvider({recoveryStore:store}).create(input(f,{paths:['src/selected']}));
 const recover=()=>new SnapshotCopyWorkspaceProvider({recoveryStore:store}).recover({snapshot_id:snapshot.receipt.snapshot_id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal});
 const before={root:statSync(snapshot.isolated_root,{bigint:true}),file:statSync(join(snapshot.isolated_root,'src/selected'),{bigint:true}),record:JSON.stringify(store.records.get(snapshot.receipt.snapshot_id))};
 await recover();const afterRoot=statSync(snapshot.isolated_root,{bigint:true}),afterFile=statSync(join(snapshot.isolated_root,'src/selected'),{bigint:true});
 for(const key of ['ino','mtimeNs','ctimeNs']){assert.equal(afterRoot[key],before.root[key]);assert.equal(afterFile[key],before.file[key]);}assert.equal(readFileSync(join(snapshot.isolated_root,'src/selected'),'utf8'),'before');assert.equal(JSON.stringify(store.records.get(snapshot.receipt.snapshot_id)),before.record);
 rmSync(join(snapshot.isolated_root,'src/selected'));rmdirSync(join(snapshot.isolated_root,'src'));writeFileSync(join(snapshot.isolated_root,'src'),'unselected parent');await assert.rejects(recover,/workspace_scope_changed/);rmSync(join(snapshot.isolated_root,'src'));mkdirSync(join(snapshot.isolated_root,'src'));symlinkSync(f.sourceRoot,join(snapshot.isolated_root,'src/selected'),'junction');await assert.rejects(recover,/workspace_path_unsafe/);
});

test('an interrupted preparation has no recoverable ready record and store errors expose only bounded codes',async t=>{
 const f=fixture(t);mkdirSync(join(f.sourceRoot,'src'));writeFileSync(join(f.sourceRoot,'src/a'),'before');const store=recoveryStore();let id;
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore:store}).create(input(f,{guard:context=>{id=context.snapshot_id;if(context.phase==='copy')throw Error('stop');}})),/workspace_guard_rejected/);
 const roots=readdirSync(f.storageRoot),options={snapshot_id:id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal};
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore:store}).recover(options),/workspace_recovery_not_found/);assert.deepEqual(readdirSync(f.storageRoot),roots);assert.equal(store.commits,0);
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore:{commit:async()=>{},read:async()=>{throw Error('private exception includes a root');}}}).recover(options),error=>error.message==='workspace_recovery_unavailable');
});
