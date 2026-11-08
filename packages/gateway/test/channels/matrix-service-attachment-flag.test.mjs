import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startMatrixChannelService } from '../../src/channels/matrix-service.ts';

const base = {
  GENERAL_AGENT_MATRIX_BASE_URL: 'https://matrix.example.org',
  GENERAL_AGENT_MATRIX_ACCESS_TOKEN: 'synthetic-matrix-access-token',
  GENERAL_AGENT_GATEWAY_INTERNAL_URL: 'http://127.0.0.1:18831',
  GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN: 'synthetic-channel-service-token-32',
};

async function captureOptions(env) {
  let captured;
  const db = new DatabaseSync(':memory:');
  let service;
  try {
    service = await startMatrixChannelService(env, {
      db,
      matrixFetch: async () => Response.json({ user_id: '@bot:example.org' }),
      register: async (_app, options) => {
        captured = options;
        return { async start() {}, async stop() {}, async uninstall() {}, async pollMatrix() { return { nextBatch: 'next', receipts: [] }; } };
      },
    });
    return captured;
  } finally { await service?.close(); db.close(); }
}

test('Matrix attachment forwarding stays disabled unless the v2 intake flag is explicitly enabled', async () => {
  const disabled = await captureOptions(base);
  assert.equal(Object.hasOwn(disabled, 'attachmentForward'), false);

  const enabled = await captureOptions({ ...base, GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED: 'true',
    GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED: 'true' });
  assert.equal(typeof enabled.attachmentForward, 'function');
});

test('Matrix attachment opt-in rejects malformed or incomplete recovery configuration', async () => {
  await assert.rejects(() => captureOptions({ ...base, GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED: 'yes' }),
    /channel_attachment_configuration_invalid/);
  await assert.rejects(() => captureOptions({ ...base, GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED: 'true' }),
    /channel_attachment_original_recovery_required/);
});

test('Matrix sync cursor and terminal refusal receipts survive service restart', async () => {
  const db = new DatabaseSync(':memory:');
  const refusal = { provider_message_id: '$event-1:example.org', source_sha256: 'a'.repeat(64),
    status_code: 409, error_code: 'CHANNEL_BINDING_NOT_VERIFIED' };
  const starts = [];
  const register = async (_app, options) => {
    starts.push(options);
    return { async start() {}, async stop() {}, async uninstall() {}, async pollMatrix(since) {
      assert.equal(since, starts.length === 1 ? undefined : 'syt_next_1');
      return { nextBatch: starts.length === 1 ? 'syt_next_1' : 'syt_next_2', receipts: [],
        ...(starts.length === 1 ? { terminalRefusals: [refusal] } : {}) };
    } };
  };
  const deps = { db, matrixFetch: async () => Response.json({ user_id: '@bot:example.org' }), register };
  try {
    const first = await startMatrixChannelService(base, deps);
    assert.equal(first.cursor(), null);
    await first.poll();
    assert.equal(first.cursor(), 'syt_next_1');
    await first.close();

    const second = await startMatrixChannelService(base, deps);
    assert.equal(second.cursor(), 'syt_next_1');
    await second.poll();
    assert.equal(second.cursor(), 'syt_next_2');
    assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_matrix_poll_refusals').get().n), 1);
    assert.equal(starts[0].lookupMatrixTerminalRefusal('$event-1:example.org', 'a'.repeat(64)).error_code,
      'CHANNEL_BINDING_NOT_VERIFIED');
    await second.close();
  } finally { db.close(); }
});

test('Matrix retryable batches leave the durable cursor unchanged', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const service = await startMatrixChannelService(base, {
      db,
      matrixFetch: async () => Response.json({ user_id: '@bot:example.org' }),
      register: async () => ({ async start() {}, async stop() {}, async uninstall() {},
        async pollMatrix() { throw Error('CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN'); } }),
    });
    await assert.rejects(() => service.poll(), /CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN/);
    assert.equal(service.cursor(), null);
    assert.equal(Number(db.prepare('SELECT count(*) n FROM ga_matrix_poll_cursors').get().n), 0);
    await service.close();
  } finally { db.close(); }
});
