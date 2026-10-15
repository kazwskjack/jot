import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureNativeChildClosure } from '../native-child-closure.js';
import { createNativeHandoffLifecycle } from '../native-handoff-lifecycle.js';

async function fixture(t) {
  const parentBinding = Object.freeze({ runId: 'root-run', sessionRef: 'lead' });
  const childBinding = Object.freeze({ runId: 'child-run', sessionRef: 'child' });
  const parentHeader = { delegationDepth: 0 };
  const childHeader = { delegationDepth: 1, parentSession: 'lead' };
  const childEvents = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const effects = [];
  let cleanup;
  let projectionReads = 0;
  let persistenceFlushes = 0;
  let persistenceReads = 0;
  let sessionGetterReads = 0;
  let snapshotGetterReads = 0;
  let state = { revision: 1, phase: 'active', controller: 'lead-role', route: ['lead-role'] };
  let recovery;
  const requests = [];

  const parent = {
    id: 'lead',
    status: 'idle',
    session: { id: 'lead', header: parentHeader, seq: 0, eventAt: () => undefined },
    ctx: { tools: { guard: () => () => {} }, on: () => () => {} },
    inbox: {
      nextTurn: [],
      nextStep: [],
      prepend(target, message) { this[target === 'next-turn' ? 'nextTurn' : 'nextStep'].unshift(message); },
    },
    whenIdle: async () => {},
    runMaintenance: async (operation) => operation(new AbortController().signal),
  };
  const child = {
    id: 'child',
    status: 'idle',
    session: {
      id: 'child', header: childHeader, seq: childEvents.length,
      eventAt: (seq) => childEvents[seq],
    },
    whenIdle: async () => {},
  };
  const ctx = {
    effect(register) {
      effects.push(register);
      cleanup = register();
    },
  };
  const registry = { get: (id) => id === 'lead' ? parent : undefined };
  const persistence = {
    async flush() { persistenceFlushes++; },
    async open(id) {
      persistenceReads++;
      const header = id === 'lead' ? parentHeader : childHeader;
      const events = id === 'lead' ? [] : childEvents;
      return {
        id, access: 'read', header, inheritedEventCount: 0,
        async read(offset, count) { return { events: events.slice(offset, offset + count) }; },
        async close() {},
      };
    },
  };
  const projections = {
    stateOf() { projectionReads++; return { 'next-turn': [], 'next-step': [] }; },
    get snapshot() {
      snapshotGetterReads++;
      return () => ({ asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } });
    },
  };
  const sessions = Object.defineProperty({}, 'get', {
    get() {
      sessionGetterReads++;
      return (id) => id === 'child' ? child.session : undefined;
    },
  });
  const sourceProof = await captureNativeChildClosure({
    agent: child, parentSessionRef: parent.id, registry, persistence, projections,
  });
  const requestId = 'handoff-return-' + createHash('sha256')
    .update(JSON.stringify([parentBinding.runId, parentBinding.sessionRef, childBinding.runId, childBinding.sessionRef]))
    .digest('hex');
  const returnedState = {
    revision: 3, phase: 'returned', controller: 'lead-role',
    route: ['lead-role', 'reviewer', 'lead-role'],
  };
  const bridge = {
    bindingFor(agent) { return agent === parent ? parentBinding : agent === child ? childBinding : undefined; },
    async request(path, binding, payload) {
      requests.push({ path, binding, payload });
      if (path === 'native-child-source') {
        return { source: { previous_run_id: childBinding.runId, role_ref: 'reviewer', proof: sourceProof } };
      }
      if (payload.action === 'start') {
        state = { revision: 1, phase: 'active', controller: 'lead-role', route: ['lead-role'] };
        return { state, binding: { revision: 1, run_id: parentBinding.runId, session_ref: parentBinding.sessionRef } };
      }
      if (payload.action === 'get') {
        return { state, binding: { revision: state.revision, run_id: childBinding.runId, session_ref: childBinding.sessionRef } };
      }
      if (payload.action === 'transfer' && payload.request.to === 'reviewer') {
        state = { revision: 2, phase: 'active', controller: 'reviewer', route: ['lead-role', 'reviewer'] };
        return { state, binding: { revision: 2, run_id: childBinding.runId, session_ref: childBinding.sessionRef } };
      }
      if (payload.action === 'transfer' && payload.request.to === 'lead-role') return { state: returnedState };
      if (payload.action === 'recover_return') return { recovery };
      throw new Error(`Unexpected management action: ${payload.action}`);
    },
  };
  const lifecycle = createNativeHandoffLifecycle({
    ctx, bridge, registry, persistence, projections, sessions,
    policyVersion: 1, maxHops: 2, route: { provider: 'fixture', model: 'bounded' },
    validateLog: async () => ({ validated: true }),
  });
  t.after(async () => { await cleanup?.(); });

  return {
    lifecycle, parent, child, parentBinding, childBinding, bridge, requests, effects,
    sourceProof, requestId, returnedState, projections, sessions,
    counts: () => ({ projectionReads, persistenceFlushes, persistenceReads, sessionGetterReads, snapshotGetterReads }),
    setRecovery(value) { recovery = value; },
  };
}

test('one lifecycle shares its official Inbox Gate across admission, return, and recovery', async (t) => {
  const f = await fixture(t);
  const { lifecycle } = f;
  assert.equal(f.effects.length, 1, 'the lifecycle owns exactly one Gate disposal hook');
  assert.equal(typeof lifecycle.handoffAdmission, 'function');
  assert.equal(typeof lifecycle.handoffReturn, 'function');
  assert.equal(typeof lifecycle.handoffRecovery, 'function');

  const gateCalls = [];
  for (const method of ['arm', 'transition', 'complete']) {
    const invoke = lifecycle.inboxGate[method].bind(lifecycle.inboxGate);
    lifecycle.inboxGate[method] = (...args) => {
      gateCalls.push({ method, gate: lifecycle.inboxGate });
      return invoke(...args);
    };
  }

  const admission = await lifecycle.handoffAdmission({
    parent: f.parent,
    child: f.child,
    roleRef: 'reviewer',
    binding: f.childBinding,
    parentBinding: f.parentBinding,
  });
  assert.equal(admission.state.revision, 2);
  assert.equal(lifecycle.inboxGate.statusFor(f.parent, f.parentBinding).state, 'armed');

  const returned = await lifecycle.handoffReturn({
    parent: f.parent,
    child: f.child,
    parentBinding: f.parentBinding,
    binding: f.childBinding,
    roleRef: 'reviewer',
    receipt: { closed: true, run_id: f.childBinding.runId },
  });
  assert.equal(returned.state.phase, 'returned');
  assert.equal(lifecycle.inboxGate.statusFor(f.parent, f.parentBinding), undefined);

  lifecycle.inboxGate.arm({
    parent: f.parent, parentBinding: f.parentBinding, childRunId: f.childBinding.runId,
    childSessionRef: f.childBinding.sessionRef, roleRef: 'reviewer', activeRevision: 2,
  });
  f.setRecovery({
    state: 'returned', execution_authorized: false, revision: 3,
    lead_role_ref: 'lead-role', role_ref: 'reviewer', child_run_id: f.childBinding.runId,
    child_session_ref: f.childBinding.sessionRef, request_id: f.requestId, proof: f.sourceProof,
    receipt: { state: f.returnedState },
  });
  assert.deepEqual(await lifecycle.handoffRecovery({ parent: f.parent, parentBinding: f.parentBinding }), {
    state: 'returned', request_id: f.requestId, revision: 3,
  });
  assert.equal(lifecycle.inboxGate.statusFor(f.parent, f.parentBinding), undefined);

  assert.deepEqual(gateCalls.map(({ method }) => method), ['arm', 'transition', 'complete', 'arm', 'complete']);
  assert.ok(gateCalls.every(({ gate }) => gate === lifecycle.inboxGate));
  for (const { binding } of f.requests) assert.deepEqual(binding, f.parentBinding);
  assert.ok(f.requests.filter(({ path }) => path === 'handoff')
    .every(({ payload }) => payload.expected_policy_version === 1));
  assert.ok(f.counts().projectionReads > 0);
  assert.ok(f.counts().persistenceFlushes > 0 && f.counts().persistenceReads > 0);
  assert.ok(f.counts().sessionGetterReads > 0 && f.counts().snapshotGetterReads > 0);
  assert.equal(f.bridge.bindingFor(f.parent), f.parentBinding);
});
