import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('packed adapter loads independently with every runtime module included',async t=>{
 const cwd=fileURLToPath(new URL('..',import.meta.url)),base=resolve(cwd,'../../.test-tmp/adapter-package');
 mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 t.after(()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 // Invoke npm through Node, avoiding Windows cmd string interpolation.
 const npm=join(resolve(process.execPath,'..'),'node_modules/npm/bin/npm-cli.js');
 const output=execFileSync(process.execPath,[npm,'pack','--json','--ignore-scripts','--pack-destination',root,'--cache',join(base,'npm-cache')],{cwd,encoding:'utf8'});
 const [pack]=JSON.parse(output),files=pack.files.map(file=>file.path);
 assert.equal(typeof pack.filename,'string');assert.match(pack.filename,/^[A-Za-z0-9._-]+\.tgz$/);
 execFileSync('tar',['-xzf',join(root,pack.filename),'-C',root]);
 const entry=await import(pathToFileURL(join(root,'package/index.js')).href);
 const native=await import(pathToFileURL(join(root,'package/native-role-host.js')).href);
 assert.equal(typeof native.createNativeRoleHost,'function');
 assert.equal(typeof entry.createAdapterHandler,'function');assert.equal(typeof entry.apply,'function');
 for(const name of ['workbench-goal.js','model-budget-stream.js','checkpoint.js','native-child-admission.js','native-role-provider.js','native-role-host.js','native-handoff-barrier.js','native-child-closure.js','native-operation-observer.js'])assert.ok(files.includes(name),name);
 assert.equal(readFileSync(join(root,'package/package.json'),'utf8').includes('"private": true'),true);
});
