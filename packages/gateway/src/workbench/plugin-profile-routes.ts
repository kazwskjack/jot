import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type Input = Record<string, unknown>;
type Actor = (request: FastifyRequest) => string;
type ReceiptValue = { state: 'reserved' | 'dispatched' | 'settled' | 'unknown'; response?: unknown; responseStatus?: number };
type ReceiptContext = { ownerId: string; profileId: string; operation: string; operationId: string; actionSha256: string };
type RouteContext = { ownerId: string; routeOperation: string; operation: string; operationId: string; actionSha256: string };
type ReceiptExecutor = {
  lookupOperation(ownerId: string, operationId: string): {
    route_operation: string; request_sha256: string; operation_id: string; operation: string; state: ReceiptValue['state']; response?: unknown; response_status?: number;
  };
  bindReservation(input: RouteContext): ReceiptValue;
  lookupReservation(input: RouteContext): ReceiptValue;
  markUnknownReservation(input: RouteContext): ReceiptValue;
  claim(input: ReceiptContext): { dispatch: boolean; state: ReceiptValue['state']; response?: unknown; responseStatus?: number };
  settle(input: ReceiptContext, response: unknown): ReceiptValue;
  markUnknown(input: ReceiptContext): ReceiptValue;
};
export type PluginProfileClient = {
  pluginProfileBundles(ownerId: string, signal?: AbortSignal): Promise<unknown>;
  installPluginProfileBundle(input: { ownerId: string; operationId: string; spec: string; enabled: boolean }, signal?: AbortSignal): Promise<unknown>;
  enablePluginProfileBundle(input: { ownerId: string; operationId: string; name: string; enabled: boolean }, signal?: AbortSignal): Promise<unknown>;
  removePluginProfileBundle(input: { ownerId: string; operationId: string; name: string }, signal?: AbortSignal): Promise<unknown>;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_ID = /^[\x21-\x7e]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const OPERATION = new Set(['plugin.bundle.install', 'plugin.bundle.enable', 'plugin.bundle.remove']);
const MAX_PUBLIC_BYTES = 64 * 1024;

function fail(code: string): never { throw Object.assign(new Error(code), {code}); }

function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('plugin_profile_request_invalid');
  return value as Input;
}

function exact(value: Input, keys: string[]): void {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail('plugin_profile_request_invalid');
}

function noQuery(request: FastifyRequest): void {
  if (Object.keys(object(request.query)).length) fail('plugin_profile_request_invalid');
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) fail('idempotency_key_invalid');
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
  }
  fail('plugin_profile_request_invalid');
}

function actionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function safeSpec(value: string): boolean {
  if (/(?:[?&]|^)(?:token|access_token|password|passwd|secret|api_key)=/i.test(value)) return false;
  if (!value.includes('://')) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function safeBundleList(value: unknown): { bundles: Array<{ name: string; installed?: boolean; enabled?: boolean; version?: string }> } {
  if (!Array.isArray(value) || value.length > 512) fail('plugin_profile_response_invalid');
  const bundles = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('plugin_profile_response_invalid');
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 192) fail('plugin_profile_response_invalid');
    const bundle: { name: string; installed?: boolean; enabled?: boolean; version?: string } = {name: row.name};
    for (const key of ['installed', 'enabled'] as const) if (row[key] !== undefined) {
      if (typeof row[key] !== 'boolean') fail('plugin_profile_response_invalid');
      bundle[key] = row[key] as boolean;
    }
    if (row.version !== undefined) {
      if (typeof row.version !== 'string' || row.version.length > 128) fail('plugin_profile_response_invalid');
      bundle.version = row.version;
    }
    return bundle;
  });
  const response = {bundles};
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_PUBLIC_BYTES) fail('plugin_profile_response_invalid');
  return response;
}

function routeContext(request: FastifyRequest, ownerId: string, operation: string, action: unknown): RouteContext {
  if (!OPERATION.has(operation)) fail('plugin_profile_request_invalid');
  const path = request.url.split('?')[0] ?? '';
  return {ownerId, routeOperation: `${request.method} ${path}`, operation,
    operationId: idempotencyKey(request), actionSha256: actionDigest(action)};
}

function publicError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({error: {code}});
}

function publicHandler(handler: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'private, no-store');
    try { return await handler(request, reply); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'plugin_profile_request_invalid' || code === 'idempotency_key_invalid') {
        return publicError(reply, 422, code.toUpperCase());
      }
      throw error;
    }
  };
}

function mapInternalReceiptError(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : '';
  if (code === 'unauthorized') return {status: 401, code: 'UNAUTHORIZED'};
  if (code === 'plugin_profile_receipt_not_found') return {status: 404, code: 'PLUGIN_PROFILE_RECEIPT_NOT_FOUND'};
  if (code.endsWith('_scope_mismatch') || code.endsWith('_forbidden')) return {status: 403, code: code.toUpperCase()};
  if (code.endsWith('_invalid') || code.endsWith('_corrupt')) return {status: 422, code: code.toUpperCase()};
  return {status: 409, code: code ? code.toUpperCase() : 'PLUGIN_PROFILE_RECEIPT_CONFLICT'};
}

function toReceiptContext(input: Input): ReceiptContext {
  exact(input, ['ownerId', 'profileId', 'operation', 'operationId', 'actionSha256']);
  if (typeof input.ownerId !== 'string' || !ID.test(input.ownerId)
    || typeof input.profileId !== 'string' || !ID.test(input.profileId)
    || typeof input.operation !== 'string' || !OPERATION.has(input.operation)
    || typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)
    || typeof input.actionSha256 !== 'string' || !HASH.test(input.actionSha256)) fail('plugin_profile_receipt_request_invalid');
  return {ownerId: input.ownerId, profileId: input.profileId, operation: input.operation,
    operationId: input.operationId, actionSha256: input.actionSha256};
}

function serviceAuthorized(request: FastifyRequest, token: string): boolean {
  const actual = request.headers.authorization;
  if (typeof actual !== 'string' || token.length < 16) return false;
  const candidate = Buffer.from(actual), expected = Buffer.from(`Bearer ${token}`);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function receiptBody(request: FastifyRequest, action: 'claim' | 'settle' | 'unknown', token: string): Input {
  if (!serviceAuthorized(request, token)) fail('unauthorized');
  const input = object(request.body);
  const keys = action === 'settle'
    ? ['ownerId', 'profileId', 'operation', 'operationId', 'actionSha256', 'response']
    : ['ownerId', 'profileId', 'operation', 'operationId', 'actionSha256'];
  exact(input, keys);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_PUBLIC_BYTES) fail('plugin_profile_receipt_request_invalid');
  return input;
}

/** The shared preHandler reserves each command; the original receipt executor owns dispatch and settlement. */
export function registerPluginProfileRoutes(app: FastifyInstance, options: {
  actor: Actor;
  client: PluginProfileClient;
  receipts: ReceiptExecutor;
  internalChannelToken: string;
}): void {
  const {actor, client, receipts, internalChannelToken} = options;
  if (typeof internalChannelToken !== 'string' || internalChannelToken.length < 16) throw new Error('plugin_profile_routes_config_invalid');

  app.get('/v1/plugin-profile/bundles', publicHandler(async request => {
    noQuery(request);
    const ownerId = actor(request);
    return safeBundleList(await client.pluginProfileBundles(ownerId));
  }));

  app.get('/v1/plugin-profile/operations/:operationId', publicHandler(async (request, reply) => {
    noQuery(request);
    const operationId = object(request.params).operationId;
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('plugin_profile_request_invalid');
    try { return receipts.lookupOperation(actor(request), operationId); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'plugin_profile_receipt_not_found') return publicError(reply, 404, 'PLUGIN_PROFILE_RECEIPT_NOT_FOUND');
      throw error;
    }
  }));

  async function mutate(request: FastifyRequest, reply: FastifyReply, operation: string, action: Input,
    call: (ownerId: string, operationId: string) => Promise<unknown>) {
    const ownerId = actor(request), context = routeContext(request, ownerId, operation, action);
    let reservation: ReceiptValue;
    try { reservation = receipts.bindReservation(context); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'plugin_profile_receipt_state_conflict' || code === 'idempotency_conflict') return publicError(reply, 409, 'IDEMPOTENCY_CONFLICT');
      return publicError(reply, 409, 'PLUGIN_PROFILE_OPERATION_UNAVAILABLE');
    }
    if (reservation.state === 'settled') return reply.code(reservation.responseStatus ?? 200).send(reservation.response);
    if (reservation.state === 'unknown') return publicError(reply, 409, 'PLUGIN_OPERATION_UNKNOWN');
    try {
      await call(ownerId, context.operationId);
    } catch (error) {
      const status = Number((error as {status?: unknown})?.status);
      if ([401, 403, 422].includes(status)) return publicError(reply, status === 401 ? 503 : status, status === 401 ? 'PLUGIN_PROFILE_UNAVAILABLE' : 'PLUGIN_OPERATION_NOT_AUTHORIZED');
      if (status === 409) {
        try {
          const current = receipts.lookupReservation(context);
          if (current.state === 'settled') return reply.code(current.responseStatus ?? 200).send(current.response);
          if (current.state === 'unknown') return publicError(reply, 409, 'PLUGIN_OPERATION_UNKNOWN');
          receipts.markUnknownReservation(context);
        } catch {}
        return publicError(reply, 409, 'PLUGIN_OPERATION_UNKNOWN');
      }
      try {
        const current = receipts.markUnknownReservation(context);
        if (current.state === 'settled') return reply.code(current.responseStatus ?? 200).send(current.response);
      } catch {}
      return publicError(reply, 409, 'PLUGIN_OPERATION_UNKNOWN');
    }
    try {
      const settled = receipts.lookupReservation(context);
      if (settled.state === 'settled') return reply.code(settled.responseStatus ?? 200).send(settled.response);
      if (settled.state === 'unknown') return publicError(reply, 409, 'PLUGIN_OPERATION_UNKNOWN');
      receipts.markUnknownReservation(context);
    } catch {
      try { receipts.markUnknownReservation(context); } catch {}
    }
    return publicError(reply, 409, 'PLUGIN_OPERATION_UNKNOWN');
  }

  app.post('/v1/plugin-profile/bundles', {config:{pluginProfileMutation:true}}, publicHandler(async (request, reply) => {
    noQuery(request);
    const input = object(request.body); exact(input, ['spec', 'enabled']);
    if (typeof input.spec !== 'string' || !input.spec.trim() || input.spec.length > 512 || !safeSpec(input.spec) || typeof input.enabled !== 'boolean') fail('plugin_profile_request_invalid');
    const action = {spec: input.spec, enabled: input.enabled};
    return mutate(request, reply, 'plugin.bundle.install', action,
      (ownerId, operationId) => client.installPluginProfileBundle({ownerId, operationId, ...action}));
  }));

  app.patch('/v1/plugin-profile/bundles/:bundleName/enabled', {config:{pluginProfileMutation:true}}, publicHandler(async (request, reply) => {
    noQuery(request);
    const params = object(request.params), name = params.bundleName;
    if (typeof name !== 'string' || !name.trim() || name.length > 192) fail('plugin_profile_request_invalid');
    const input = object(request.body); exact(input, ['enabled']);
    if (typeof input.enabled !== 'boolean') fail('plugin_profile_request_invalid');
    const action = {name, enabled: input.enabled};
    return mutate(request, reply, 'plugin.bundle.enable', action,
      (ownerId, operationId) => client.enablePluginProfileBundle({ownerId, operationId, ...action}));
  }));

  app.delete('/v1/plugin-profile/bundles/:bundleName', {config:{pluginProfileMutation:true}}, publicHandler(async (request, reply) => {
    noQuery(request);
    const params = object(request.params), name = params.bundleName;
    if (typeof name !== 'string' || !name.trim() || name.length > 192) fail('plugin_profile_request_invalid');
    const input = object(request.body ?? {}); exact(input, []);
    const action = {name};
    return mutate(request, reply, 'plugin.bundle.remove', action,
      (ownerId, operationId) => client.removePluginProfileBundle({ownerId, operationId, name}));
  }));

  for (const action of ['claim', 'settle', 'unknown'] as const) {
    app.post(`/internal/v1/workbench/plugin-profile/receipt/${action}`, {config:{pluginProfileInternal:true}}, async (request, reply) => {
      try {
        const input = receiptBody(request, action, internalChannelToken);
        const {response, ...contextInput} = input;
        const context = toReceiptContext(contextInput);
        const result = action === 'claim' ? receipts.claim(context)
          : action === 'settle' ? receipts.settle(context, response)
            : receipts.markUnknown(context);
        return reply.code(200).send(result);
      } catch (error) {
        const mapped = mapInternalReceiptError(error);
        return reply.code(mapped.status).send({error: {code: mapped.code}});
      }
    });
  }
}
