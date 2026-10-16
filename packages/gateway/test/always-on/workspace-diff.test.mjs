import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmdirSync,rmSync,existsSync} from 'node:fs';import {resolve,join,relative,isAbsolute} from 'node:path';
import {SnapshotCopyWorkspaceProvider} from '../../src/always-on/snapshot-provider.ts';
const module=await import('../../src/always-on/workspace-diff.ts').catch(()=>({}));
const sha=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const file=(path,char='a',bytes=4,executable=false)=>({path,kind:'file',sha256:char.repeat(64),bytes,executable});
const dir=path=>({path,kind:'directory'});
const manifest=entries=>({protocol:1,provider:'snapshot-copy',paths:['src'],entries:[dir('src'),...entries].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
const diff=(base,result,extra={})=>module.createWorkspaceDiff({base,result,base_sha256:sha(base),result_sha256:sha(result),...extra});

test('workspace differences are frozen non-authorizing artifacts over exact manifest hashes',()=>{
 assert.equal(typeof module.createWorkspaceDiff,'function');const base=manifest([file('src/a')]),result=manifest([file('src/a','b')]);
 const value=diff(base,result);assert.equal(value.execution_authorized,false);assert.equal(value.base_sha256,sha(base));assert.equal(value.result_sha256,sha(result));assert.ok(Object.isFrozen(value));assert.ok(Object.isFrozen(value.changes));
 assert.deepEqual(value.changes.map(c=>({kind:c.kind,path:c.path,content_changed:c.content_changed,mode_changed:c.mode_changed})),[{kind:'modify',path:'src/a',content_changed:true,mode_changed:false}]);
 const {diff_sha256,...payload}=value;assert.equal(diff_sha256,sha(payload));
 assert.throws(()=>diff(base,result,{base_sha256:'0'.repeat(64)}),/workspace_diff_base_changed/);
 assert.throws(()=>diff(base,result,{result_sha256:'0'.repeat(64)}),/workspace_diff_result_changed/);
});

test('diff retains file mode, empty directory, deletion and file-directory type changes',()=>{
 const base=manifest([file('src/mode'),dir('src/old-empty'),file('src/replaced'),file('src/removed','c')]);
 const result=manifest([file('src/mode','a',4,true),dir('src/new-empty'),dir('src/replaced')]);
 const value=diff(base,result);assert.deepEqual(value.changes.map(c=>[c.kind,c.path]),[['modify','src/mode'],['add','src/new-empty'],['delete','src/old-empty'],['delete','src/removed'],['replace','src/replaced']]);
 assert.equal(value.changes[0].content_changed,false);assert.equal(value.changes[0].mode_changed,true);
});

test('only unique exact content matches establish rename and retain case-only and mode facts',()=>{
 const base=manifest([file('src/name','a'),file('src/Case','b')]),result=manifest([file('src/renamed','a',4,true),file('src/case','b')]);
 const value=diff(base,result);assert.deepEqual(value.changes.map(c=>[c.kind,c.from,c.path,c.mode_changed,c.case_only]),[['rename','src/Case','src/case',false,true],['rename','src/name','src/renamed',true,false]]);
 const ambiguous=diff(manifest([file('src/old')]),manifest([file('src/new-a'),file('src/new-b')]));
 assert.deepEqual(ambiguous.changes.map(c=>c.kind),['add','add','delete']);
});

test('scope changes and malformed manifests cannot become reviewed differences',()=>{
 const base=manifest([]);assert.throws(()=>diff(base,{...base,paths:['other']}),/workspace_/);
 for(const entry of [file('../outside'),file('src/A'),{...file('src/invalid'),bytes:-1},{path:'src/link',kind:'symlink',target:'outside'}]){
  const result=manifest([entry,...(entry.path==='src/A'?[file('src/a')]:[])]);assert.throws(()=>diff(base,result),/workspace_/);
 }
});

test('unchanged snapshots have no changes and input bytes are never mutated',()=>{
 const base=manifest([file('src/a')]),before=structuredClone(base),value=diff(base,base);assert.deepEqual(value.changes,[]);assert.deepEqual(base,before);
 assert.throws(()=>value.changes.push({kind:'delete',path:'src/a'}),TypeError);
});

test('large repeated-content groups retain every addition and deletion without invented renames',()=>{
 const base=manifest(Array.from({length:2500},(_,i)=>file('src/old-'+i))),result=manifest(Array.from({length:2500},(_,i)=>file('src/new-'+i)));
 const value=diff(base,result);assert.equal(value.changes.length,5000);assert.equal(value.changes.filter(c=>c.kind==='add').length,2500);assert.equal(value.changes.filter(c=>c.kind==='delete').length,2500);
});

test('a selected file never grants deletion or replacement of its unselected ancestor directory',()=>{
 const base={protocol:1,provider:'snapshot-copy',paths:['src/selected.txt'],entries:[dir('src'),file('src/selected.txt')]},result={...base,entries:[]};
 assert.deepEqual(diff(base,result).changes.map(c=>[c.kind,c.path]),[['delete','src/selected.txt']]);
 assert.throws(()=>diff(base,{...base,entries:[file('src')]}),/workspace_/);
 assert.deepEqual(diff(result,base).changes.map(c=>[c.kind,c.path]),[['add','src/selected.txt']]);
});

test('real isolated byte edits generate an exact frozen difference while original source stays unchanged',async t=>{
 const parent=resolve('.test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'workspace-diff-')),sourceRoot=join(root,'source'),storageRoot=join(root,'snapshots');
 t.after(()=>{const child=relative(parent,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 mkdirSync(join(sourceRoot,'src/empty'),{recursive:true});mkdirSync(storageRoot);const binary=Buffer.alloc(2*1024*1024+3,85);
 writeFileSync(join(sourceRoot,'src/old.bin'),binary);writeFileSync(join(sourceRoot,'src/content.txt'),'original fixture content');
 const provider=new SnapshotCopyWorkspaceProvider(),guard=()=>{},signal=new AbortController().signal;
 const snapshot=await provider.create({sourceRoot,storageRoot,paths:['src'],guard,signal});
 renameSync(join(snapshot.isolated_root,'src/old.bin'),join(snapshot.isolated_root,'src/new.bin'));rmdirSync(join(snapshot.isolated_root,'src/empty'));
 mkdirSync(join(snapshot.isolated_root,'src/new-empty'));writeFileSync(join(snapshot.isolated_root,'src/content.txt'),'new isolated content');writeFileSync(join(snapshot.isolated_root,'src/added.bin'),Buffer.from([0,1,2]));
 const observed=await provider.inspect({snapshot,guard,signal}),value=module.createWorkspaceDiff({base:snapshot.manifest,result:observed.manifest,base_sha256:snapshot.receipt.manifest_sha256,result_sha256:observed.manifest_sha256});
 assert.deepEqual(value.changes.map(c=>[c.kind,c.path]),[['add','src/added.bin'],['modify','src/content.txt'],['delete','src/empty'],['rename','src/new.bin'],['add','src/new-empty']].sort((a,b)=>a[1]<b[1]?-1:1));
 assert.equal(value.changes.find(c=>c.kind==='rename').from,'src/old.bin');assert.deepEqual(readFileSync(join(sourceRoot,'src/old.bin')),binary);
 assert.equal(readFileSync(join(sourceRoot,'src/content.txt'),'utf8'),'original fixture content');assert.equal(existsSync(join(sourceRoot,'src/empty')),true);assert.equal(existsSync(join(sourceRoot,'src/new.bin')),false);
 assert.equal(JSON.stringify(value).includes(root),false);assert.equal(JSON.stringify(value).includes('isolated content'),false);assert.equal(value.execution_authorized,false);
});
