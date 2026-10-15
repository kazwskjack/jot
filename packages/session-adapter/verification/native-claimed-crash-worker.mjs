// Real DSH rc2 worker for a hard-crash-after-claim characterization.
// The LLM adapter is local and scripted; no provider or network is contacted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {createNativeClaimedInputRecoverySetup} from '../native-claimed-input.js';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';

const [dataRootArg, stage, scenario, priorJson] = process.argv.slice(2);
const dataRoot = resolve(dataRootArg ?? '');
const base = resolve('.test-tmp/native-claimed-crash');
const childPath = relative(base, dataRoot);
assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), 'worker data must stay under E:/.test-tmp');
assert.ok(['prepare', 'resume', 'recover', 'recover-hold'].includes(stage));
assert.ok(['ordinary', 'goal', 'goal-human'].includes(scenario));

const runtime = resolve(process.env.JOT_DSH_RUNTIME_MODULES ?? '');
assert.ok(runtime && runtime !== resolve('.'), 'JOT_DSH_RUNTIME_MODULES must name the deployed rc2 runtime');
const names = [
  'cordis', 'dsh-session', 'dsh-session-projection', 'dsh-session-persistence-jsonl',
  'dsh-session-query', 'dsh-agent', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt',
  'dsh-agent-loop', 'dsh-goal', 'dsh-goal-round-driver',
];
const modules = {};
for (const name of names) {
  const manifest = JSON.parse(readFileSync(join(runtime, name, 'package.json'), 'utf8'));
  if (name !== 'cordis') assert.equal(manifest.version, '0.2.0-rc.2', `${name} runtime version`);
  modules[name] = await import(pathToFileURL(join(runtime, name, 'lib/index.js')).href);
}

const sessionId = 'claimed-crash-'+scenario;
let ctx;
let handle;
let modelCalls = 0;
class ScriptedAdapter extends modules['dsh-llm'].LlmAdapter {
  async *stream() {
    modelCalls++;
    yield { type: 'text-delta', index: 0, text: 'Local crash characterization response.' };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function sendIpc(message) {
  if (typeof process.send !== 'function') throw new Error('native_claimed_crash_ipc_unavailable');
  await new Promise((resolvePromise, reject) => {
    process.send(message, (error) => error ? reject(error) : resolvePromise());
  });
}

function publicMessage(message) {
  return {
    id: message.id,
    role: message.role,
    source: message.source,
  };
}

async function sessionEvents(session) {
  return (await ctx.sessionQuery.readSession(session.id)).events;
}

ctx = new modules.cordis.Context();
for (const name of names.filter((candidate) => candidate !== 'cordis')) {
  await ctx.plugin(modules[name].default ?? modules[name], name === 'dsh-session-persistence-jsonl'
    ? { root: join(dataRoot, 'sessions'), compression: 'none' }
    : {});
}
ctx.llm.registerAdapter(['local-characterization'], new ScriptedAdapter());

if (stage === 'prepare') {
  handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'local-characterization', model: 'scripted' },
  });
  const agent = handle.agent;
  let expectedId;
  let gateReached;
  const gateReady = new Promise((resolvePromise) => { gateReached = resolvePromise; });
  ctx.on('agent/pre-step', async ({ agent: subject, messages, turn, step }, next) => {
    if (subject !== agent) return next();
    const claimed = scenario === 'ordinary'
      ? messages.find((message) => message.id === expectedId)
      : messages.find((message) => message.source.kind === 'goal' && message.source.round > 0);
    if (!claimed) return next();

    // This is the point after official claim and before step/model entry.
    const session = agent.session;
    const preCrashSeq = session.seq;
    const events = await sessionEvents(session);
    assert.equal(await ctx.sessions.flush(session), true, 'a Session durability listener must participate');
    await ctx.sessionPersistence.flush();
    const persisted = await ctx.sessionPersistence.open(sessionId, 'read');
    let durableEventCount;
    let durableSuffixCount;
    let durablePrefixMatches;
    try {
      assert.equal(persisted.id, sessionId);
      assert.equal(persisted.access, 'read');
      const prefix = await persisted.read(0, preCrashSeq);
      const suffix = await persisted.read(preCrashSeq, 1);
      durableEventCount = prefix.events.length;
      durableSuffixCount = suffix.events.length;
      assert.deepEqual(prefix.events, events, 'durable log must exactly match the live Session prefix');
      durablePrefixMatches = true;
      assert.equal(durableEventCount, preCrashSeq, 'durable log must include the exact pre-step boundary');
      assert.equal(durableSuffixCount, 0, 'durable log must have no suffix after the reported boundary');
      assert.equal(session.seq, preCrashSeq, 'live Session must not advance during the persistence readback');
    } finally {
      await persisted.close();
    }
    const inbox = ctx.sessionProjections.stateOf(agent.session, 'inbox');
    const ready = {
      kind: 'ready',
      stage,
      scenario,
      pid: process.pid,
      sessionId,
      message: publicMessage(claimed),
      claimedMessages: messages.map(publicMessage),
      turn,
      step,
      preCrashSeq,
      durabilityFlushCompleted: true,
      persistenceFlushCompleted: true,
      durableEventCount,
      durableSuffixCount,
      durablePrefixMatches,
      modelCalls,
      inbox: {
        nextTurn: inbox['next-turn'].map((message) => message.id),
        nextStep: inbox['next-step'].map((message) => message.id),
      },
      inboxSplices: events.filter((event) => event.type === 'agent/inbox/spliced').map((event) => ({
        seq: event.seq,
        target: event.data.target,
        removedCount: event.data.removedCount ?? 0,
        insertedIds: event.data.inserted.map((message) => message.id),
      })),
      userMessageIds: events.filter((event) => event.type === 'user/message').map((event) => event.data.id),
      goal: ctx.goals.get(agent) ?? null,
    };
    await sendIpc(ready);
    gateReached();
    // Keep this worker alive, suspended inside the actual pre-step callback.
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
  });

  if (scenario === 'ordinary') {
    const original = modules['dsh-llm'].createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Crash after native user message claim.' }],
    });
    expectedId = original.id;
    agent.followup(original);
  } else {
    if(scenario==='goal-human')agent.inject(modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Preserve this human instruction alongside the automatic Goal.'}]}));
    ctx.goals.create(agent, {
      objective: 'Characterize Goal round state after a process crash during pre-step.',
      maxGoalRounds: 2,
    });
  }
  await gateReady;
  await new Promise(() => {});
}

const prior = JSON.parse(priorJson ?? 'null');
assert.ok(prior && prior.kind === 'ready' && prior.sessionId === sessionId);
let recoverySetup,publishedDurable=false;
if(stage==='recover'||stage==='recover-hold'){
 const invariants=await import(pathToFileURL(join(runtime,'dsh-invariants/lib/index.js')).href),sessionInvariant=await import(pathToFileURL(join(runtime,'dsh-session/lib/invariant.js')).href);
 recoverySetup=createNativeClaimedInputRecoverySetup({Session:modules['dsh-session'].Session,agents:ctx.agents,sessions:ctx.sessions,query:ctx.sessionQuery,projections:ctx.sessionProjections,
  validateLog:createNativeInvariantReplay({Context:modules.cordis.Context,Service:modules.cordis.Service,InvariantRegistry:invariants.InvariantRegistry,sessionInvariant}),
  // Fixture-only authority: this probe has no Gateway/user identity and must
  // not be mistaken for production owner/lease authorization.
  authorize:async({agent})=>({authorized:agent.id===prior.sessionId}),confirmReplaySafety:async()=>({safe:true})});
 ctx.on('agent/created',async({agent})=>{if(agent.id!==sessionId)return;const stored=await ctx.sessionPersistence.open(sessionId,'read');try{const result=await stored.read(0,agent.session.seq);assert.deepEqual(result.events,await sessionEvents(agent.session));assert.equal((await stored.read(agent.session.seq,1)).events.length,0);publishedDurable=true;}finally{await stored.close();}});
}
handle = await ctx.agents.resume({
  resumeSessionId: sessionId,
  agentOptions: { provider: 'local-characterization', model: 'scripted' },
  ...(recoverySetup?{setup:recoverySetup}:{}),
});
const agent = handle.agent;
assert.equal(agent.session.id, sessionId, 'resume must attach the exact original Session');
await agent.whenIdle();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
await ctx.sessions.flush(agent.session);

const events = await sessionEvents(agent.session);
const inbox = ctx.sessionProjections.stateOf(agent.session, 'inbox');
const goal = ctx.goals.get(agent) ?? null;
const postCrashEvents = events.filter((event) => event.seq >= prior.preCrashSeq).map((event) => ({
  seq: event.seq,
  type: event.type,
  reason: event.type === 'turn/end' ? event.data.reason : undefined,
  data: event.type === 'session/end-seed' ? event.data : undefined,
}));
const originalUserEvents = events.filter((event) => event.type === 'user/message' && event.data.id === prior.message.id);
const result = {
  kind: 'result',
  stage,
  scenario,
  pid: process.pid,
  sessionId: agent.session.id,
  originalMessage: prior.message,
  originalPending: [...inbox['next-turn'], ...inbox['next-step']].some((message) => message.id === prior.message.id),
  originalUserMessageCommits: originalUserEvents.length,
  originalUserMessageSeqs: originalUserEvents.map((event) => event.seq),
  modelCallsAfterResume: modelCalls,
  resumeTurnStarts: postCrashEvents.filter((event) => event.type === 'turn/start').length,
  inbox: {
    nextTurn: inbox['next-turn'].map((message) => message.id),
    nextStep: inbox['next-step'].map((message) => message.id),
  },
  postCrashEvents,
  goal,
  recovery:recoverySetup?.resultFor(agent),publishedDurable,
  claimedPendingIds:(prior.claimedMessages??[]).filter(message=>[...inbox['next-turn'],...inbox['next-step']].some(item=>item.id===message.id)).map(message=>message.id),
};

if(stage==='recover-hold'){
 await sendIpc({...result,kind:'restored-ready'});setInterval(()=>{},60000);await new Promise(()=>{});
}
if(stage==='recover'){
 const continuation=modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Continue the original task after verifying the recovered input.'}]});
 agent.followup(continuation);await agent.whenIdle();
 const used=await sessionEvents(agent.session);result.originalHumanCommits=Object.fromEntries(prior.claimedMessages.filter(message=>message.source.kind!=='goal').map(message=>[message.id,used.filter(event=>event.type==='user/message'&&event.data.id===message.id).length]));
 result.continuationId=continuation.id;result.continuationCommits=used.filter(event=>event.type==='user/message'&&event.data.id===continuation.id).length;
 result.goalMessageCommits=used.filter(event=>event.type==='user/message'&&prior.claimedMessages.some(message=>message.id===event.data.id&&message.source.kind==='goal')).length;
 result.modelCallsAfterExplicitContinuation=modelCalls;
}

await handle.dispose();
handle = undefined;
await ctx.fiber.dispose();
ctx = undefined;
await sendIpc(result);
