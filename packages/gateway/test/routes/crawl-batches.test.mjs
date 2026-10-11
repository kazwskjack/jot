import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('internal crawl batch binding and events are authenticated and survive snapshot rebuild', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-crawl-route-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'], internalChannelToken: 'token-1234567890' });
  const userHeaders = { 'x-user-id': 'owner-1' };
  const internalHeaders = { authorization: 'Bearer token-1234567890' };
  try {
    const conv = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers: userHeaders,
      payload: { workspace_id: 'ws', model: { provider: 'p', model: 'm' } } })).json();
    const run = (await service.app.inject({ method: 'POST', url: `/v1/conversations/${conv.conversation_id}/messages`, headers: userHeaders,
      payload: { client_message_id: 'crawl-1', content: [{ type: 'text', text: 'collect' }] } })).json();
    const binding = await service.app.inject({ method: 'POST', url: '/internal/v1/crawl-batches/bind', headers: internalHeaders,
      payload: { batch_id: 'batch-12345678', run_id: run.run_id, owner_id: 'owner-1', conversation_id: conv.conversation_id, requested_count: 1 } });
    assert.equal(binding.statusCode, 201);
    const event = await service.app.inject({ method: 'POST', url: '/internal/v1/crawl-batches/events', headers: internalHeaders,
      payload: { owner_id: 'owner-1', event: { batch_id: 'batch-12345678', event_id: 'evt-12345678-a', event_seq: 1, type: 'item.updated', input_index: 0, item_id: 'item-1234-a', url: 'https://example.com', status: 'succeeded', source_id: 'src-crawl-1', result_ref: 'result-1', title: 'Example' } } });
    assert.equal(event.statusCode, 202);
    const snapshot = await service.app.inject({ method: 'GET', url: `/v1/conversations/${conv.conversation_id}/snapshot`, headers: userHeaders });
    assert.equal(snapshot.statusCode, 200);
    const snapshotValue = snapshot.json();
    assert.equal(snapshotValue.crawl_batches[0].completed_count, 1);
    assert.equal(snapshotValue.sources[0].source_id, 'src-crawl-1');
    assert.deepEqual(snapshotValue.activities[0].detail.urls, ['https://example.com/']);
    const replay = await service.app.inject({ method: 'GET', url: `/v1/conversations/${conv.conversation_id}/events?after=0&follow=0`, headers: userHeaders });
    assert.equal(replay.statusCode, 200);
    assert.match(replay.body, /event: activity\.upsert/);
    assert.match(replay.body, /https:\/\/example\.com\//);
    assert.equal((await service.app.inject({ method: 'GET', url: '/v1/crawl-batches/batch-12345678', headers: { 'x-user-id': 'other' } })).statusCode, 404);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
