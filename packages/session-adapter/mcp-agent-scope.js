import {normalizeMcpControlTools} from './mcp-control-host.js';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

async function createScopedHttpForwarder(config, hostFetch, signal) {
  if (config.transport !== 'streamable-http') throw new Error('mcp_agent_scope_invalid');
  const upstream = new URL(config.url);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.hash) {
    throw new Error('mcp_agent_scope_invalid');
  }
  const endpointPath = '/' + randomBytes(24).toString('hex');
  const controllers = new Set();
  const requestHeaders = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'last-event-id'];
  const responseHeaders = ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version', 'retry-after', 'www-authenticate'];
  const server = createServer(async (request, response) => {
    if (request.url !== endpointPath || !['GET', 'POST', 'DELETE'].includes(request.method)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      signal?.throwIfAborted();
      const headers = new Headers();
      for (const name of requestHeaders) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const result = await hostFetch(config.url, {
        method: request.method, headers, signal: controller.signal, redirect: 'manual',
        ...(request.method === 'POST' ? {body: Readable.toWeb(request), duplex: 'half'} : {}),
      });
      // The SDK must never follow an upstream redirect outside scoped Host fetch.
      if (result.status >= 300 && result.status < 400) {
        await result.body?.cancel();
        throw new Error('mcp_scoped_http_redirect');
      }
      const outgoing = {};
      for (const name of responseHeaders) {
        const value = result.headers.get(name);
        if (value !== null) outgoing[name] = value;
      }
      response.writeHead(result.status, outgoing);
      if (result.body) await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502);
        response.end();
      }
    } finally {
      controllers.delete(controller);
      request.off('aborted', abort);
      response.off('close', abort);
      signal?.removeEventListener('abort', abort);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closing;
  return {
    url: 'http://127.0.0.1:' + server.address().port + endpointPath,
    close() {
      closing ??= new Promise(resolve => {
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        server.close(resolve);
      });
      return closing;
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMcpPlugin(value) {
  return isObject(value) && value.name === 'mcp-client' && typeof value.apply === 'function';
}

function abortError(signal) {
  try { signal.throwIfAborted(); } catch (error) { return error; }
  const error = new Error('mcp_agent_scope_aborted');
  error.name = 'AbortError';
  return error;
}

function awaitFiber(fiber, signal) {
  if (!signal) return Promise.resolve(fiber);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => settle(reject, abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(fiber).then(value => settle(resolve, value), error => settle(reject, error));
    if (signal.aborted) onAbort();
  });
}

/**
 * Hold exact AgentSetup contexts and mount only the bound DSH MCP plugin inside
 * them. The returned close handle owns only the child Cordis Fiber; Agent
 * teardown remains with the original AgentHandle owner. A Host-only fetch
 * closure may be injected for one mount without becoming plugin config.
 */
export function createMcpAgentScopeRegistry({ mcpPlugin } = {}) {
  if (!isMcpPlugin(mcpPlugin)) throw new Error('mcp_agent_plugin_invalid');
  const contexts = new WeakMap();
  const agentsByContext = new WeakMap();

  function setup(agentCtx, agent) {
    if (!isObject(agent) || !isObject(agentCtx) || typeof agentCtx.plugin !== 'function') {
      throw new Error('mcp_agent_scope_invalid');
    }
    if (contexts.has(agent) || agentsByContext.has(agentCtx)) throw new Error('mcp_agent_scope_conflict');
    contexts.set(agent, agentCtx);
    agentsByContext.set(agentCtx, agent);
  }

  function dispose(agentCtx, agent) {
    if (contexts.get(agent) === agentCtx) contexts.delete(agent);
    if (agentsByContext.get(agentCtx) === agent) agentsByContext.delete(agentCtx);
  }

  /** `config` must already be authorized and transport-approved by the Host. */
  async function mount(options) {
    if (!isObject(options) || Object.keys(options).some(key => !['agent', 'config', 'signal', 'hostFetch', 'hostTransport', 'captureCatalogue'].includes(key))) {
      throw new Error('mcp_agent_scope_invalid');
    }
    const { agent, config, signal, hostFetch, hostTransport, captureCatalogue = false } = options;
    if (typeof captureCatalogue !== 'boolean') throw new Error('mcp_agent_scope_invalid');
    if (!isObject(agent) || signal !== undefined && (!signal || typeof signal.throwIfAborted !== 'function'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      throw new Error('mcp_agent_scope_invalid');
    }
    if (hostFetch !== undefined && typeof hostFetch !== 'function') throw new Error('mcp_agent_scope_invalid');
    if(hostTransport!==undefined&&(typeof hostTransport!=='function'||mcpPlugin.hostTransportProtocol!==1||config.transport!=='stdio'))throw Error('mcp_agent_scope_invalid');
    signal?.throwIfAborted();
    const agentCtx = contexts.get(agent);
    if (!agentCtx) throw new Error('mcp_agent_scope_unavailable');

    let fiber, forwarder, catalogue;
    try {
      if(hostFetch!==undefined)forwarder=await createScopedHttpForwarder(config,hostFetch,signal);
      const observe = captureCatalogue && mcpPlugin.hostCatalogueProtocol === 1 ? value => {
        if (value?.serverName !== config.serverName) throw new Error('mcp_reload_catalog_unproven');
        catalogue = structuredClone(normalizeMcpControlTools(value.tools));
      } : undefined;
      const plugin = hostTransport || observe ? {...mcpPlugin, apply(inner, value) {
        if (hostTransport) inner.provide('jotMcpTransportFactory', hostTransport);
        if (observe) inner.provide('jotMcpCatalogueObserver', observe);
        return mcpPlugin.apply(inner, value);
      }} : mcpPlugin;
      if ((hostTransport || observe) && typeof agentCtx.isolate !== 'function') throw new Error('mcp_agent_scope_invalid');
      let mountContext = agentCtx;
      if (hostTransport) mountContext = mountContext.isolate('jotMcpTransportFactory');
      if (observe) mountContext = mountContext.isolate('jotMcpCatalogueObserver');
      fiber = mountContext.plugin(plugin, forwarder?{...config,url:forwarder.url}:config);
      if (!fiber || typeof fiber.then !== 'function' || typeof fiber.dispose !== 'function') {
        throw new Error('mcp_agent_fiber_invalid');
      }
      await awaitFiber(fiber, signal);
      signal?.throwIfAborted();
      if (contexts.get(agent) !== agentCtx || agentsByContext.get(agentCtx) !== agent) {
        throw new Error('mcp_agent_scope_unavailable');
      }
    } catch {
      await forwarder?.close();
      try { await fiber?.dispose?.(); } catch { /* Preserve startup and cancellation outcomes. */ }
      signal?.throwIfAborted();
      throw new Error('mcp_agent_plugin_start_failed');
    }

    let closePromise;
    return Object.freeze({
      ...(captureCatalogue && mcpPlugin.hostCatalogueProtocol === 1 ? {readCatalogue() {
        if (!catalogue) throw new Error('mcp_reload_catalog_unproven');
        return structuredClone(catalogue);
      }} : {}),
      close() {
        if (!closePromise) closePromise = Promise.all([Promise.resolve().then(()=>fiber.dispose()),forwarder?.close()]).then(()=>undefined);
        return closePromise;
      },
    });
  }

  return Object.freeze({ setup, mount, dispose });
}
