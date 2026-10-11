import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

const headers = { 'x-user-id': 'title-user' };
const model = { provider: 'harness', model: 'automatic' };

async function createConversation(app, title) {
  const payload = { workspace_id: 'ws-1', model, ...(title === undefined ? {} : { title }) };
  return (await app.inject({ method: 'POST', url: '/v1/conversations', headers, payload })).json();
}

async function send(app, conversationId, clientMessageId, text) {
  return app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers,
    payload: { client_message_id: clientMessageId, content: [{ type: 'text', text }] } });
}

test('first textual message replaces only the default conversation title', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-auto-title-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'] });
  try {
    const automatic = await createConversation(service.app);
    assert.equal(automatic.title, 'New conversation');

    const first = await send(service.app, automatic.conversation_id, 'message-1',
      '  去 GitHub\n实时搜索近期最热门的 10 个 AI Agent 框架，并生成报告  ');
    assert.equal(first.statusCode, 202);
    const renamed = (await service.app.inject({ method: 'GET',
      url: `/v1/conversations/${automatic.conversation_id}`, headers })).json();
    assert.equal(renamed.title, '去 GitHub 实时搜索近期最热门的 10 个 AI…');
    assert.equal(renamed.version, 2);

    await send(service.app, automatic.conversation_id, 'message-2', '第二条消息不能再次改名');
    const unchanged = (await service.app.inject({ method: 'GET',
      url: `/v1/conversations/${automatic.conversation_id}`, headers })).json();
    assert.equal(unchanged.title, renamed.title);
    assert.equal(unchanged.version, 2);

    const manual = await createConversation(service.app, '人工命名');
    await send(service.app, manual.conversation_id, 'message-3', '这条消息不能覆盖人工名称');
    const manualAfter = (await service.app.inject({ method: 'GET',
      url: `/v1/conversations/${manual.conversation_id}`, headers })).json();
    assert.equal(manualAfter.title, '人工命名');
    assert.equal(manualAfter.version, 1);
  } finally {
    await service.app.close();
    service.db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
