import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-delivery-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('input', 'conv', null, 'user', 'complete', '{"blocks":[]}', 'now', 'now');
  db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('run-1', 'conv', 'input', 'running', 1, 'now', 'now');
  return { db, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('current chat reply does not create an external delivery requirement', () => {
  const f = fixture();
  try {
    const service = new ChannelDeliveryService(f.db);
    assert.equal(service.enqueueExternal({ runId: 'run-1', messageId: 'msg-1',
      destination: 'current_chat', recipient: 'self', artifactRef: null }), null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM ga_channel_deliveries').get().count, 0);
  } finally { f.close(); }
});

test('explicit external delivery is idempotent by effect identity', () => {
  const f = fixture();
  try {
    const service = new ChannelDeliveryService(f.db);
    const input = { runId: 'run-1', messageId: 'msg-1', destination: 'wecom',
      recipient: 'user-1', artifactRef: 'artifact-1' };
    const first = service.enqueueExternal(input);
    const second = service.enqueueExternal(input);
    assert.equal(second.effect_id, first.effect_id);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM ga_channel_deliveries').get().count, 1);
  } finally { f.close(); }
});

test('text delivery stores an immutable payload without requiring an artifact', () => {
  const f = fixture();
  try {
    const service = new ChannelDeliveryService(f.db);
    const first = service.enqueueExternal({ runId: 'run-1', messageId: 'msg-text-1',
      destination: 'wecom', recipient: 'user-1', artifactRef: null,
      text: '登录后才能继续，请打开登录链接。' });
    const second = service.enqueueExternal({ runId: 'run-1', messageId: 'msg-text-1',
      destination: 'wecom', recipient: 'user-1', artifactRef: null,
      text: '登录后才能继续，请打开登录链接。' });
    assert.equal(second.effect_id, first.effect_id);
    const row = f.db.prepare('SELECT artifact_ref,payload_json FROM ga_channel_deliveries WHERE effect_id=?')
      .get(first.effect_id);
    assert.equal(row.artifact_ref, null);
    assert.deepEqual(JSON.parse(row.payload_json), { kind: 'text', text: '登录后才能继续，请打开登录链接。' });
  } finally { f.close(); }
});

test('provider success followed by receipt failure retries receipt only', () => {
  const f = fixture();
  try {
    let now = 1000;
    const service = new ChannelDeliveryService(f.db, () => now);
    service.enqueueExternal({ runId: 'run-1', messageId: 'msg-1', destination: 'wecom',
      recipient: 'user-1', artifactRef: 'artifact-1' });
    const send = service.claim('worker-1', 30);
    assert.equal(send.phase, 'send');
    service.recordProviderSent(send.effect_id, send.generation, { provider_message_id: 'wx-1' });
    service.recordReceiptFailure(send.effect_id, 'RUNTIME_TRANSPORT_UNAVAILABLE');
    now += 31;
    const retry = service.claim('worker-1', 30);
    assert.equal(retry.phase, 'receipt_only');
    assert.equal(retry.provider_receipt.provider_message_id, 'wx-1');
  } finally { f.close(); }
});

test('unknown provider response is not blindly retried', () => {
  const f = fixture();
  try {
    const service = new ChannelDeliveryService(f.db);
    const queued = service.enqueueExternal({ runId: 'run-1', messageId: 'msg-1',
      destination: 'wecom', recipient: 'user-1', artifactRef: 'artifact-1' });
    const send = service.claim('worker-1', 30);
    service.recordProviderUnknown(send.effect_id, send.generation);
    assert.equal(service.claim('worker-1', 30), null);
    assert.equal(service.get(queued.effect_id).status, 'outcome_unknown');
  } finally { f.close(); }
});

test('one C delivery request projects idempotently into the J outbox', () => {
  const f = fixture();
  try {
    const service = new ChannelDeliveryService(f.db);
    const request = { request_id: 'delivery:abc', run_id: 'runtime-run',
      client_run_id: 'run-1', artifact_ref: 'artifact:report-1', recipient_ref: 'owner' };
    const first = service.enqueueProjected(request);
    const second = service.enqueueProjected(request);
    assert.equal(first.effect_id, 'delivery:abc');
    assert.equal(second.effect_id, 'delivery:abc');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM ga_channel_deliveries').get().count, 1);
  } finally { f.close(); }
});
