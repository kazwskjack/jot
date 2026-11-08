import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { McpRegistryService } from './mcp-registry.ts';

type Input = Record<string, unknown>;
type Actor = (request: FastifyRequest) => string;
type Atomic = (request: FastifyRequest, status: number, operation: () => unknown) => unknown;
type ReadUnknownOperations = (ownerId: string, agentId: string) => Array<{ operation_id: string; state: 'unknown'; updated_at: string }>;
function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_mcp_request');
  return value as Input;
}
function body(request: FastifyRequest, allowed: string[]): Input {
  const input = object(request.body);
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('invalid_mcp_request');
  return input;
}
function params<K extends string>(request: FastifyRequest, keys: readonly K[]): Record<K, string> {
  const input = object(request.params), result = {} as Record<K, string>;
  if (Object.keys(input).some(key => !keys.some(allowed => allowed === key))) throw new Error('invalid_mcp_request');
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== 'string' || !value || value.length > 192) throw new Error('invalid_mcp_request');
    result[key] = value;
  }
  return result;
}
function noQuery(request: FastifyRequest): void {
  if (Object.keys(object(request.query)).length) throw new Error('invalid_mcp_request');
}
function version(input: Input): number {
  if (!Number.isSafeInteger(input.expected_version) || Number(input.expected_version) < 1) throw new Error('invalid_expected_version');
  return Number(input.expected_version);
}

/** Owner-scoped MCP status and configuration routes. Runtime discovery and execution use internal routes. */
export function registerWorkbenchMcpRoutes(app: FastifyInstance, registry: McpRegistryService, actor: Actor,
	atomic: Atomic = (_request, _status, operation) => operation(), readUnknownOperations?: ReadUnknownOperations): void {
  app.get('/v1/agents/:agentId/mcp', async request => {
    noQuery(request);
    const { agentId } = params(request, ['agentId']);
    return registry.list(actor(request), agentId);
  });
  if (readUnknownOperations) app.get('/v1/agents/:agentId/mcp/operations', async request => {
    noQuery(request);
    const { agentId } = params(request, ['agentId']);
    const ownerId = actor(request);
    registry.list(ownerId, agentId);
    return { items: readUnknownOperations(ownerId, agentId) };
  });
  app.post('/v1/agents/:agentId/mcp/connections', async (request, reply) => {
    noQuery(request);
    const { agentId } = params(request, ['agentId']);
    return reply.code(201).send(atomic(request, 201, () => registry.create(actor(request), agentId, request.body)));
  });
  app.patch('/v1/agents/:agentId/mcp/connections/:connectionId/config', async request => {
    noQuery(request);
    const { agentId, connectionId } = params(request, ['agentId', 'connectionId']);
    const input = body(request, ['expected_version', 'config']);
    version(input);
    return atomic(request, 200, () => registry.stageConfig(actor(request), agentId, connectionId, input));
  });
  app.patch('/v1/agents/:agentId/mcp/connections/:connectionId/enabled', async request => {
    noQuery(request);
    const { agentId, connectionId } = params(request, ['agentId', 'connectionId']);
    const input = body(request, ['expected_version', 'enabled']);
    version(input);
    return atomic(request, 200, () => registry.setEnabled(actor(request), agentId, connectionId, input));
  });
  app.put('/v1/agents/:agentId/mcp/connections/:connectionId/tools', async request => {
    noQuery(request);
    const { agentId, connectionId } = params(request, ['agentId', 'connectionId']);
    const input = body(request, ['expected_version', 'tool_ids']);
    version(input);
    return atomic(request, 200, () => registry.setAllowedTools(actor(request), agentId, connectionId, input));
  });
  app.post('/v1/agents/:agentId/mcp/connections/:connectionId/reload', async (request, reply) => {
    noQuery(request);
    const { agentId, connectionId } = params(request, ['agentId', 'connectionId']);
    const input = body(request, ['expected_version']);
    return reply.code(202).send(atomic(request, 202, () => registry.requestReload(actor(request), agentId, connectionId, version(input))));
  });
  app.delete('/v1/agents/:agentId/mcp/connections/:connectionId', async (request, reply) => {
    noQuery(request);
    const { agentId, connectionId } = params(request, ['agentId', 'connectionId']);
    const input = body(request, ['expected_version']);
    return reply.code(202).send(atomic(request, 202, () => registry.remove(actor(request), agentId, connectionId, version(input))));
  });
}
