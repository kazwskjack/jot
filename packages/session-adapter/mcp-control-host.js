import { createHash } from 'node:crypto';
import { validateMcpConnections } from './mcp-runtime.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const IDENTITY_KEYS = ['owner_id', 'agent_id', 'connection_id', 'version', 'config_version', 'generation'];
const RELOAD_KEYS = ['protocol', ...IDENTITY_KEYS, 'config'];
const CANCEL_KEYS = ['protocol', ...IDENTITY_KEYS];
const REMOVE_KEYS = ['protocol', 'owner_id', 'agent_id', 'connection_id'];
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RELOAD_TIMEOUT_MS = 85_000;
const GUARD_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const RELOAD_PATH = '/internal/v1/mcp/reload';
const CANCEL_PATH = '/internal/v1/mcp/cancel';
const REMOVE_PATH = '/internal/v1/mcp/remove';

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (!isObject(value) || Reflect.ownKeys(value).length !== Object.keys(value).length
    || Object.keys(value).some(key => !keys.includes(key))) fail('mcp_control_invalid_request');
}
function tuple(value) {
  if (!isObject(value)) fail('mcp_control_invalid_request');
  const projected = Object.fromEntries(IDENTITY_KEYS.map(key => [key, value[key]]));
  exact(projected, IDENTITY_KEYS);
  if (!['owner_id', 'agent_id', 'connection_id'].every(key => typeof projected[key] === 'string' && ID.test(projected[key]))
    || !['version', 'config_version', 'generation'].every(key => Number.isSafeInteger(projected[key]) && projected[key] > 0)) {
    fail('mcp_control_invalid_request');
  }
  return Object.freeze(projected);
}
function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { fail('mcp_control_invalid_request'); }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function tupleKey(value) { return IDENTITY_KEYS.map(key => String(value[key])).join('\0'); }
function identityDigest(value) { return createHash('sha256').update(canonical(value.config)).digest('hex'); }

export function normalizeMcpControlReload(value) {
  exact(value, RELOAD_KEYS);
  if (value.protocol !== 1) fail('mcp_control_invalid_request');
  const identity = tuple(value);
  if (!isObject(value.config)) fail('mcp_control_invalid_request');
  try {
    validateMcpConnections([{
      connection_id: identity.connection_id,
      server_name: value.config.server_name,
      transport: value.config.transport,
      version: identity.config_version,
      generation: identity.generation,
      config: value.config,
      tools: [],
    }], identity.owner_id);
  } catch { fail('mcp_control_invalid_request'); }
  const result = Object.freeze({ protocol: 1, ...identity, config: structuredClone(value.config) });
  if (serializedBytes(result) > MAX_REQUEST_BYTES) fail('mcp_control_request_too_large');
  return result;
}

export function normalizeMcpControlCancel(value) {
  exact(value, CANCEL_KEYS);
  if (value.protocol !== 1) fail('mcp_control_invalid_request');
  return Object.freeze({ protocol: 1, ...tuple(value) });
}

function normalizeMcpControlRemove(value) {
  exact(value, REMOVE_KEYS);
  if (value.protocol !== 1 || !['owner_id', 'agent_id', 'connection_id'].every(key => typeof value[key] === 'string' && ID.test(value[key]))) {
    fail('mcp_control_invalid_request');
  }
  return Object.freeze({ protocol: 1, owner_id: value.owner_id, agent_id: value.agent_id, connection_id: value.connection_id });
}

export function normalizeMcpControlTools(value) {
  if (!Array.isArray(value) || value.length > 100) fail('mcp_control_catalog_invalid');
  const names = new Set();
  const tools = value.map(tool => {
    exact(tool, ['name', 'description', 'input_schema'], 'mcp_control_catalog_invalid');
    const name = tool.name;
    const description = tool.description === undefined ? '' : tool.description;
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || names.has(name)
      || typeof description !== 'string' || description.length > 2048
      || !isObject(tool.input_schema) || tool.input_schema.type !== 'object'
      || serializedBytes(tool.input_schema) > 16 * 1024 || JSON.stringify(tool.input_schema).includes('"$ref"')) {
      fail('mcp_control_catalog_invalid');
    }
    names.add(name);
    return Object.freeze({ name, description, input_schema: structuredClone(tool.input_schema) });
  });
  return Object.freeze(tools.sort((left, right) => left.name.localeCompare(right.name, 'en')));
}

function linkSignal(source, target) {
  if (!source) return () => {};
  const onAbort = () => { if (!target.aborted) target.abort(source.reason); };
  if (source.aborted) onAbort();
  else source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

function awaitWithSignal(value, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, signal.reason ?? Object.assign(new Error('mcp_control_cancelled'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(result => finish(resolve, result), error => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

function protocolError(error) {
  const code = error?.code;
  if (code === 'mcp_reload_failed_prior_retained') return { status: 503, value: { reason_code: code } };
  if (code === 'mcp_control_invalid_request') return { status: 422, value: { error: code } };
  if (code === 'mcp_control_request_too_large') return { status: 413, value: { error: code } };
  if (code === 'mcp_control_stale' || code === 'mcp_control_identity_conflict'
    || code === 'mcp_control_generation_not_active') return { status: 409, value: { reason_code: code } };
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return { status: 499, value: { reason_code: 'mcp_control_cancelled' } };
  return { status: 503, value: { reason_code: 'mcp_control_unavailable' } };
}

/**
 * Host-side coordinator for the authenticated Session Adapter routes.
 * `resolveScopes` must return only AgentSetup-bound runtime scopes previously
 * associated with this exact Gateway owner/agent pair. The module owns local
 * AbortControllers and child-runtime close handles; no callback crosses HTTP.
 */
export function createMcpControlHost({ resolveScopes, assertCurrent, guardIntervalMs = 5000,
  activationTimeoutMs = 30000, maxEntries = 2048, reloadTimeoutMs = RELOAD_TIMEOUT_MS,
  guardTimeoutMs = GUARD_TIMEOUT_MS, closeTimeoutMs = CLOSE_TIMEOUT_MS } = {}) {
  if (typeof resolveScopes !== 'function' || typeof assertCurrent !== 'function'
    || !Number.isSafeInteger(guardIntervalMs) || guardIntervalMs < 1
    || !Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs < guardIntervalMs
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1
    || !Number.isSafeInteger(reloadTimeoutMs) || reloadTimeoutMs < 1 || reloadTimeoutMs > RELOAD_TIMEOUT_MS
    || !Number.isSafeInteger(guardTimeoutMs) || guardTimeoutMs < 1 || guardTimeoutMs > GUARD_TIMEOUT_MS
    || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > CLOSE_TIMEOUT_MS) fail('mcp_control_host_invalid');

  const entries = new Map();
  let closed = false;

  async function current(entry, phase) {
    entry.controller.signal.throwIfAborted();
    let state;
    const guardSignal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(guardTimeoutMs)]);
    try {
      state = await awaitWithSignal(Promise.resolve(assertCurrent(entry.identity, phase, guardSignal, entry.request.config)), guardSignal);
    }
    catch { fail('mcp_control_stale'); }
    entry.controller.signal.throwIfAborted();
    if (phase === 'pending' && state !== 'pending') fail('mcp_control_stale');
    if (phase === 'active' && state !== 'active') fail('mcp_control_generation_not_active');
    return state;
  }

  function createStartupRecord(entry) {
    let resolveCompletion;
    const record = {
      settled: false, handle: undefined, closePromise: undefined, finished: false,
      completion: new Promise(resolve => { resolveCompletion = resolve; }),
      finish(outcome) {
        if (record.finished) return;
        record.finished = true;
        resolveCompletion(outcome);
        if (outcome.ok) entry.startups.delete(record);
      },
    };
    entry.startups.add(record);
    return record;
  }

  async function closeStartup(record, handle) {
    if (record.closePromise) return record.closePromise;
    record.closePromise = (async () => {
      let closed = false;
      try {
        if (!handle || typeof handle.close !== 'function') fail('mcp_control_unavailable');
        await handle.close();
        closed = true;
      } catch { /* A failed late close remains represented by this record. */ }
      record.finish({ ok: closed });
    })();
    return record.closePromise;
  }

  async function closeEntry(entry, reason = 'mcp_control_cancelled') {
    if (entry.closePromise) return entry.closePromise;
    entry.state = 'closed';
    clearTimeout(entry.guardTimer);
    entry.controller.abort(Object.assign(new Error(reason), { name: 'AbortError' }));
    entry.unlinkRequest?.();
    entry.unlinkDeadline?.();
    for (const record of entry.startups) {
      if (record.settled) void closeStartup(record, record.handle);
    }
    const handleClosures = entry.handles.map(handle => Promise.resolve().then(() => handle.close()).then(() => ({ ok: true })));
    const startupClosures = [...entry.startups].map(record => record.completion);
    const closing = Promise.allSettled([...handleClosures, ...startupClosures]);
    closing.then(results => {
      if (results.every(result => result.status === 'fulfilled' && result.value?.ok !== false)) entry.reclaimed = true;
    });
    entry.closePromise = (async () => {
      const results = await awaitWithSignal(closing, AbortSignal.timeout(closeTimeoutMs));
      if (results.some(result => result.status === 'rejected' || result.value?.ok === false)) fail('mcp_control_unavailable');
    })().catch(() => { throw new Error('mcp_control_unavailable'); });
    return await entry.closePromise;
  }

  async function closeFromGuard(entry, reason) {
    try { await closeEntry(entry, reason); }
    catch { /* Failed cleanup remains fenced and non-reclaimable; contain the timer rejection. */ }
  }

  function scheduleGuard(entry) {
    if (entry.state === 'closed' || entry.controller.signal.aborted) return;
    entry.guardTimer = setTimeout(async () => {
      if (entry.state === 'closed' || entry.controller.signal.aborted) return;
      try {
        const guardSignal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(guardTimeoutMs)]);
        const state = await awaitWithSignal(Promise.resolve(assertCurrent(entry.identity, 'active', guardSignal, entry.request.config)), guardSignal);
        if (state === 'active') entry.activeSeen = true;
        else if (state === 'suspended' && (entry.activeSeen || Date.now() - entry.stagedAt <= activationTimeoutMs)) {
          // A newer generation is staging; keep the old child Fiber idle until
          // Gateway either publishes the replacement or sends its tuple cancel.
        } else if (state === 'pending' && !entry.activeSeen && Date.now() - entry.stagedAt <= activationTimeoutMs) {
          // Gateway's local complete() runs immediately after the HTTP response.
        } else {
          await closeFromGuard(entry, 'mcp_control_guard_expired');
          return;
        }
      } catch {
        await closeFromGuard(entry, 'mcp_control_guard_unavailable');
        return;
      }
      scheduleGuard(entry);
    }, guardIntervalMs);
    entry.guardTimer.unref?.();
  }

  async function perform(entry) {
    await current(entry, 'pending');
    const resolving = Promise.resolve().then(() => resolveScopes(entry.identity.owner_id, entry.identity.agent_id, entry.controller.signal));
    const scopes = await awaitWithSignal(resolving, entry.controller.signal);
    entry.controller.signal.throwIfAborted();
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 64
      || scopes.some(scope => !isObject(scope) || typeof scope.reload !== 'function')) fail('mcp_control_unavailable');
    const catalogs = [];
    for (const scope of scopes) {
      await current(entry, 'pending');
      const record = createStartupRecord(entry);
      const pending = Promise.resolve().then(() => scope.reload({
        identity: entry.identity,
        config: structuredClone(entry.request.config),
        signal: entry.controller.signal,
        assertCurrent: phase => current(entry, phase),
      }));
      // Keep the startup represented until it is adopted or a late handle has
      // been confirmed closed. A timeout alone is not cleanup evidence.
      const observed = pending.then(handle => {
        record.settled = true;
        record.handle = handle;
        if (entry.controller.signal.aborted || entry.state === 'closed') {
          return closeStartup(record, handle).then(() => handle);
        }
        return handle;
      }, error => {
        record.settled = true;
        record.finish({ ok: true });
        throw error;
      });
      let handle;
      try { handle = await awaitWithSignal(observed, entry.controller.signal); }
      catch (error) { throw error; }
      if (!isObject(handle) || typeof handle.close !== 'function') {
        await closeStartup(record, handle);
        fail('mcp_control_unavailable');
      }
      if (entry.controller.signal.aborted || entry.state === 'closed') {
        await closeStartup(record, handle);
        entry.controller.signal.throwIfAborted();
        fail('mcp_control_stale');
      }
      entry.handles.push(handle);
      record.finish({ ok: true });
      catalogs.push(normalizeMcpControlTools(handle.tools));
      await current(entry, 'pending');
    }
    const first = catalogs[0];
    if (catalogs.some(catalog => canonical(catalog) !== canonical(first))) fail('mcp_control_catalog_invalid');
    const response = Object.freeze({ protocol: 1, ...entry.identity, tools: first });
    if (serializedBytes(response) > MAX_RESPONSE_BYTES) fail('mcp_control_catalog_invalid');
    entry.state = 'staged';
    entry.tools = first;
    entry.stagedAt = Date.now();
    entry.unlinkRequest?.();
    entry.unlinkRequest = undefined;
    entry.unlinkDeadline?.();
    entry.unlinkDeadline = undefined;
    scheduleGuard(entry);
    return response;
  }

  async function reload(input, signal) {
    if (closed) fail('mcp_control_unavailable');
    if (signal !== undefined && (!signal || typeof signal.throwIfAborted !== 'function'
      || typeof signal.addEventListener !== 'function')) fail('mcp_control_invalid_request');
    signal?.throwIfAborted();
    const request = normalizeMcpControlReload(input);
    const identity = Object.freeze(Object.fromEntries(IDENTITY_KEYS.map(key => [key, request[key]])));
    const key = tupleKey(identity), digest = identityDigest(request);
    const existing = entries.get(key);
    if (existing) {
      if (existing.digest !== digest) fail('mcp_control_identity_conflict');
      if (existing.state === 'closed') fail('mcp_control_stale');
      const duplicateSignal = signal ?? new AbortController().signal;
      const guardSignal = AbortSignal.any([duplicateSignal, AbortSignal.timeout(guardTimeoutMs)]);
      let state;
      try {
        state = await awaitWithSignal(Promise.resolve(assertCurrent(identity, 'active', guardSignal, existing.request.config)), guardSignal);
      } catch { fail('mcp_control_stale'); }
      if (state !== 'pending' && state !== 'active') fail('mcp_control_stale');
      return await awaitWithSignal(existing.promise, signal ?? new AbortController().signal);
    }
    if (entries.size >= maxEntries) {
      for (const [closedKey, entry] of entries) {
        if (entry.state === 'closed' && entry.reclaimed) entries.delete(closedKey);
        if (entries.size < maxEntries) break;
      }
      if (entries.size >= maxEntries) fail('mcp_control_unavailable');
    }
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(reloadTimeoutMs);
    const entry = { key, identity, request, digest, controller, handles: [], startups: new Set(), state: 'starting', activeSeen: false, reclaimed: false,
      stagedAt: 0, guardTimer: undefined, closePromise: undefined, unlinkRequest: undefined, unlinkDeadline: undefined,
      promise: undefined, tools: undefined };
    entry.unlinkRequest = linkSignal(signal, controller);
    entry.unlinkDeadline = linkSignal(deadline, controller);
    entries.set(key, entry);
    entry.promise = perform(entry).catch(error => {
      const cleanup = closeEntry(entry, error?.code ?? 'mcp_control_unavailable');
      if (entry.controller.signal.aborted) {
        void cleanup.catch(() => {});
        throw error;
      }
      return cleanup.then(() => { throw error; });
    });
    return await awaitWithSignal(entry.promise, signal ?? new AbortController().signal);
  }

  async function cancel(input) {
    const identity = normalizeMcpControlCancel(input);
    const key = tupleKey(identity), entry = entries.get(key);
    if (entry) await closeEntry(entry);
    return Object.freeze({ protocol: 1, ...identity, cancelled: true });
  }

  async function removeConnection(input, signal) {
    if (closed) fail('mcp_control_unavailable');
    const request = normalizeMcpControlRemove(input);
    signal?.throwIfAborted();
    const matching = [...entries.values()].filter(entry => entry.identity.owner_id === request.owner_id
      && entry.identity.agent_id === request.agent_id && entry.identity.connection_id === request.connection_id);
    const closedEntries = await Promise.allSettled(matching.map(entry => closeEntry(entry, 'mcp_control_removed')));
    if (closedEntries.some(result => result.status === 'rejected')) fail('mcp_control_unavailable');
    const resolving = Promise.resolve().then(() => resolveScopes(request.owner_id, request.agent_id, signal));
    const scopes = await awaitWithSignal(resolving, signal ?? new AbortController().signal);
    signal?.throwIfAborted();
    if (!Array.isArray(scopes) || scopes.length > 64 || scopes.some(scope => !isObject(scope) || typeof scope.cancelConnection !== 'function')) {
      fail('mcp_control_unavailable');
    }
    for (const scope of scopes) {
      signal?.throwIfAborted();
      await awaitWithSignal(Promise.resolve().then(() => scope.cancelConnection({ connectionId: request.connection_id, signal })),
        signal ?? new AbortController().signal);
    }
    return Object.freeze({ protocol: 1, owner_id: request.owner_id, agent_id: request.agent_id,
      connection_id: request.connection_id, removed: true });
  }

  async function dispose() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...entries.values()].map(entry => closeEntry(entry, 'mcp_control_host_closed')));
  }

  return Object.freeze({ reload, cancel, removeConnection, dispose });
}

/** Adapter index.js should dispatch this handler only after its existing
 * Bearer-token authentication and with the existing request AbortSignal. */
export function createMcpControlRouteHandler(host) {
  if (!host || typeof host.reload !== 'function' || typeof host.cancel !== 'function' || typeof host.removeConnection !== 'function') fail('mcp_control_host_invalid');
  return async ({ method, url, body, signal }) => {
    if (method !== 'POST' || ![RELOAD_PATH, CANCEL_PATH, REMOVE_PATH].includes(url)) return { status: 404, value: { error: 'not_found' } };
    try {
      if (url === RELOAD_PATH) return { status: 200, value: await host.reload(body, signal) };
      if (url === CANCEL_PATH) return { status: 200, value: await host.cancel(body) };
      return { status: 200, value: await host.removeConnection(body, signal) };
    } catch (error) { return signal?.aborted ? { status: 499, value: { reason_code: 'mcp_control_cancelled' } } : protocolError(error); }
  };
}
