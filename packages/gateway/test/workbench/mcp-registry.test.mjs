import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { McpRegistryService } from '../../src/workbench/mcp-registry.ts';

const base = resolve(fileURLToPath(new URL('../../../../.test-tmp/workbench-mcp/', import.meta.url)));
mkdirSync(base, { recursive: true });

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(base, 'case-'));
  const db = openProductDatabase(join(dir, 'fixture.sqlite'));
  const workbench = new WorkbenchService(db, { workspaceIds: ['ws'], root: join(dir, 'shared') });
  const capabilityChanges = [];
  const registry = new McpRegistryService(db, workbench, { onCapabilityChange: (owner, agentId) => capabilityChanges.push([owner, agentId]), ...options });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, workbench, registry, capabilityChanges };
}

const stdio = (overrides = {}) => ({
  server_name: 'repo_tools',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  env_refs: { API_TOKEN: 'secret://owner-a/repo-token' },
  ...overrides,
});

const discovered = (name = 'search') => ({
  name,
  description: 'Search public repository records.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
});

test('connections are owner and Agent scoped, disabled by default, and public projections redact transport configuration', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const foreign = workbench.createAgent('owner-b', { name: 'Foreign' });

  const created = registry.create('owner-a', agent.agent_id, stdio());
  assert.equal(created.version, 1);
  assert.equal(created.enabled, false);
  assert.equal(created.state, 'configured');
  assert.equal(created.credentials_configured, true);
  assert.equal(JSON.stringify(created).includes('secret://'), false);
  assert.equal(JSON.stringify(created).includes('server.js'), false);
  assert.equal(JSON.stringify(created).includes('API_TOKEN'), false);
  assert.throws(() => registry.list('owner-b', agent.agent_id), /agent_not_found/);
  assert.throws(() => registry.list('owner-a', foreign.agent_id), /agent_not_found/);
  assert.deepEqual(registry.list('owner-a', agent.agent_id).items.map(x => x.connection_id), [created.connection_id]);
});

test('capability changes bump the Agent epoch without requiring an unowned Workbench callback', t => {
  const dir = mkdtempSync(join(base, 'default-callback-'));
  const db = openProductDatabase(join(dir, 'fixture.sqlite'));
  const workbench = new WorkbenchService(db, { workspaceIds: ['ws'], root: join(dir, 'shared') });
  const registry = new McpRegistryService(db, workbench);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const created = registry.create('owner-a', agent.agent_id, stdio());
  const enabled = registry.setEnabled('owner-a', agent.agent_id, created.connection_id, {
    expected_version: created.version, enabled: true,
  });
  assert.equal(workbench.getAgent('owner-a', agent.agent_id).capability_epoch, agent.capability_epoch + 1);

  const staged = registry.stageConfig('owner-a', agent.agent_id, created.connection_id, {
    expected_version: enabled.version, config: stdio({ args: ['replacement.js'] }),
  });
  assert.equal(staged.version, enabled.version);
  assert.equal(staged.state, 'reloading');
  assert.equal(workbench.getAgent('owner-a', agent.agent_id).capability_epoch, agent.capability_epoch + 2);
});

test('only credential references are accepted and HTTP endpoints cannot embed credentials or secret query parameters', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  assert.throws(() => registry.create('owner-a', agent.agent_id, stdio({ env_refs: { API_TOKEN: 'plaintext-secret' } })), /invalid_credential_reference/);
  assert.throws(() => registry.create('owner-a', agent.agent_id, stdio({ env_refs: { API_TOKEN: 'secret://owner-b/repo-token' } })), /invalid_credential_reference/);
  assert.throws(() => registry.create('owner-a', agent.agent_id, {
    server_name: 'remote', transport: 'streamable-http', url: 'https://user:pass@example.test/mcp', header_refs: {},
  }), /invalid_mcp_connection/);
  assert.throws(() => registry.create('owner-a', agent.agent_id, {
    server_name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp?token=cleartext', header_refs: {},
  }), /invalid_mcp_connection/);
  assert.throws(() => registry.create('owner-a', agent.agent_id, {
    server_name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp',
    header_refs: { Authorization: 'secret://owner-b/mcp-token' },
  }), /invalid_credential_reference/);
  const valid = registry.create('owner-a', agent.agent_id, stdio());
  assert.throws(() => registry.stageConfig('owner-a', agent.agent_id, valid.connection_id, {
    expected_version: 1, config: stdio({ env_refs: { API_TOKEN: 'secret://owner-b/repo-token' } }),
  }), /invalid_credential_reference/);
});

test('a reload publishes one validated generation and keeps newly discovered tools disabled until owner grants them', t => {
  const { workbench, registry, capabilityChanges } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  const prepared = registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
  assert.equal(prepared.generation, 1);
  assert.equal(prepared.config.env_refs.API_TOKEN, 'secret://owner-a/repo-token');

  const active = registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [discovered()]);
  assert.equal(active.state, 'ready');
  assert.equal(active.active_generation, 1);
  assert.equal(active.tools.length, 1);
  assert.equal(active.tools[0].approved, false);
  assert.equal(active.tools[0].source, 'mcp_server');
  assert.equal(active.tools[0].source_untrusted, true);
  assert.deepEqual(active.tools[0].input_schema, discovered().input_schema);
  assert.match(active.tools[0].tool_id, /^mcp_[a-f0-9]{32}$/);

  const granted = registry.setAllowedTools('owner-a', agent.agent_id, connection.connection_id, {
    expected_version: 2, tool_ids: [active.tools[0].tool_id],
  });
  assert.equal(granted.version, 3);
  assert.equal(granted.tools[0].approved, true);
  assert.deepEqual(capabilityChanges, [['owner-a', agent.agent_id], ['owner-a', agent.agent_id], ['owner-a', agent.agent_id], ['owner-a', agent.agent_id]]);
});

test('failed reload keeps the prior active generation, config version, tool snapshot, and owner grants', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  let connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
  connection = registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [discovered()]);
  connection = registry.setAllowedTools('owner-a', agent.agent_id, connection.connection_id, {
    expected_version: 2, tool_ids: [connection.tools[0].tool_id],
  });

  registry.stageConfig('owner-a', agent.agent_id, connection.connection_id, {
    expected_version: 3,
    config: stdio({ args: ['replacement.js'] }),
  });
  const staged = registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 3);
  assert.equal(staged.generation, 2);
  const afterFailure = registry.failReload('owner-a', agent.agent_id, connection.connection_id, 2, 'mcp_server_unavailable');
  assert.equal(afterFailure.version, 3);
  assert.equal(afterFailure.active_generation, 1);
  assert.equal(afterFailure.state, 'error');
  assert.equal(afterFailure.last_error_code, 'mcp_server_unavailable');
  assert.equal(afterFailure.tools[0].approved, true);
  assert.equal(JSON.stringify(afterFailure).includes('replacement.js'), false);

  registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 3);
  const replacement = registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 2, [discovered()]);
  assert.equal(replacement.active_generation, 2);
  assert.equal(replacement.tools[0].approved, false);
});

test('catalogs accept omitted or empty optional tool descriptions', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
  const active = registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [{ ...discovered(), description: '' }]);
  assert.equal(active.tools[0].description, '');
});

test('discovered catalogs are bounded across all MCP connections for one Agent', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const activate = (serverName, count) => {
    const connection = registry.create('owner-a', agent.agent_id, stdio({ server_name: serverName }));
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
    registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
    const tools = Array.from({ length: count }, (_, index) => ({ ...discovered(`tool-${index}`), description: '' }));
    return { connection, tools };
  };
  const first = activate('catalog_a', 100);
  registry.activateReload('owner-a', agent.agent_id, first.connection.connection_id, 1, first.tools);
  const second = activate('catalog_b', 28);
  registry.activateReload('owner-a', agent.agent_id, second.connection.connection_id, 1, second.tools);
  const third = activate('catalog_c', 1);
  assert.throws(() => registry.activateReload('owner-a', agent.agent_id, third.connection.connection_id, 1, third.tools), /mcp_tool_catalog_limit/);
  assert.equal(registry.list('owner-a', agent.agent_id).items.reduce((total, item) => total + item.tools.length, 0), 128);
});

test('registry restart marks persisted runtime state disconnected without losing the active snapshot or grants', t => {
  const { db, workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  let connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
  connection = registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [discovered()]);
  registry.setAllowedTools('owner-a', agent.agent_id, connection.connection_id, {
    expected_version: 2, tool_ids: [connection.tools[0].tool_id],
  });

  const capabilityChanges = [];
  const restarted = new McpRegistryService(db, workbench, {
    onCapabilityChange: (owner, agentId) => { capabilityChanges.push([owner, agentId]); },
  });
  const recovered = restarted.list('owner-a', agent.agent_id).items[0];
  assert.equal(recovered.state, 'disconnected');
  assert.equal(recovered.active_generation, 1);
  assert.equal(recovered.tools[0].approved, true);
  assert.equal(recovered.last_error_code, 'mcp_runtime_restarted');
  assert.deepEqual(restarted.runtimeConnections('owner-a', agent.agent_id), []);
  assert.deepEqual(capabilityChanges, [['owner-a', agent.agent_id]]);
});

test('duplicate remote tool names or malformed schemas reject a whole staged generation', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
  assert.throws(() => registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [discovered('same'), discovered('same')]), /invalid_mcp_tool_catalog/);
  assert.throws(() => registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [discovered('invalid schema').input_schema]), /invalid_mcp_tool_catalog/);
  const after = registry.list('owner-a', agent.agent_id).items[0];
  assert.equal(after.active_generation, 0);
  assert.notEqual(after.state, 'ready');
});

test('an invalid provider result fails the staged reload and releases its pending generation', t => {
  const reloads = [];
  const { workbench, registry } = fixture(t, { onReloadRequested: request => { reloads.push(request); } });
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
  const result = reloads[0].complete([{ name: 'bad', input_schema: { type: 'string' } }]);
  assert.equal(result.state, 'error');
  assert.equal(result.pending_generation, null);
  assert.equal(result.last_error_code, 'mcp_reload_invalid_result');
  assert.equal(reloads[0].signal.aborted, true);
});

test('trusted reload callbacks receive secret references privately and publish only validated snapshots', t => {
  const reloads = [];
  const { workbench, registry } = fixture(t, { onReloadRequested: request => { reloads.push(request); } });
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  let connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  const pending = registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
  assert.equal(pending.state, 'connecting');
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].config.env_refs.API_TOKEN, 'secret://owner-a/repo-token');
  connection = reloads[0].complete([discovered()]);
  assert.equal(connection.state, 'ready');
  assert.equal(JSON.stringify(connection).includes('secret://'), false);
  assert.equal(registry.runtimeConnections('owner-a', agent.agent_id).length, 0);
  connection = registry.setAllowedTools('owner-a', agent.agent_id, connection.connection_id, {
    expected_version: 2, tool_ids: [connection.tools[0].tool_id],
  });
  const runtime = registry.runtimeConnections('owner-a', agent.agent_id);
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].config.env_refs.API_TOKEN, 'secret://owner-a/repo-token');
  assert.equal(runtime[0].tools[0].approved, true);
  assert.equal(Object.hasOwn(runtime[0].tools[0], 'source_untrusted'), false, 'the read-only source label does not alter the trusted Adapter DTO');
});

test('reload discovery is available before any grants or runtime run and carries an exact private guard', t => {
  const reloads = [];
  const { workbench, registry } = fixture(t, { onReloadRequested: request => { reloads.push(request); } });
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, {
    server_name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp',
    header_refs: { Authorization: 'secret://owner-a/token' },
  });
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });

  const pending = registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
  const request = reloads[0];
  assert.equal(pending.state, 'connecting');
  assert.equal(request.owner_id, 'owner-a');
  assert.equal(request.agent_id, agent.agent_id);
  assert.equal(request.connection_id, connection.connection_id);
  assert.equal(request.version, 2);
  assert.equal(request.generation, 1);
  assert.equal(request.config.header_refs.Authorization, 'secret://owner-a/token');
  assert.ok(Object.isFrozen(request.config));
  assert.ok(Object.isFrozen(request.config.header_refs));
  assert.equal(typeof request.assertCurrent, 'function');
  assert.ok(request.signal instanceof AbortSignal);
  assert.doesNotThrow(() => request.assertCurrent());
  assert.deepEqual(registry.runtimeConnections('owner-a', agent.agent_id), []);
  assert.equal(request.signal.aborted, false);
});

test('reload guard rejects stale version, config, pending generation, disabled state, and runtime state', async t => {
  const mutations = [
    ['version', "UPDATE wb_mcp_connections SET version=version+1 WHERE connection_id=?", []],
    ['config', "UPDATE wb_mcp_connections SET pending_config_json='{}' WHERE connection_id=?", []],
    ['generation', "UPDATE wb_mcp_connections SET pending_generation=pending_generation+1 WHERE connection_id=?", []],
    ['disabled', "UPDATE wb_mcp_connections SET enabled=0 WHERE connection_id=?", []],
    ['runtime state', "UPDATE wb_mcp_connections SET runtime_state='ready' WHERE connection_id=?", []],
  ];
  for (const [label, sql] of mutations) await t.test(label, st => {
    let request;
    const { db, workbench, registry } = fixture(st, { onReloadRequested: value => { request = value; } });
    const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
    const connection = registry.create('owner-a', agent.agent_id, stdio());
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
    registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
    assert.doesNotThrow(() => request.assertCurrent());
    db.prepare(sql).run(connection.connection_id);
    assert.throws(() => request.assertCurrent(), /mcp_reload_stale/);
  });
});

test('reload signals are aborted by disable and removal, and a published replacement cancels the old generation', async t => {
  await t.test('disable', st => {
    let request;
    const { workbench, registry } = fixture(st, { onReloadRequested: value => { request = value; } });
    const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
    const connection = registry.create('owner-a', agent.agent_id, stdio());
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
    registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
    let abortEvents = 0;
    request.signal.addEventListener('abort', () => { abortEvents++; });
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 2, enabled: false });
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 3, enabled: false });
    assert.equal(request.signal.aborted, true);
    assert.equal(abortEvents, 1);
    assert.throws(() => request.assertCurrent(), /mcp_reload_stale/);
  });
  await t.test('remove', st => {
    let request;
    const { workbench, registry } = fixture(st, { onReloadRequested: value => { request = value; } });
    const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
    const connection = registry.create('owner-a', agent.agent_id, stdio());
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
    registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
    let abortEvents = 0;
    request.signal.addEventListener('abort', () => { abortEvents++; });
    registry.remove('owner-a', agent.agent_id, connection.connection_id, 2);
    assert.equal(request.signal.aborted, true);
    assert.equal(abortEvents, 1);
    assert.throws(() => request.assertCurrent(), /mcp_reload_stale/);
  });
  await t.test('published replacement', st => {
    const requests = [];
    const { workbench, registry } = fixture(st, { onReloadRequested: value => { requests.push(value); } });
    const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
    const connection = registry.create('owner-a', agent.agent_id, stdio());
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
    registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
    let firstAbortEvents = 0;
    requests[0].signal.addEventListener('abort', () => { firstAbortEvents++; });
    requests[0].complete([discovered('first')]);
    assert.equal(requests[0].signal.aborted, false);
    registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
    requests[1].complete([discovered('second')]);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(firstAbortEvents, 1);
    assert.equal(requests[1].signal.aborted, false);
    assert.equal(registry.find('owner-a', agent.agent_id, connection.connection_id).active_generation, 2);
  });
  await t.test('grant change', st => {
    let request;
    const { workbench, registry } = fixture(st, { onReloadRequested: value => { request = value; } });
    const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
    let connection = registry.create('owner-a', agent.agent_id, stdio());
    registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
    registry.requestReload('owner-a', agent.agent_id, connection.connection_id, 2);
    request.complete([discovered()]);
    assert.equal(request.signal.aborted, false);
    let abortEvents = 0;
    request.signal.addEventListener('abort', () => { abortEvents++; });
    connection = registry.find('owner-a', agent.agent_id, connection.connection_id);
    registry.setAllowedTools('owner-a', agent.agent_id, connection.connection_id, {
      expected_version: connection.version, tool_ids: [connection.tools[0].tool_id],
    });
    assert.equal(request.signal.aborted, true);
    assert.equal(abortEvents, 1);
  });
});

test('staging cannot race an in-flight generation and disabling fences the pending reload', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 1, enabled: true });
  registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 2);
  assert.throws(() => registry.stageConfig('owner-a', agent.agent_id, connection.connection_id, {
    expected_version: 2, config: stdio({ args: ['replacement.js'] }),
  }), /mcp_reload_in_progress/);
  const disabled = registry.setEnabled('owner-a', agent.agent_id, connection.connection_id, { expected_version: 2, enabled: false });
  assert.equal(disabled.state, 'disconnected');
  assert.equal(disabled.pending_generation, null);
  assert.equal(disabled.active_generation, 0);
  assert.throws(() => registry.activateReload('owner-a', agent.agent_id, connection.connection_id, 1, [discovered()]), /mcp_reload_stale/);
  assert.throws(() => registry.prepareReload('owner-a', agent.agent_id, connection.connection_id, 3), /mcp_connection_disabled/);
});

test('removal fences runtime access and erases private config after host cleanup confirms', t => {
  const removals = [];
  const { workbench, registry } = fixture(t, { onRemovalRequested: request => removals.push(request) });
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  const removing = registry.remove('owner-a', agent.agent_id, connection.connection_id, 1);
  assert.equal(removing.state, 'removing');
  assert.equal(registry.runtimeConnections('owner-a', agent.agent_id).length, 0);
  assert.equal(removals.length, 1);
  removals[0].finish();
  assert.deepEqual(registry.list('owner-a', agent.agent_id).items, []);
});

test('removal without a runtime callback returns the completed removed state', t => {
  const { workbench, registry } = fixture(t);
  const agent = workbench.createAgent('owner-a', { name: 'Researcher' });
  const connection = registry.create('owner-a', agent.agent_id, stdio());
  const removed = registry.remove('owner-a', agent.agent_id, connection.connection_id, 1);
  assert.equal(removed.state, 'removed');
  assert.equal(removed.credentials_configured, false);
  assert.deepEqual(removed.tools, []);
  assert.deepEqual(registry.list('owner-a', agent.agent_id).items, []);
});
