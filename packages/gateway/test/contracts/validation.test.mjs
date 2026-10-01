import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContractValidator } from '../../src/contracts/validator.ts';
import { buildServer } from '../../src/server.ts';

test('all declared JSON request and success response schemas compile', () => {
  const contracts = new ContractValidator();
  assert.equal(contracts.operationCount, 33);
  assert.deepEqual(contracts.compilationErrors, []);
});

test('request validation rejects missing required fields and unknown operations', () => {
  const contracts = new ContractValidator();
  assert.equal(contracts.validateRequest('createConversation', {
    title: 'Research', workspace_id: 'ws', model: { provider: 'zhipu', model: 'glm-5.3-flash' },
  }).valid, true);
  const invalid = contracts.validateRequest('createConversation', { title: 'missing workspace' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length > 0);
  assert.throws(() => contracts.validateRequest('notAnOperation', {}), /contract_operation_unknown/);
});

test('response validation applies the operation status schema', () => {
  const contracts = new ContractValidator();
  const valid = contracts.validateResponse('createConversation', 201, {
    conversation_id: 'conv-1', title: 'Research', workspace_id: 'ws',
    model: { provider: 'zhipu', model: 'glm-5.3-flash' },
    created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', version: 1,
    project_id: 'project-1', pinned: false, pinned_at: null, archived: false, archived_at: null,
  });
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  assert.equal(contracts.validateResponse('createConversation', 201, { conversation_id: 'conv-1' }).valid, false);
});

test('server rejects an invalid JSON request before business handlers run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-contract-server-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'] });
  try {
    const response = await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u' }, payload: { title: 'workspace and model are missing' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'CONTRACT_REQUEST_INVALID');
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('server blocks a handler response that violates its OpenAPI success schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-contract-response-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'] });
  service.conversations.create = () => ({ invalid: true });
  try {
    const response = await service.app.inject({ method: 'POST', url: '/v1/conversations',
      headers: { 'x-user-id': 'u' },
      payload: { workspace_id: 'ws', model: { provider: 'zhipu', model: 'glm-5.3-flash' } } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'CONTRACT_RESPONSE_INVALID');
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
