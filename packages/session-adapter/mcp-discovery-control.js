import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {normalizeMcpControlReload} from './mcp-control-host.js';

/** Reuse live Workbench scopes, or own a discovery-only native Agent for one operation. */
export function createMcpDiscoveryScopeResolver({agents, provider, readState, readOwnerBinding}) {
  if (typeof provider?.resolveReloadScopes !== 'function' || typeof readState !== 'function'
    || typeof readOwnerBinding !== 'function') throw new Error('mcp_control_unavailable');

  return async (ownerId, agentId, signal) => {
    const existing = await provider.resolveReloadScopes(ownerId, agentId, signal);
    if (!Array.isArray(existing)) throw new Error('mcp_control_unavailable');
    if (existing.length) return existing;
    if (typeof agents?.create !== 'function' || typeof provider.bindReloadScope !== 'function') {
      throw new Error('mcp_control_unavailable');
    }
    return [Object.freeze({
      async cancelConnection({signal: requestSignal} = {}) {
        // The control Host already closes all matching discovery handles before resolving scopes.
        requestSignal?.throwIfAborted();
      },
      async reload(input) {
        const request = normalizeMcpControlReload({protocol: 1, ...input.identity, config: input.config});
        const {protocol, config, ...identity} = request;
        if (identity.owner_id !== ownerId || identity.agent_id !== agentId) throw new Error('mcp_control_stale');
        const original = readOwnerBinding();
        const checkOwner = () => {
          input.signal?.throwIfAborted();
          const current = readOwnerBinding();
          if (original.ownerId !== ownerId || current.ownerId !== ownerId || current.profileId !== original.profileId) {
            throw new Error('mcp_control_stale');
          }
        };
        const current = async requestSignal => {
          checkOwner(); requestSignal?.throwIfAborted();
          const state = await readState(identity, requestSignal, config);
          checkOwner(); requestSignal?.throwIfAborted();
          if (state?.owner_id !== ownerId || state.agent_id !== agentId || !isDeepStrictEqual(state.identity, identity)
            || !Number.isSafeInteger(state.capability_epoch) || state.capability_epoch < 1) throw new Error('mcp_control_stale');
          return state;
        };
        const state = await current(input.signal);
        if (state.state !== 'pending') throw new Error('mcp_control_stale');
        const handle = await agents.create({
          sessionId: `mcp-discovery-${randomUUID()}`, agentOptions: {}, signal: input.signal,
          setup(agentCtx, agent) {
            // Discovery registers native tool definitions but never drives a model or dispatches tools.
            agentCtx.tools.guard(() => 'MCP_DISCOVERY_EXECUTION_FORBIDDEN');
            agentCtx.on('agent/pre-step', (event, next) => event.agent === agent ? {kind: 'reject'} : next(), {prepend: true});
          },
        });
        let unbind, mounted, closing;
        const close = () => {
          closing ??= (async () => {
            const failures = [];
            try { await mounted?.close(); } catch (error) { failures.push(error); }
            try { await unbind?.(); } catch (error) { failures.push(error); }
            try { await handle.dispose(); } catch (error) { failures.push(error); }
            if (failures.length) throw new Error('mcp_discovery_close_failed');
          })();
          return closing;
        };
        try {
          checkOwner();
          unbind = provider.bindReloadScope({
            agent: handle.agent, ownerId, agentId, capabilityEpoch: state.capability_epoch,
            connections: [], discoveryOnly: true,
            readOriginalState: async (_scope, expected, requestSignal) => {
              if (!isDeepStrictEqual(expected, identity)) throw new Error('mcp_control_stale');
              const live = await current(requestSignal);
              if (live.state === 'pending' && live.capability_epoch !== state.capability_epoch) throw new Error('mcp_control_stale');
              // The binding records its admission epoch. Publishing the approved
              // catalogue advances the current role epoch without granting execution here.
              return {...live, capability_epoch: state.capability_epoch};
            },
          });
          if (typeof unbind?.scope?.reload !== 'function') throw new Error('mcp_control_unavailable');
          mounted = await unbind.scope.reload(input);
          checkOwner();
          return Object.freeze({tools: mounted.tools, close, signal: unbind.signal});
        } catch (error) {
          await close();
          throw error;
        }
      },
    })];
  };
}
