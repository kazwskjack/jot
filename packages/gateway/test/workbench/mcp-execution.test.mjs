import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildServer } from '../../src/server.ts';
import { executeMcpTool } from '../../../session-adapter/mcp-runtime.js';
import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { registerWorkbenchExecution } from '../../src/workbench/execution.ts';
import { McpExecutionJournal } from '../../src/workbench/mcp-execution.ts';
import { McpRegistryService } from '../../src/workbench/mcp-registry.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';

const callerBase = 'E:/codex/yunticket/.test-tmp/workbench-mcp-execution-caller';

test('the real Session MCP caller closes through Gateway prepare, dispatch, and settle routes using a synthetic tool result', async t => {
  mkdirSync(callerBase, { recursive: true });
  const directory = mkdtempSync(join(callerBase, 'case-'));
  const db = openProductDatabase(join(directory, 'fixture.sqlite'));
  const workbench = new WorkbenchService(db, { workspaceIds: ['ws'], root: join(directory, 'shared') });
  const tasks = new PersistentTaskService(db, workbench, { projectionRoot: join(directory, 'tasks') });
  const routes = new Map();
  const app = { post(path, handler) { routes.set(`POST ${path}`, handler); } };
  const token = 'synthetic-mcp-execution-token-01';
  const registry = new McpRegistryService(db, workbench);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  const agent = workbench.createAgent('owner-1', { name: 'Researcher' });
  const configured = registry.create('owner-1', agent.agent_id, {
    server_name: 'repo', transport: 'stdio', command: 'node', args: [], env_refs: {},
  });
  registry.setEnabled('owner-1', agent.agent_id, configured.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-1', agent.agent_id, configured.connection_id, 2);
  const discovered = registry.activateReload('owner-1', agent.agent_id, configured.connection_id, 1, [{
    name: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  }]);
  const approved = registry.setAllowedTools('owner-1', agent.agent_id, configured.connection_id, {
    expected_version: discovered.version, tool_ids: [discovered.tools[0].tool_id],
  });

  const runRepository = new RunRepository(db, new EventStore(db));
  const queued = runRepository.enqueue(agent.conversation_id, 'owner-1', {
    client_message_id: 'synthetic-mcp-input', content: [{ type: 'text', text: 'Synthetic MCP execution fixture' }],
  });
  workbench.bindRun('owner-1', agent.agent_id, queued.run_id, 'chat');
  const timestamp = new Date().toISOString();
  const sessionRef = 'synthetic-mcp-session';
  db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)')
    .run(agent.conversation_id, 'owner-1', sessionRef, timestamp, timestamp);
  const lease = { owner: 'synthetic-mcp-worker', generation: 1 };
  db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)')
    .run(queued.run_id, lease.owner, lease.generation, String(Date.now() + 60_000), timestamp);

  registerWorkbenchExecution(app, db, workbench, tasks, token, undefined, undefined, undefined, undefined, new Set(), registry);
  const identity = { run_id: queued.run_id, session_ref: sessionRef, execution_lease: lease };
  const tool = approved.tools[0];
  const callId = 'synthetic-mcp-call-1';
  const phases = [];
  let dispatches = 0;
  const request = async (action, payload) => {
    phases.push(action);
    const handler = routes.get(`POST /internal/v1/workbench/mcp-${action}`);
    assert.ok(handler, `missing Gateway MCP ${action} route`);
    return handler({ headers: { authorization: `Bearer ${token}` }, body: { ...identity, ...payload } });
  };
  const execute = () => executeMcpTool({
    exec: { name: tool.public_name, callId, arguments: { query: 'synthetic only' } },
    binding: { connection_id: configured.connection_id, generation: 1, tool_id: tool.tool_id },
    validateInput: (_name, value) => value,
    check: async () => {},
    request,
    next: async () => { dispatches += 1; return { content: [{ type: 'text', text: 'Synthetic MCP result' }] }; },
  });

  const first = JSON.parse(await execute());
  const second = JSON.parse(await execute());
  assert.deepEqual(first.result, { content: [{ type: 'text', text: 'Synthetic MCP result' }] });
  assert.deepEqual(second, first);
  assert.equal(first.execution_receipt.kind, 'tool_receipt');
  assert.equal(dispatches, 1, 'a settled call must never dispatch twice');
  assert.deepEqual(phases, ['prepare', 'settle', 'prepare']);
  const operation = db.prepare('SELECT state,public_name,call_id FROM wb_mcp_operations WHERE run_id=? AND call_id=?')
    .get(queued.run_id, callId);
  assert.deepEqual({ ...operation }, { state: 'settled', public_name: tool.public_name, call_id: callId });
});

test('a repeated dispatched call after uncertainty returns the original unknown operation without re-authorizing', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let authorizationCalls = 0;
  const registry = {
    authorizeTool() {
      authorizationCalls += 1;
      return { public_name: 'mcp__repo__search', input_schema: { type: 'object' } };
    },
  };
  const evidence = { record() { throw new Error('unexpected_settlement'); } };
  const journal = new McpExecutionJournal(db, registry, evidence);
  const identity = { owner_id: 'owner-1', agent_id: 'agent-1', run_id: 'run-1', session_ref: 'session-1' };
  const call = {
    connection_id: 'connection-1', generation: 1, tool_id: `mcp_${'a'.repeat(32)}`,
    call_id: 'call-1', arguments: { query: 'status' },
  };

  const first = journal.begin(identity, call);
  assert.equal(first.dispatch, true);
  assert.equal(first.state, 'dispatched');
  const ambiguous = journal.markUnknown(identity, first.operation_id, 'connection_lost');
  assert.equal(ambiguous.state, 'unknown');

  const recovered = journal.begin(identity, call);
  assert.equal(recovered.dispatch, false);
  assert.equal(recovered.state, 'unknown');
  assert.equal(recovered.operation_id, first.operation_id);
  assert.equal(authorizationCalls, 1);
});

test('a dispatched operation from a prior Gateway process is marked unknown when the journal starts', t => {
  const directory = mkdtempSync(join('E:/codex/yunticket/.test-tmp', 'mcp-execution-restart-'));
  let restartedDb;
  t.after(() => {
    restartedDb?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'journal.sqlite');
  const identity = { owner_id: 'owner-1', agent_id: 'agent-1', run_id: 'run-1', session_ref: 'session-1' };
  const call = {
    connection_id: 'connection-1', generation: 1, tool_id: `mcp_${'a'.repeat(32)}`,
    call_id: 'call-1', arguments: { query: 'status' },
  };
  let authorizationCalls = 0;
  const registry = {
    authorizeTool() {
      authorizationCalls += 1;
      return { public_name: 'mcp__repo__search', input_schema: { type: 'object' } };
    },
  };
  const evidence = { record() { throw new Error('unexpected_settlement'); } };
  const firstDb = new DatabaseSync(path);
  const firstJournal = new McpExecutionJournal(firstDb, registry, evidence);
  const first = firstJournal.begin(identity, call);
  firstDb.close();

  restartedDb = new DatabaseSync(path);
  const restartedJournal = new McpExecutionJournal(restartedDb, registry, evidence);
  const persisted = restartedDb.prepare('SELECT state FROM wb_mcp_operations WHERE operation_id=?').get(first.operation_id);
  assert.equal(persisted.state, 'unknown');

  const recovered = restartedJournal.begin(identity, call);
  assert.equal(recovered.dispatch, false);
  assert.equal(recovered.state, 'unknown');
  assert.equal(recovered.operation_id, first.operation_id);
  assert.equal(authorizationCalls, 1);
});

test('MCP internal routes bypass browser CSRF only when their service bearer is valid', async t => {
  mkdirSync(callerBase, { recursive: true });
  const directory = mkdtempSync(join(callerBase, 'csrf-routes-'));
  const owner = 'mcp-csrf-owner';
  const token = 'synthetic-mcp-csrf-internal-token';
  const csrf = 'synthetic-browser-csrf-token';
  const origin = 'https://fixture.invalid';
  const server = await buildServer({ databasePath: join(directory, 'gateway.sqlite'), workspaces: ['ws'],
    workbenchRoot: join(directory, 'workspace'), templateRoot: fileURLToPath(new URL('../../file-engine/templates/', import.meta.url)),
    csrfToken: csrf, allowedOrigins: [origin], internalChannelToken: token });
  t.after(async () => {
    await server.app.close();
    if (server.db.isOpen) server.db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const agent = server.workbench.createAgent(owner, { name: 'MCP CSRF fixture' });
  const registry = new McpRegistryService(server.db, server.workbench);
  const connection = registry.create(owner, agent.agent_id, {
    server_name: 'repo', transport: 'stdio', command: 'node', args: [], env_refs: {},
  });
  registry.setEnabled(owner, agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  const reload = registry.prepareReload(owner, agent.agent_id, connection.connection_id, 2);
  const discovered = registry.activateReload(owner, agent.agent_id, connection.connection_id, reload.generation, [{
    name: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  }]);
  const approved = registry.setAllowedTools(owner, agent.agent_id, connection.connection_id, {
    expected_version: discovered.version, tool_ids: [discovered.tools[0].tool_id],
  });
  const queued = server.runs.enqueue(agent.conversation_id, owner, {
    client_message_id: 'synthetic-mcp-csrf-run', content: [{ type: 'text', text: 'Synthetic MCP CSRF fixture' }],
  });
  server.workbench.bindRun(owner, agent.agent_id, queued.run_id, 'chat');
  server.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(queued.run_id);
  const timestamp = new Date().toISOString();
  const sessionRef = 'synthetic-mcp-csrf-session';
  server.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)')
    .run(agent.conversation_id, owner, sessionRef, timestamp, timestamp);
  const lease = { owner: 'synthetic-mcp-csrf-worker', generation: 1 };
  server.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)')
    .run(queued.run_id, lease.owner, lease.generation, String(Date.now() + 60_000), timestamp);
  const identity = { run_id: queued.run_id, session_ref: sessionRef, execution_lease: lease };
  const headers = { authorization: `Bearer ${token}`, 'x-user-id': owner, origin };
  const currentConnection = registry.runtimeConnections(owner, agent.agent_id)[0];
  const binding = server.db.prepare('SELECT epoch AS capability_epoch FROM wb_run_bindings WHERE run_id=? AND owner_id=?')
    .get(queued.run_id, owner);
  const current = await server.app.inject({ method: 'POST', url: '/internal/v1/workbench/mcp-current', headers,
    payload: { owner_id: owner, agent_id: agent.agent_id, connection_id: connection.connection_id,
      version: approved.version, config_version: approved.version, generation: approved.active_generation,
      config: currentConnection.config, run_id: queued.run_id, session_ref: sessionRef,
      capability_epoch: Number(binding.capability_epoch) } });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().state, 'active');

  const tool = approved.tools[0];
  const prepare = await server.app.inject({ method: 'POST', url: '/internal/v1/workbench/mcp-prepare', headers,
    payload: { ...identity, connection_id: connection.connection_id, generation: approved.active_generation,
      tool_id: tool.tool_id, call_id: 'synthetic-mcp-csrf-call', arguments: { query: 'status' } } });
  assert.equal(prepare.statusCode, 200, prepare.body);
  assert.equal(prepare.json().dispatch, true);
  assert.equal(prepare.json().state, 'dispatched');

  const settle = await server.app.inject({ method: 'POST', url: '/internal/v1/workbench/mcp-settle', headers,
    payload: { ...identity, operation_id: prepare.json().operation_id, state: 'settled',
      result: { content: [{ type: 'text', text: 'Synthetic MCP result' }] } } });
  assert.equal(settle.statusCode, 200, settle.body);
  assert.equal(settle.json().state, 'settled');

  for (const url of ['/internal/v1/workbench/mcp-current', '/internal/v1/workbench/mcp-prepare', '/internal/v1/workbench/mcp-settle']) {
    const denied = await server.app.inject({ method: 'POST', url,
      headers: { authorization: 'Bearer invalid-mcp-csrf-token', 'x-user-id': owner, origin,
        'x-csrf-token': csrf }, payload: {} });
    assert.equal(denied.statusCode, 401, `${url} must still reject an invalid service bearer`);
    assert.equal(denied.json().error?.code, 'UNAUTHORIZED');
  }
});
