import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { McpExecutionJournal, listUnknownMcpOperations } from '../../src/workbench/mcp-execution.ts';
import { McpRegistryService } from '../../src/workbench/mcp-registry.ts';
import { registerWorkbenchMcpRoutes } from '../../src/workbench/mcp-routes.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';

const base = resolve('../../.test-tmp/workbench-mcp-operation-status');
mkdirSync(base, { recursive: true });

function fixture(t) {
  const dir = mkdtempSync(join(base, 'case-'));
  const db = openProductDatabase(join(dir, 'fixture.sqlite'));
  const workbench = new WorkbenchService(db, { workspaceIds: ['ws'], root: join(dir, 'shared') });
  const registry = new McpRegistryService(db, workbench);
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map(method => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
  const journal = new McpExecutionJournal(db, {
    authorizeTool() { return { public_name: 'search', input_schema: { type: 'object' } }; },
  }, { record() { return { kind: 'test', reference: 'receipt-secret-marker' }; } });
  registerWorkbenchMcpRoutes(app, registry, request => String(request.headers['x-user-id'] ?? ''), undefined,
    (owner, agentId) => listUnknownMcpOperations(db, owner, agentId));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, workbench, registry, journal, routes };
}

async function invoke(routes, method, path, { owner = 'owner-a', params = {}, query = {}, body = {} } = {}) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `missing route: ${method} ${path}`);
  let status = 200;
  const reply = { code(value) { status = value; return this; }, send(value) { return value; } };
  const result = await handler({ headers: { 'x-user-id': owner }, params, query, body }, reply);
  return { status, result };
}

function identity(owner, agent, run, session) {
  return { owner_id: owner, agent_id: agent, run_id: run, session_ref: session };
}

function call(callId) {
  return {
    connection_id: 'connection-1', generation: 1, tool_id: `mcp_${'a'.repeat(32)}`,
    call_id: callId, arguments: { token: 'argument-secret-marker' },
  };
}

test('unknown MCP status is owner and agent scoped and never returns invocation or result data', async t => {
  const { db, workbench, journal, routes } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const otherAgent = workbench.createAgent('owner-a', { name: 'Reviewer' });
  const unknownIdentity = identity('owner-a', agent.agent_id, 'run-unknown', 'session-unknown');
  const unknown = journal.begin(unknownIdentity, call('call-unknown'));
  journal.markUnknown(unknownIdentity, unknown.operation_id, 'provider_unavailable');

  const foreignIdentity = identity('owner-a', otherAgent.agent_id, 'run-foreign', 'session-foreign');
  const foreign = journal.begin(foreignIdentity, call('call-foreign'));
  journal.markUnknown(foreignIdentity, foreign.operation_id, 'provider_unavailable');

  const settledIdentity = identity('owner-a', agent.agent_id, 'run-settled', 'session-settled');
  const settled = journal.begin(settledIdentity, call('call-settled'));
  journal.settle(settledIdentity, settled.operation_id, { result: 'response-secret-marker' });

  db.prepare(`UPDATE wb_mcp_operations SET public_name=?,last_error_code=?,response_json=?,receipt_json=?
    WHERE operation_id=?`).run('name-secret-marker', 'error-secret-marker', 'response-secret-marker', 'receipt-secret-marker', unknown.operation_id);
  const updatedBefore = db.prepare('SELECT updated_at FROM wb_mcp_operations WHERE operation_id=?').get(unknown.operation_id).updated_at;

  const listed = await invoke(routes, 'GET', '/v1/agents/:agentId/mcp/operations', { params: { agentId: agent.agent_id } });
  assert.equal(listed.status, 200);
  assert.equal(listed.result.items.length, 1);
  assert.deepEqual(Object.keys(listed.result.items[0]).sort(), ['operation_id', 'state', 'updated_at']);
  assert.deepEqual(listed.result.items[0], {
    operation_id: unknown.operation_id,
    state: 'unknown',
    updated_at: updatedBefore,
  });
  const serialized = JSON.stringify(listed.result);
  for (const marker of ['argument-secret-marker', 'response-secret-marker', 'receipt-secret-marker', 'error-secret-marker', 'name-secret-marker', 'call-unknown']) {
    assert.equal(serialized.includes(marker), false, `status response exposed ${marker}`);
  }

  const otherAgentList = await invoke(routes, 'GET', '/v1/agents/:agentId/mcp/operations', { params: { agentId: otherAgent.agent_id } });
  assert.deepEqual(otherAgentList.result, { items: [{ operation_id: foreign.operation_id, state: 'unknown', updated_at: db.prepare('SELECT updated_at FROM wb_mcp_operations WHERE operation_id=?').get(foreign.operation_id).updated_at }] });
  await assert.rejects(invoke(routes, 'GET', '/v1/agents/:agentId/mcp/operations', {
    owner: 'owner-b', params: { agentId: agent.agent_id },
  }), /agent_not_found/);
  assert.equal(db.prepare('SELECT updated_at FROM wb_mcp_operations WHERE operation_id=?').get(unknown.operation_id).updated_at, updatedBefore);
  assert.equal(routes.has('POST /v1/agents/:agentId/mcp/operations/:operationId/retry'), false);
  assert.equal(routes.has('POST /v1/agents/:agentId/mcp/operations/:operationId/settle'), false);
  assert.equal(routes.has('POST /v1/agents/:agentId/mcp/operations/:operationId/dispatch'), false);
});

test('operation status route rejects query controls and only registers a GET projection', async t => {
  const { workbench, routes } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  await assert.rejects(invoke(routes, 'GET', '/v1/agents/:agentId/mcp/operations', {
    params: { agentId: agent.agent_id }, query: { retry: 'true' },
  }), /invalid_mcp_request/);
  assert.deepEqual([...routes.keys()].filter(route => route.endsWith('/mcp/operations')), ['GET /v1/agents/:agentId/mcp/operations']);
});
