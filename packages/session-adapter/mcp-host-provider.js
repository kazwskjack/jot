import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpAgentRuntimeProvider } from './mcp-agent-provider.js';

export const name = 'jot-mcp-host-provider';
export const inject = ['profileContext', 'agents'];

export async function apply(ctx) {
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
  const mcpPlugin = await import(pathToFileURL(clientEntry).href);
  if (mcpPlugin.name !== 'mcp-client' || typeof mcpPlugin.apply !== 'function') {
    throw Error('jot_mcp_host_client_invalid');
  }

  // This Host has no trusted stdio allowlist, scoped HTTP fetcher, or secret-ref
  // resolver. The provider therefore keeps both transports fail-closed. Never
  // derive command, network, credential, or owner authorization from model input.
  const provider = createMcpAgentRuntimeProvider({ mcpPlugin });
  ctx.on('credentials/reference-updated', () => provider.invalidateCredentials());
  ctx.on('agent/created', ({agent}) => provider.setup(agent.ctx, agent));
  for (const agent of ctx.agents.list()) provider.setup(agent.ctx, agent);
  ctx.provide('jotMcpRuntimeProvider', provider);
  ctx.effect(() => async () => provider.close(), 'jotMcpHostProvider()');
}
