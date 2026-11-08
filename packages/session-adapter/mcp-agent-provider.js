import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertMcpExecutionInput, compileMcpToolInputValidator, validateMcpConnections } from './mcp-runtime.js';
import { createMcpAgentScopeRegistry } from './mcp-agent-scope.js';
import { normalizeMcpControlReload } from './mcp-control-host.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const RAW_TOOL_PREFIX = 'mcp__';

function isAbortSignal(signal) {
  return signal === undefined || !!signal && typeof signal.throwIfAborted === 'function'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function';
}

function combineSignals(parent, ...lifetimes) {
  const controller = new AbortController();
  const forward = signal => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const sources = [parent, ...lifetimes].filter(Boolean);
  const listeners = sources.map(source => () => forward(source));
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (source.aborted) forward(source);
    else source.addEventListener('abort', listeners[index], { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (let index = 0; index < sources.length; index++) sources[index].removeEventListener('abort', listeners[index]);
    },
  };
}

export function awaitWithSignal(value, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, signal.reason ?? Object.assign(new Error('mcp_agent_generation_closed'), {name: 'AbortError'}));
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(value).then(result => finish(resolve, result), error => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const MCP_EXECUTION_RECEIPT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    kind: Object.freeze({ type: 'string', const: 'tool_receipt' }),
    reference: Object.freeze({ type: 'string' }),
    hash: Object.freeze({ type: 'string' }),
  }),
  required: Object.freeze(['kind', 'reference', 'hash']),
  additionalProperties: false,
});

function outputWithExecutionReceipt(output) {
  if (!isObject(output) || !isObject(output.schema) || output.schema.type !== 'object') {
    fail('mcp_agent_tool_generation_mismatch');
  }
  const schema = structuredClone(output.schema);
  const properties = isObject(schema.properties) ? schema.properties : {};
  if (Object.hasOwn(properties, 'execution_receipt')) fail('mcp_agent_tool_generation_mismatch');
  schema.properties = { ...properties, execution_receipt: MCP_EXECUTION_RECEIPT_SCHEMA };
  return Object.freeze({ ...output, schema: deepFreeze(schema) });
}

function fail(code) {
  throw new Error(code);
}

function nativeToolName(serverName, rawName) {
  const name = `${RAW_TOOL_PREFIX}${serverName}__${rawName}`;
  // The DSH MCP client preserves this canonical subset verbatim. Other raw
  // names are normalized or hashed by the SDK, so this candidate fails closed.
  if (name.length > 64 || !/^[A-Za-z0-9_-]+$/.test(name)) fail('mcp_agent_tool_generation_mismatch');
  return name;
}

function reloadServerName(identity, source, existingNames) {
  const tuple = [identity.owner_id, identity.agent_id, identity.connection_id, identity.generation].join('\0');
  for (let attempt = 0; attempt < 16; attempt++) {
    const serverName = 'j' + createHash('sha256').update(tuple + '\0' + attempt).digest('hex').slice(0, 6);
    try {
      const names = source.tools.map(tool => nativeToolName(serverName, tool.raw_name));
      if (new Set(names).size === names.length && names.every(name => !existingNames.has(name))) return serverName;
    } catch { /* A shorter candidate name may fit a valid native tool name. */ }
  }
  fail('mcp_reload_candidate_name_unavailable');
}

/**
 * Convert a credential-free Gateway stdio connection to the locked DSH
 * `StdioConfig` shape. Gateway secret refs need an explicit trusted translator
 * port such as `translateCredentialRef(secretRef, { agent, connectionId })`,
 * plus a separately approved DSH credential resolver. This candidate has no
 * mapping config, invokes no translator, and never reads secret values.
 * Streamable HTTP remains unavailable without a target egress policy injection
 * point.
 */
export function toDshMcpStdioConfig(connection) {
  if (!isObject(connection) || connection.transport !== 'stdio' || !isObject(connection.config)
    || connection.config.transport !== 'stdio' || connection.config.server_name !== connection.server_name) {
    fail('mcp_agent_transport_unavailable');
  }
  const config = connection.config;
  if (!isObject(config.env_refs) || Object.keys(config.env_refs).length !== 0) {
    fail('mcp_agent_credential_mapping_unavailable');
  }
  if (typeof config.command !== 'string' || !config.command
    || config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))
    || config.cwd !== undefined && typeof config.cwd !== 'string') {
    fail('mcp_agent_config_invalid');
  }
  return Object.freeze({
    transport: 'stdio',
    serverName: connection.server_name,
    command: config.command,
    args: Object.freeze([...(config.args ?? [])]),
    env: Object.freeze({}),
    cwd: config.cwd ?? '',
    toolCallTimeoutMs: 60000,
    failOnStartupError: true,
    reconnect: Object.freeze({ enabled: false }),
  });
}

/** Convert a credential-free Gateway HTTP connection to the locked DSH config. */
export function toDshMcpHttpConfig(connection) {
  if (!isObject(connection) || connection.transport !== 'streamable-http' || !isObject(connection.config)
    || connection.config.transport !== 'streamable-http' || connection.config.server_name !== connection.server_name
    || typeof connection.config.url !== 'string' || !isObject(connection.config.header_refs)) {
    fail('mcp_agent_config_invalid');
  }
  return Object.freeze({
    transport: 'streamable-http',
    serverName: connection.server_name,
    url: connection.config.url,
    // Secret refs are resolved inside hostFetch for each request and never enter DSH config.
    headers: Object.freeze({}),
    failOnStartupError: true,
    toolCallTimeoutMs: 60000,
  });
}

/**
 * Create the Agent-scoped provider consumed by `mcpRuntimeProvider.attach`.
 * `authorizeStdio` must be supplied by trusted Host policy; it is never derived
 * from model calls or webpage content. Setup must be called from the locked
 * DSH `AgentSetup(agentCtx, agent)` callback for each unpublished Agent.
 */
export function createMcpAgentRuntimeProvider({ mcpPlugin, authorizeStdio, httpFetchForConnection } = {}) {
  if (authorizeStdio !== undefined && typeof authorizeStdio !== 'function'
    || httpFetchForConnection !== undefined && typeof httpFetchForConnection !== 'function') fail('mcp_agent_provider_invalid');
  const scopes = createMcpAgentScopeRegistry({ mcpPlugin });
  const contexts = new WeakMap();
  const activeByAgent = new WeakMap();
  const activeStates = new Set();
  const reloadByAgent = new WeakMap();
  const reloadBindings = new Set();
  const retiredReloadClosures = new Set();
  let providerClosed = false;
  let credentialGeneration = 0;
  let credentialsInvalidating = false;
  let credentialInvalidationFailed = false;
  let providerClosePromise;

  async function closeAgent(agent) {
    const state = activeByAgent.get(agent);
    if (state) await state.close();
  }

  function retireReloadBinding(binding) {
    if (!binding || binding.retirement) return binding?.retirement;
    binding.active = false;
    binding.controller.abort(new Error('mcp_reload_scope_stale'));
    reloadBindings.delete(binding);
    if (reloadByAgent.get(binding.agent) === binding) reloadByAgent.delete(binding.agent);
    binding.retirement = (async () => {
      await Promise.allSettled([...binding.jobs]);
      const closed = await Promise.allSettled([...binding.handles].map(handle => handle.close()));
      if (closed.some(result => result.status === 'rejected')) fail('mcp_reload_close_failed');
    })();
    retiredReloadClosures.add(binding.retirement);
    binding.retirement.then(() => retiredReloadClosures.delete(binding.retirement), () => {});
    return binding.retirement;
  }

  /** Trusted Workbench binding only: the caller supplies the ORIGINAL read-only
   * operation/context source. This volatile index stores no operation receipts. */
  function bindReloadScope({ agent, ownerId, agentId, capabilityEpoch, connections, readOriginalState } = {}) {
    if (credentialsInvalidating || credentialInvalidationFailed) fail('mcp_agent_credentials_changing');
    if (providerClosed) fail('mcp_agent_provider_closed');
    const scope = contexts.get(agent);
    if (!scope) fail('mcp_agent_scope_unavailable');
    if (![ownerId, agentId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value))
      || !Number.isSafeInteger(capabilityEpoch) || capabilityEpoch < 1
      || typeof readOriginalState !== 'function' || typeof scope.tools.schemas !== 'function') fail('mcp_reload_binding_invalid');
    const validated = validateMcpConnections(connections, ownerId);
    const snapshot = deepFreeze(structuredClone(validated.connections));
    retireReloadBinding(reloadByAgent.get(agent));
    const binding = { agent, scope, ownerId, agentId, capabilityEpoch, connections: snapshot, readOriginalState,
      controller: new AbortController(), active: true, jobs: new Set(), handles: new Set(), retirement: undefined };
    const ensure = () => {
      binding.controller.signal.throwIfAborted();
      if (providerClosed || !binding.active || reloadByAgent.get(agent) !== binding || contexts.get(agent) !== scope) fail('mcp_reload_scope_stale');
    };
    async function perform(input) {
      ensure();
      if (!isObject(input) || typeof input.assertCurrent !== 'function' || !isAbortSignal(input.signal)) fail('mcp_reload_binding_invalid');
      const request = normalizeMcpControlReload({ protocol: 1, ...input.identity, config: input.config });
      const { protocol, config, ...identity } = request;
      if (identity.owner_id !== ownerId || identity.agent_id !== agentId) fail('mcp_reload_scope_stale');
      const source = snapshot.find(row => row.connection_id === identity.connection_id);
      if (!source) fail('mcp_reload_connection_unavailable');
      const active = activeByAgent.get(agent);
      const priorConnection = active?.connectionStates.get(identity.connection_id);
      const priorRuntimeLive = () => !!active && activeByAgent.get(agent) === active && active.active
        && !!priorConnection && priorConnection.active && !priorConnection.controller.signal.aborted
        && priorConnection.fibers.length > 0 && priorConnection.version === source.version
        && priorConnection.generation === source.generation && isDeepStrictEqual(priorConnection.connection, source);
      const linked = combineSignals(input.signal, binding.controller.signal);
      let fiber, handle;
      const check = async () => {
        ensure(); linked.signal.throwIfAborted();
        await awaitWithSignal(Promise.resolve().then(() => input.assertCurrent('pending')), linked.signal);
        ensure();
        const state = await awaitWithSignal(Promise.resolve().then(() => readOriginalState(
          Object.freeze({ owner_id: ownerId, agent_id: agentId, capability_epoch: capabilityEpoch }), identity, linked.signal, config)), linked.signal);
        ensure();
        if (state?.state !== 'pending') fail('mcp_reload_operation_unknown');
        if (state.owner_id !== ownerId || state.agent_id !== agentId || state.capability_epoch !== capabilityEpoch
          || !isDeepStrictEqual(state.identity, identity)) fail('mcp_reload_scope_stale');
      };
      try {
        await check();
        if (identity.version !== source.version || identity.generation !== source.generation + 1
          || ![source.version, source.version + 1].includes(identity.config_version)
          || identity.config_version === source.version && !isDeepStrictEqual(config, source.config)) {
          fail('mcp_reload_scope_stale');
        }
        if (!priorRuntimeLive()) fail('mcp_reload_prior_runtime_unavailable');
        if (priorConnection.pending.size || priorConnection.calls.size) fail('mcp_reload_prior_runtime_busy');
        // Preserve the existing Host policy; neither a reload nor an operator
        // binding supplies a new stdio or tool execution permission.
        if (config.transport !== 'stdio' || source.server_name !== config.server_name) fail('mcp_reload_transport_unavailable');
        const staged = { ...source, version: identity.config_version, generation: identity.generation, config };
        const dshConfig = toDshMcpStdioConfig(staged);
        if (!authorizeStdio || await authorizeStdio(Object.freeze({ agent, connectionId: source.connection_id,
          serverName: config.server_name, command: dshConfig.command, args: dshConfig.args, cwd: dshConfig.cwd })) !== true) fail('mcp_agent_stdio_forbidden');
        await check();
        const before = scope.tools.schemas(agent);
        if (!Array.isArray(before)) fail('mcp_reload_catalog_unproven');
        const candidateServer = reloadServerName(identity, source, new Set(before.map(tool => tool?.name)));
        const prefix = `${RAW_TOOL_PREFIX}${candidateServer}__`;
        fiber = await scopes.mount({ agent, config: Object.freeze({ ...dshConfig, serverName: candidateServer }), signal: linked.signal });
        handle = Object.freeze({ close: async () => {
          await fiber.close(); binding.handles.delete(handle); linked.dispose();
        } });
        binding.handles.add(handle);
        await check();
        const visible = scope.tools.schemas(agent);
        if (!Array.isArray(visible)) fail('mcp_reload_catalog_unproven');
        const known = new Map(source.tools.map(tool => [nativeToolName(candidateServer, tool.raw_name), tool]));
        const discovered = visible.filter(tool => typeof tool?.name === 'string' && tool.name.startsWith(prefix)).map(tool => {
          const original = known.get(tool.name), definition = scope.tools.get(tool.name, agent);
          // The SDK does not expose raw names for normalized/hashed additions.
          // Refuse them rather than invent a raw name or omit an unknown tool.
          if (!original || !definition || !isDeepStrictEqual(definition.parameters, tool.parameters)
            || definition.description !== tool.description) fail('mcp_reload_catalog_unproven');
          return { ...original, description: tool.description, input_schema: tool.parameters };
        });
        const checked = validateMcpConnections([{ ...staged, tools: discovered }]);
        await check();
        if (!priorRuntimeLive()) fail('mcp_reload_prior_runtime_unavailable');
        if (priorConnection.pending.size || priorConnection.calls.size) fail('mcp_reload_prior_runtime_busy');
        await awaitWithSignal(active.closeConnection(identity.connection_id), linked.signal);
        await check();
        return Object.freeze({ tools: Object.freeze(checked.connections[0].tools.map(tool => Object.freeze({
          name: tool.raw_name, description: tool.description, input_schema: tool.input_schema }))), close: handle.close });
      } catch (error) {
        let candidateClosed = true;
        try { if (handle) await handle.close(); else if (fiber) await fiber.close(); }
        catch { candidateClosed = false; /* Binding teardown retains failed handles. */ }
        linked.dispose();
        if (candidateClosed && priorRuntimeLive()) {
          const code = 'mcp_reload_failed_prior_retained';
          throw Object.assign(new Error(code), { code });
        }
        throw error;
      }
    }
    binding.scopeHandle = Object.freeze({
      reload(input) {
        const job = perform(input); binding.jobs.add(job);
        job.then(() => binding.jobs.delete(job), () => binding.jobs.delete(job));
        return job;
      },
      async cancelConnection({ connectionId, signal } = {}) {
        ensure(); signal?.throwIfAborted();
        if (typeof connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(connectionId)) fail('mcp_reload_binding_invalid');
        await awaitWithSignal(activeByAgent.get(agent)?.cancelConnection({ connectionId, signal }) ?? Promise.resolve(), signal ?? new AbortController().signal);
      },
    });
    reloadByAgent.set(agent, binding); reloadBindings.add(binding);
    return () => retireReloadBinding(binding);
  }

  async function resolveReloadScopes(ownerId, agentId, signal) {
    signal?.throwIfAborted();
    if (providerClosed || credentialsInvalidating || credentialInvalidationFailed) return [];
    const scopes = [], agents = new Set();
    for (const binding of reloadBindings) {
      if (!binding.active || binding.ownerId !== ownerId || binding.agentId !== agentId
        || reloadByAgent.get(binding.agent) !== binding || contexts.get(binding.agent) !== binding.scope) continue;
      agents.add(binding.agent);
      scopes.push(binding.scopeHandle);
    }
    for (const state of activeStates) {
      if (state.ownerId !== ownerId || state.agentId !== agentId || !state.active
        || activeByAgent.get(state.agent) !== state || agents.has(state.agent)) continue;
      agents.add(state.agent);
      scopes.push(state.scopeHandle);
    }
    return Object.freeze(scopes);
  }

  function setup(agentCtx, agent) {
    const tools = agentCtx?.tools;
    if (providerClosed) fail('mcp_agent_provider_closed');
    if (!isObject(agent) || !isObject(agentCtx) || typeof agentCtx.plugin !== 'function' || typeof agentCtx.effect !== 'function'
      || !tools || typeof tools.get !== 'function' || typeof tools.register !== 'function' || typeof tools.guard !== 'function') {
      fail('mcp_agent_scope_invalid');
    }
    const removeRawMcpGuard = tools.guard(exec => typeof exec?.name === 'string' && exec.name.startsWith(RAW_TOOL_PREFIX)
      ? 'MCP_RAW_TOOL_FORBIDDEN' : undefined);
    if (typeof removeRawMcpGuard !== 'function') fail('mcp_agent_scope_invalid');
    try {
      scopes.setup(agentCtx, agent);
      contexts.set(agent, Object.freeze({ tools }));
      agentCtx.effect(() => async () => {
        try { await Promise.all([retireReloadBinding(reloadByAgent.get(agent)), closeAgent(agent)]); }
        finally {
          contexts.delete(agent);
          scopes.dispose(agentCtx, agent);
          removeRawMcpGuard();
        }
      }, 'jotMcpAgentRuntimeLifecycle()');
    } catch (error) {
      contexts.delete(agent);
      scopes.dispose(agentCtx, agent);
      removeRawMcpGuard();
      throw error;
    }
  }

  async function attach(options) {
    if (providerClosed) fail('mcp_agent_provider_closed');
    if (credentialsInvalidating || credentialInvalidationFailed) fail('mcp_agent_credentials_changing');
    const admittedCredentialGeneration = credentialGeneration;
    if (!isObject(options) || Object.keys(options).some(key => !['agent', 'connections', 'signal', 'ownerId', 'agentId', 'assertCurrent'].includes(key))
      || !isObject(options.agent) || !isAbortSignal(options.signal)) fail('mcp_agent_provider_invalid');
    const { agent, signal, ownerId, agentId, assertCurrent } = options;
    const scope = contexts.get(agent);
    if (!scope) fail('mcp_agent_scope_unavailable');
    const validated = validateMcpConnections(options.connections, ownerId);
    const connections = validated.connections;
    if (!validated.toolNames.length) return Object.freeze({ tool_names: Object.freeze([]), close: async () => {} });
    const hasStdio = connections.some(connection => connection.transport === 'stdio');
    const hasHttp = connections.some(connection => connection.transport === 'streamable-http');
    if (hasStdio && !authorizeStdio) fail('mcp_agent_stdio_forbidden');
    if (hasHttp && !httpFetchForConnection) fail('mcp_agent_http_unavailable');
    if (hasHttp && (![ownerId, agentId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value))
      || typeof assertCurrent !== 'function')) fail('mcp_agent_http_binding_unavailable');

    const previous = activeByAgent.get(agent);
    const state = {
      agent,
      ownerId,
      agentId,
      active: true,
      controller: new AbortController(),
      pending: new Set(),
      connectionStates: new Map(),
      removedConnections: new Set(),
      fibers: [],
      signalLinks: [],
      unregisterAliases: [],
      closePromise: undefined,
      closeConnection(connectionId) {
        const connection = this.connectionStates.get(connectionId);
        if (!connection) return Promise.resolve();
        if (!connection.closePromise) {
          connection.active = false;
          connection.controller.abort(new Error('mcp_agent_connection_closed'));
          connection.closePromise = (async () => {
            await Promise.allSettled([...connection.pending, ...connection.calls]);
            const errors = [];
            const forget = (items, item) => { const index = items.lastIndexOf(item); if (index >= 0) items.splice(index, 1); };
            for (const unregister of [...connection.unregisterAliases].reverse()) {
              try {
                unregister();
                forget(connection.unregisterAliases, unregister);
                forget(this.unregisterAliases, unregister);
              } catch { errors.push(true); }
            }
            for (const fiber of [...connection.fibers].reverse()) {
              try {
                await fiber.close();
                forget(connection.fibers, fiber);
                forget(this.fibers, fiber);
              } catch { errors.push(true); }
            }
            for (const linked of connection.signalLinks.splice(0).reverse()) {
              linked.dispose(); forget(this.signalLinks, linked);
            }
            if (errors.length) throw new Error('mcp_agent_close_failed');
            this.connectionStates.delete(connectionId);
          })().catch(error => { connection.closePromise = undefined; throw error; });
        }
        return connection.closePromise;
      },
      close() {
        if (!this.closePromise) {
          this.active = false;
          this.controller.abort(new Error('mcp_agent_generation_closed'));
          this.closePromise = (async () => {
            const results = await Promise.allSettled([...this.connectionStates.keys()].reverse().map(id => this.closeConnection(id)));
            activeStates.delete(this);
            if (activeByAgent.get(agent) === this) activeByAgent.delete(agent);
            if (results.some(result => result.status === 'rejected')) throw new Error('mcp_agent_close_failed');
          })();
        }
        return this.closePromise;
      },
      async cancelConnection({ connectionId, signal: requestSignal } = {}) {
        requestSignal?.throwIfAborted();
        if (typeof connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(connectionId)) fail('mcp_agent_provider_invalid');
        this.removedConnections.add(connectionId);
        await awaitWithSignal(this.closeConnection(connectionId), requestSignal ?? new AbortController().signal);
      },
    };
    state.scopeHandle = Object.freeze({ cancelConnection: request => state.cancelConnection(request) });
    activeByAgent.set(agent, state);
    activeStates.add(state);
    if (previous) {
      try { await previous.close(); } catch { /* A prior handle is already fenced before its replacement. */ }
    }

    const ensureActive = () => {
      signal?.throwIfAborted();
      if (credentialsInvalidating || admittedCredentialGeneration !== credentialGeneration
        || !state.active || activeByAgent.get(agent) !== state) fail('mcp_agent_generation_closed');
    };
    try {
      ensureActive();
      const serverNames = new Set();
      const prepared = connections.map(connection => {
        const dshConfig = connection.transport === 'stdio'
          ? toDshMcpStdioConfig(connection) : toDshMcpHttpConfig(connection);
        if (serverNames.has(dshConfig.serverName)) fail('mcp_agent_config_invalid');
        serverNames.add(dshConfig.serverName);
        const rawNames = new Set();
        const tools = connection.tools.map(tool => {
          if (rawNames.has(tool.raw_name)) fail('mcp_agent_tool_generation_mismatch');
          rawNames.add(tool.raw_name);
          const dshName = nativeToolName(connection.server_name, tool.raw_name);
          return { approved: tool, dshName, priorDefinition: scope.tools.get(dshName, agent) };
        });
        return { connection, dshConfig, tools };
      });
      for (const { connection, dshConfig } of prepared.filter(row => row.connection.transport === 'stdio')) {
        const request = Object.freeze({
          agent,
          connectionId: connection.connection_id,
          serverName: connection.server_name,
          command: dshConfig.command,
          args: dshConfig.args,
          cwd: dshConfig.cwd,
        });
        let authorized = false;
        try { authorized = await authorizeStdio(request) === true; } catch { /* Fail closed with a stable code. */ }
        ensureActive();
        if (!authorized) fail('mcp_agent_stdio_forbidden');
      }

      // Stage every DSH Fiber before publishing any Gateway-facing alias.
      const aliases = [];
      for (const { connection, dshConfig, tools } of prepared) {
        ensureActive();
        const connectionState = { connectionId: connection.connection_id, connection: deepFreeze(structuredClone(connection)),
          version: connection.version, generation: connection.generation, active: true, controller: new AbortController(),
          pending: new Set(), calls: new Set(), fibers: [], signalLinks: [], unregisterAliases: [], closePromise: undefined };
        state.connectionStates.set(connection.connection_id, connectionState);
        const linked = combineSignals(signal, state.controller.signal, connectionState.controller.signal);
        state.signalLinks.push(linked);
        connectionState.signalLinks.push(linked);
        const ensureConnectionActive = () => {
          ensureActive();
          linked.signal.throwIfAborted();
          if (!connectionState.active || state.removedConnections.has(connection.connection_id)) fail('mcp_agent_connection_closed');
        };
        const bound = Object.freeze({owner_id: ownerId, agent_id: agentId, connection_id: connection.connection_id,
          version: connection.version, generation: connection.generation, config: deepFreeze(structuredClone(connection.config))});
        const assertConnectionCurrent = async () => {
          ensureConnectionActive();
          if (typeof assertCurrent === 'function') {
            try { await awaitWithSignal(Promise.resolve(assertCurrent(bound, linked.signal)), linked.signal); }
            catch { fail('mcp_agent_generation_closed'); }
          }
          ensureConnectionActive();
        };
        await assertConnectionCurrent();
        let hostFetch;
        if (connection.transport === 'streamable-http') {
          const assertBoundCurrent = async () => {
            await assertConnectionCurrent();
          };
          try {
            const pendingFetch = Promise.resolve(httpFetchForConnection({ownerId, agentId, connection, binding: bound,
              signal: linked.signal, assertCurrent: assertBoundCurrent}));
            connectionState.pending.add(pendingFetch); state.pending.add(pendingFetch);
            pendingFetch.then(() => { connectionState.pending.delete(pendingFetch); state.pending.delete(pendingFetch); },
              () => { connectionState.pending.delete(pendingFetch); state.pending.delete(pendingFetch); });
            hostFetch = await awaitWithSignal(pendingFetch, linked.signal);
            ensureConnectionActive();
          } catch {
            if (linked.signal.aborted) ensureActive();
            throw new Error('mcp_agent_http_unavailable');
          }
          if (typeof hostFetch !== 'function') fail('mcp_agent_http_unavailable');
        }
        const pendingMount = scopes.mount({ agent, config: dshConfig, signal: linked.signal, ...(hostFetch ? {hostFetch} : {}) }).then(fiber => {
          state.fibers.push(fiber);
          connectionState.fibers.push(fiber);
          return fiber;
        });
        state.pending.add(pendingMount);
        connectionState.pending.add(pendingMount);
        try { await pendingMount; }
        finally { state.pending.delete(pendingMount); connectionState.pending.delete(pendingMount); }
        await assertConnectionCurrent();

        for (const { approved: tool, dshName, priorDefinition } of tools) {
          const native = scope.tools.get(dshName, agent);
          if (!native || native === priorDefinition || native.name !== dshName || typeof native.execute !== 'function'
            || !isDeepStrictEqual(native.parameters, tool.input_schema) || native.description !== tool.description) {
            fail('mcp_agent_tool_generation_mismatch');
          }
          aliases.push({ approved: tool, native, connectionState, validateInput: compileMcpToolInputValidator(tool.input_schema) });
        }
      }

      for (const connection of connections) {
        if (state.removedConnections.has(connection.connection_id) || !state.connectionStates.has(connection.connection_id)) {
          fail('mcp_agent_connection_closed');
        }
      }
      const publicNames = [];
      for (const { approved: tool, native, connectionState, validateInput } of aliases) {
        ensureActive();
        const alias = Object.freeze({
          ...native,
          name: tool.public_name,
          output: outputWithExecutionReceipt(native.output),
          execute: async (args, exec) => {
            if (credentialsInvalidating || admittedCredentialGeneration !== credentialGeneration
              || !state.active || activeByAgent.get(agent) !== state) fail('mcp_agent_generation_closed');
            if (!connectionState.active) fail('mcp_agent_connection_closed');
            const call = (async () => {
              try {
                validateInput(args);
                if (!isDeepStrictEqual(args, exec?.arguments)) fail('mcp_agent_input_invalid');
                assertMcpExecutionInput(exec, args);
              } catch {
                fail('mcp_agent_input_invalid');
              }
              return await native.execute.call(native, args, exec);
            })();
            connectionState.calls.add(call);
            try { return await call; } finally { connectionState.calls.delete(call); }
          },
        });
        const unregister = scope.tools.register(alias);
        state.unregisterAliases.push(unregister);
        connectionState.unregisterAliases.push(unregister);
        publicNames.push(tool.public_name);
      }
      ensureActive();
      return Object.freeze({ tool_names: Object.freeze([...publicNames]), close: () => state.close() });
    } catch (error) {
      const superseded = activeByAgent.get(agent) !== state;
      try { await state.close(); } catch { /* Preserve the attach failure. */ }
      if (signal?.aborted) signal.throwIfAborted();
      if (superseded || error?.message === 'mcp_agent_generation_closed') throw new Error('mcp_agent_generation_closed');
      if (typeof error?.message === 'string' && error.message.startsWith('mcp_agent_')) throw error;
      throw new Error('mcp_agent_provider_unavailable');
    }
  }

  async function invalidateCredentials() {
    if (credentialInvalidationFailed) fail('mcp_agent_credential_invalidation_failed');
    if (providerClosed) fail('mcp_agent_provider_closed');
    const generation = ++credentialGeneration;
    credentialsInvalidating = true;
    // Closing starts synchronously, fencing old tool aliases before any await.
    const retirements = [...reloadBindings].map(binding => retireReloadBinding(binding));
    const results = await Promise.allSettled([
      ...[...activeStates].map(state => state.close()), ...retirements, ...retiredReloadClosures,
    ]);
    if (results.some(result => result.status === 'rejected')) {
      credentialInvalidationFailed = true;
      fail('mcp_agent_credential_invalidation_failed');
    }
    if (generation === credentialGeneration) credentialsInvalidating = false;
  }

  async function close() {
    if (!providerClosePromise) {
      providerClosed = true;
      providerClosePromise = (async () => {
        for (const binding of [...reloadBindings]) retireReloadBinding(binding);
        const results = await Promise.allSettled([...activeStates].map(state => state.close()).concat([...retiredReloadClosures]));
        if (results.some(result => result.status === 'rejected')) fail('mcp_agent_provider_close_failed');
      })();
    }
    return providerClosePromise;
  }

  return Object.freeze({ setup, attach, bindReloadScope, resolveReloadScopes, invalidateCredentials, close });
}
