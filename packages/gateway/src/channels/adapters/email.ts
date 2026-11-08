import { createHmac, timingSafeEqual } from 'node:crypto';
import { emailPrincipal } from '../email-provider.ts';
import type { ApiServerAttachment } from './api-server.ts';

const MAX_BODY = 256 * 1024;
const MAX_ATTACHMENTS = 10;
type EmailAttachment = ApiServerAttachment;
export type VerifiedEmailRelayEvent = Readonly<{
  channel: 'email'; principal: string; providerThreadId: string; providerMessageId: string;
  text: string; attachments: readonly EmailAttachment[]; authenticated: true;
}>;
export type EmailRelayOptions = { secret: string; nowSeconds?: number; maxSkewSeconds?: number;
  attachmentHosts?: readonly string[]; maxAttachmentBytes?: number };
function fail(code: string): never { throw new Error(code); }
function header(headers: Headers | Record<string, string | undefined>, key: string): string {
  if (headers instanceof Headers) return headers.get(key) ?? '';
  return Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? '';
}
function mailId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 998 && /^<[^<>\s\u0000-\u001f]+>$/.test(value);
}
function attachment(value: unknown, options: EmailRelayOptions): EmailAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('channel_attachment_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'download_url,file_name,media_type,provider_file_id,size_bytes'
    || typeof row.provider_file_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row.provider_file_id)
    || typeof row.file_name !== 'string' || !row.file_name || row.file_name.length > 255
    || /[\u0000-\u001f\u007f/\\]/.test(row.file_name)
    || typeof row.media_type !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(row.media_type)
    || !Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes) < 1
    || Number(row.size_bytes) > (options.maxAttachmentBytes ?? 100 * 1024 * 1024)
    || typeof row.download_url !== 'string') fail('channel_attachment_invalid');
  let url: URL;
  try { url = new URL(row.download_url); } catch { fail('channel_attachment_invalid'); }
  const hosts = (options.attachmentHosts ?? []).map(value => value.toLowerCase());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hosts.includes(url.hostname.toLowerCase())) {
    fail('channel_attachment_invalid');
  }
  return Object.freeze({ providerFileId: row.provider_file_id, fileName: row.file_name,
    mediaType: row.media_type.toLowerCase(), sizeBytes: Number(row.size_bytes), downloadUrl: url.toString() });
}

/** Verify a configured inbound mail relay callback. The relay signs timestamp + exact body bytes. */
export function verifyEmailRelayEvent(rawBody: string | Uint8Array,
  headers: Headers | Record<string, string | undefined>, options: EmailRelayOptions): VerifiedEmailRelayEvent {
  if (!options || typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < 32 || /[\r\n]/.test(options.secret)) {
    fail('email_relay_config_invalid');
  }
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!body.length || body.length > MAX_BODY) fail('channel_event_invalid');
  const timestamp = header(headers, 'x-jot-timestamp'); const signature = header(headers, 'x-jot-signature');
  if (!/^\d{10}$/.test(timestamp)) fail('channel_event_timestamp_invalid');
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000); const skew = options.maxSkewSeconds ?? 300;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 1 || skew > 3600
    || Math.abs(now - Number(timestamp)) > skew) fail('channel_event_timestamp_invalid');
  if (!/^[a-f0-9]{64}$/i.test(signature)) fail('channel_event_signature_invalid');
  const expected = createHmac('sha256', options.secret).update(timestamp).update('.').update(body).digest();
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('channel_event_signature_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { fail('channel_event_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('channel_event_invalid');
  const row = parsed as Record<string, unknown>;
  const allowed = ['attachments', 'from', 'in_reply_to', 'message_id', 'references', 'subject', 'text'];
  if (Object.keys(row).some(key => !allowed.includes(key)) || typeof row.from !== 'string' || !mailId(row.message_id)
    || (row.in_reply_to !== undefined && !mailId(row.in_reply_to))
    || (row.references !== undefined && (typeof row.references !== 'string' || row.references.length > 10000))
    || typeof row.text !== 'string' || row.text.length > 4000) fail('channel_event_invalid');
  let principal: string;
  try { principal = emailPrincipal(row.from); } catch { fail('channel_event_invalid'); }
  const references = typeof row.references === 'string' ? row.references.match(/<[^<>\s]+>/g) : null;
  const thread = references?.[0] ?? row.in_reply_to ?? row.message_id;
  const source = row.attachments === undefined ? [] : row.attachments;
  if (!Array.isArray(source) || source.length > MAX_ATTACHMENTS) fail('channel_attachment_invalid');
  const attachments = source.map(value => attachment(value, options));
  if (!row.text.trim() && !attachments.length) fail('channel_event_invalid');
  return Object.freeze({ channel: 'email', principal, providerThreadId: thread as string,
    providerMessageId: row.message_id, text: row.text.trim(), attachments: Object.freeze(attachments), authenticated: true });
}
