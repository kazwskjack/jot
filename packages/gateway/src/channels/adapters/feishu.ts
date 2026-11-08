import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_BODY = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
type FetchLike = typeof fetch;
type FeishuAttachment = Readonly<{ providerFileId: string; fileName: string; mediaType: string; sizeBytes?: number }>;
export type VerifiedFeishuEvent = Readonly<{ channel: 'feishu'; principal: string; providerThreadId: string;
  providerMessageId: string; text: string; attachments: readonly FeishuAttachment[]; authenticated: true }>;
export type FeishuCallbackResult = VerifiedFeishuEvent | Readonly<{ kind: 'challenge'; challenge: string }>;
export type FeishuVerificationOptions = { verificationToken: string; encryptKey?: string; nowSeconds?: number; maxSkewSeconds?: number };
export type FeishuProviderConfig = { baseUrl?: string; accessToken: string; timeoutMs?: number; maxAttachmentBytes?: number };
function fail(code: string): never { throw new Error(code); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function header(headers: Headers | Record<string, string | undefined>, key: string): string {
  if (headers instanceof Headers) return headers.get(key) ?? '';
  return Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? '';
}
function parseJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail('feishu_event_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('feishu_event_invalid');
  return parsed as Record<string, unknown>;
}
function decryptEvent(encoded: string, encryptKey: string): string {
  let bytes: Buffer;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { fail('feishu_event_invalid'); }
  if (bytes.length < 32 || bytes.length % 16 !== 0 || bytes.toString('base64') !== encoded) fail('feishu_event_invalid');
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const iv = bytes.subarray(0, 16);
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
  } catch { fail('feishu_event_invalid'); }
}
function eventAttachments(message: Record<string, unknown>, content: Record<string, unknown>): FeishuAttachment[] {
  if (message.message_type !== 'file' && message.message_type !== 'image') return [];
  const key = message.message_type === 'image' ? content.image_key : content.file_key;
  if (typeof key !== 'string' || !ID.test(key)) fail('feishu_attachment_invalid');
  const name = typeof content.file_name === 'string' && content.file_name.length <= 255 ? content.file_name
    : message.message_type === 'image' ? `${key}.image` : `${key}.file`;
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) fail('feishu_attachment_invalid');
  const size = content.size;
  if (size !== undefined && (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > MAX_ATTACHMENT_BYTES)) {
    fail('feishu_attachment_invalid');
  }
  return [Object.freeze({ providerFileId: key, fileName: name,
    mediaType: message.message_type === 'image' ? 'image/*' : 'application/octet-stream',
    ...(size === undefined ? {} : { sizeBytes: Number(size) }) })];
}

/** Validate Feishu URL verification, callback signature, optional AES payload, token, and message identity. */
export function verifyFeishuCallback(rawBody: string | Uint8Array, headers: Headers | Record<string, string | undefined>,
  options: FeishuVerificationOptions): FeishuCallbackResult {
  if (!options || typeof options.verificationToken !== 'string' || !options.verificationToken) fail('feishu_config_invalid');
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!body.length || body.length > MAX_BODY) fail('feishu_event_invalid');
  let outer = parseJson(body.toString('utf8'));
  if (typeof outer.encrypt === 'string') {
    if (typeof options.encryptKey !== 'string' || !options.encryptKey) fail('feishu_config_invalid');
    const timestamp = header(headers, 'x-lark-request-timestamp'); const nonce = header(headers, 'x-lark-request-nonce');
    const signature = header(headers, 'x-lark-signature');
    if (!/^\d{10}$/.test(timestamp)) fail('feishu_timestamp_invalid');
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000); const skew = options.maxSkewSeconds ?? 300;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 1 || skew > 3600
      || Math.abs(now - Number(timestamp)) > skew || !nonce || nonce.length > 256 || !/^[a-f0-9]{64}$/i.test(signature)) {
      fail('feishu_signature_invalid');
    }
    const expected = createHash('sha256').update(timestamp + nonce + options.encryptKey).update(body).digest();
    const supplied = Buffer.from(signature, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('feishu_signature_invalid');
    outer = parseJson(decryptEvent(outer.encrypt, options.encryptKey));
  }
  if (outer.type === 'url_verification') {
    if (typeof outer.token !== 'string' || !equal(outer.token, options.verificationToken)
      || typeof outer.challenge !== 'string' || !outer.challenge || outer.challenge.length > 1024) fail('feishu_unauthorized');
    return Object.freeze({ kind: 'challenge', challenge: outer.challenge });
  }
  const headerData = outer.header && typeof outer.header === 'object' && !Array.isArray(outer.header)
    ? outer.header as Record<string, unknown> : {};
  if (typeof headerData.token !== 'string' || !equal(headerData.token, options.verificationToken)) fail('feishu_unauthorized');
  if (headerData.event_type !== 'im.message.receive_v1') fail('feishu_event_unsupported');
  const event = outer.event && typeof outer.event === 'object' && !Array.isArray(outer.event)
    ? outer.event as Record<string, unknown> : {};
  const sender = event.sender && typeof event.sender === 'object' && !Array.isArray(event.sender)
    ? event.sender as Record<string, unknown> : {};
  const senderId = sender.sender_id && typeof sender.sender_id === 'object' && !Array.isArray(sender.sender_id)
    ? sender.sender_id as Record<string, unknown> : {};
  const message = event.message && typeof event.message === 'object' && !Array.isArray(event.message)
    ? event.message as Record<string, unknown> : {};
  if (typeof senderId.open_id !== 'string' || !ID.test(senderId.open_id)
    || typeof message.message_id !== 'string' || !ID.test(message.message_id)
    || typeof message.chat_id !== 'string' || !ID.test(message.chat_id)
    || typeof message.content !== 'string' || message.content.length > 256 * 1024) fail('feishu_event_invalid');
  const content = parseJson(message.content);
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  const attachments = eventAttachments(message, content);
  if (!text && !attachments.length) fail('feishu_event_invalid');
  return Object.freeze({ channel: 'feishu', principal: senderId.open_id, providerThreadId: message.chat_id,
    providerMessageId: message.message_id, text, attachments: Object.freeze(attachments), authenticated: true });
}

function baseUrl(value: unknown): URL {
  if (typeof value !== 'string') fail('feishu_config_invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('feishu_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('feishu_config_invalid');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('feishu_provider_receipt_unconfirmed');
  return value as Record<string, unknown>;
}

export function createFeishuProvider(config: FeishuProviderConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  if (!config || typeof config.accessToken !== 'string' || !config.accessToken.trim() || /[\r\n]/.test(config.accessToken)) fail('feishu_config_invalid');
  const base = baseUrl(config.baseUrl ?? 'https://open.feishu.cn'); const timeout = config.timeoutMs ?? 15000;
  const maxAttachment = config.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000
    || !Number.isSafeInteger(maxAttachment) || maxAttachment < 1 || maxAttachment > 500 * 1024 * 1024) fail('feishu_config_invalid');
  async function request(path: string, body: BodyInit, multipart = false): Promise<Record<string, unknown>> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    let response: Response;
    try { response = await fetchImpl(new URL(path, base), { method: 'POST', headers: {
      authorization: `Bearer ${config.accessToken}`, accept: 'application/json',
      ...(multipart ? {} : { 'content-type': 'application/json' }),
    }, body, redirect: 'error', signal: controller.signal }); }
    catch { throw new Error('network_feishu_delivery_ambiguous'); }
    finally { clearTimeout(timer); }
    if (!response.ok) fail('feishu_provider_rejected');
    let data: Record<string, unknown>;
    try { data = jsonObject(await response.json()); } catch { fail('feishu_provider_receipt_unconfirmed'); }
    if (data.code !== 0) fail('feishu_provider_rejected');
    return data;
  }
  async function sendMessage(recipient: string, msgType: string, content: Record<string, unknown>) {
    if (!ID.test(recipient)) fail('feishu_recipient_invalid');
    const result = await request('open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
      receive_id: recipient, msg_type: msgType, content: JSON.stringify(content),
    }));
    const data = jsonObject(result.data); const messageId = data.message_id;
    if (typeof messageId !== 'string' || !ID.test(messageId)) fail('feishu_provider_receipt_unconfirmed');
    return { provider_message_id: messageId };
  }
  return {
    async send(text, recipient) {
      if (typeof text !== 'string' || !text.trim() || text.length > 20000) fail('feishu_content_invalid');
      return sendMessage(recipient, 'text', { text });
    },
    async sendFile(path, recipient, displayName) {
      if (!ID.test(recipient) || typeof displayName !== 'string' || !displayName.trim() || displayName.length > 255) fail('feishu_attachment_invalid');
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size < 1 || info.size > maxAttachment) fail('feishu_attachment_invalid');
      const raw = await readFile(path);
      if (raw.length !== info.size || raw.length > maxAttachment) fail('feishu_attachment_invalid');
      const bytes = new Uint8Array(new ArrayBuffer(raw.length)); bytes.set(raw);
      const form = new FormData(); form.set('file_type', 'stream'); form.set('file_name', basename(displayName.replaceAll('\\', '/')));
      form.set('file', new Blob([bytes]), basename(displayName.replaceAll('\\', '/')));
      const uploaded = await request('open-apis/im/v1/files', form, true); const data = jsonObject(uploaded.data);
      if (typeof data.file_key !== 'string' || !ID.test(data.file_key)) fail('feishu_provider_receipt_unconfirmed');
      return sendMessage(recipient, 'file', { file_key: data.file_key });
    },
  };
}
