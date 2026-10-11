import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('project and conversation metadata routes persist drawer state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-project-routes-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'] });
  const headers = { 'x-user-id': 'owner-a' };
  try {
    const defaults = await service.app.inject({ method: 'GET', url: '/v1/projects', headers });
    assert.equal(defaults.statusCode, 200);
    assert.equal(defaults.json().items[0].title, 'jotV0');

    const createdProject = await service.app.inject({ method: 'POST', url: '/v1/projects', headers, payload: { title: 'Research' } });
    assert.equal(createdProject.statusCode, 201);
    const project = createdProject.json();

    const createdConversation = await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws-1', model: { provider: 'zhipu', model: 'glm' }, project_id: project.project_id } });
    assert.equal(createdConversation.statusCode, 201);
    const conversation = createdConversation.json();
    assert.equal(conversation.project_id, project.project_id);

    const pinned = await service.app.inject({ method: 'PATCH', url: `/v1/conversations/${conversation.conversation_id}`, headers,
      payload: { expected_version: conversation.version, pinned: true } });
    assert.equal(pinned.statusCode, 200);
    assert.equal(pinned.json().pinned, true);

    const active = await service.app.inject({ method: 'GET', url: `/v1/conversations?project_id=${project.project_id}&state=active`, headers });
    assert.equal(active.statusCode, 200);
    assert.deepEqual(active.json().items.map(item => item.conversation_id), [conversation.conversation_id]);

    const archived = await service.app.inject({ method: 'PATCH', url: `/v1/conversations/${conversation.conversation_id}`, headers,
      payload: { expected_version: pinned.json().version, archived: true } });
    assert.equal(archived.statusCode, 200);
    assert.equal((await service.app.inject({ method: 'GET', url: `/v1/conversations?project_id=${project.project_id}`, headers })).json().items.length, 0);
    assert.equal((await service.app.inject({ method: 'GET', url: `/v1/conversations?project_id=${project.project_id}&state=archived`, headers })).json().items.length, 1);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('project routes enforce owner isolation and optimistic locking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-project-route-owner-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'] });
  try {
    const created = (await service.app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'owner-a' }, payload: { title: 'A' } })).json();
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/v1/projects/${created.project_id}`, headers: { 'x-user-id': 'owner-b' },
      payload: { expected_version: 1, title: 'No' } })).statusCode, 404);
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/v1/projects/${created.project_id}`, headers: { 'x-user-id': 'owner-a' },
      payload: { expected_version: 1, title: 'B' } })).statusCode, 200);
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/v1/projects/${created.project_id}`, headers: { 'x-user-id': 'owner-a' },
      payload: { expected_version: 1, title: 'Stale' } })).statusCode, 409);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
