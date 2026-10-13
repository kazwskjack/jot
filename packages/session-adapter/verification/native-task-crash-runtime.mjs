import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';import {resolve,join,relative,isAbsolute} from 'node:path';import {fileURLToPath} from 'node:url';
test('abrupt native member exit retains unknown costs under a replacement worker fence',{timeout:60000,skip:!process.env.JOT_DSH_RUNTIME_MODULES},t=>{
 const base=resolve('.test-tmp/native-task-crash');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 t.after(()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const worker=fileURLToPath(new URL('./native-task-crash-worker.mjs',import.meta.url));
 for(const stage of ['prepare','resume']){
  const result=spawnSync(process.execPath,['--experimental-strip-types',worker,root,stage],{cwd:process.cwd(),encoding:'utf8',timeout:25000,maxBuffer:512000,windowsHide:true});
  assert.equal(result.error,undefined,stage+': '+String(result.error));assert.equal(result.status,stage==='prepare'?77:0,stage+': '+result.stdout+'\n'+result.stderr);
 }
 const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert.notEqual(result.pid,result.previousPid);assert.equal(result.abruptProcessExit,true);assert.equal(result.unknownCalls,1);assert.equal(result.heldBudgetPreserved,true);assert.equal(result.sameFenceRejected,true);assert.equal(result.noNewDispatch,true);t.diagnostic(JSON.stringify(result));
});
