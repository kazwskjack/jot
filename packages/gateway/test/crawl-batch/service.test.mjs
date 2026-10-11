import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { CrawlBatchService } from '../../src/crawl-batch/service.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';

function fixture({ ownerId = 'owner-1', withDelivery = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ga-crawl-batch-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv-12345678', ownerId, 'ws', 'crawl', 'model', 1, now, now);
  db.prepare('INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('run-12345678', 'conv-12345678', 'running', 1, now, now);
  const events = new EventStore(db);
  const delivery = withDelivery ? new ChannelDeliveryService(db) : undefined;
  return { db, events, service: new CrawlBatchService(db, events, delivery), directory };
}

function close(value) { value.db.close(); rmSync(value.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }

test('bind is owner-bound and emits one stable activity', () => {
  const f = fixture();
  try {
    const first = f.service.bind({ batch_id: 'batch-12345678', run_id: 'run-12345678', owner_id: 'owner-1', conversation_id: 'conv-12345678', requested_count: 2 });
    const second = f.service.bind({ batch_id: 'batch-12345678', run_id: 'run-12345678', owner_id: 'owner-1', conversation_id: 'conv-12345678', requested_count: 2 });
    assert.equal(first.batch_id, second.batch_id);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ga_events WHERE type=\'activity.upsert\'').get().n, 1);
    assert.throws(() => f.service.bind({ batch_id: 'batch-87654321', run_id: 'run-12345678', owner_id: 'other', conversation_id: 'conv-12345678', requested_count: 2 }), /crawl_batch_owner_mismatch/);
  } finally { close(f); }
});

test('ingest is idempotent, accepts out of order item indexes, and projects sources', () => {
  const f = fixture();
  try {
    f.service.bind({ batch_id: 'batch-12345678', run_id: 'run-12345678', owner_id: 'owner-1', conversation_id: 'conv-12345678', requested_count: 2 });
    const item = { batch_id: 'batch-12345678', event_id: 'evt-12345678-a', event_seq: 1, type: 'item.updated', input_index: 1, item_id: 'item-1234-a', url: 'https://two.example.test/page', status: 'succeeded', source_id: 'src-2', result_ref: 'result-2', title: 'Two', excerpt: 'body' };
    const result = f.service.ingest('owner-1', item);
    assert.equal(result.completed_count, 1);
    assert.equal(f.service.ingest('owner-1', item).duplicate, true);
    const final = f.service.ingest('owner-1', { batch_id: 'batch-12345678', event_id: 'evt-12345678-b', event_seq: 2, type: 'batch.completed', status: 'partial' });
    assert.equal(final.status, 'partial');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ga_sources').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ga_events WHERE type=\'source.upsert\'').get().n, 1);
  } finally { close(f); }
});

test('partial batch activity keeps partial status instead of masquerading as success', () => {
  const f = fixture();
  try {
    const bound = f.service.bind({ batch_id: 'batch-partial-12345678', run_id: 'run-12345678', owner_id: 'owner-1', conversation_id: 'conv-12345678', requested_count: 2 });
    f.service.ingest('owner-1', { batch_id: bound.batch_id, event_id: 'evt-partial-start', event_seq: 1, type: 'batch.started' });
    f.service.ingest('owner-1', { batch_id: bound.batch_id, event_id: 'evt-partial-item', event_seq: 2, type: 'item.updated', input_index: 0, item_id: 'item-partial-1', url: 'https://example.com/ok', status: 'succeeded' });
    const value = f.service.ingest('owner-1', { batch_id: bound.batch_id, event_id: 'evt-partial-end', event_seq: 3, type: 'batch.completed', status: 'partial' });
    assert.equal(value.status, 'partial');
    const event = f.db.prepare("SELECT payload_json FROM ga_events WHERE type='activity.upsert' ORDER BY seq DESC LIMIT 1").get();
    const activity = JSON.parse(event.payload_json);
    assert.equal(activity.status, 'partial');
    assert.deepEqual(activity.detail.urls, ['https://example.com/ok']);
  } finally { close(f); }
});

test('crawl activity includes real failed item reasons without changing batch status semantics', () => {
  const f = fixture();
  try {
    const bound = f.service.bind({ batch_id: 'batch-errors-12345678', run_id: 'run-12345678', owner_id: 'owner-1', conversation_id: 'conv-12345678', requested_count: 2 });
    f.service.ingest('owner-1', { batch_id: bound.batch_id, event_id: 'evt-errors-1', event_seq: 1, type: 'item.updated', input_index: 0, item_id: 'item-errors-1', url: 'https://example.com/timeout', status: 'failed', error_code: 'PAGE_TIMEOUT' });
    const event = f.db.prepare("SELECT payload_json FROM ga_events WHERE type='activity.upsert' ORDER BY seq DESC LIMIT 1").get();
    const activity = JSON.parse(event.payload_json);
    assert.deepEqual(activity.detail.errors, [{ input_index: 0, error_code: 'PAGE_TIMEOUT', url: 'https://example.com/timeout' }]);
  } finally { close(f); }
});

test('cancel persists an outbox control intent without ending the product run', () => {
  const f = fixture();
  try {
    f.service.bind({ batch_id: 'batch-12345678', run_id: 'run-12345678', owner_id: 'owner-1', conversation_id: 'conv-12345678', requested_count: 2 });
    f.service.ingest('owner-1', { batch_id: 'batch-12345678', event_id: 'evt-12345678-a', event_seq: 1, type: 'batch.started' });
    const value = f.service.cancel('owner-1', 'run-12345678');
    assert.equal(value.accepted, true);
    assert.equal(value.batches[0].status, 'cancelling');
    assert.equal(f.db.prepare("SELECT event_type FROM ga_outbox WHERE aggregate_type='crawl_batch'").get().event_type, 'crawl.cancel');
    assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get('run-12345678').status, 'running');
  } finally { close(f); }
});

test('WeCom batch summary is one durable message and follows the channel owner', () => {
  const f = fixture({ ownerId: 'channel:wecom:wx-user-1', withDelivery: true });
  try {
    const owner = 'channel:wecom:wx-user-1';
    const bound = f.service.bind({ batch_id: 'batch-wecom-12345678', run_id: 'run-12345678', owner_id: owner,
      conversation_id: 'conv-12345678', requested_count: 2 });
    f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-wecom-start', event_seq: 1, type: 'batch.started' });
    f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-wecom-ok', event_seq: 2, type: 'item.updated',
      input_index: 0, item_id: 'item-wecom-ok', url: 'https://example.com/ok', status: 'succeeded' });
    f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-wecom-fail', event_seq: 3, type: 'item.updated',
      input_index: 1, item_id: 'item-wecom-fail', url: 'https://example.com/fail', status: 'failed', error_code: 'PAGE_TIMEOUT' });
    const terminal = f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-wecom-end', event_seq: 4,
      type: 'batch.completed', status: 'partial' });
    assert.equal(terminal.status, 'partial');
    const row = f.db.prepare('SELECT destination,recipient,payload_json,status FROM ga_channel_deliveries').get();
    assert.deepEqual({ destination: row.destination, recipient: row.recipient, status: row.status,
      payload: JSON.parse(row.payload_json) }, {
      destination: 'wecom', recipient: 'wx-user-1', status: 'pending',
      payload: { kind: 'text', text: '并行采集部分完成：2/2 项已结束，失败 1 项。' },
    });
    f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-wecom-end', event_seq: 4,
      type: 'batch.completed', status: 'partial' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ga_channel_deliveries').get().n, 1);
    assert.ok(f.db.prepare('SELECT summary_delivery_effect_id FROM ga_crawl_batches WHERE batch_id=?').get(bound.batch_id).summary_delivery_effect_id);
  } finally { close(f); }
});

test('WeCom cancellation persists control intent and emits only the terminal summary', () => {
  const f = fixture({ ownerId: 'channel:wecom:wx-user-2', withDelivery: true });
  try {
    const owner = 'channel:wecom:wx-user-2';
    const bound = f.service.bind({ batch_id: 'batch-wecom-cancel1', run_id: 'run-12345678', owner_id: owner,
      conversation_id: 'conv-12345678', requested_count: 1 });
    f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-cancel-start', event_seq: 1, type: 'batch.started' });
    const cancel = f.service.cancel(owner, 'run-12345678', 'USER_CANCELLED');
    assert.equal(cancel.batches[0].status, 'cancelling');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ga_outbox WHERE event_type='crawl.cancel'").get().n, 1);
    f.service.ingest(owner, { batch_id: bound.batch_id, event_id: 'evt-cancel-end', event_seq: 2, type: 'batch.cancelled' });
    const row = f.db.prepare('SELECT recipient,payload_json FROM ga_channel_deliveries').get();
    assert.equal(row.recipient, 'wx-user-2');
    assert.deepEqual(JSON.parse(row.payload_json), { kind: 'text', text: '并行采集已取消：0/1 项已结束，失败 0 项。' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ga_channel_deliveries').get().n, 1);
  } finally { close(f); }
});
