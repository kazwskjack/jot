import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SnapshotCopyWorkspaceProvider} from '../../src/always-on/snapshot-provider.ts';
import {workspaceManifestHash} from '../../src/always-on/workspace-provider.ts';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){const base=resolve('test/artifacts');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'materialize-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const storageRoot=join(root,'snapshots');mkdirSync(storageRoot);return {root,storageRoot};}
function source(f,changes={}){const content=Buffer.from([0,255,0,8]),manifest={protocol:1,provider:'snapshot-copy',paths:['context','new.md','newdir'],entries:[{path:'context',kind:'directory'},{path:'context/source.bin',kind:'file',sha256:sha(content),bytes:content.length,executable:false}]};return {storageRoot:f.storageRoot,manifest,selection:[{path:'context',kind:'directory'},{path:'new.md',kind:'file'},{path:'newdir',kind:'directory'}],read:async function*(path){assert.equal(path,'context/source.bin');yield content.subarray(0,1);yield content.subarray(1);},assertCurrent:async()=>{},guard:()=>{},signal:new AbortController().signal,...changes};}
function store(){const records=new Map();return {records,commit:async r=>records.set(r.snapshot_id,structuredClone(r)),read:async id=>records.get(id)};}

test('trusted streamed materialization retains raw bytes and explicit absent targets through durable recovery',async t=>{
 const f=fixture(t),recoveryStore=store(),provider=new SnapshotCopyWorkspaceProvider({recoveryStore}),input=source(f),snapshot=await provider.materialize(input);
 assert.deepEqual(readFileSync(join(snapshot.isolated_root,'context/source.bin')),Buffer.from([0,255,0,8]));assert.deepEqual(readdirSync(snapshot.isolated_root),['context']);assert.equal(snapshot.receipt.manifest_sha256,workspaceManifestHash(input.manifest));assert.equal(snapshot.receipt.execution_authorized,false);
 writeFileSync(join(snapshot.isolated_root,'new.md'),'new file');mkdirSync(join(snapshot.isolated_root,'newdir'));writeFileSync(join(snapshot.isolated_root,'newdir/new.txt'),'nested new file');
 const next=new SnapshotCopyWorkspaceProvider({recoveryStore}),restored=await next.recover({snapshot_id:snapshot.receipt.snapshot_id,storageRoot:f.storageRoot,guard:()=>{},signal:input.signal}),inspection=await next.inspect({snapshot:restored,guard:()=>{},signal:input.signal});
 assert.equal(inspection.manifest.entries.find(e=>e.path==='new.md').sha256,sha('new file'));assert.ok(inspection.manifest.entries.find(e=>e.path==='newdir/new.txt'));assert.equal(readdirSync(f.storageRoot).length,1);
});

test('materialization refuses wrong bytes, source drift, scope changes and cancellation without ready records',async t=>{
 for(const kind of ['bytes','source','scope','cancel']){const f=fixture(t),recoveryStore=store(),controller=new AbortController();let checked=0;
  const input=source(f,{signal:controller.signal,read:async function*(){yield Buffer.from([0,255]);if(kind==='cancel')controller.abort();yield Buffer.from([0,kind==='bytes'?9:8]);},assertCurrent:async()=>{if(kind==='source'&&++checked>1)throw Error('changed');}});
  if(kind==='scope')input.selection[0]={path:'context',kind:'file'};
  await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore}).materialize(input),/workspace_/);assert.equal(recoveryStore.records.size,0);
 }
});

test('materialization does not accept a missing current-source verifier or reads for directories',async t=>{
 const f=fixture(t);await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().materialize(source(f,{assertCurrent:undefined})),/workspace_/);assert.deepEqual(readdirSync(f.storageRoot),[]);
});

test('empty current source can retain new target absence without creating placeholder files',async t=>{
 const f=fixture(t),recoveryStore=store(),input=source(f,{manifest:{protocol:1,provider:'snapshot-copy',paths:['new'],entries:[]},selection:[{path:'new',kind:'directory'}],read:async function*(){throw Error('nothing to read');}});
 const first=await new SnapshotCopyWorkspaceProvider({recoveryStore}).materialize(input);assert.deepEqual(readdirSync(first.isolated_root),[]);assert.equal(first.receipt.total_bytes,0);
 const restored=await new SnapshotCopyWorkspaceProvider({recoveryStore}).recover({snapshot_id:first.receipt.snapshot_id,storageRoot:f.storageRoot,guard:()=>{},signal:input.signal});assert.deepEqual(restored.manifest.entries,[]);
});

test('cancelled source iterators are closed and bounds refuse before filesystem allocation',async t=>{
 const f=fixture(t),controller=new AbortController();let closed=false;
 const input=source(f,{signal:controller.signal,read:async function*(){try{yield Buffer.from([0,255]);controller.abort();yield Buffer.from([0,8]);}finally{closed=true;}}});
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().materialize(input),/workspace_/);assert.equal(closed,true);
 const g=fixture(t);await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().materialize(source(g,{limits:{max_total_bytes:3}})),/workspace_limit/);assert.deepEqual(readdirSync(g.storageRoot),[]);
});

test('a lost durable response preserves one original ready artifact and does not repeat source reads on recovery',async t=>{
 const f=fixture(t),recoveryStore=store(),commit=recoveryStore.commit;recoveryStore.commit=async record=>{await commit(record);throw Error('synthetic reply loss');};let reads=0,id;
 await assert.rejects(()=>new SnapshotCopyWorkspaceProvider({recoveryStore}).materialize(source(f,{guard:context=>{id=context.snapshot_id;},read:async function*(){reads++;yield Buffer.from([0,255,0,8]);}})),/workspace_recovery_commit_unknown/);
 const restored=await new SnapshotCopyWorkspaceProvider({recoveryStore}).recover({snapshot_id:id,storageRoot:f.storageRoot,guard:()=>{},signal:new AbortController().signal});assert.equal(restored.receipt.status,'ready');assert.equal(reads,1);assert.equal(readdirSync(f.storageRoot).length,1);
});

test('private paths, collisions and malformed future selection are rejected before copying',async t=>{
 const f=fixture(t);
 for(const change of [{selection:[{path:'context',kind:'directory'}]},{manifest:{protocol:1,provider:'snapshot-copy',paths:['.env'],entries:[]},selection:[{path:'.env',kind:'file'}]},{manifest:{protocol:1,provider:'snapshot-copy',paths:['A','a'],entries:[]},selection:[{path:'A',kind:'file'},{path:'a',kind:'file'}]}])await assert.rejects(()=>new SnapshotCopyWorkspaceProvider().materialize(source(f,change)),/workspace_/);
 assert.deepEqual(readdirSync(f.storageRoot),[]);
});
