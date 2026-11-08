import {loadScopedMcpStdioRuntime} from './mcp-stdio-runtime.js';
import {createMcpHostStdioAuthorization,createMcpHostStdioTransports,normalizeMcpStdioPolicy} from './mcp-host-stdio.js';
import {createMcpHostHttpFetch,normalizeMcpHttpPolicy} from './mcp-host-http.js';
import {resolveOwnerBoundDshProfileContext} from './dsh-profile-binding.js';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpAgentRuntimeProvider } from './mcp-agent-provider.js';

export const name = 'jot-mcp-host-provider';
export const inject = ['profileContext', 'agents'];

export async function apply(ctx,config={}) {
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!['httpPolicy','stdioPolicy'].includes(key)))throw Error('jot_mcp_host_config_invalid');
  const stdioPolicy=config.stdioPolicy===undefined?undefined:normalizeMcpStdioPolicy(config.stdioPolicy);
  const httpPolicy=config.httpPolicy===undefined?undefined:normalizeMcpHttpPolicy(config.httpPolicy);
  const anchor = ctx.get('profileContext')?.installAnchor;
  if (typeof anchor !== 'string' || !isAbsolute(anchor)) throw Error('jot_mcp_host_installation_missing');
  const require = createRequire(anchor);
  let hostManifest, clientManifestPath, clientEntry;
  try {
    hostManifest = JSON.parse(await readFile(anchor, 'utf8'));
    clientManifestPath = require.resolve('@deepseek-ai/dsh-mcp-client/package.json');
    clientEntry = require.resolve('@deepseek-ai/dsh-mcp-client');
  } catch {
    throw Error('jot_mcp_host_client_unavailable');
  }
  if (hostManifest.name !== '@deepseek-ai/dsh' || hostManifest.version !== '0.2.1-rc.2') {
    throw Error('jot_mcp_host_runtime_version_mismatch');
  }
  let clientManifest;
  try { clientManifest = JSON.parse(await readFile(clientManifestPath, 'utf8')); }
  catch { throw Error('jot_mcp_host_client_unavailable'); }
  if (clientManifest.name !== '@deepseek-ai/dsh-mcp-client' || clientManifest.version !== '0.2.1-rc.2') {
    throw Error('jot_mcp_host_client_version_mismatch');
  }
  const stdioRuntime=stdioPolicy?await loadScopedMcpStdioRuntime(clientEntry,()=>ctx.logger.warn('mcp_stdio_stderr_received')):undefined;
  const mcpPlugin = stdioRuntime?.plugin??await import(pathToFileURL(clientEntry).href);
  if (mcpPlugin.name !== 'mcp-client' || typeof mcpPlugin.apply !== 'function') {
    throw Error('jot_mcp_host_client_invalid');
  }

  const readIdentity=()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext'));
  if([httpPolicy,stdioPolicy].some(policy=>policy&&readIdentity().ownerId!==policy.owner_id))throw Error('jot_mcp_host_owner_invalid');
  const authorizeStdio=stdioPolicy?createMcpHostStdioAuthorization({policy:stdioPolicy,readIdentity}):undefined;
  const httpFetchForConnection=httpPolicy?createMcpHostHttpFetch({policy:httpPolicy,readIdentity,
    readCredentials:()=>ctx.get('credentials')}):undefined;
  const stdioTransportForConnection=stdioPolicy?createMcpHostStdioTransports({policy:stdioPolicy,readIdentity,
    readCredentials:()=>ctx.get('credentials'),authorize:authorizeStdio,createTransport:stdioRuntime.createTransport}):undefined;
  const provider = createMcpAgentRuntimeProvider({mcpPlugin,...(httpFetchForConnection?{httpFetchForConnection}:{}),
    ...(authorizeStdio?{authorizeStdio}:{}),...(stdioTransportForConnection?{stdioTransportForConnection}:{})});
  ctx.on('credentials/reference-updated', () => provider.invalidateCredentials());
  ctx.on('agent/created', ({agent}) => provider.setup(agent.ctx, agent));
  for (const agent of ctx.agents.list()) provider.setup(agent.ctx, agent);
  ctx.provide('jotMcpRuntimeProvider', provider);
  ctx.effect(() => async () => provider.close(), 'jotMcpHostProvider()');
}
