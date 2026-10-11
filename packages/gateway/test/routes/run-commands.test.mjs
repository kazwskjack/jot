import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('steer, cancel, and resume obey run state and checkpoint contracts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-command-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'] });
  const headers = { 'x-user-id': 'u', 'idempotency-key': 'command-1' };
  try {
    const conversation = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws-1', model: { provider: 'p', model: 'm' } } })).json();
    const receipt = (await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversation.conversation_id}/messages`, headers,
      payload: { client_message_id: 'm1', content: [{ type: 'text', text: 'work' }] } })).json();
    const queuedInput = { client_message_id: 'steer-queued', expected_run_version: 1, text: 'queued supplement' };
    const queued = await service.app.inject({ method: 'POST', url: `/v1/runs/${receipt.run_id}/steer`, headers,
      payload: queuedInput });
    assert.equal(queued.statusCode, 202);
    const replay = await service.app.inject({ method: 'POST', url: `/v1/runs/${receipt.run_id}/steer`, headers, payload: queuedInput });
    assert.equal(replay.json().command_id, queued.json().command_id);
    assert.equal(service.runs.get(receipt.run_id, 'u').status, 'queued');
    assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n, 1);
    assert.equal(service.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n, 1);
    service.db.prepare("UPDATE ga_runs SET status='starting' WHERE id=?").run(receipt.run_id);
    const starting = await service.app.inject({ method: 'POST', url: `/v1/runs/${receipt.run_id}/steer`,
      headers: { ...headers, 'idempotency-key': 'steer-starting' },
      payload: { client_message_id: 'steer-starting', expected_run_version: 1, text: 'starting supplement' } });
    assert.equal(starting.statusCode, 202);
    assert.equal(service.runs.get(receipt.run_id, 'u').status, 'starting');

    service.runs.applyRuntimeOutcome(receipt.run_id, { status: 'running', runtime_revision: 1, reason_code: null });
    const running = service.runs.get(receipt.run_id, 'u');
    const steer = await service.app.inject({ method: 'POST', url: `/v1/runs/${receipt.run_id}/steer`, headers: { ...headers, 'idempotency-key': 'steer-running' },
      payload: { client_message_id: 'steer-1', expected_run_version: running.version, text: 'more' } });
    assert.equal(steer.statusCode, 202);

    const cancel = await service.app.inject({ method: 'POST', url: `/v1/runs/${receipt.run_id}/cancel`,
      headers: { ...headers, 'idempotency-key': 'cancel-1' },
      payload: { expected_run_version: running.version, reason: 'stop' } });
    assert.equal(cancel.statusCode, 202);
    assert.equal(service.runs.get(receipt.run_id, 'u').status, 'cancelling');

    service.db.prepare("UPDATE ga_runs SET status='failed',checkpoint_id='cp-1',version=version+1 WHERE id=?").run(receipt.run_id);
    const failed = service.runs.get(receipt.run_id, 'u');
    const resumed = await service.app.inject({ method: 'POST', url: `/v1/runs/${receipt.run_id}/resume`,
      headers: { ...headers, 'idempotency-key': 'resume-1' },
      payload: { expected_run_version: failed.version, checkpoint_id: 'cp-1' } });
    assert.equal(resumed.statusCode, 202);
    assert.equal(resumed.json().continuation_of, receipt.run_id);
    assert.notEqual(resumed.json().run_id, receipt.run_id);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
