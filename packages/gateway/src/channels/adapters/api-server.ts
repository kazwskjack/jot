import { createHmac, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';

const MAX_EVENT_BYTES = 128 * 1024;
const MAX_ATTACHMENTS = 10;
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;
const SAFE_FILE_NAME = /^[^\u0000-\u001f\u007f/\\]{1,255}$/;

export type ApiServerAttachment = Readonly<{
  providerFileId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  downloadUrl: string;
}>;

export type VerifiedApiServerEvent = Readonly<{
  channel: 'api-server';
  principal: string;
  providerThreadId: string;
  providerMessageId: string;
  text: string;
  attachments: readonly ApiServerAttachment[];
  authenticated: true;
}>;

export type ApiServerVerificationOptions = {
  secret: string;
  nowSeconds?: number;
  maxSkewSeconds?: number;
  maxAttachmentBytes?: number;
  attachmentHosts?: readonly string[];
};

export type ApiServerDeliveryContext = {
  effectId: string;
  generation: number;
  idempotencyKey: string;
};

export type ApiServerProviderConfig = {
  sendUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttachmentBytes?: number;
};

type FetchLike = typeof fetch;

function fail(code: string): never {
  throw new Error(code);
}

function header(headers: Headers | Record<string, string | undefined>, key: string): string {
  if (headers instanceof Headers) return headers.get(key) ?? '';
  const wanted = key.toLowerCase();
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted);
  return entry?.[1] ?? '';
}

function bytesOf(rawBody: string | Uint8Array): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
}

function validSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32
    && !/[\r\n]/.test(secret);
}

function validateAttachment(value: unknown, options: ApiServerVerificationOptions): ApiServerAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('channel_attachment_invalid');
  const row = value as Record<string, unknown>;
  const expectedKeys = ['download_url', 'file_name', 'media_type', 'provider_file_id', 'size_bytes'];
  if (Object.keys(row).sort().join(',') !== expectedKeys.join(',')) fail('channel_attachment_invalid');
  if (typeof row.provider_file_id !== 'string' || !PROVIDER_ID.test(row.provider_file_id)
    || typeof row.file_name !== 'string' || !SAFE_FILE_NAME.test(row.file_name)
    || typeof row.media_type !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(row.media_type)
    || !Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes) < 1
    || Number(row.size_bytes) > (options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES)
    || typeof row.download_url !== 'string') fail('channel_attachment_invalid');
  let url: URL;
  try { url = new URL(row.download_url); } catch { fail('channel_attachment_invalid'); }
  const allowedHosts = (options.attachmentHosts ?? []).map(host => host.toLowerCase());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !allowedHosts.includes(url.hostname.toLowerCase())) fail('channel_attachment_invalid');
  return Object.freeze({
    providerFileId: row.provider_file_id,
    fileName: row.file_name,
    mediaType: row.media_type.toLowerCase(),
    sizeBytes: Number(row.size_bytes),
    downloadUrl: url.toString(),
  });
}

/** Verify a Jot API-server callback over the exact bytes received on the wire.
 * The signing input is `<unix-seconds>.<raw-body>` and the digest is lowercase hex.
 */
export function verifyApiServerEvent(
  rawBody: string | Uint8Array,
  headers: Headers | Record<string, string | undefined>,
  options: ApiServerVerificationOptions,
): VerifiedApiServerEvent {
  if (!options || !validSecret(options.secret)) fail('api_server_config_invalid');
  const body = bytesOf(rawBody);
  if (!body.length || body.length > MAX_EVENT_BYTES) fail('channel_event_invalid');
  const timestamp = header(headers, 'x-jot-timestamp');
  const signature = header(headers, 'x-jot-signature');
  if (!/^\d{10}$/.test(timestamp)) fail('channel_event_timestamp_invalid');
  const timestampSeconds = Number(timestamp);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = options.maxSkewSeconds ?? 300;
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxSkew) || maxSkew < 1 || maxSkew > 3600
    || Math.abs(nowSeconds - timestampSeconds) > maxSkew) fail('channel_event_timestamp_invalid');
  if (!/^[a-f0-9]{64}$/i.test(signature)) fail('channel_event_signature_invalid');
  const expected = createHmac('sha256', options.secret)
    .update(timestamp).update('.').update(body).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('channel_event_signature_invalid');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { fail('channel_event_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('channel_event_invalid');
  const event = parsed as Record<string, unknown>;
  const expectedKeys = ['attachments', 'message_id', 'principal', 'text', 'thread_id'];
  const actualKeys = Object.keys(event).sort();
  if (actualKeys.filter(key => key !== 'attachments').join(',') !== expectedKeys.filter(key => key !== 'attachments').join(',')
    || actualKeys.some(key => !expectedKeys.includes(key))) fail('channel_event_invalid');
  if (typeof event.principal !== 'string' || !PROVIDER_ID.test(event.principal)
    || typeof event.thread_id !== 'string' || !PROVIDER_ID.test(event.thread_id)
    || typeof event.message_id !== 'string' || !PROVIDER_ID.test(event.message_id)
    || typeof event.text !== 'string' || event.text.length > 4000) fail('channel_event_invalid');
  const text = event.text.trim();
  const rawAttachments = event.attachments === undefined ? [] : event.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_ATTACHMENTS) fail('channel_attachment_invalid');
  const attachments = rawAttachments.map(attachment => validateAttachment(attachment, options));
  const fileIds = new Set<string>();
  for (const attachment of attachments) {
    if (fileIds.has(attachment.providerFileId)) fail('channel_attachment_invalid');
    fileIds.add(attachment.providerFileId);
  }
  if (!text && !attachments.length) fail('channel_event_invalid');
  return Object.freeze({
    channel: 'api-server',
    principal: event.principal,
    providerThreadId: event.thread_id,
    providerMessageId: event.message_id,
    text,
    attachments: Object.freeze(attachments),
    authenticated: true,
  });
}

function endpoint(value: unknown): URL {
  if (typeof value !== 'string') fail('api_server_config_invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('api_server_config_invalid'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail('api_server_config_invalid');
  }
  return url;
}

function receiptId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.provider_message_id === 'string' ? row.provider_message_id
    : typeof row.message_id === 'string' ? row.message_id
      : typeof row.id === 'string' ? row.id : null;
  return id && id.length <= 512 && /^[^\u0000-\u001f\u007f]+$/.test(id) ? id : null;
}

export function createApiServerProvider(config: ApiServerProviderConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string, context?: ApiServerDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string, context?: ApiServerDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  const url = endpoint(config?.sendUrl);
  if (typeof config.bearerToken !== 'string' || !config.bearerToken.trim() || /[\r\n]/.test(config.bearerToken)) {
    fail('api_server_config_invalid');
  }
  if (typeof fetchImpl !== 'function') fail('api_server_config_invalid');
  const timeoutMs = config.timeoutMs ?? 15000;
  const maxResponseBytes = config.maxResponseBytes ?? 64 * 1024;
  const maxAttachmentBytes = config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1024 * 1024
    || !Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > 500 * 1024 * 1024) {
    fail('api_server_config_invalid');
  }

  async function request(body: BodyInit, recipient: string, context?: ApiServerDeliveryContext,
    isMultipart = false): Promise<Record<string, unknown> & { provider_message_id: string }> {
    if (typeof recipient !== 'string' || !recipient.trim() || recipient.length > 512 || /[\r\n]/.test(recipient)) {
      fail('api_server_recipient_invalid');
    }
    if (context && (!context.effectId || !PROVIDER_ID.test(context.effectId)
      || !Number.isSafeInteger(context.generation) || context.generation < 1
      || !context.idempotencyKey || context.idempotencyKey.length > 255
      || /[\r\n]/.test(context.idempotencyKey))) fail('api_server_delivery_context_invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.bearerToken}`,
          ...(isMultipart ? {} : { 'content-type': 'application/json' }),
          ...(context ? { 'idempotency-key': context.idempotencyKey } : {}),
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new Error('network_api_server_delivery_ambiguous');
    } finally {
      clearTimeout(timer);
    }
    let responseText: string;
    try {
      responseText = await response.text();
      if (Buffer.byteLength(responseText, 'utf8') > maxResponseBytes) fail('api_server_provider_receipt_unconfirmed');
    } catch {
      fail('api_server_provider_receipt_unconfirmed');
    }
    if (!response.ok) fail('api_server_provider_rejected');
    let value: unknown = null;
    if (responseText.trim()) {
      try { value = JSON.parse(responseText); } catch { fail('api_server_provider_receipt_unconfirmed'); }
    }
    const id = receiptId(value) ?? (context ? `api-server:${context.effectId}` : null);
    if (!id) fail('api_server_provider_receipt_unconfirmed');
    return { provider_message_id: id };
  }

  return {
    async send(text, recipient, context) {
      if (typeof text !== 'string' || !text.trim() || text.length > 120000) fail('api_server_content_invalid');
      return request(JSON.stringify({ text, recipient }), recipient, context);
    },
    async sendFile(path, recipient, displayName, context) {
      if (typeof path !== 'string' || !path || typeof displayName !== 'string' || !displayName.trim()
        || displayName.length > 255) fail('api_server_attachment_invalid');
      const fileStat = await stat(path).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size < 1 || fileStat.size > maxAttachmentBytes) {
        fail('api_server_attachment_invalid');
      }
      const raw = await readFile(path);
      if (raw.length !== fileStat.size || raw.length > maxAttachmentBytes) fail('api_server_attachment_invalid');
      const form = new FormData();
      form.set('recipient', recipient);
      const blobBytes = new Uint8Array(new ArrayBuffer(raw.length));
      blobBytes.set(raw);
      form.set('file', new Blob([blobBytes]), basename(displayName.replaceAll('\\', '/')));
      return request(form, recipient, context, true);
    },
  };
}
