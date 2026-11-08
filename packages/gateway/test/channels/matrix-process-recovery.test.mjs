import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

test('Matrix durable admission survives actual process exit; reopened stage-only stays pending without mutation',t=>{
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'matrix-process-'));
 t.after(()=>{const rel=relative(parent,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const child=fileURLToPath(new URL('./fixtures/matrix-process-recovery-child.mjs',import.meta.url));
 const run=(mode,expected)=>{const result=spawnSync(process.execPath,[child,root,mode],{encoding:'utf8',timeout:30000});
  assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,expected,result.stdout+'\n'+result.stderr);
  const lines=result.stdout.trim().split('\n').filter(Boolean);assert.equal(lines.length,1,result.stdout);return JSON.parse(lines[0]);};
 const crashed=run('crash',77),recovered=run('recover',0),pending=run('pending',0);
 assert.equal(new Set([crashed.pid,recovered.pid,pending.pid]).size,3);
 assert.equal(crashed.checkpoint,'admission_committed_before_cursor');assert.equal(crashed.cursor,'cursor-bind');
 assert.deepEqual(recovered.original,crashed.original);assert.deepEqual(pending.original,crashed.original);
 assert.equal(recovered.cursor,'cursor-file');assert.equal(pending.cursor,'cursor-file');assert.deepEqual(pending.counts,[1,1,1]);
 assert.equal(typeof recovered.stage_key,'string');
 assert.ok(pending.stage_keys.includes(recovered.stage_key));
 t.diagnostic(JSON.stringify({crashed,recovered,pending}));
});
