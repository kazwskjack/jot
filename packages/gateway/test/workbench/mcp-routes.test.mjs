import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { buildServer } from '../../src/server.ts';
import { McpRegistryService } from '../../src/workbench/mcp-registry.ts';
import { registerWorkbenchMcpRoutes } from '../../src/workbench/mcp-routes.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';

const base = resolve(fileURLToPath(new URL('../../../../.test-tmp/workbench-mcp-routes/', import.meta.url)));
mkdirSync(base, { recursive: true });

function fixture(t, registryOptions = {}) {
  const dir = mkdtempSync(join(base, 'case-'));
  const db = openProductDatabase(join(dir, 'fixture.sqlite'));
  const workbench = new WorkbenchService(db, { workspaceIds: ['ws'], root: join(dir, 'shared') });
  const registry = new McpRegistryService(db, workbench, registryOptions);
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map(method => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
  registerWorkbenchMcpRoutes(app, registry, request => String(request.headers['x-user-id'] ?? ''));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { registry, workbench, routes };
}

async function invoke(routes, method, path, { owner = 'owner-a', params = {}, query = {}, body = {} } = {}) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `missing route: ${method} ${path}`);
  let status = 200;
  const reply = { code(value) { status = value; return this; }, send(value) { return value; } };
  const result = await handler({ headers: { 'x-user-id': owner }, params, query, body }, reply);
  return { status, result };
}

test('owner routes configure and list MCP connections without returning command or credential references', async t => {
  const { workbench, routes } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const created = await invoke(routes, 'POST', '/v1/agents/:agentId/mcp/connections', {
    params: { agentId: agent.agent_id },
    body: { server_name: 'repo', transport: 'stdio', command: 'node', args: ['mcp.js'], env_refs: { TOKEN: 'secret://owner-a/repo-token' } },
  });
  assert.equal(created.status, 201);
  const listed = await invoke(routes, 'GET', '/v1/agents/:agentId/mcp', { params: { agentId: agent.agent_id } });
  assert.equal(listed.result.items[0].state, 'configured');
  assert.equal(JSON.stringify(listed.result).includes('mcp.js'), false);
  assert.equal(JSON.stringify(listed.result).includes('secret://'), false);
});


test('connection management is owner isolated and rejects unrecognized fields instead of accepting credential values', async t => {
  const { workbench, routes } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  await assert.rejects(invoke(routes, 'POST', '/v1/agents/:agentId/mcp/connections', {
    params: { agentId: agent.agent_id }, owner: 'owner-b',
    body: { server_name: 'repo', transport: 'stdio', command: 'node', args: [], env_refs: {} },
  }), /agent_not_found/);
  await assert.rejects(invoke(routes, 'POST', '/v1/agents/:agentId/mcp/connections', {
    params: { agentId: agent.agent_id },
    body: { server_name: 'repo', transport: 'stdio', command: 'node', args: [], env: { TOKEN: 'plaintext' } },
  }), /invalid_mcp_connection/);
  await assert.rejects(invoke(routes, 'GET', '/v1/agents/:agentId/mcp', {
    params: { agentId: agent.agent_id }, query: { include_secrets: 'true' },
  }), /invalid_mcp_request/);
});

test('all six owner mutation routes preserve version and approval boundaries with a synthetic reload result', async t => {
  const { workbench, routes } = fixture(t, {
    onReloadRequested: () => [{ name: 'search', description: 'Search documents', input_schema: { type: 'object', properties: {} } }],
  });
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const created = await invoke(routes, 'POST', '/v1/agents/:agentId/mcp/connections', {
    params: { agentId: agent.agent_id },
    body: { server_name: 'repo', transport: 'stdio', command: 'node', args: [], env_refs: {} },
  });
  assert.equal(created.status, 201);

  const enabled = await invoke(routes, 'PATCH', '/v1/agents/:agentId/mcp/connections/:connectionId/enabled', {
    params: { agentId: agent.agent_id, connectionId: created.result.connection_id },
    body: { expected_version: 1, enabled: true },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.result.version, 2);
  assert.equal(enabled.result.enabled, true);

  const reloaded = await invoke(routes, 'POST', '/v1/agents/:agentId/mcp/connections/:connectionId/reload', {
    params: { agentId: agent.agent_id, connectionId: created.result.connection_id },
    body: { expected_version: 2 },
  });
  assert.equal(reloaded.status, 202);
  assert.equal(reloaded.result.state, 'ready');
  assert.equal(reloaded.result.tools.length, 1);
  assert.equal(reloaded.result.tools[0].approved, false);

  const granted = await invoke(routes, 'PUT', '/v1/agents/:agentId/mcp/connections/:connectionId/tools', {
    params: { agentId: agent.agent_id, connectionId: created.result.connection_id },
    body: { expected_version: 2, tool_ids: [reloaded.result.tools[0].tool_id] },
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.result.version, 3);
  assert.equal(granted.result.tools[0].approved, true);

  const staged = await invoke(routes, 'PATCH', '/v1/agents/:agentId/mcp/connections/:connectionId/config', {
    params: { agentId: agent.agent_id, connectionId: created.result.connection_id },
    body: { expected_version: 3, config: { server_name: 'repo', transport: 'stdio', command: 'node', args: ['new.mjs'], env_refs: {} } },
  });
  assert.equal(staged.status, 200);
  assert.equal(staged.result.version, 3);
  assert.equal(staged.result.state, 'reloading');

  const removed = await invoke(routes, 'DELETE', '/v1/agents/:agentId/mcp/connections/:connectionId', {
    params: { agentId: agent.agent_id, connectionId: created.result.connection_id },
    body: { expected_version: 3 },
  });
  assert.equal(removed.status, 202);
  assert.equal(removed.result.state, 'removed');
  assert.equal(removed.result.credentials_configured, false);
});

test('the Gateway mounts owner-scoped MCP routes with versioned configuration and redacted credentials', async t => {
  const root = mkdtempSync(join(base, 'gateway-'));
  const csrf = 'mcp-gateway-test-csrf-token';
  const origin = 'https://mcp-gateway-fixture.jot.example';
  const secretRef = 'secret://alice/local-token';
  const service = await buildServer({
    databasePath: ':memory:', workspaces: ['ws'], workbenchRoot: join(root, 'workspaces'),
    templateRoot: resolve(fileURLToPath(new URL('../../../../packages/gateway/file-engine/templates/', import.meta.url))),
    csrfToken: csrf, allowedOrigins: [origin], internalChannelToken: 'mcp-gateway-internal-token',
  });
  t.after(async () => {
    await service.app.close();
    service.db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const request = (method, url, payload, owner = 'alice') => service.app.inject({
    method, url, ...(payload === undefined ? {} : { payload }),
    headers: { 'x-user-id': owner, origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
  });
  const createdAgent = await request('POST', '/v1/agents', {
    name: 'MCP fixture', instructions: 'Use only approved tools', workspace_id: 'ws',
  });
  assert.equal(createdAgent.statusCode, 201, createdAgent.body);
  const agentId = createdAgent.json().agent_id;

  const created = await request('POST', `/v1/agents/${agentId}/mcp/connections`, {
    server_name: 'fixture', transport: 'stdio', command: 'node', args: ['fixture.mjs'], env_refs: { TOKEN: secretRef },
  });
  assert.equal(created.statusCode, 201, created.body);
  const connection = created.json();
  assert.equal(connection.enabled, false);
  assert.equal(JSON.stringify(connection).includes(secretRef), false);

  const listed = await request('GET', `/v1/agents/${agentId}/mcp`);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().items[0].version, connection.version);
  assert.equal(JSON.stringify(listed.json()).includes(secretRef), false);
  assert.equal((await request('GET', `/v1/agents/${agentId}/mcp`, undefined, 'bob')).statusCode, 404);

  const enabled = await request('PATCH', `/v1/agents/${agentId}/mcp/connections/${connection.connection_id}/enabled`, {
    expected_version: connection.version, enabled: true,
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().version, connection.version + 1);

  const unavailableGrant = await request('PUT', `/v1/agents/${agentId}/mcp/connections/${connection.connection_id}/tools`, {
    expected_version: enabled.json().version, tool_ids: [],
  });
  assert.equal(unavailableGrant.statusCode, 409, unavailableGrant.body);

  const unavailableReload = await request('POST', `/v1/agents/${agentId}/mcp/connections/${connection.connection_id}/reload`, {
    expected_version: enabled.json().version,
  });
  assert.equal(unavailableReload.statusCode, 503, unavailableReload.body);

  const rejectedConfig = await request('PATCH', `/v1/agents/${agentId}/mcp/connections/${connection.connection_id}/config`, {
    expected_version: enabled.json().version,
    config: { server_name: 'fixture', transport: 'stdio', command: 'node', args: [], env_refs: { TOKEN: 'secret://bob/other-owner' } },
  });
  assert.equal(rejectedConfig.statusCode, 422, rejectedConfig.body);
  assert.equal(rejectedConfig.body.includes('secret://bob/other-owner'), false);

  const staged = await request('PATCH', `/v1/agents/${agentId}/mcp/connections/${connection.connection_id}/config`, {
    expected_version: enabled.json().version,
    config: { server_name: 'fixture', transport: 'stdio', command: 'node', args: ['replacement.mjs'], env_refs: { TOKEN: secretRef } },
  });
  assert.equal(staged.statusCode, 200, staged.body);
  assert.equal(staged.json().version, enabled.json().version);
  assert.equal(staged.json().state, 'reloading');
  assert.equal(JSON.stringify(staged.json()).includes(secretRef), false);

  const removed = await request('DELETE', `/v1/agents/${agentId}/mcp/connections/${connection.connection_id}`, {
    expected_version: enabled.json().version,
  });
  assert.equal(removed.statusCode, 202, removed.body);
  assert.equal(removed.json().state, 'removed');
  assert.equal(JSON.stringify(removed.json()).includes(secretRef), false);
  assert.deepEqual((await request('GET', `/v1/agents/${agentId}/mcp`)).json().items, []);
});
