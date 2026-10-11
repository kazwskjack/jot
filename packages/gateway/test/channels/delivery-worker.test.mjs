import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../src/channels/worker.ts';

function fixture(prefix = 'ga-delivery-worker-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('input', 'conv', null, 'user', 'complete', '{"blocks":[]}', 'now', 'now');
  db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('run-1', 'conv', 'input', 'running', 1, 'now', 'now');
  return { db, directory };
}

test('delivery worker sends a projected artifact once and registers its receipt', async () => {
  const { db, directory } = fixture();
  const store = new ChannelDeliveryService(db);
  store.enqueueProjected({ request_id: 'delivery:abc', run_id: 'a'.repeat(32),
    client_run_id: 'run-1', artifact_ref: 'artifact:report-1', recipient_ref: 'owner' });
  const calls = [];
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async (...args) => { calls.push(['send', ...args]); return { provider_message_id: 'wx-1' }; },
  }, { registerDeliveryReceipt: async (...args) => { calls.push(['receipt', ...args]); return { ok: true }; } }, {
    resolveArtifact: () => ({ path: '/safe/report.docx', displayName: 'report.docx' }),
    resolveRuntime: () => ({ runtimeRunId: 'a'.repeat(32), clientRunId: 'run-1' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.deepEqual(calls.map(item => item[0]), ['send', 'receipt']);
    assert.equal(store.get('delivery:abc').status, 'delivered');
    assert.equal(await worker.processNext(), false);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delivery worker sends a text delivery without resolving an artifact or Runtime binding', async () => {
  const { db, directory } = fixture('ga-delivery-worker-text-');
  const store = new ChannelDeliveryService(db);
  store.enqueueExternal({ runId: 'run-1', messageId: 'msg-text-1', destination: 'wecom',
    recipient: 'owner', artifactRef: null, text: '需要登录：请打开登录链接。' });
  const calls = [];
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async () => { throw new Error('artifact_path_must_not_be_resolved'); },
    send: async (...args) => { calls.push(['send', ...args]); return { ok: true, errcode: 0 }; },
  }, { registerDeliveryReceipt: async () => { throw new Error('runtime_receipt_not_required_for_chat_text'); } }, {
    resolveArtifact: () => { throw new Error('artifact_must_not_be_resolved'); },
    resolveRuntime: () => { throw new Error('runtime_binding_must_not_be_required'); },
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.deepEqual(calls, [['send', '需要登录：请打开登录链接。', 'owner']]);
    const row = db.prepare('SELECT status FROM ga_channel_deliveries').get();
    assert.equal(row.status, 'delivered');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delivery worker sends every artifact volume in order and settles one group receipt', async () => {
  const { db, directory } = fixture('ga-delivery-worker-volumes-');
  const store = new ChannelDeliveryService(db);
  store.enqueueProjected({ request_id: 'delivery:multi', run_id: 'b'.repeat(32),
    client_run_id: 'run-1', artifact_ref: 'artifact:group-1', recipient_ref: 'owner' });
  const sent = []; const receipts = []; const cleaned = [];
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async path => { sent.push(path); return { provider_message_id: `wx-${sent.length}` }; },
  }, { registerDeliveryReceipt: async (...args) => { receipts.push(args); return { ok: true }; } }, {
    resolveArtifact: () => { throw new Error('single_resolver_must_not_run'); },
    resolveArtifacts: () => [{ path: '/tmp/one.docx', displayName: '一.docx' },
      { path: '/tmp/two.docx', displayName: '二.docx' }],
    cleanupArtifact: artifactRef => cleaned.push(artifactRef),
    resolveRuntime: () => ({ runtimeRunId: 'b'.repeat(32), clientRunId: 'run-1' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.deepEqual(sent, ['/tmp/one.docx', '/tmp/two.docx']);
    assert.equal(receipts.length, 1);
    assert.deepEqual(cleaned, ['artifact:group-1']);
    assert.match(receipts[0][2], /^wecom:group:/);
    assert.equal(store.get('delivery:multi').status, 'delivered');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('ambiguous later volume stops without resending already confirmed volumes', async () => {
  const { db, directory } = fixture('ga-delivery-worker-ambiguous-');
  const store = new ChannelDeliveryService(db);
  store.enqueueProjected({ request_id: 'delivery:ambiguous', run_id: 'c'.repeat(32),
    client_run_id: 'run-1', artifact_ref: 'artifact:group-2', recipient_ref: 'owner' });
  let attempts = 0;
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('network timeout');
      return { provider_message_id: 'wx-first' };
    },
  }, { registerDeliveryReceipt: async () => { throw new Error('must_not_settle'); } }, {
    resolveArtifact: () => { throw new Error('single_resolver_must_not_run'); },
    resolveArtifacts: () => [{ path: '/tmp/one.docx', displayName: '一.docx' },
      { path: '/tmp/two.docx', displayName: '二.docx' }],
    resolveRuntime: () => ({ runtimeRunId: 'c'.repeat(32), clientRunId: 'run-1' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    const state = store.get('delivery:ambiguous');
    assert.equal(state.status, 'outcome_unknown');
    assert.equal(JSON.parse(state.provider_receipt_json).receipts[0].provider_message_id, 'wx-first');
    assert.equal(await worker.processNext(), false);
    assert.equal(attempts, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cleanup failure retries receipt and cleanup without resending confirmed files', async () => {
  const { db, directory } = fixture('ga-delivery-worker-cleanup-retry-');
  const store = new ChannelDeliveryService(db);
  store.enqueueProjected({ request_id: 'delivery:cleanup-retry', run_id: 'd'.repeat(32),
    client_run_id: 'run-1', artifact_ref: 'artifact:group-3', recipient_ref: 'owner' });
  let sends = 0; let receipts = 0; let cleanups = 0;
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async () => { sends += 1; return { provider_message_id: 'wx-confirmed' }; },
  }, { registerDeliveryReceipt: async () => { receipts += 1; return { ok: true }; } }, {
    resolveArtifact: () => ({ path: '/tmp/one.docx', displayName: '一.docx' }),
    cleanupArtifact: () => {
      cleanups += 1;
      if (cleanups === 1) throw new Error('filesystem_busy');
    },
    resolveRuntime: () => ({ runtimeRunId: 'd'.repeat(32), clientRunId: 'run-1' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(store.get('delivery:cleanup-retry').status, 'receipt_pending');
    assert.equal(await worker.processNext(), true);
    assert.equal(store.get('delivery:cleanup-retry').status, 'delivered');
    assert.equal(sends, 1);
    assert.equal(receipts, 2);
    assert.equal(cleanups, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('runtime must accept the delivery receipt before artifact cleanup', async () => {
  const { db, directory } = fixture('ga-delivery-worker-runtime-reject-');
  const store = new ChannelDeliveryService(db);
  store.enqueueProjected({ request_id: 'delivery:runtime-reject', run_id: 'e'.repeat(32),
    client_run_id: 'run-1', artifact_ref: 'artifact:group-4', recipient_ref: 'owner' });
  let sends = 0; let cleanups = 0;
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async () => { sends += 1; return { provider_message_id: 'wx-confirmed' }; },
  }, { registerDeliveryReceipt: async () => ({ ok: false, status: 'rejected',
    reason_code: 'DELIVERY_RECEIPT_INVALID' }) }, {
    resolveArtifact: () => ({ path: '/tmp/one.docx', displayName: '一.docx' }),
    cleanupArtifact: () => { cleanups += 1; },
    resolveRuntime: () => ({ runtimeRunId: 'e'.repeat(32), clientRunId: 'run-1' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(store.get('delivery:runtime-reject').status, 'receipt_pending');
    assert.equal(sends, 1);
    assert.equal(cleanups, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
