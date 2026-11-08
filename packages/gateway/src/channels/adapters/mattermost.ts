import { timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';
import {requireFileDeliveryContext,requireTextDeliveryContext,type FileDeliveryEffectContext,type DeliveryEffectContext} from '../delivery-effect-context.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DETERMINATE_REJECTION_STATUSES = new Set([401, 403]);

export type VerifiedMattermostEvent = Readonly<{
  channel: 'mattermost'; principal: string; providerThreadId: string; providerMessageId: string;
  text: string; attachments: readonly []; authenticated: true;
}>;
export type MattermostConfig = { baseUrl: string; botToken: string; timeoutMs?: number; maxAttachmentBytes?: number };
type FetchLike = typeof fetch;
function fail(code: string): never { throw new Error(code); }
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length >= 16 && timingSafeEqual(a, b);
}

/** Validate a Mattermost outgoing webhook body. The configured token is the provider credential. */
export function verifyMattermostOutgoingWebhook(rawBody: string | Uint8Array,
  headers: Headers | Record<string, string | undefined>, expectedToken: string): VerifiedMattermostEvent {
  if (typeof expectedToken !== 'string' || expectedToken.length < 16 || /[\r\n]/.test(expectedToken)) fail('mattermost_config_invalid');
  const raw = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!raw.length || raw.length > MAX_EVENT_BYTES) fail('mattermost_event_invalid');
  let contentType = '';
  if (headers instanceof Headers) contentType = headers.get('content-type') ?? '';
  else contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  let body: Record<string, unknown>;
  try {
    if (contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    } else if (contentType.toLowerCase().startsWith('application/json')) {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('mattermost_event_invalid');
      body = parsed as Record<string, unknown>;
    } else fail('mattermost_event_invalid');
  } catch { fail('mattermost_event_invalid'); }
  if (typeof body.token !== 'string' || !equalSecret(body.token, expectedToken)) fail('mattermost_unauthorized');
  for (const field of ['file_ids', 'attachments', 'files']) {
    if (body[field] !== undefined && (!Array.isArray(body[field]) || (body[field] as unknown[]).length > 0)) {
      fail('mattermost_attachment_unsupported');
    }
  }
  if (typeof body.user_id !== 'string' || !ID.test(body.user_id)
    || typeof body.channel_id !== 'string' || !ID.test(body.channel_id)
    || typeof body.post_id !== 'string' || !ID.test(body.post_id)
    || typeof body.text !== 'string' || body.text.length > 4000 || !body.text.trim()) fail('mattermost_event_invalid');
  return Object.freeze({ channel: 'mattermost', principal: body.user_id, providerThreadId: body.channel_id,
    providerMessageId: body.post_id, text: body.text.trim(), attachments: Object.freeze([]) as readonly [], authenticated: true });
}

function safeBase(value: unknown): URL {
  if (typeof value !== 'string') fail('mattermost_config_invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('mattermost_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('mattermost_config_invalid');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
function remoteId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).id;
  return typeof value === 'string' && ID.test(value) ? value : null;
}

export function createMattermostProvider(config: MattermostConfig, fetchImpl: FetchLike = fetch): DeliveryProvider {
  if (!config || typeof config.botToken !== 'string' || !config.botToken.trim() || /[\r\n]/.test(config.botToken)) {
    fail('mattermost_config_invalid');
  }
  const base = safeBase(config.baseUrl);
  const timeout = config.timeoutMs ?? 15000;
  const maxAttachmentBytes = config.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000
    || !Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > 500 * 1024 * 1024) {
    fail('mattermost_config_invalid');
  }
  async function post(path: string, body: BodyInit, multipart = false, priorProviderSideEffect = false): Promise<Response> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    try {
      const response = await fetchImpl(new URL(`api/v4/${path}`, base), { method: 'POST', headers: {
        authorization: `Bearer ${config.botToken}`, accept: 'application/json',
        ...(multipart ? {} : { 'content-type': 'application/json' }),
      }, body, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        if (!priorProviderSideEffect && DETERMINATE_REJECTION_STATUSES.has(response.status)) fail('mattermost_provider_rejected');
        fail('network_mattermost_delivery_ambiguous');
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === 'mattermost_provider_rejected') throw error;
      throw new Error('network_mattermost_delivery_ambiguous');
    } finally { clearTimeout(timer); }
  }
  async function json(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { fail('mattermost_provider_receipt_unconfirmed'); }
  }
  return {
    async send(text, recipient, context?:DeliveryEffectContext) {
      if (!ID.test(recipient) || typeof text !== 'string' || !text.trim() || text.length > 16000) fail('mattermost_delivery_invalid');
      requireTextDeliveryContext(context);
      const response = await post('posts', JSON.stringify({ channel_id: recipient, message: text }));
      const id = remoteId(await json(response));
      if (!id) fail('mattermost_provider_receipt_unconfirmed');
      return { provider_message_id: id };
    },
    async sendFile(path, recipient, displayName, context?:FileDeliveryEffectContext, beforePost?:()=>Promise<boolean>) {
      if (!ID.test(recipient) || typeof displayName !== 'string' || !displayName.trim() || displayName.length > 255) {
        fail('mattermost_delivery_invalid');
      }
      const effect=requireFileDeliveryContext(context);
      if(effect.filePart.displayName!==displayName||typeof beforePost!=='function')fail('mattermost_delivery_invalid');
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size < 1 || info.size > maxAttachmentBytes) fail('mattermost_attachment_invalid');
      const raw = await readFile(path);
      if (raw.length !== info.size || raw.length > maxAttachmentBytes) fail('mattermost_attachment_invalid');
      const bytes = new Uint8Array(new ArrayBuffer(raw.length)); bytes.set(raw);
      const form = new FormData(); form.set('channel_id', recipient);
      form.set('files', new Blob([bytes]), basename(displayName.replaceAll('\\', '/')));
      const uploaded = await json(await post('files', form, true));
      if (!uploaded || typeof uploaded !== 'object' || Array.isArray(uploaded)
        || !Array.isArray((uploaded as Record<string, unknown>).file_infos)) fail('mattermost_provider_receipt_unconfirmed');
      const file = ((uploaded as Record<string, unknown>).file_infos as unknown[])[0];
      const fileId = file && typeof file === 'object' && !Array.isArray(file)
        ? (file as Record<string, unknown>).id : null;
      if (typeof fileId !== 'string' || !ID.test(fileId)) fail('mattermost_provider_receipt_unconfirmed');
      if(!await beforePost())fail('mattermost_delivery_authority_revoked_after_upload');
      const response = await post('posts', JSON.stringify({ channel_id: recipient, message: '', file_ids: [fileId] }), false, true);
      const id = remoteId(await json(response));
      if (!id) fail('mattermost_provider_receipt_unconfirmed');
      return { provider_message_id: id };
    },
  };
}
