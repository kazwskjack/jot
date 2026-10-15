// Hard-kill only the exact Node workers spawned by this test, after IPC confirms
// their original Session log was flushed from inside the actual pre-step hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = process.env.JOT_DSH_RUNTIME_MODULES;

test('pre-publication setup restores exact original human input after hard kill without waking the Goal', {timeout:90000,skip:!runtime}, async t=>{
 const base=resolve('.test-tmp/native-claimed-crash');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'recovery-')),children=new Set();
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await Promise.allSettled([...children].map(child=>waitForExit(child)));const subpath=relative(base,root);assert.ok(subpath&&!subpath.startsWith('..')&&!isAbsolute(subpath));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const worker=fileURLToPath(new URL('./native-claimed-crash-worker.mjs',import.meta.url));
 for(const scenario of ['ordinary','goal-human']){
  const dataRoot=join(root,scenario);mkdirSync(dataRoot,{recursive:true});const prepared=spawnWorker(worker,dataRoot,'prepare',scenario,undefined,children),ready=await waitForMessage(prepared.child,'ready',prepared.output);
  assert.equal(ready.pid,prepared.child.pid);assert.equal(ready.durablePrefixMatches,true);assert.equal(ready.persistenceFlushCompleted,true);assert.equal(ready.modelCalls,0);assert.equal(prepared.child.kill('SIGKILL'),true);await waitForExit(prepared.child);
  const originals=ready.claimedMessages.filter(message=>message.source.kind!=='goal');assert.ok(originals.length>0);
  const repaired=spawnWorker(worker,dataRoot,'recover-hold',scenario,ready,children),saved=await waitForMessage(repaired.child,'restored-ready',repaired.output);
  assert.equal(saved.pid,repaired.child.pid);assert.equal(saved.recovery.state,'restored');assert.equal(saved.recovery.restored,originals.length);assert.equal(saved.publishedDurable,true);assert.equal(saved.modelCallsAfterResume,0);
  assert.equal(repaired.child.kill('SIGKILL'),true);await waitForExit(repaired.child);
  const resumed=spawnWorker(worker,dataRoot,'recover',scenario,ready,children),result=await waitForMessage(resumed.child,'result',resumed.output);assert.equal((await waitForExit(resumed.child)).code,0,resumed.output.stderr);
  assert.equal(result.recovery.state,'none');assert.equal(result.recovery.restored,0);assert.equal(result.recovery.already_pending,originals.length);assert.equal(result.recovery.execution_authorized,false);assert.equal(result.publishedDurable,true);
  assert.deepEqual(result.claimedPendingIds.sort(),originals.map(message=>message.id).sort());assert.equal(result.modelCallsAfterResume,0);assert.equal(result.resumeTurnStarts,0);
  assert.ok(Object.values(result.originalHumanCommits).every(count=>count===1));assert.equal(result.continuationCommits,1);assert.equal(result.goalMessageCommits,0);
  if(scenario==='goal-human'){assert.equal(result.goal.activation,'disarmed');assert.equal(result.goal.phase,'active');assert.equal(result.recovery.goal_owned,1);}
  t.diagnostic(JSON.stringify({scenario,actualHardKill:true,secondKillAfterRestoration:true,noDuplicateAfterSecondResume:true,originalIdsRetained:true,setupBeforePublish:true,durableBeforePublish:true,noAutomaticWake:true,originalHumanCommits:result.originalHumanCommits,modelCallsAfterExplicitContinuation:result.modelCallsAfterExplicitContinuation,authority:'fixture only',production:false}));
 }
});

function waitForMessage(child, kind, output, timeoutMs = 30000) {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (message) => {
      if (message?.kind === 'error') {
        cleanup();
        reject(new Error(`${message.error}\n${output.stderr}`));
      } else if (message?.kind === kind) {
        cleanup();
        resolvePromise(message);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`worker exited before ${kind}: code=${code}, signal=${signal}\n${output.stderr}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for worker ${kind}\n${output.stderr}`));
    }, timeoutMs);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`timed out waiting for exact worker pid ${child.pid} to exit`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    };
    child.once('exit', onExit);
  });
}

function spawnWorker(workerPath, dataRoot, stage, scenario, prior, children) {
  const args = ['--experimental-strip-types', workerPath, dataRoot, stage, scenario];
  if (prior !== undefined) args.push(JSON.stringify(prior));
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout = (output.stdout + chunk).slice(-20000); });
  child.stderr.on('data', (chunk) => { output.stderr = (output.stderr + chunk).slice(-20000); });
  children.add(child);
  return { child, output };
}

test('hard process exit after native Inbox claim characterizes ordinary and Goal resume behavior', {
  timeout: 120000,
  skip: !runtime,
}, async (t) => {
  const base = resolve('.test-tmp/native-claimed-crash');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled([...children].map((child) => waitForExit(child)));
    const childPath = relative(base, root);
    assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), 'temporary files stay under E:/.test-tmp');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const workerPath = fileURLToPath(new URL('./native-claimed-crash-worker.mjs', import.meta.url));
  const observations = [];
  for (const scenario of ['ordinary', 'goal']) {
    const dataRoot = join(root, scenario);
    mkdirSync(dataRoot, { recursive: true });

    const prepared = spawnWorker(workerPath, dataRoot, 'prepare', scenario, undefined, children);
    const ready = await waitForMessage(prepared.child, 'ready', prepared.output);
    assert.equal(ready.pid, prepared.child.pid, 'kill target is the exact worker that reported readiness');
    assert.equal(ready.durabilityFlushCompleted, true);
    assert.equal(ready.persistenceFlushCompleted, true);
    assert.equal(ready.durableEventCount, ready.preCrashSeq);
    assert.equal(ready.durableSuffixCount, 0, 'no persisted log suffix exists beyond the reported pre-crash boundary');
    assert.equal(ready.durablePrefixMatches, true, 'durable events exactly match the live Session prefix');
    assert.equal(ready.sessionId, scenario === 'ordinary' ? 'claimed-crash-ordinary' : 'claimed-crash-goal');
    assert.equal(ready.modelCalls, 0, 'the worker is waiting before model entry');
    assert.deepEqual(ready.inbox, { nextTurn: [], nextStep: [] }, 'claim has already removed the message from official Inbox projection');
    assert.equal(ready.userMessageIds.includes(ready.message.id), false, 'pre-step input is not yet a committed user/message');
    assert.ok(ready.inboxSplices.some((splice) => splice.removedCount > 0), 'claim is represented by a durable Inbox splice');
    if (scenario === 'ordinary') {
      assert.equal(ready.message.source.kind, 'user');
    } else {
      assert.equal(ready.message.source.kind, 'goal');
      assert.equal(ready.message.source.round, 1);
      assert.equal(ready.goal.phase, 'active');
    }

    // This is deliberately a hard stop of only the ChildProcess handle returned
    // by spawnWorker. No PID lookup, shell, taskkill, service, or unrelated process.
    const killedExactWorker = prepared.child.kill('SIGKILL');
    assert.equal(killedExactWorker, true);
    const killedExit = await waitForExit(prepared.child);
    assert.ok(killedExit.signal === 'SIGKILL' || killedExit.code !== 0,
      `worker must not exit normally after the parent hard-kill: ${JSON.stringify(killedExit)}`);

    const resumed = spawnWorker(workerPath, dataRoot, 'resume', scenario, ready, children);
    const result = await waitForMessage(resumed.child, 'result', resumed.output);
    const resumeExit = await waitForExit(resumed.child);
    assert.equal(resumeExit.code, 0, `resume worker failed: ${resumed.output.stderr}`);
    assert.equal(result.sessionId, ready.sessionId, 'new host resumes the exact original Session');
    assert.equal(result.originalPending, false);
    assert.equal(result.originalUserMessageCommits, 0);
    assert.equal(result.modelCallsAfterResume, 0, 'resume does not auto-wake the claimed message');
    assert.equal(result.resumeTurnStarts, 0);
    assert.deepEqual(result.inbox, { nextTurn: [], nextStep: [] });
    const interrupted = result.postCrashEvents.filter((event) => event.type === 'turn/end' && event.reason?.kind === 'interrupted');
    assert.equal(interrupted.length, 1, 'official resume repairs the open turn with an interrupted closer');
    assert.deepEqual(result.postCrashEvents.map((event) => event.type), ['turn/end', 'session/end-seed']);
    assert.deepEqual(result.postCrashEvents[1].data, {}, 'restored Session marks the end of its seed');
    if (scenario === 'goal') {
      assert.equal(result.goal.phase, 'active');
      assert.equal(result.goal.activation, 'disarmed');
      assert.equal(result.goal.roundsStarted, 0);
    }

    observations.push({
      scenario,
      sessionId: ready.sessionId,
      originalMessageId: ready.message.id,
      preCrashInbox: ready.inbox,
      preCrashSpliceCount: ready.inboxSplices.length,
      preCrashModelCalls: ready.modelCalls,
      hardKilledPid: prepared.child.pid,
      hardKill: killedExit,
      resumedInbox: result.inbox,
      originalPending: result.originalPending,
      originalUserMessageCommits: result.originalUserMessageCommits,
      modelCallsAfterResume: result.modelCallsAfterResume,
      officialPostCrashEvents: result.postCrashEvents,
      goal: result.goal,
    });
  }

  t.diagnostic(JSON.stringify({
    runtime: '0.2.0-rc.2', actualChildProcesses: true, killTarget: 'spawn-returned ChildProcess only',
    noExternalProvider: true, noNetwork: true, production: false, observations,
  }));
});
