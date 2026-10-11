import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { RuntimeEventProjector } from '../../src/harness/runtime-projector.ts';

test('projector replays every C revision in order and advances the durable binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-projector-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const events = new EventStore(db); const runs = new RunRepository(db, events);
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'task' }] });
  const coordinator = new HarnessCoordinator(db, runs, events);
  const lease = coordinator.claimNext('worker', 30_000); coordinator.start(lease);
  coordinator.bindSession(lease, `session-${'b'.repeat(32)}`);
  const client = { events: async (_run, after) => ({ ok: true, run_id: 'a'.repeat(32), head_revision: 2,
    events: after === 0 ? [
      { revision: 1, status: 'running', reason_code: null },
      { revision: 2, status: 'completion_eligible', reason_code: null },
    ] : [] }) };
  try {
    const result = await new RuntimeEventProjector(db, coordinator, client).sync(lease, 'a'.repeat(32));
    assert.equal(result, 2);
    assert.equal(runs.get(receipt.run_id, 'owner').status, 'running');
    assert.equal(db.prepare('SELECT last_runtime_revision FROM ga_runtime_bindings WHERE run_id=?').get(receipt.run_id).last_runtime_revision, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('projector resumes after a crash between outcome commit and cursor advance without duplicating the outcome', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-projector-crash-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const events = new EventStore(db); const runs = new RunRepository(db, events);
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  const receipt = runs.enqueue('conv', 'owner', { client_message_id: 'm', content: [{ type: 'text', text: 'task' }] });
  const coordinator = new HarnessCoordinator(db, runs, events);
  const lease = coordinator.claimNext('worker', 30_000); coordinator.start(lease);
  coordinator.bindSession(lease, `session-${'c'.repeat(32)}`);
  const runtimeRunId = 'd'.repeat(32);
  const client = { events: async (_run, after) => ({ ok: true, run_id: runtimeRunId, head_revision: 2,
    events: after === 0 ? [
      { revision: 1, status: 'running', reason_code: null },
      { revision: 2, status: 'completion_eligible', reason_code: null },
    ] : after === 1 ? [{ revision: 2, status: 'completion_eligible', reason_code: null }] : [] }) };
  let injected = false;
  const crashingCoordinator = new Proxy(coordinator, {
    get(target, property, receiver) {
      if (property === 'bindRuntimeRevision') return (...args) => {
        if (!injected) { injected = true; throw new Error('injected_projector_crash'); }
        return target.bindRuntimeRevision(...args);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await assert.rejects(new RuntimeEventProjector(db, crashingCoordinator, client).sync(lease, runtimeRunId), /injected_projector_crash/);
    assert.equal(db.prepare('SELECT runtime_revision FROM ga_runs WHERE id=?').get(receipt.run_id).runtime_revision, 1);
    assert.equal(db.prepare('SELECT last_runtime_revision FROM ga_runtime_bindings WHERE run_id=?').get(receipt.run_id).last_runtime_revision, 0);

    const result = await new RuntimeEventProjector(db, coordinator, client).sync(lease, runtimeRunId);
    assert.equal(result, 2);
    assert.equal(runs.get(receipt.run_id, 'owner').status, 'running');
    const outcomeEvents = db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='runtime.outcome' ORDER BY seq").all(receipt.run_id);
    assert.equal(outcomeEvents.length, 2);
    assert.deepEqual(outcomeEvents.map(row => JSON.parse(row.payload_json).revision), [1, 2]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
