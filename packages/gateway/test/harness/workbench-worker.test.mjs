import test from 'node:test';
import assert from 'node:assert/strict';
import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { HarnessWorker } from '../../src/harness/worker.ts';
function fixture() {
  const db = openProductDatabase(':memory:'); const events = new EventStore(db); const runs = new RunRepository(db, events);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('agent-chat', 'owner', 'ws', 'Agent', '{}', 1, now, now);
  const receipt = runs.enqueue('agent-chat', 'owner', { client_message_id: 'test-input', content: [{ type: 'text', text: 'Find sources' }] });
  return { db, events, runs, receipt, coordinator: new HarnessCoordinator(db, runs, events) };
}
test('revoked Agent execution is rejected before invoking DSH', async () => {
  const x = fixture(); let invoked = false;
  try {
    const worker = new HarnessWorker(x.db, x.coordinator, { run: async () => { invoked = true; return {}; } }, {
      workerId: 'test', leaseMs: 30000,
      executionGuard: { assertRunActive: () => { throw new Error('agent_capability_revoked'); }, contextForRun: () => null },
    });
    await worker.processNext();
    assert.equal(invoked, false);
    assert.equal(x.runs.get(x.receipt.run_id, 'owner').status, 'interrupted');
  } finally { x.db.close(); }
});
test('Agent run identity is forwarded to the host bridge, and deletion blocks answer publication', async () => {
  const x = fixture(); let active = true; let forwarded;
  try {
    const worker = new HarnessWorker(x.db, x.coordinator, { run: async input => {
      forwarded = input.workbenchRunId;
      active = false;
      return { final_text: 'Must not publish after revocation', observed: true, completed: false, runtime_status: 'not_required', reason_code: 'CHAT' };
    } }, { workerId: 'test', leaseMs: 30000, executionGuard: {
      assertRunActive: () => { if (!active) throw new Error('agent_capability_revoked'); },
      contextForRun: () => ({ agent_id: 'agent-1' }),
    } });
    await worker.processNext();
    assert.equal(forwarded, x.receipt.run_id);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM ga_messages WHERE role='assistant'").get().n, 0);
    assert.notEqual(x.runs.get(x.receipt.run_id, 'owner').status, 'succeeded');
  } finally { x.db.close(); }
});

test('revocation during output resolution blocks both final publication and channel delivery', async () => {
  const x = fixture(); let active = true; let delivered = false;
  try {
    const worker = new HarnessWorker(x.db, x.coordinator, { run: async () => ({
      final_text: 'Revoked during output resolution', output_artifact_refs: ['artifact-test'],
      observed: true, completed: true, runtime_status: 'not_required', reason_code: 'CHAT',
    }) }, { workerId: 'test', leaseMs: 30000,
      executionGuard: { assertRunActive: () => { if (!active) throw new Error('agent_capability_revoked'); }, contextForRun: () => ({ agent_id: 'agent-1' }) },
      attachmentResolver: { resolveForMessage: () => [], resolveOutputs: () => { active = false; return []; }, releaseLease() {} },
      channelDelivery: { enqueueText() { delivered = true; return {}; } },
    });
    await worker.processNext();
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM ga_messages WHERE role='assistant'").get().n, 0);
    assert.notEqual(x.runs.get(x.receipt.run_id, 'owner').status, 'succeeded');
    assert.equal(delivered, false);
  } finally { x.db.close(); }
});
