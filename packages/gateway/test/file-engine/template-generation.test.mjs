import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

test('neutral template generation preserves exact artifact and catalog bytes across build times',async t=>{
 const base=resolve('.test-tmp');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'reproducible-templates-'));
 t.after(()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 mkdirSync(join(root,'scripts'));copyFileSync(new URL('../../scripts/create-template.py',import.meta.url),join(root,'scripts/create-template.py'));
 const generate=()=>{
  const run=spawnSync(process.env.PYTHON??'python',[join(root,'scripts/create-template.py')],
   {encoding:'utf8',windowsHide:true,env:{...process.env,TEMP:root,TMP:root,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(run.status,0,run.error?.message??run.stderr);
  const directory=join(root,'file-engine/templates');
  return Object.fromEntries(readdirSync(directory).sort().map(name=>[name,createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')]));
 };
 const first=generate();assert.equal(Object.keys(first).length,5);
 // ZIP timestamps have two-second resolution. Cross it before rebuilding.
 await delay(2200);
 assert.deepEqual(generate(),first,'clock changes must not alter published templates or catalog hashes');
});
