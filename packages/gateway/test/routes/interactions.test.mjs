import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('question answers and approval decisions are typed, versioned, and durable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-interaction-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'] });
  const headers = { 'x-user-id': 'u', 'idempotency-key': 'i-1' };
  try {
    const conv = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws', model: { provider: 'p', model: 'm' } } })).json();
    const receipt = (await service.app.inject({ method: 'POST', url: `/v1/conversations/${conv.conversation_id}/messages`, headers,
      payload: { client_message_id: 'm', content: [{ type: 'text', text: 'task' }] } })).json();
    const now = new Date(); const expires = new Date(now.getTime() + 60_000).toISOString();
    const question = { interaction_id: 'int-q', run_id: receipt.run_id, tool_call_id: 'tool-1', version: 1,
      status: 'pending', created_at: now.toISOString(), expires_at: expires, kind: 'question',
      questions: [{ question_id: 'q-1', prompt: 'Choose', options: [{ option_id: 'a', label: 'A' }], multiple: false, allow_custom: false }] };
    const digest = `sha256:${'a'.repeat(64)}`;
    const approval = { interaction_id: 'int-a', run_id: receipt.run_id, tool_call_id: 'tool-2', version: 1,
      status: 'pending', created_at: now.toISOString(), expires_at: expires, kind: 'approval',
      action_digest: digest, action_summary: 'send', risk: 'medium' };
    const insert = service.db.prepare('INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    insert.run('int-q', conv.conversation_id, receipt.run_id, 'question', 'pending', 1, null, JSON.stringify(question), expires, now.toISOString());
    insert.run('int-a', conv.conversation_id, receipt.run_id, 'approval', 'pending', 1, digest, JSON.stringify(approval), expires, now.toISOString());

    const listed = await service.app.inject({ method: 'GET', url: `/v1/conversations/${conv.conversation_id}/interactions`, headers });
    assert.equal(listed.json().items.length, 2);
    const answered = await service.app.inject({ method: 'POST', url: '/v1/interactions/int-q/response', headers,
      payload: { expected_version: 1, answers: [{ question_id: 'q-1', selected_option_ids: ['a'] }] } });
    assert.equal(answered.statusCode, 202);
    assert.equal(answered.json().status, 'answered');
    assert.equal(service.db.prepare("SELECT COUNT(*) AS count FROM ga_run_commands WHERE kind='interaction_response'").get().count, 1);

    const decided = await service.app.inject({ method: 'POST', url: '/v1/interactions/int-a/decision', headers: { ...headers, 'idempotency-key': 'i-2' },
      payload: { expected_version: 1, action_digest: digest, decision: 'deny' } });
    assert.equal(decided.statusCode, 202);
    assert.equal(decided.json().status, 'denied');
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
