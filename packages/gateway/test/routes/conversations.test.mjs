import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('capabilities and conversation routes enforce owner, version, and active-run rules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-conv-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'] });
  const headers = { 'x-user-id': 'user-1' };
  try {
    const capabilities = await service.app.inject({ method: 'GET', url: '/v1/capabilities', headers });
    assert.equal(capabilities.statusCode, 200);
    assert.equal(capabilities.json().limits.max_active_runs_per_conversation, 1);
    assert.equal(capabilities.json().limits.max_concurrent_sessions, 5);

    const created = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws-1', model: { provider: 'zhipu', model: 'glm' }, title: 'Old' } })).json();
    assert.equal((await service.app.inject({ method: 'GET', url: '/v1/conversations', headers })).json().items.length, 1);
    assert.equal((await service.app.inject({ method: 'GET', url: `/v1/conversations/${created.conversation_id}`, headers: { 'x-user-id': 'other' } })).statusCode, 404);

    const patched = await service.app.inject({ method: 'PATCH', url: `/v1/conversations/${created.conversation_id}`, headers,
      payload: { expected_version: 1, title: 'New' } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().version, 2);
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/v1/conversations/${created.conversation_id}`, headers,
      payload: { expected_version: 1, title: 'Stale' } })).statusCode, 409);

    await service.app.inject({ method: 'POST', url: `/v1/conversations/${created.conversation_id}/messages`, headers,
      payload: { client_message_id: 'm-1', content: [{ type: 'text', text: 'hello' }] } });
    const history = await service.app.inject({ method: 'GET', url: `/v1/conversations/${created.conversation_id}/messages?limit=10`, headers });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().items[0].blocks[0].text, 'hello');

    const runId = history.json().items[0].run_id;
    const now = new Date().toISOString();
    service.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('artifact-output', created.conversation_id, 'user-1', 'upload', 1, now, now);
    service.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('artifact-output', 1, join(directory, 'result.docx'), 'a'.repeat(64), 42,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        JSON.stringify({ file_name: '结果.docx', status: 'ready' }), now);
    service.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
      .run(runId, 'artifact-output', 1, now);
    const outputs = await service.app.inject({ method: 'GET', url: `/v1/runs/${runId}/artifacts`, headers });
    assert.equal(outputs.statusCode, 200);
    assert.equal(outputs.json().items[0].file_name, '结果.docx');
    assert.equal(outputs.json().items[0].download_url, '/v1/artifacts/artifact-output/download?version=1');
    assert.equal((await service.app.inject({ method: 'GET', url: `/v1/runs/${runId}/artifacts`,
      headers: { 'x-user-id': 'other' } })).statusCode, 404);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
