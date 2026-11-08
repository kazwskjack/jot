import { timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';
import { localProviderReceipt, type ProviderDeliveryContext } from './delivery-context.ts';

const ID = /^[A-Za-z0-9+][A-Za-z0-9._:+;@/-]{0,191}$/;
const MAX_BODY = 1024 * 1024;
const MAX_ATTACHMENTS = 10;
type FetchLike = typeof fetch;
export type BlueBubblesAttachment = Readonly<{ providerFileId: string; fileName: string; mediaType: string; sizeBytes?: number }>;
export type VerifiedBlueBubblesEvent = Readonly<{ channel: 'bluebubbles'; principal: string; providerThreadId: string;
  providerMessageId: string; text: string; attachments: readonly BlueBubblesAttachment[]; authenticated: true }>;
export type BlueBubblesEventResult = Readonly<{ kind: 'event'; event: VerifiedBlueBubblesEvent } | { kind: 'ignored' }>;
export type BlueBubblesProviderConfig = { baseUrl: string; password: string; fileSendUrl?: string; timeoutMs?: number;
  maxAttachmentBytes?: number; serverId?: string };
function fail(code: string): never { throw new Error(code); }
function compare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}
function parseJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail('bluebubbles_event_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('bluebubbles_event_invalid');
  return parsed as Record<string, unknown>;
}

/** The BlueBubbles webhook protocol has no event signature; deployments authenticate a high-entropy callback path. */
export function verifyBlueBubblesWebhook(pathSecret: string, expectedSecret: string, rawBody: string | Uint8Array,
  options: { serverId?: string } = {}): BlueBubblesEventResult {
  if (typeof pathSecret !== 'string' || typeof expectedSecret !== 'string' || !compare(pathSecret, expectedSecret)) {
    fail('bluebubbles_unauthorized');
  }
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!bytes.length || bytes.length > MAX_BODY) fail('bluebubbles_event_invalid');
  const body = parseJson(bytes.toString('utf8'));
  if (body.type !== 'new-message') return Object.freeze({ kind: 'ignored' });
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) fail('bluebubbles_event_invalid');
  const data = body.data as Record<string, unknown>;
  if (data.isFromMe === true) return Object.freeze({ kind: 'ignored' });
  if (options.serverId && data.serverId !== undefined && data.serverId !== options.serverId) fail('bluebubbles_event_invalid');
  const message = data.message && typeof data.message === 'object' && !Array.isArray(data.message)
    ? data.message as Record<string, unknown> : data;
  const chats = Array.isArray(data.chats) ? data.chats : [];
  const chat = chats[0] && typeof chats[0] === 'object' && !Array.isArray(chats[0]) ? chats[0] as Record<string, unknown> : {};
  const handle = message.handle && typeof message.handle === 'object' && !Array.isArray(message.handle)
    ? message.handle as Record<string, unknown>
    : data.handle && typeof data.handle === 'object' && !Array.isArray(data.handle) ? data.handle as Record<string, unknown> : {};
  const principal = handle.address ?? handle.guid;
  const messageId = message.guid ?? message.id;
  const threadId = chat.guid ?? data.chatGuid;
  const text = message.text ?? message.attributedBody ?? data.text;
  if (typeof principal !== 'string' || !ID.test(principal) || typeof messageId !== 'string' || !ID.test(messageId)
    || typeof threadId !== 'string' || !ID.test(threadId) || typeof text !== 'string' || text.length > 4000) {
    fail('bluebubbles_event_invalid');
  }
  if (message.attachments !== undefined && !Array.isArray(message.attachments)) fail('bluebubbles_attachment_invalid');
  const source = Array.isArray(message.attachments) ? message.attachments : [];
  if (source.length > MAX_ATTACHMENTS) fail('bluebubbles_attachment_invalid');
  const attachments = source.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bluebubbles_attachment_invalid');
    const item = value as Record<string, unknown>;
    const id = item.guid ?? item.id;
    const name = item.transferName ?? item.filename ?? item.name ?? 'attachment.bin';
    const mediaType = item.mimeType ?? item.mime_type ?? 'application/octet-stream';
    const size = item.totalBytes ?? item.size;
    if (typeof id !== 'string' || !ID.test(id) || typeof name !== 'string' || !name || name.length > 255
      || /[\u0000-\u001f\u007f/\\]/.test(name) || typeof mediaType !== 'string'
      || (size !== undefined && (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > 100 * 1024 * 1024))) {
      fail('bluebubbles_attachment_invalid');
    }
    return Object.freeze({ providerFileId: id, fileName: name, mediaType,
      ...(size === undefined ? {} : { sizeBytes: Number(size) }) });
  });
  if (!String(text).trim() && !attachments.length) return Object.freeze({ kind: 'ignored' });
  return Object.freeze({ kind: 'event', event: Object.freeze({ channel: 'bluebubbles', principal,
    providerThreadId: threadId, providerMessageId: messageId, text: String(text).trim(),
    attachments: Object.freeze(attachments), authenticated: true }) });
}

function httpsUrl(value: unknown): URL {
  if (typeof value !== 'string') fail('bluebubbles_config_invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('bluebubbles_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('bluebubbles_config_invalid');
  return url;
}
function providerId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const id = data.guid ?? data.id ?? body.guid ?? body.id;
  return typeof id === 'string' && ID.test(id) ? id : null;
}

export function createBlueBubblesProvider(config: BlueBubblesProviderConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string, context?: ProviderDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string, context?: ProviderDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  if (!config || typeof config.password !== 'string' || !config.password.trim() || /[\r\n]/.test(config.password)) fail('bluebubbles_config_invalid');
  const base = httpsUrl(config.baseUrl); const fileSendUrl = config.fileSendUrl === undefined ? null : httpsUrl(config.fileSendUrl);
  const timeout = config.timeoutMs ?? 15000; const maxFile = config.maxAttachmentBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000
    || !Number.isSafeInteger(maxFile) || maxFile < 1 || maxFile > 500 * 1024 * 1024) fail('bluebubbles_config_invalid');
  async function post(target: URL, body: BodyInit, multipart = false): Promise<string | null> {
    const url = new URL(target); url.searchParams.set('password', config.password);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    let response: Response;
    try { response = await fetchImpl(url, { method: 'POST', headers: { accept: 'application/json',
      ...(multipart ? {} : { 'content-type': 'application/json' }) }, body, redirect: 'error', signal: controller.signal }); }
    catch { throw new Error('network_bluebubbles_delivery_ambiguous'); }
    finally { clearTimeout(timer); }
    if (!response.ok) fail('bluebubbles_provider_rejected');
    let data: unknown;
    try { data = await response.json(); } catch { fail('bluebubbles_provider_receipt_unconfirmed'); }
    if (data && typeof data === 'object' && !Array.isArray(data) && (data as Record<string, unknown>).status !== undefined
      && Number((data as Record<string, unknown>).status) !== 200) fail('bluebubbles_provider_rejected');
    return providerId(data);
  }
  return {
    async send(text, recipient, context) {
      if (!ID.test(recipient) || typeof text !== 'string' || !text.trim() || text.length > 20000) fail('bluebubbles_delivery_invalid');
      const target = new URL('/api/v1/message/text', base);
      const id = await post(target, JSON.stringify({ chatGuid: recipient, text, method: 'private-api' }));
      return { provider_message_id: id ?? localProviderReceipt('bluebubbles', context) };
    },
    async sendFile(path, recipient, displayName, context) {
      if (!fileSendUrl) fail('bluebubbles_attachment_unsupported');
      if (!ID.test(recipient) || typeof displayName !== 'string' || !displayName.trim() || displayName.length > 255) fail('bluebubbles_attachment_invalid');
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size < 1 || info.size > maxFile) fail('bluebubbles_attachment_invalid');
      const raw = await readFile(path);
      if (raw.length !== info.size || raw.length > maxFile) fail('bluebubbles_attachment_invalid');
      const bytes = new Uint8Array(new ArrayBuffer(raw.length)); bytes.set(raw);
      const form = new FormData(); form.set('chatGuid', recipient);
      form.set('file', new Blob([bytes]), basename(displayName.replaceAll('\\', '/')));
      const id = await post(fileSendUrl, form, true);
      return { provider_message_id: id ?? localProviderReceipt('bluebubbles', context) };
    },
  };
}
