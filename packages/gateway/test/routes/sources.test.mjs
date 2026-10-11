import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('source access can become fetched only with a Runtime evidence reference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-source-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'] });
  const headers = { 'x-user-id': 'u' };
  try {
    const conv = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws', model: { provider: 'p', model: 'm' } } })).json();
    const run = (await service.app.inject({ method: 'POST', url: `/v1/conversations/${conv.conversation_id}/messages`, headers,
      payload: { client_message_id: 'm', content: [{ type: 'text', text: 'task' }] } })).json();
    assert.throws(() => service.sources.project({ source_id: 'src-bad', conversation_id: conv.conversation_id,
      run_id: run.run_id, url: 'https://example.com', title: 'Example', access: 'fetched', runtime_revision: 1 }));
    service.sources.project({ source_id: 'src-1', conversation_id: conv.conversation_id, run_id: run.run_id,
      activity_id: 'activity-1', url: 'https://example.com/a', title: 'Example', access: 'fetched',
      runtime_evidence_ref: 'leaf:call:abc', runtime_revision: 1, retrieved_at: new Date().toISOString() });
    const response = await service.app.inject({ method: 'GET', url: '/v1/sources/src-1', headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().host, 'example.com');
    assert.equal(response.json().access, 'fetched');
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
