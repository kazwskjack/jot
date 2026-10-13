import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';import {resolve,join,relative,isAbsolute} from 'node:path';import {fileURLToPath} from 'node:url';
test('native task dispatch resumes after the original OS process exits, retaining Session and accounting',{timeout:60000,skip:!process.env.JOT_DSH_RUNTIME_MODULES},t=>{
 const base=resolve('.test-tmp/native-task-restart');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 t.after(()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const worker=fileURLToPath(new URL('./native-task-restart-worker.mjs',import.meta.url));
 for(const stage of ['prepare','resume']){
  const result=spawnSync(process.execPath,['--experimental-strip-types',worker,root,stage],{cwd:process.cwd(),encoding:'utf8',timeout:25000,maxBuffer:512000,windowsHide:true});
  assert.equal(result.error,undefined,stage+': '+String(result.error));assert.equal(result.status,0,stage+': '+result.stdout+'\n'+result.stderr);
 }
 const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert.notEqual(result.pid,result.previousPid);assert.equal(result.actualProcessRestart,true);assert.equal(result.closures,2);assert.deepEqual(result.calls,{lead:1,child:2});t.diagnostic(JSON.stringify(result));
});
