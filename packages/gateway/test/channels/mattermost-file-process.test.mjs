import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('file v2 reopens durable DB after observation/stage/admission and only looks up original request',t=>{
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const child=fileURLToPath(new URL('./fixtures/mattermost-file-process-child.mjs',import.meta.url));
 for(const mode of ['observed','staged','accepted']){const root=mkdtempSync(join(parent,'mattermost-file-process-'));t.after(()=>{const rel=relative(parent,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
  const run=(phase,status)=>{const result=spawnSync(process.execPath,[child,root,phase],{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,status,result.stdout+'\n'+result.stderr);return JSON.parse(result.stdout.trim());};
  const crashed=run(mode,mode==='observed'?78:mode==='staged'?79:80),reopened=run('recover-'+mode,0);assert.notEqual(crashed.pid,reopened.pid);assert.deepEqual(reopened.observations,crashed.observations);assert.deepEqual(reopened.events,crashed.events);assert.equal(reopened.runs,mode==='accepted'?1:0);t.diagnostic(JSON.stringify({mode,crashed,reopened}));
 }
});
