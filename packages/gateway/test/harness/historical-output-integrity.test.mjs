import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs,{mkdtempSync,mkdirSync,writeFileSync,rmSync,statSync,utimesSync,renameSync,symlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureHistoricalOutputBytes,verifyHistoricalOutputBytes} from '../../src/harness/historical-output-integrity.ts';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-output-witness-')),path=join(root,'output.txt'),bytes=Buffer.from('original verified bytes');
 writeFileSync(path,bytes);t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 return{root,path,bytes,item:{artifactId:'artifact-fixture',displayName:'output.txt',mediaType:'text/plain',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),localPath:path,kind:'text',version:1}};
}
test('a process-local witness verifies actual bytes and cannot be used after closing',t=>{
 const f=fixture(t),w=captureHistoricalOutputBytes(f.root,[f.item]);
 assert.equal(Object.isFrozen(w),true);w.assertUnchanged();w.assertUnchanged();w.close();w.close();
 assert.throws(()=>w.assertUnchanged(),/historical_output_integrity_unconfirmed/);
 verifyHistoricalOutputBytes(f.root,[f.item]);
});
for(const change of ['same-size','restored-mtime','replacement','deleted','path-alias'])test('prepared byte witness refuses '+change,t=>{
 const f=fixture(t);if(change==='path-alias'){mkdirSync(join(f.root,'files'));const path=join(f.root,'files','output.txt');renameSync(f.path,path);f.path=path;f.item.localPath=path;}
 const before=statSync(f.path),w=captureHistoricalOutputBytes(f.root,[f.item]);
 try{
  if(change==='same-size'||change==='restored-mtime'){writeFileSync(f.path,Buffer.alloc(f.bytes.length,120));if(change==='restored-mtime')utimesSync(f.path,before.atime,before.mtime);}
  if(change==='replacement'){renameSync(f.path,join(f.root,'old.txt'));writeFileSync(f.path,f.bytes);}
  if(change==='deleted')rmSync(f.path);
  if(change==='path-alias'){
   try{renameSync(join(f.root,'files'),join(f.root,'saved'));}
   catch(error){if(process.platform!=='win32'||error.code!=='EPERM')throw error;w.assertUnchanged();t.diagnostic('Windows refused directory replacement while its verified file descriptor remained open; this is an OS refusal, not witness rejection.');return;}
   symlinkSync(join(f.root,'saved'),join(f.root,'files'),process.platform==='win32'?'junction':'dir');
  }
  assert.throws(()=>w.assertUnchanged());
 }finally{w.close();}
});
test('pre-existing junction or directory symlink is refused before byte preparation',t=>{
 const f=fixture(t),alias=join(f.root,'alias');symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>captureHistoricalOutputBytes(f.root,[{...f.item,localPath:join(alias,'output.txt')}]),/historical_output_integrity_unconfirmed/);
});
test('catalog hash and serialized witness-looking fields never bypass real byte verification',t=>{
 const f=fixture(t);writeFileSync(f.path,Buffer.alloc(f.bytes.length,120));
 assert.throws(()=>captureHistoricalOutputBytes(f.root,[{...f.item,verified:true,fd:0,stat:{size:f.bytes.length}}]),/historical_output_integrity_unconfirmed/);
});
test('all owned descriptors close when a later output fails preparation',t=>{
 const f=fixture(t),open=fs.openSync,close=fs.closeSync,owned=new Set();let opened=0;
 fs.openSync=(...args)=>{const fd=open(...args);owned.add(fd);opened++;return fd;};
 fs.closeSync=fd=>{const result=close(fd);owned.delete(fd);return result;};syncBuiltinESMExports();
 try{assert.throws(()=>captureHistoricalOutputBytes(f.root,[f.item,{...f.item,localPath:join(f.root,'missing.txt')}]));assert.equal(opened,1);assert.equal(owned.size,0);}
 finally{fs.openSync=open;fs.closeSync=close;syncBuiltinESMExports();}
 const w=captureHistoricalOutputBytes(f.root,[f.item]);w.assertUnchanged();w.close();
});
test('cancellation prevents preparation or invalidates an existing witness without creating authority',t=>{
 const f=fixture(t),abort=new AbortController();abort.abort();assert.throws(()=>captureHistoricalOutputBytes(f.root,[f.item],abort.signal));
 const next=new AbortController(),w=captureHistoricalOutputBytes(f.root,[f.item],next.signal);try{next.abort();assert.throws(()=>w.assertUnchanged());}finally{w.close();}
});
