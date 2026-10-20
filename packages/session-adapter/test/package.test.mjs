import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('packed adapter loads independently with every runtime module included',async t=>{
 const cwd=fileURLToPath(new URL('..',import.meta.url)),base=resolve(process.env.JOT_TEST_TMP??resolve(cwd,'../../.test-tmp'),'adapter-package');
 mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 t.after(()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 // Invoke npm through Node, avoiding Windows cmd string interpolation.
 const npm=join(resolve(process.execPath,'..'),'node_modules/npm/bin/npm-cli.js');
 const output=execFileSync(process.execPath,[npm,'pack','--json','--ignore-scripts','--pack-destination',root,'--cache',join(base,'npm-cache')],{cwd,encoding:'utf8'});
 const [pack]=JSON.parse(output),files=pack.files.map(file=>file.path);
 assert.equal(typeof pack.filename,'string');assert.match(pack.filename,/^[A-Za-z0-9._-]+\.tgz$/);
 execFileSync('tar',['-xzf',join(root,pack.filename),'-C',root]);
 const entry=await import(pathToFileURL(join(root,'package/index.js')).href);
 const observedGoal=await import(pathToFileURL(join(root,'package/conversation-goal-run-host.js')).href);
 assert.equal(typeof observedGoal.createConversationGoalRunHost,'function');assert.ok(files.includes('conversation-goal-run-host.js'));
 const native=await import(pathToFileURL(join(root,'package/native-role-host.js')).href);
 assert.equal(typeof native.createNativeRoleHost,'function');
 const handoff=await import(pathToFileURL(join(root,'package/native-handoff-admission.js')).href);assert.equal(typeof handoff.createNativeHandoffAdmission,'function');
 const handback=await import(pathToFileURL(join(root,'package/native-handoff-return.js')).href);assert.equal(typeof handback.createNativeHandoffReturn,'function');assert.equal(typeof handback.createNativeHandoffRecovery,'function');assert.ok(files.includes('native-handoff-return.js'));
 const closure=await import(pathToFileURL(join(root,'package/native-child-closure.js')).href);assert.equal(typeof closure.verifyOfflineNativeClosure,'function');
 const workspace=await import(pathToFileURL(join(root,'package/native-workspace-barrier.js')).href);assert.equal(typeof workspace.withNativeWorkspaceBarrier,'function');assert.ok(files.includes('native-workspace-barrier.js'));
 const factory=await import(pathToFileURL(join(root,'package/native-workspace-factory.js')).href);assert.equal(typeof factory.createNativeWorkspaceFactoryGate,'function');assert.ok(files.includes('native-workspace-factory.js'));
 const source=await import(pathToFileURL(join(root,'package/native-workspace-source.js')).href);assert.equal(typeof source.readNativeWorkspaceFamily,'function');assert.equal(typeof source.createNativeWorkspaceSourceHost,'function');assert.equal(entry.createNativeWorkspaceSourceHost,source.createNativeWorkspaceSourceHost);assert.ok(files.includes('native-workspace-source.js'));
 const replay=await import(pathToFileURL(join(root,'package/native-invariant-replay.js')).href);assert.equal(typeof replay.createNativeInvariantReplay,'function');
 const inbox=await import(pathToFileURL(join(root,'package/native-handoff-inbox.js')).href);assert.equal(typeof inbox.createNativeHandoffInboxGate,'function');
 const claimed=await import(pathToFileURL(join(root,'package/native-claimed-input.js')).href);assert.equal(typeof claimed.createNativeClaimedInputRecoverySetup,'function');assert.equal(entry.createNativeClaimedInputRecoverySetup,claimed.createNativeClaimedInputRecoverySetup);assert.ok(files.includes('native-claimed-input.js'));
 for(const [file,method] of [['ordinary-claimed-composer.js','createOrdinaryClaimedSessionComposer'],['native-claimed-composer.js','createNativeClaimedSessionComposer'],['native-replay-profile.js','createNativeReplayProfile'],['native-replay-provenance.js','createNativeReplayProvenance']]){const module=await import(pathToFileURL(join(root,'package',file)).href);assert.equal(typeof module[method],'function');assert.equal(entry[method],module[method]);}
 const prepared=await import(pathToFileURL(join(root,'package/scripts/prepare-dsh-pre-setup.mjs')).href);assert.equal(typeof prepared.prepareDshPreSetupRuntime,'function');assert.ok(files.includes('runtime-patches/DSH-MIT-LICENSE.txt'));assert.ok(files.includes('runtime-patches/dsh-agent-loop-rc2-sha256.json'));assert.ok(files.includes('dsh-pre-setup-patch.js'));
 const lifecycle=await import(pathToFileURL(join(root,'package/native-handoff-lifecycle.js')).href);assert.equal(typeof lifecycle.createNativeHandoffLifecycle,'function');assert.ok(files.includes('native-handoff-lifecycle.js'));
 const scheduler=await import(pathToFileURL(join(root,'package/native-task-scheduler.js')).href);assert.equal(typeof scheduler.createNativeTaskScheduler,'function');assert.ok(files.includes('native-task-scheduler.js'));
 assert.equal(typeof entry.createAdapterHandler,'function');assert.equal(typeof entry.apply,'function');assert.equal(typeof entry.createNativeHandoffLifecycle,'function');
 for(const name of ['workbench-goal.js','host-execution-lease.js','model-budget-stream.js','checkpoint.js','native-child-admission.js','native-role-provider.js','native-role-host.js','native-handoff-admission.js','native-handoff-barrier.js','native-child-closure.js','native-operation-observer.js'])assert.ok(files.includes(name),name);
 assert.equal(readFileSync(join(root,'package/package.json'),'utf8').includes('"private": true'),true);
});
