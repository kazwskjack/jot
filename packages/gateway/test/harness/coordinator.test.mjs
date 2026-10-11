import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { HarnessCoordinator, FenceRejectedError } from '../../src/harness/coordinator.ts';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-coordinator-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const events = new EventStore(db);
  const runs = new RunRepository(db, events);
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv-1', 'user-1', 'ws-1', 't', '{}', 1, 'now', 'now');
  const receipt = runs.enqueue('conv-1', 'user-1', { client_message_id: 'm-1', content: [{ type: 'text', text: 'run' }] });
  return { directory, db, events, runs, receipt };
}

test('one worker claims, starts, and settles a queued run with a fence', () => {
  const state = setup();
  let now = 1000;
  try {
    const coordinator = new HarnessCoordinator(state.db, state.runs, state.events, () => now);
    const lease = coordinator.claimNext('worker-a', 5000);
    assert.equal(lease.run_id, state.receipt.run_id);
    assert.equal(lease.generation, 1);
    coordinator.start(lease);
    coordinator.applyRuntimeOutcome(lease, { status: 'running', runtime_revision: 1, reason_code: null });
    assert.equal(state.runs.get(lease.run_id, 'user-1').status, 'running');
  } finally { state.db.close(); rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('expired owner cannot commit after a new worker advances the generation', () => {
  const state = setup();
  let now = 1000;
  try {
    const coordinator = new HarnessCoordinator(state.db, state.runs, state.events, () => now);
    const oldLease = coordinator.claimNext('worker-a', 100);
    coordinator.start(oldLease);
    now = 1200;
    const newLease = coordinator.claimNext('worker-b', 1000);
    assert.equal(newLease.generation, 2);
    assert.throws(
      () => coordinator.applyRuntimeOutcome(oldLease, { status: 'completion_eligible', runtime_revision: 1, reason_code: null }),
      FenceRejectedError,
    );
    coordinator.applyRuntimeOutcome(newLease, { status: 'completion_eligible', runtime_revision: 1, reason_code: null });
    assert.equal(state.runs.get(newLease.run_id, 'user-1').status, 'running');
  } finally { state.db.close(); rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('five workers claim different conversations and never overlap one conversation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-coordinator-multi-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const events = new EventStore(db);
  const runs = new RunRepository(db, events);
  try {
    for (let index = 1; index <= 5; index += 1) {
      const conversationId = `conv-${index}`;
      db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(conversationId, 'user-1', 'ws-1', 't', '{}', 1, `2026-01-01T00:00:0${index}Z`, `2026-01-01T00:00:0${index}Z`);
      runs.enqueue(conversationId, 'user-1', { client_message_id: `m-${index}`, content: [{ type: 'text', text: 'run' }] });
    }
    runs.enqueue('conv-1', 'user-1', { client_message_id: 'm-6', content: [{ type: 'text', text: 'later' }] });
    const coordinator = new HarnessCoordinator(db, runs, events, () => 1000);
    const leases = Array.from({ length: 5 }, (_, index) => coordinator.claimNext(`worker-${index + 1}`, 5000));
    assert.equal(new Set(leases.map(lease => lease?.conversation_id)).size, 5);
    assert.equal(coordinator.claimNext('worker-6', 5000), null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
