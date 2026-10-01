import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('write routes require ASCII actor, allowed Origin, CSRF token, and idempotency key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-security-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'],
    csrfToken: '0123456789abcdef', allowedOrigins: ['https://jot.example'] });
  const payload = { workspace_id: 'ws', model: { provider: 'p', model: 'm' } };
  try {
    assert.equal((await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u', origin: 'https://evil.example', 'x-csrf-token': '0123456789abcdef', 'idempotency-key': '12345678' }, payload })).statusCode, 403);
    assert.equal((await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u', origin: 'https://jot.example', 'x-csrf-token': 'wrongwrongwrongwr', 'idempotency-key': '12345678' }, payload })).statusCode, 403);
    assert.equal((await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u', origin: 'https://jot.example', 'x-csrf-token': '0123456789abcdef', 'idempotency-key': 'short' }, payload })).statusCode, 400);
    const ok = await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u', origin: 'https://jot.example', 'x-csrf-token': '0123456789abcdef', 'idempotency-key': '12345678' }, payload });
    assert.equal(ok.statusCode, 201);
    assert.doesNotMatch(ok.body, /E:\\|\/var\/lib/);
    const replay = await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u', origin: 'https://jot.example', 'x-csrf-token': '0123456789abcdef', 'idempotency-key': '12345678' }, payload });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.body, ok.body);
    const conflict = await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u', origin: 'https://jot.example', 'x-csrf-token': '0123456789abcdef', 'idempotency-key': '12345678' },
      payload: { ...payload, title: 'different request' } });
    assert.equal(conflict.statusCode, 409);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
