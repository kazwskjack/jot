// Characterize the deployed rc2 AgentLoop's official inbox and pre-step path.
// The SDK, projections, lifecycle, and Goal driver are real; only the model
// provider is a local scripted LlmAdapter, so this probe makes no network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeHandoffInboxGate } from '../native-handoff-inbox.js';

const runtime = process.env.JOT_DSH_RUNTIME_MODULES;
const coreNames = [
  'dsh-session',
  'dsh-session-projection',
  'dsh-session-persistence-jsonl',
  'dsh-session-query',
  'dsh-agent',
  'dsh-llm',
  'dsh-tools',
  'dsh-system-prompt',
  'dsh-agent-loop',
];
const names = ['cordis', ...coreNames];
const goalNames = ['dsh-goal', 'dsh-goal-round-driver'];

function protectLead(h){
 const binding=Object.freeze({runId:'original-root',sessionRef:h.agent.id});
 const gate=createNativeHandoffInboxGate({ctx:h.ctx,bridge:{bindingFor:agent=>agent===h.agent?binding:undefined},registry:h.ctx.agents,persistence:h.ctx.sessionPersistence});
 return {gate,scope:{parent:h.agent,parentBinding:binding,childRunId:'original-child-run',childSessionRef:'original-child',roleRef:'reviewer',activeRevision:2},receipt:{revision:3,phase:'returned',controller:'lead-role',route:['lead-role','reviewer','lead-role']}};
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function within(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function messageText(message) {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function createHarness(t, { withGoal = false } = {}) {
  assert.ok(runtime, 'JOT_DSH_RUNTIME_MODULES must point at the deployed rc2 package directory');
  const moduleNames = withGoal ? [...names, ...goalNames] : names;
  const modules = {};
  for (const name of moduleNames) {
    const manifest = JSON.parse(readFileSync(join(runtime, name, 'package.json'), 'utf8'));
    if (name !== 'cordis') assert.equal(manifest.version, '0.2.1-rc.2', `${name} runtime version`);
    modules[name] = await import(pathToFileURL(join(runtime, name, 'lib/index.js')).href);
  }

  const tempBase = resolve('.test-tmp/native-prestep-inbox-runtime');
  mkdirSync(tempBase, { recursive: true });
  const root = mkdtempSync(join(tempBase, 'case-'));
  let ctx;
  let handle;
  const releases = new Set();
  t.after(async () => {
    for (const release of releases) release();
    if (handle) await handle.dispose();
    if (ctx) await ctx.fiber.dispose();
    const child = relative(tempBase, root);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'temporary runtime data stays under E:/.test-tmp');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  ctx = new modules.cordis.Context();
  for (const name of moduleNames.filter((candidate) => candidate !== 'cordis')) {
    await ctx.plugin(modules[name].default ?? modules[name], name === 'dsh-session-persistence-jsonl'
      ? { root: join(root, 'sessions'), compression: 'none' }
      : {});
  }

  const modelInputs = [];
  class ScriptedAdapter extends modules['dsh-llm'].LlmAdapter {
    async *stream(options) {
      modelInputs.push(options.messages);
      yield { type: 'text-delta', index: 0, text: 'Local characterization response.' };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['local-characterization'], new ScriptedAdapter());
  handle = await ctx.agents.create({
    sessionId: withGoal ? 'prestep-goal-driver' : 'prestep-inbox',
    agentOptions: { provider: 'local-characterization', model: 'scripted' },
  });

  const agent = handle.agent;
  const events = [];
  const claimed = [];
  ctx.on('session/event', (session, event) => {
    if (session === agent.session) events.push(event);
  });
  ctx.on('agent/inbox/claimed', ({ agent: subject, message }) => {
    if (subject === agent) claimed.push(message);
  });

  return {
    modules,
    ctx,
    agent,
    events,
    claimed,
    modelInputs,
    releases,
    inbox() { return ctx.sessionProjections.stateOf(agent.session, 'inbox'); },
  };
}

test('a paused real Goal stays paused until explicit resume and original-scope control reconciliation', {timeout:20000,skip:!runtime}, async t=>{
 const h=await createHarness(t,{withGoal:true}),p=protectLead(h),message=h.modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Preserve my exact message through explicit resume.'}]}),first=deferred(),second=deferred();let claims=0;
 h.ctx.on('agent/inbox/claimed',({agent,message:claimed})=>{if(agent===h.agent&&claimed.id===message.id)(++claims===1?first:second).resolve();});
 h.agent.inject(message);h.ctx.goals.create(h.agent,{objective:'Exercise explicit user resume, never automatic wake.',maxGoalRounds:3});p.gate.arm(p.scope);
 await within(first.promise,'first Goal claim');await within(p.gate.transition(p.scope,async()=>true),'first held boundary');
 h.agent.cancel({kind:'user'},{keepInbox:true});await within(h.agent.whenIdle(),'cancelled Goal');assert.equal(h.ctx.goals.get(h.agent).phase,'paused');
 assert.throws(()=>p.gate.complete({...p.scope,receipt:p.receipt}),/goal_inactive/);assert.equal(h.modelInputs.length,0);assert.equal(p.gate.statusFor(h.agent,p.scope.parentBinding).state,'blocked');
 const paused=h.ctx.goals.get(h.agent);h.ctx.goals.resume(h.agent,{id:paused.id,revision:paused.revision});
 await within(second.promise,'explicit resumed Goal claim');await new Promise(resolve=>setImmediate(resolve));assert.equal(h.modelInputs.length,0);
 p.gate.arm(p.scope);await within(p.gate.transition(p.scope,async()=>true),'reauthorized original scope');
 // The fixture's receipt represents a trusted backend reconciliation; the
 // driver resumes only here, never from the resume/arm calls alone.
 p.gate.complete({...p.scope,receipt:p.receipt});await within(h.agent.whenIdle(),'resumed Goal settlement');
 assert.equal(userMessages(h.events).filter(item=>item.id===message.id).length,1);assert.ok(h.modelInputs.length>0);await p.gate.dispose();
});

test('a failed control return ends the real held driver without a model call or lost input', {timeout:20000,skip:!runtime}, async t=>{
 const h=await createHarness(t),p=protectLead(h),message=h.modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Retain this message when reconciliation fails.'}]}),claimed=deferred();
 h.ctx.on('agent/inbox/claimed',({agent,message:item})=>{if(agent===h.agent&&item.id===message.id)claimed.resolve();});p.gate.arm(p.scope);h.agent.followup(message);await within(claimed.promise,'failure input claim');await within(p.gate.transition(p.scope,async()=>true),'failure hold boundary');p.gate.fail(p.scope);
 await within(h.agent.whenIdle(),'failed held driver to stop');assert.equal(p.gate.statusFor(h.agent,p.scope.parentBinding).state,'blocked');assert.equal(h.modelInputs.length,0);assert.deepEqual(h.inbox()['next-step'].map(item=>item.id),[message.id]);
 p.gate.complete({...p.scope,receipt:p.receipt});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.agent.status,'idle');assert.equal(h.modelInputs.length,0);assert.deepEqual(h.inbox()['next-step'].map(item=>item.id),[message.id]);await p.gate.dispose();
});

function installPreStepGate(ctx, agent, predicate, { untilAbort = false } = {}) {
  const entered = deferred();
  const gate = deferred();
  let observedSignal;
  const release = () => gate.resolve();
  ctx.on('agent/pre-step', async ({ agent: subject, messages, signal }, next) => {
    if (subject !== agent || !predicate(messages)) return next();
    observedSignal = signal;
    entered.resolve(messages);
    if (untilAbort) {
      await new Promise((resolvePromise) => {
        if (signal.aborted) return resolvePromise();
        signal.addEventListener('abort', resolvePromise, { once: true });
      });
    } else {
      await gate.promise;
    }
    return next();
  });
  return { entered: entered.promise, release, get signal() { return observedSignal; } };
}

function userMessages(events) {
  return events.filter((event) => event.type === 'user/message').map((event) => event.data);
}

for(const withGoal of [false,true])test(withGoal?'handoff cancellation preserves claimed human input while the official Goal stays paused':'handoff cancellation restores claimed native input without another wake',{timeout:20000,skip:!runtime},async t=>{
 const h=await createHarness(t,{withGoal}),protectedLead=protectLead(h),original=h.modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Keep this exact original input.'}]}),pending=h.modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Later pending input.'}]}),claimed=deferred();
 h.ctx.on('agent/inbox/claimed',({agent,message})=>{if(agent===h.agent&&message.id===original.id)claimed.resolve();});
 if(withGoal){h.agent.inject(original);h.ctx.goals.create(h.agent,{objective:'Protect original user input through a handoff pause.',maxGoalRounds:2});protectedLead.gate.arm(protectedLead.scope);}else{protectedLead.gate.arm(protectedLead.scope);h.agent.followup(original);}
 await within(claimed.promise,'original input claim');
 await within(protectedLead.gate.transition(protectedLead.scope,async()=> 'held without a transfer'),'owned held boundary');
 h.agent.steer(pending);assert.equal(h.modelInputs.length,0);h.agent.cancel({kind:'user'},{keepInbox:true});await within(h.agent.whenIdle(),'cancelled held step');
 const queued=[...h.inbox()['next-step'],...h.inbox()['next-turn']];assert.equal(queued.filter(message=>message.id===original.id).length,1);assert.equal(queued.filter(message=>message.id===pending.id).length,1);assert.equal(userMessages(h.events).some(message=>message.id===original.id),false);assert.equal(h.modelInputs.length,0);
 if(withGoal)assert.equal(h.ctx.goals.get(h.agent).phase,'paused');
 await assert.rejects(protectedLead.gate.transition(protectedLead.scope,async()=>{}));await protectedLead.gate.dispose();
});

test('handoff release continues the same claimed input and later Inbox input without a synthetic wake',{timeout:20000,skip:!runtime},async t=>{
 const h=await createHarness(t),protectedLead=protectLead(h),original=h.modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Original claimed input.'}]}),pending=h.modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Input received during the hold.'}]}),claimed=deferred();
 h.ctx.on('agent/inbox/claimed',({agent,message})=>{if(agent===h.agent&&message.id===original.id)claimed.resolve();});protectedLead.gate.arm(protectedLead.scope);h.agent.followup(original);await within(claimed.promise,'original claim');
 await within(protectedLead.gate.transition(protectedLead.scope,async()=> 'still held'),'original held boundary');h.agent.steer(pending);assert.equal(h.modelInputs.length,0);
 protectedLead.gate.complete({...protectedLead.scope,receipt:protectedLead.receipt});await within(h.agent.whenIdle(),'same driver continuation');
 assert.equal(h.modelInputs.length,2);assert.deepEqual(userMessages(h.events).map(message=>message.id),[original.id,pending.id]);assert.equal(h.inbox()['next-step'].length,0);await protectedLead.gate.dispose();
});

test('rc2 claims the original input before pre-step, then consumes original and steered supplement exactly once', {
  timeout: 20000,
  skip: !runtime,
}, async (t) => {
  const h = await createHarness(t);
  const original = h.modules['dsh-llm'].createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Original native request.' }],
  });
  const supplement = h.modules['dsh-llm'].createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Supplement while original is waiting.' }],
  });
  const gate = installPreStepGate(h.ctx, h.agent, (messages) => messages.some((message) => message.id === original.id));
  h.releases.add(gate.release);

  h.agent.followup(original);
  const claimedAtPreStep = await within(gate.entered, 'original pre-step');
  assert.deepEqual(claimedAtPreStep.map((message) => message.id), [original.id]);
  assert.equal(h.ctx.sessionProjections.stateOf(h.agent.session, 'inbox')['next-turn'].length, 0,
    'claim happens before callback: original is not left in the Inbox projection');
  assert.equal(h.claimed.filter((message) => message.id === original.id).length, 1);

  h.agent.steer(supplement);
  assert.deepEqual(h.inbox()['next-step'].map((message) => message.id), [supplement.id]);
  assert.equal(h.modelInputs.length, 0, 'pre-step wait must happen before any model request');

  gate.release();
  await within(h.agent.whenIdle(), 'original and supplement to reach idle');
  assert.equal(h.modelInputs.length, 2, 'one model request per admitted native user message');

  const admitted = userMessages(h.events);
  assert.deepEqual(admitted.map((message) => message.id), [original.id, supplement.id]);
  assert.equal(admitted.filter((message) => message.id === original.id).length, 1);
  assert.equal(admitted.filter((message) => message.id === supplement.id).length, 1);
  assert.ok(admitted.every((message) => message.source.kind === 'user'));
  const latestUserText = h.modelInputs.map((messages) => {
    const latest = messages.filter((message) => message.role === 'user').at(-1);
    return latest && messageText(latest);
  });
  assert.match(latestUserText[0], /Original native request\./);
  assert.match(latestUserText[1], /Supplement while original is waiting\./);
  assert.equal(h.events.filter((event) => event.type === 'assistant/message').length, 2,
    'each admitted input settles once; no extra assistant settlement is synthesized');
  assert.deepEqual(h.inbox()['next-step'], []);
  assert.deepEqual(h.inbox()['next-turn'], []);

  t.diagnostic(JSON.stringify({
    runtime: '0.2.1-rc.2', officialInboxProjection: true, originalClaimedBeforePreStep: true,
    originalAndSupplementCommittedOnce: true, modelCalls: h.modelInputs.length,
    assistantSettlements: h.events.filter((event) => event.type === 'assistant/message').length,
    provider: 'local scripted; no network', production: false,
  }));
});

test('native keepInbox cancellation aborts the wait without waking or consuming unclaimed work', {
  timeout: 20000,
  skip: !runtime,
}, async (t) => {
  const h = await createHarness(t);
  const original = h.modules['dsh-llm'].createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Original request cancelled in pre-step.' }],
  });
  const pending = h.modules['dsh-llm'].createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Unclaimed follow-up to preserve.' }],
  });
  const gate = installPreStepGate(h.ctx, h.agent, (messages) => messages.some((message) => message.id === original.id), { untilAbort: true });

  h.agent.followup(original);
  const claimedAtPreStep = await within(gate.entered, 'cancellable original pre-step');
  assert.deepEqual(claimedAtPreStep.map((message) => message.id), [original.id]);
  h.agent.steer(pending);
  assert.deepEqual(h.inbox()['next-step'].map((message) => message.id), [pending.id]);
  assert.equal(h.modelInputs.length, 0);

  h.agent.cancel({ kind: 'user' }, { keepInbox: true });
  await within(h.agent.whenIdle(), 'cancelled agent to become idle');
  assert.equal(gate.signal.aborted, true, 'pre-step receives the official activity AbortSignal');
  assert.deepEqual(h.inbox()['next-step'].map((message) => message.id), [pending.id],
    'keepInbox retains unclaimed messages, not the message already claimed for pre-step');
  assert.equal(h.claimed.filter((message) => message.id === original.id).length, 1);
  assert.equal(userMessages(h.events).some((message) => message.id === original.id), false,
    'the claimed original never reaches user/message because cancellation precedes step entry');
  assert.equal(h.modelInputs.length, 0);

  const seqAtIdle = h.agent.session.seq;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(h.agent.status, 'idle');
  assert.equal(h.agent.session.seq, seqAtIdle, 'cancellation does not self-wake or create another turn');
  assert.deepEqual(h.inbox()['next-step'].map((message) => message.id), [pending.id]);

  t.diagnostic(JSON.stringify({
    runtime: '0.2.1-rc.2', officialCancelSignal: true, keepInboxRetainedUnclaimedMessage: true,
    claimedOriginalCommitted: false, selfWakeAfterCancel: false, modelCalls: h.modelInputs.length,
    provider: 'local scripted; no network', production: false,
  }));
});

test('Goal round cancellation restores other claimed native input through its official Inbox', {
  timeout: 20000,
  skip: !runtime,
}, async (t) => {
  const h = await createHarness(t, { withGoal: true });
  const supplement = h.modules['dsh-llm'].createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Human supplement alongside an automatic Goal round.' }],
  });
  const gate = installPreStepGate(h.ctx, h.agent, (messages) => messages.some((message) => message.source.kind === 'goal' && message.source.round > 0), { untilAbort: true });

  h.agent.inject(supplement);
  h.ctx.goals.create(h.agent, { objective: 'Characterize cancellation while a Goal round is claimed.', maxGoalRounds: 2 });
  const claimedAtPreStep = await within(gate.entered, 'Goal round pre-step');
  const goalMessage = claimedAtPreStep.find((message) => message.source.kind === 'goal' && message.source.round > 0);
  assert.ok(goalMessage, 'the installed Goal driver submits a real goal-sourced user message');
  assert.ok(claimedAtPreStep.some((message) => message.id === supplement.id), 'both inputs are claimed in the same step');
  assert.deepEqual(h.inbox()['next-step'], [], 'the supplement is already claimed while pre-step is waiting');

  h.agent.cancel({ kind: 'user' }, { keepInbox: true });
  await within(h.agent.whenIdle(), 'cancelled Goal round to become idle');
  assert.equal(gate.signal.aborted, true);
  assert.deepEqual(h.inbox()['next-step'].map((message) => message.id), [supplement.id],
    'Goal driver restores the non-Goal claimed input into the official Inbox');
  assert.equal(h.inbox()['next-turn'].some((message) => message.id === goalMessage.id), false,
    'the claimed Goal round itself is not restored');
  assert.equal(userMessages(h.events).some((message) => message.id === goalMessage.id), false);
  assert.equal(userMessages(h.events).some((message) => message.id === supplement.id), false);
  assert.equal(h.modelInputs.length, 0);
  const goal = h.ctx.goals.get(h.agent);
  assert.equal(goal.phase, 'paused', 'the driver pauses the cancelled active Goal rather than auto-restarting it');

  t.diagnostic(JSON.stringify({
    runtime: '0.2.1-rc.2', actualGoalAndRoundDriver: true, goalRoundClaimedThenNotCommitted: true,
    otherClaimedInputRestoredToOfficialInbox: true, goalPhase: goal.phase,
    selfWakeAfterCancel: false, modelCalls: h.modelInputs.length,
    provider: 'local scripted; no network', production: false,
  }));
});
