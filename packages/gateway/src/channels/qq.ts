import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

export type QQWebhookHeaders = Headers | Record<string, string | undefined>;

export interface QQChannelIntake {
  accept(input: Record<string, unknown>, options: { providerSignatureVerified: boolean }): unknown;
}

export interface QQWebhookConfig {
  appId: string;
  botSecret: string;
  intake: QQChannelIntake;
}

export interface QQWebhookRequest {
  headers: QQWebhookHeaders;
  body: Uint8Array;
}

export interface QQWebhookResponse {
  status: number;
  body: Record<string, unknown>;
  intake_result?: unknown;
  ignored?: true;
}

export type QQTransport = (url: URL, init: RequestInit) => Promise<Response>;

export interface QQDeliveryConfig {
  appId: string;
  appSecret: string;
  timeoutMs?: number;
}

interface QQReplyContext {
  principal: string;
  providerMessageId: string;
  scope: 'c2c' | 'group';
  targetId: string;
}

/**
 * Process QQ HTTP callbacks using the existing channel intake contract.
 * This module intentionally owns no identity, conversation, event, or outbox
 * tables; intake and delivery lookups use the gateway's existing records.
 */
export function createQQWebhookAdapter(config: QQWebhookConfig) {
  if (!config || typeof config.appId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(config.appId)
    || !config.intake || typeof config.intake.accept !== 'function') {
    throw new Error('qq_config_invalid');
  }
  const privateKey = qqPrivateKey(config.botSecret);
  const publicKey = createPublicKey(privateKey);

  return {
    async handle(request: QQWebhookRequest): Promise<QQWebhookResponse> {
      if (!(request.body instanceof Uint8Array) || request.body.byteLength < 1
        || request.body.byteLength > MAX_CALLBACK_BYTES) throw new Error('qq_callback_body_invalid');
      if (header(request.headers, 'x-bot-appid') !== config.appId) throw new Error('qq_app_id_invalid');
      const payload = parsePayload(request.body);
      if (payload.op === 13) {
        const data = object(payload.d);
        if (!data || typeof data.plain_token !== 'string' || !data.plain_token
          || data.plain_token.length > 512 || typeof data.event_ts !== 'string'
          || !/^\d{1,20}$/.test(data.event_ts)) throw new Error('qq_validation_payload_invalid');
        if (isDispatchSignatureMessage(data.event_ts, data.plain_token)) {
          throw new Error('qq_validation_payload_invalid');
        }
        const message = Buffer.from(`${data.event_ts}${data.plain_token}`, 'utf8');
        return { status: 200, body: {
          plain_token: data.plain_token,
          signature: sign(null, message, privateKey).toString('hex'),
        } };
      }
      if (payload.op !== 0) throw new Error('qq_callback_opcode_invalid');

      const timestamp = header(request.headers, 'x-signature-timestamp');
      const signature = header(request.headers, 'x-signature-ed25519');
      if (!verifyQQWebhookSignature({ secret: config.botSecret, timestamp, signature,
        body: request.body, publicKey })) throw new Error('qq_signature_invalid');

      const normalized = normalizeQQMessage(payload);
      if (!normalized) return { status: 200, body: { op: 12 }, ignored: true };
      const intakeResult = config.intake.accept(normalized, { providerSignatureVerified: true });
      return { status: 200, body: { op: 12 }, intake_result: intakeResult };
    },
  };
}

/** Tencent signs timestamp + exact raw HTTP body with Ed25519. */
export function verifyQQWebhookSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  body: Uint8Array;
} & { publicKey?: ReturnType<typeof createPublicKey> }): boolean {
  if (typeof input.timestamp !== 'string' || !/^\d{1,20}$/.test(input.timestamp)
    || typeof input.signature !== 'string' || !/^[a-fA-F0-9]{128}$/.test(input.signature)
    || !(input.body instanceof Uint8Array) || input.body.byteLength > MAX_CALLBACK_BYTES) return false;
  try {
    const publicKey = input.publicKey ?? createPublicKey(qqPrivateKey(input.secret));
    const message = Buffer.concat([Buffer.from(input.timestamp, 'utf8'), Buffer.from(input.body)]);
    return verify(null, message, publicKey, Buffer.from(input.signature, 'hex'));
  } catch {
    return false;
  }
}

export function createQQDeliveryProvider(
  config: QQDeliveryConfig,
  db: DatabaseSync,
  transport: QQTransport = fetch,
) {
  const appId = validCredential(config?.appId, 'qq_config_invalid');
  const appSecret = validCredential(config?.appSecret, 'qq_config_invalid');
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) {
    throw new Error('qq_config_invalid');
  }
  let cachedToken: { value: string; expiresAt: number } | undefined;
  let tokenRequest: Promise<string> | undefined;

  const accessToken = async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const response = await transport(new URL(QQ_TOKEN_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await responseObject(response);
      if (!response.ok || typeof data.access_token !== 'string' || !data.access_token.trim()
        || data.access_token.length > 8192) throw new Error('qq_token_unavailable');
      const expiresIn = Number(data.expires_in);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
        throw new Error('qq_token_response_invalid');
      }
      cachedToken = { value: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return data.access_token;
    })();
    try { return await tokenRequest; } finally { tokenRequest = undefined; }
  };

  const sendWithKey = async (text: string, recipient: string, idempotencyKey: string) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value || value.length > 4000 || typeof idempotencyKey !== 'string'
      || !idempotencyKey || idempotencyKey.length > 512) throw new Error('qq_message_invalid');
    const context = resolveQQReplyContext(db, idempotencyKey);
    if (!context || context.principal !== recipient) throw new Error('qq_reply_context_missing');
    const route = qqMessageRoute(context);
    const body = {
      content: value,
      msg_type: 0,
      msg_id: context.providerMessageId,
      ...(context.scope === 'c2c' || context.scope === 'group' ? { msg_seq: 1 } : {}),
    };
    const response = await transport(new URL(route, QQ_API_BASE), {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${await accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return {};
    const receipt = await responseObject(response);
    if (typeof receipt.id !== 'string' || !receipt.id.trim() || receipt.id.length > 512
      || /[\u0000-\u001f\u007f]/.test(receipt.id)) return {};
    return { provider_message_id: receipt.id };
  };

  return {
    async send(): Promise<Record<string, unknown>> {
      throw new Error('qq_reply_context_required');
    },
    sendWithKey,
    async sendFile(): Promise<Record<string, unknown>> {
      throw new Error('qq_file_delivery_not_supported');
    },
  };
}

/** Correlate an outbox effect to its original signed QQ message without a new store. */
export function resolveQQReplyContext(db: DatabaseSync, effectId: string): QQReplyContext | undefined {
  const rows = db.prepare(`SELECT e.run_id,e.recipient,v.principal,v.provider_message_id,v.created_at
    FROM ga_channel_deliveries e JOIN ga_channel_message_events v
      ON v.channel='qq' AND v.run_id=e.run_id AND v.principal=e.recipient
    WHERE e.effect_id=?`).all(effectId) as Array<Record<string, unknown>>;
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (typeof row.recipient !== 'string' || typeof row.principal !== 'string'
    || row.recipient !== row.principal || typeof row.provider_message_id !== 'string'
    || !row.provider_message_id.trim() || typeof row.created_at !== 'string') return undefined;
  const target = parseQQPrincipal(row.principal);
  if (!target) return undefined;
  const receivedAt = Date.parse(row.created_at);
  const replyWindowMs = target.scope === 'c2c' ? 60 * 60 * 1000 : 5 * 60 * 1000;
  if (!Number.isFinite(receivedAt) || Date.now() - receivedAt < 0
    || Date.now() - receivedAt > replyWindowMs) return undefined;
  return { principal: row.principal, providerMessageId: row.provider_message_id,
    scope: target.scope, targetId: target.targetId };
}

function normalizeQQMessage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = object(payload.d);
  if (!data) throw new Error('qq_message_payload_invalid');
  const eventType = payload.t;
  let principal: string | undefined;
  if (eventType === 'C2C_MESSAGE_CREATE') {
    const author = object(data.author);
    if (typeof author?.user_openid === 'string') principal = qqPrincipal('c2c', author.user_openid);
  } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
    if (typeof data.group_openid === 'string') principal = qqPrincipal('group', data.group_openid);
  } else {
    return undefined;
  }

  const messageId = typeof data.id === 'string' ? data.id : '';
  const text = typeof data.content === 'string' ? data.content.trim() : '';
  if (!principal || !messageId || !text) return undefined;
  checkedProviderId(messageId);
  return { channel: 'qq', principal, message_id: messageId, text };
}

function qqPrincipal(scope: 'c2c' | 'group', providerId: string): string {
  return `qq:${scope}:${checkedProviderId(providerId)}`;
}

function checkedProviderId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,480}$/.test(value)) {
    throw new Error('qq_provider_identity_invalid');
  }
  return value;
}

function parseQQPrincipal(principal: string): { scope: QQReplyContext['scope']; targetId: string } | undefined {
  const parts = principal.split(':');
  if (parts[0] !== 'qq') return undefined;
  if (parts.length === 3 && ['c2c', 'group'].includes(parts[1]!)) {
    try { return { scope: parts[1] as 'c2c' | 'group', targetId: checkedProviderId(parts[2]!) }; }
    catch { return undefined; }
  }
  return undefined;
}

function qqMessageRoute(context: QQReplyContext): string {
  const target = encodeURIComponent(context.targetId);
  if (context.scope === 'c2c') return `/v2/users/${target}/messages`;
  return `/v2/groups/${target}/messages`;
}

function qqPrivateKey(secret: string) {
  if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret, 'utf8') > 4096
    || /[\r\n]/.test(secret)) throw new Error('qq_secret_invalid');
  let seed = Buffer.from(secret, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed.subarray(0, 32)]),
    format: 'der', type: 'pkcs8' });
}

function validCredential(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value)) throw new Error(error);
  return value;
}

function header(headers: QQWebhookHeaders, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

function parsePayload(bytes: Uint8Array): Record<string, unknown> {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('qq_callback_json_invalid'); }
  const row = object(payload);
  if (!row || !Number.isInteger(row.op)) throw new Error('qq_callback_payload_invalid');
  return row;
}

function isDispatchSignatureMessage(eventTs: string, plainToken: string): boolean {
  const message = Buffer.from(eventTs + plainToken, 'utf8');
  // A dispatch verifier can split the signed bytes at any 1-20 digit timestamp prefix.
  for (let timestampLength = 1; timestampLength <= 20 && timestampLength < message.byteLength;
    timestampLength += 1) {
    const digit = message[timestampLength - 1]!;
    if (digit < 0x30 || digit > 0x39) break;
    try {
      // Reuse the callback parser for every timestamp split it accepts.
      if (parsePayload(message.subarray(timestampLength)).op === 0) return true;
    } catch {}
  }
  return false;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await response.text(); } catch { return {}; }
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return object(parsed) ?? {};
  } catch { return {}; }
}
