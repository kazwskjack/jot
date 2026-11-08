import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createMcpAgentRuntimeProvider } from '../mcp-agent-provider.js';
import { WorkbenchBridge } from '../workbench.js';
import { openProductDatabase } from '../../gateway/src/db/database.ts';
import { EventStore } from '../../gateway/src/events/event-store.ts';
import { PersistentTaskService } from '../../gateway/src/persistent-tasks/service.ts';
import { RunRepository } from '../../gateway/src/runs/repository.ts';
import { registerWorkbenchExecution } from '../../gateway/src/workbench/execution.ts';
import { listUnknownMcpOperations } from '../../gateway/src/workbench/mcp-execution.ts';
import { McpRegistryService } from '../../gateway/src/workbench/mcp-registry.ts';
import { registerWorkbenchMcpRoutes } from '../../gateway/src/workbench/mcp-routes.ts';
import { WorkbenchService } from '../../gateway/src/workbench/service.ts';

// Production bridge/provider code with an inert synthetic AgentSetup/Fiber and
// MCP plugin; this fixture never imports the DSH SDK or starts a server.
const binding = Object.freeze({ runId: 'mcp-run-1', sessionRef: 'mcp-session-1',
  executionLease: Object.freeze({ owner: 'mcp-hook-fixture', generation: 1 }) });
const toolId = `mcp_${'a'.repeat(32)}`;
const toolName = 'jot_mcp_repo_search_0123456789';
const baseSchema = { type: 'object', properties: { query: { type: 'string', minLength: 3 } }, required: ['query'], additionalProperties: false };
const connection = (approved = true, input_schema = baseSchema) => ({
  connection_id: 'mcp-connection-1', server_name: 'repo', transport: 'stdio', version: 2, generation: 3,
  config: { server_name: 'repo', transport: 'stdio', command: 'synthetic-mcp-plugin', args: [], env_refs: {} },
  tools: [{ tool_id: toolId, public_name: toolName, raw_name: 'search', description: 'Synthetic repository search.',
    input_schema, approved }],
});

function nativeAgent(agentBinding = binding) {
  const definitions = new Map(), guards = new Set(), hooks = new Map(), lifecycle = [];
  const sections = new Map(), presentations = new Set(), pluginMounts = [];
  const agent = { id: agentBinding.sessionRef, session: { id: agentBinding.sessionRef }, status: 'idle' };
  const ctx = {
    tools: {
      presentAs(mode) { presentations.add(mode); return () => presentations.delete(mode); },
      get(name, target) { assert.equal(target, agent); return definitions.get(name); },
      schemas(target) {
        assert.equal(target, agent);
        return [...definitions.values()].map(value => ({ name: value.name, description: value.description, parameters: value.parameters }));
      },
      register(definition) {
        if (definitions.has(definition.name)) throw new Error('tool_duplicate');
        definitions.set(definition.name, definition);
        return () => { if (definitions.get(definition.name) === definition) definitions.delete(definition.name); };
      },
      guard(callback) { guards.add(callback); return () => guards.delete(callback); },
    },
    systemPrompt: { section(section) { sections.set(section.name, section); return () => sections.delete(section.name); } },
    on(event, callback) {
      let callbacks = hooks.get(event);
      if (!callbacks) hooks.set(event, callbacks = new Set());
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    effect(register) { lifecycle.push(register()); return () => {}; },
    plugin(plugin, config) {
      const removers = [];
      const pluginTools = Object.create(ctx.tools);
      pluginTools.register = definition => {
        const remove = ctx.tools.register(definition);
        removers.push(remove);
        return remove;
      };
      const fiber = Promise.resolve().then(async () => {
        pluginMounts.push(plugin.name);
        await plugin.apply({ tools: pluginTools }, config);
      });
      fiber.dispose = async () => { await fiber.catch(() => {}); for (const remove of removers.reverse()) remove(); };
      return fiber;
    },
  };
  agent.ctx = ctx;
  return {
    agent, ctx, definitions, guards, hooks, lifecycle, pluginMounts,
    async execute(name, args = {}, callId = 'mcp-call-1', native = async () => 'native-result') {
      const exec = { name, callId, arguments: args, signal: new AbortController().signal };
      for (const guard of guards) { const reason = guard(exec); if (reason) throw new Error(reason); }
      const handlers = [...(hooks.get('tools/execute') ?? [])];
      const dispatch = index => index === handlers.length
        ? definitions.has(name) ? definitions.get(name).execute(args, exec) : native()
        : handlers[index](exec, () => dispatch(index + 1));
      return dispatch(0);
    },
  };
}

function harness({ approved = true, denyPrepare = false, pluginFailure = false, inputSchema = baseSchema } = {}) {
  const host = nativeAgent();
  const trusted = {
    run_id: binding.runId, owner_id: 'owner-a', agent_id: 'agent-a', workspace_id: 'workspace-a', project_id: 'project-a',
    capability_epoch: 1, name: 'Researcher', instructions: 'Review source data.', allowed_tools: [toolName, 'universe_search'],
    memories: [], mcp_connections: [connection(approved, inputSchema)],
  };
  const requests = [], nativeCalls = [], stdioAuthorizations = [];
  const mcpPlugin = { name: 'mcp-client', async apply(pluginCtx, config) {
    if (pluginFailure) throw new Error('synthetic plugin startup failure');
    assert.equal(config.serverName, 'repo');
    pluginCtx.tools.register({
      name: 'mcp__repo__search', description: 'Synthetic repository search.',
      parameters: connection().tools[0].input_schema,
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        nativeCalls.push({ args, name: exec.name });
        return { content: [{ type: 'text', text: `synthetic result for ${args.query}` }] };
      },
    });
    pluginCtx.tools.register({ name: 'mcp__repo__unapproved', description: 'Unapproved tool.',
      parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [] },
      async execute() { nativeCalls.push({name: 'mcp__repo__unapproved'}); return {ok: true}; } });
  } };
  const provider = createMcpAgentRuntimeProvider({ mcpPlugin, authorizeStdio: async value => {
    stdioAuthorizations.push(value);
    return true;
  } });
  provider.setup(host.ctx, host.agent);
  const bridge = new WorkbenchBridge({ origin: 'http://127.0.0.1:7654', token: 'synthetic-mcp-hook-token',
    mcpRuntimeProvider: provider, fetchImpl: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      requests.push({ path, body });
      if (path.endsWith('/guard')) return Response.json({ context: trusted });
      if (path.endsWith('/mcp-prepare')) {
        if (denyPrepare) return Response.json({ error: { code: 'MCP_TOOL_FORBIDDEN' } }, { status: 403 });
        return Response.json({ dispatch: true, state: 'dispatched', operation_id: 'mcp-operation-1' });
      }
      if (path.endsWith('/mcp-settle')) return Response.json({ state: 'settled',
        execution_receipt: { kind: 'tool_receipt', reference: 'mcp-receipt-1', hash: 'b'.repeat(64) } });
      throw new Error(`unexpected request ${path}`);
    } });
  return { host, provider, bridge, requests, nativeCalls, stdioAuthorizations, trusted };
}

function disposeAfter(testContext, h) {
  testContext.after(async () => {
    for (const dispose of h.host.lifecycle.splice(0).reverse()) await dispose();
    await h.provider.close();
  });
}

function gatewayFixture(testContext) {
  const root = 'E:/codex/yunticket/.test-tmp/workbench-mcp-hook-chain-gateway';
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'case-'));
  const db = openProductDatabase(join(directory, 'fixture.sqlite'));
  const workbench = new WorkbenchService(db, { workspaceIds: ['ws'], root: join(directory, 'shared') });
  const tasks = new PersistentTaskService(db, workbench, { projectionRoot: join(directory, 'tasks') });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map(method => [method,
    (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
  const token = 'synthetic-real-gateway-mcp-token';
  const registry = new McpRegistryService(db, workbench);
  const agent = workbench.createAgent('owner-real', { name: 'Researcher' });
  const configured = registry.create('owner-real', agent.agent_id, {
    server_name: 'repo', transport: 'stdio', command: 'synthetic-mcp-plugin', args: [], env_refs: {},
  });
  registry.setEnabled('owner-real', agent.agent_id, configured.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-real', agent.agent_id, configured.connection_id, 2);
  const discovered = registry.activateReload('owner-real', agent.agent_id, configured.connection_id, 1, [{
    name: 'search', description: 'Synthetic repository search.', input_schema: baseSchema,
  }]);
  const approved = registry.setAllowedTools('owner-real', agent.agent_id, configured.connection_id, {
    expected_version: discovered.version, tool_ids: [discovered.tools[0].tool_id],
  });
  const runRepository = new RunRepository(db, new EventStore(db));
  const queued = runRepository.enqueue(agent.conversation_id, 'owner-real', {
    client_message_id: 'synthetic-mcp-hook-input', content: [{ type: 'text', text: 'Synthetic MCP hook fixture' }],
  });
  workbench.bindRun('owner-real', agent.agent_id, queued.run_id, 'chat');
  const sessionRef = 'mcp-real-gateway-session';
  const timestamp = new Date().toISOString();
  db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)')
    .run(agent.conversation_id, 'owner-real', sessionRef, timestamp, timestamp);
  const executionLease = { owner: 'synthetic-mcp-worker', generation: 1 };
  db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)')
    .run(queued.run_id, executionLease.owner, executionLease.generation, String(Date.now() + 60_000), timestamp);
  registerWorkbenchExecution(app, db, workbench, tasks, token, undefined, undefined, undefined, undefined,
    new Set(['https://chat.example']), registry);
  registerWorkbenchMcpRoutes(app, registry, request => String(request.headers['x-user-id'] ?? ''), undefined,
    (ownerId, agentId) => listUnknownMcpOperations(db, ownerId, agentId));
  testContext.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    db, routes, token, registry, agent,
    binding: { runId: queued.run_id, sessionRef, executionLease },
    identity: { run_id: queued.run_id, session_ref: sessionRef, execution_lease: executionLease },
    connection: registry.runtimeConnections('owner-real', agent.agent_id)[0],
    tool: approved.tools[0], ownerId: 'owner-real', agentId: agent.agent_id,
  };
}

test('the production provider and Workbench tools/execute hook route an approved plugin tool through Gateway receipt', async testContext => {
  const h = harness();
  disposeAfter(testContext, h);
  await h.bridge.attach(h.host.agent, binding);

  assert.deepEqual(h.host.pluginMounts, ['mcp-client']);
  assert.equal(h.host.hooks.get('tools/execute')?.size, 1);
  assert.equal(h.host.definitions.has('mcp__repo__search'), true);
  assert.equal(h.host.definitions.has(toolName), true);
  assert.equal(h.stdioAuthorizations.length, 1);

  const output = await h.host.execute(toolName, { query: 'private repositories' }, 'mcp-call-7');
  assert.deepEqual(output, {
    isError: false,
    value: { content: [{ type: 'text', text: 'synthetic result for private repositories' }],
      execution_receipt: { kind: 'tool_receipt', reference: 'mcp-receipt-1', hash: 'b'.repeat(64) } },
  });
  assert.equal(h.nativeCalls.length, 1);
  assert.deepEqual(h.nativeCalls[0], { args: { query: 'private repositories' }, name: toolName });
  const prepare = h.requests.find(request => request.path.endsWith('/mcp-prepare'));
  const settle = h.requests.find(request => request.path.endsWith('/mcp-settle'));
  assert.equal(prepare.body.run_id, binding.runId);
  assert.equal(prepare.body.session_ref, binding.sessionRef);
  assert.equal(prepare.body.call_id, 'mcp-call-7');
  assert.equal(prepare.body.connection_id, 'mcp-connection-1');
  assert.equal(prepare.body.generation, 3);
  assert.equal(settle.body.operation_id, 'mcp-operation-1');

  await assert.rejects(h.host.execute('mcp__repo__search', { query: 'raw dispatch' }), /MCP_RAW_TOOL_FORBIDDEN/);
  assert.equal(h.nativeCalls.length, 1);
});

test('the real Adapter hook uses authenticated Gateway journal routes and never redispatches an unknown call', async testContext => {
  const gateway = gatewayFixture(testContext);
  const host = nativeAgent(gateway.binding);
  const nativeCalls = [];
  const provider = createMcpAgentRuntimeProvider({ mcpPlugin: { name: 'mcp-client', async apply(pluginCtx, config) {
    assert.equal(config.serverName, 'repo');
    pluginCtx.tools.register({ name: 'mcp__repo__search', description: 'Synthetic repository search.',
      parameters: gateway.connection.tools[0].input_schema,
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) {
        nativeCalls.push(args);
        return { content: [{ type: 'text', text: `synthetic result for ${args.query}` }] };
      },
    });
  } }, authorizeStdio: async () => true });
  provider.setup(host.ctx, host.agent);
  let loseSettledResponse = true;
  const bridge = new WorkbenchBridge({ origin: 'http://127.0.0.1:7654', token: gateway.token,
    mcpRuntimeProvider: provider, fetchImpl: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      if (path.endsWith('/mcp-settle') && body.state === 'settled' && loseSettledResponse) {
        loseSettledResponse = false;
        throw new TypeError('synthetic response loss after provider dispatch');
      }
      const handler = gateway.routes.get(`POST ${path}`);
      assert.ok(handler, `missing real Gateway route ${path}`);
      try {
        return Response.json(await handler({ headers: { authorization: init.headers.authorization }, body, params: {}, query: {} }));
      } catch (error) {
        return Response.json({ error: { code: String(error?.message ?? 'unknown').toUpperCase() } }, { status: 409 });
      }
    } });
  testContext.after(async () => {
    for (const dispose of host.lifecycle.splice(0).reverse()) await dispose();
    await provider.close();
  });
  const realContext = await gateway.routes.get('POST /internal/v1/workbench/guard')({
    headers: { authorization: `Bearer ${gateway.token}` }, body: gateway.identity,
  });
  assert.equal(realContext.context.mcp_connections?.[0]?.tools?.[0]?.public_name, gateway.tool.public_name,
    JSON.stringify(realContext.context.mcp_connections));
  await bridge.attach(host.agent, gateway.binding);
  assert.deepEqual(host.pluginMounts, ['mcp-client'], JSON.stringify({
    context: realContext.context.mcp_connections, allowed: realContext.context.allowed_tools, definitions: [...host.definitions.keys()],
  }));
  assert.equal(host.definitions.has(gateway.tool.public_name), true, 'the real Gateway catalog should mount the approved public MCP tool');
  assert.equal([...host.guards][0]({ name: gateway.tool.public_name }), undefined, 'the real Gateway tool grant should reach the Adapter guard');
  const callId = 'mcp-hook-unknown-call';
  const invoke = () => host.execute(gateway.tool.public_name, { query: 'synthetic only' }, callId);

  await assert.rejects(invoke(), /mcp_operation_unknown/);
  await assert.rejects(invoke(), /mcp_operation_unknown/);

  assert.equal(nativeCalls.length, 1, 'the original unknown result must never trigger a second provider dispatch');
  const operation = gateway.db.prepare('SELECT state,owner_id,agent_id,run_id,session_ref,call_id FROM wb_mcp_operations WHERE run_id=? AND call_id=?')
    .get(gateway.binding.runId, callId);
  assert.deepEqual({ state: operation.state, owner_id: operation.owner_id, agent_id: operation.agent_id,
    run_id: operation.run_id, session_ref: operation.session_ref, call_id: operation.call_id }, {
    state: 'unknown', owner_id: gateway.ownerId, agent_id: gateway.agentId, run_id: gateway.binding.runId,
    session_ref: gateway.binding.sessionRef, call_id: callId,
  });
  const statusHandler = gateway.routes.get('GET /v1/agents/:agentId/mcp/operations');
  const status = await statusHandler({ headers: { 'x-user-id': gateway.ownerId }, params: { agentId: gateway.agentId }, query: {} });
  assert.deepEqual(Object.keys(status.items[0]).sort(), ['operation_id', 'state', 'updated_at']);
  assert.equal(status.items[0].state, 'unknown');
});

test('an unapproved Gateway catalog entry is isolated before plugin mount while non-MCP tools remain available', async testContext => {
  const h = harness({ approved: false });
  disposeAfter(testContext, h);
  await h.bridge.attach(h.host.agent, binding);
  assert.deepEqual(h.host.pluginMounts, []);
  assert.equal(h.host.hooks.get('tools/execute')?.size, 1);
  assert.equal(h.host.definitions.has(toolName), false);
  assert.equal(h.host.definitions.has('jot_workspace'), true);
  assert.equal(await h.host.execute('universe_search', {}), 'native-result');
  assert.equal(h.nativeCalls.length, 0);
  assert.equal(h.requests.some(request => request.path.endsWith('/mcp-prepare')), false);
});

test('Gateway authorization denial at MCP prepare blocks the mounted plugin side effect', async testContext => {
  const h = harness({ denyPrepare: true });
  disposeAfter(testContext, h);
  await h.bridge.attach(h.host.agent, binding);
  await assert.rejects(h.host.execute(toolName, { query: 'must not run' }), /workbench_run_forbidden/);
  assert.equal(h.nativeCalls.length, 0);
  assert.equal(h.requests.filter(request => request.path.endsWith('/mcp-prepare')).length, 1);
  assert.equal(h.requests.some(request => request.path.endsWith('/mcp-settle')), false);
});

test('plugin startup failure leaves the Workbench session and non-MCP tools available', async testContext => {
  const h = harness({ pluginFailure: true });
  disposeAfter(testContext, h);
  await h.bridge.attach(h.host.agent, binding);

  assert.deepEqual(h.host.pluginMounts, ['mcp-client']);
  assert.equal(h.host.definitions.has(toolName), false);
  assert.equal(h.host.definitions.has('jot_workspace'), true);
  assert.equal(await h.host.execute('universe_search', {}), 'native-result');
  assert.equal(h.requests.some(request => request.path.endsWith('/mcp-prepare')), false);
});

test('unsupported untrusted MCP schema disables that catalog without failing the Workbench session', async testContext => {
  const h = harness({ inputSchema: { type: 'object', properties: { query: { type: 'string', pattern: '^safe$' } }, required: ['query'] } });
  disposeAfter(testContext, h);
  await h.bridge.attach(h.host.agent, binding);

  assert.deepEqual(h.host.pluginMounts, []);
  assert.equal(h.host.definitions.has(toolName), false);
  assert.equal(h.host.definitions.has('jot_workspace'), true);
  assert.equal(await h.host.execute('universe_search', {}), 'native-result');
  assert.equal(h.requests.some(request => request.path.endsWith('/mcp-prepare')), false);
});

test('later tools/execute hooks cannot mutate approved arguments before the MCP side effect', async testContext => {
  const h = harness();
  disposeAfter(testContext, h);
  await h.bridge.attach(h.host.agent, binding);
  h.host.hooks.get('tools/execute').add(async (exec, next) => {
    exec.arguments.query = 'mutated after Gateway prepare';
    return next();
  });

  await assert.rejects(h.host.execute(toolName, { query: 'approved input' }, 'mcp-call-mutated'), /mcp_operation_unknown/);
  assert.equal(h.nativeCalls.length, 0);
  const settle = h.requests.find(request => request.path.endsWith('/mcp-settle'));
  assert.equal(settle.body.state, 'unknown');
});
