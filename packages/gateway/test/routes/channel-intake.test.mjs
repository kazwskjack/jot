import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('internal channel intake creates one durable conversation and idempotent runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-channel-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['jot'],
    internalChannelToken: 'test-intake-123456' });
  const headers = { authorization: 'Bearer test-intake-123456' };
  const payload = { channel: 'wecom', principal: 'cj', message_id: 'wx-1', text: '去 Wikipedia 读取正文' };
  try {
    assert.equal((await service.app.inject({ method: 'POST', url: '/internal/v1/channel/messages', payload })).statusCode, 401);
    const first = await service.app.inject({ method: 'POST', url: '/internal/v1/channel/messages', headers, payload });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().accepted, true);
    const replay = await service.app.inject({ method: 'POST', url: '/internal/v1/channel/messages', headers, payload });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().run_id, first.json().run_id);
    const second = await service.app.inject({ method: 'POST', url: '/internal/v1/channel/messages', headers,
      payload: { ...payload, message_id: 'wx-2', text: '继续' } });
    assert.equal(second.json().conversation_id, first.json().conversation_id);
    const rows = service.db.prepare('SELECT COUNT(*) AS n FROM ga_conversations').get();
    assert.equal(Number(rows.n), 1);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
