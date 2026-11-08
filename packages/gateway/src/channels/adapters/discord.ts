import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type VerifiedDiscordInteraction = Readonly<{
  channel: 'discord';
  principal: string;
  providerThreadId: string;
  providerMessageId: string;
  text: string;
  attachments: readonly Readonly<{ providerFileId: string; fileName: string; mediaType: string; sizeBytes?: number; downloadUrl: string }>[];
  authenticated: true;
}>;

export type DiscordVerificationResult = VerifiedDiscordInteraction | Readonly<{ kind: 'ping' }>;
export type DiscordVerificationOptions = { publicKey: string; nowSeconds?: number; maxSkewSeconds?: number };
export type DiscordProviderConfig = { botToken: string; apiBase?: string; timeoutMs?: number; maxAttachmentBytes?: number };
type FetchLike = typeof fetch;

function fail(code: string): never { throw new Error(code); }
function header(headers: Headers | Record<string, string | undefined>, key: string): string {
  if (headers instanceof Headers) return headers.get(key) ?? '';
  return Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? '';
}

function collectText(data: Record<string, unknown>): string {
  const values: string[] = [];
  const visit = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const option = item as Record<string, unknown>;
      if (typeof option.value === 'string' || typeof option.value === 'number') values.push(String(option.value));
      else if (Array.isArray(option.options)) visit(option.options);
    }
  };
  visit(data.options);
  const command = typeof data.name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(data.name) ? `/${data.name}` : '';
  return [command, ...values].filter(Boolean).join(' ').slice(0, 4000);
}

function interactionAttachments(payload: Record<string, unknown>) {
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown> : {};
  const resolved = data.resolved && typeof data.resolved === 'object' && !Array.isArray(data.resolved)
    ? data.resolved as Record<string, unknown> : {};
  const source = resolved.attachments;
  const values = Array.isArray(source) ? source : source && typeof source === 'object'
    ? Object.values(source as Record<string, unknown>) : [];
  if (values.length > MAX_ATTACHMENTS) fail('discord_attachment_invalid');
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('discord_attachment_invalid');
    const file = value as Record<string, unknown>;
    let url: URL;
    try { url = new URL(String(file.url ?? '')); } catch { fail('discord_attachment_invalid'); }
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname.toLowerCase())
      || typeof file.id !== 'string' || !SAFE_ID.test(file.id)
      || typeof file.filename !== 'string' || !file.filename || file.filename.length > 255
      || typeof file.content_type !== 'string' || file.content_type.length > 200
      || (file.size !== undefined && (!Number.isSafeInteger(file.size) || Number(file.size) < 1 || Number(file.size) > 100 * 1024 * 1024))) {
      fail('discord_attachment_invalid');
    }
    return Object.freeze({ providerFileId: file.id, fileName: file.filename,
      mediaType: file.content_type, ...(file.size === undefined ? {} : { sizeBytes: Number(file.size) }),
      downloadUrl: url.toString() });
  });
}

/** Verifies Discord's Ed25519 signature against timestamp + the exact request bytes. */
export function verifyDiscordInteraction(
  rawBody: string | Uint8Array,
  headers: Headers | Record<string, string | undefined>,
  options: DiscordVerificationOptions,
): DiscordVerificationResult {
  if (!options || typeof options.publicKey !== 'string' || !/^[a-f0-9]{64}$/i.test(options.publicKey)) {
    fail('discord_config_invalid');
  }
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!body.length || body.length > MAX_EVENT_BYTES) fail('discord_interaction_invalid');
  const timestamp = header(headers, 'x-signature-timestamp');
  const signature = header(headers, 'x-signature-ed25519');
  if (!/^\d{10}$/.test(timestamp)) fail('discord_timestamp_invalid');
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.maxSkewSeconds ?? 300;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 1 || skew > 3600
    || Math.abs(now - Number(timestamp)) > skew) fail('discord_timestamp_invalid');
  if (!/^[a-f0-9]{128}$/i.test(signature)) fail('discord_signature_invalid');
  let verified = false;
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(options.publicKey, 'hex')]),
      format: 'der', type: 'spki' });
    verified = verifySignature(null, Buffer.concat([Buffer.from(timestamp), body]), publicKey, Buffer.from(signature, 'hex'));
  } catch { fail('discord_signature_invalid'); }
  if (!verified) fail('discord_signature_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { fail('discord_interaction_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('discord_interaction_invalid');
  const payload = parsed as Record<string, unknown>;
  if (payload.type === 1) return Object.freeze({ kind: 'ping' });
  if (![2, 3, 4, 5].includes(Number(payload.type)) || typeof payload.id !== 'string' || !SAFE_ID.test(payload.id)
    || typeof payload.channel_id !== 'string' || !SAFE_ID.test(payload.channel_id)) fail('discord_interaction_invalid');
  const member = payload.member && typeof payload.member === 'object' && !Array.isArray(payload.member)
    ? payload.member as Record<string, unknown> : {};
  const user = payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user)
    ? payload.user as Record<string, unknown>
    : member.user && typeof member.user === 'object' && !Array.isArray(member.user)
      ? member.user as Record<string, unknown> : {};
  if (typeof user.id !== 'string' || !SAFE_ID.test(user.id)) fail('discord_interaction_invalid');
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown> : {};
  const text = collectText(data);
  const attachments = interactionAttachments(payload);
  if (!text && !attachments.length) fail('discord_interaction_invalid');
  return Object.freeze({ channel: 'discord', principal: user.id, providerThreadId: payload.channel_id,
    providerMessageId: payload.id, text, attachments: Object.freeze(attachments), authenticated: true });
}

function safeBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { fail('discord_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('discord_config_invalid');
  return url;
}

function responseId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && SAFE_ID.test(id) ? id : null;
}

export function createDiscordProvider(config: DiscordProviderConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  if (!config || typeof config.botToken !== 'string' || !config.botToken.trim() || /[\r\n]/.test(config.botToken)) fail('discord_config_invalid');
  const base = safeBase(config.apiBase ?? 'https://discord.com/api/v10/');
  const timeout = config.timeoutMs ?? 15000;
  const maxAttachmentBytes = config.maxAttachmentBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000
    || !Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > 500 * 1024 * 1024) fail('discord_config_invalid');
  async function post(recipient: string, body: BodyInit, multipart = false) {
    if (typeof recipient !== 'string' || !SAFE_ID.test(recipient)) fail('discord_recipient_invalid');
    const target = new URL(`channels/${encodeURIComponent(recipient)}/messages`, base);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    let response: Response;
    try {
      response = await fetchImpl(target, { method: 'POST', headers: { authorization: `Bot ${config.botToken}`,
        accept: 'application/json', ...(multipart ? {} : { 'content-type': 'application/json' }) }, body,
        redirect: 'error', signal: controller.signal });
    } catch { throw new Error('network_discord_delivery_ambiguous'); }
    finally { clearTimeout(timer); }
    if (!response.ok) fail('discord_provider_rejected');
    let data: unknown;
    try { data = await response.json(); } catch { fail('discord_provider_receipt_unconfirmed'); }
    const id = responseId(data);
    if (!id) fail('discord_provider_receipt_unconfirmed');
    return { provider_message_id: id };
  }
  return {
    async send(text, recipient) {
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) fail('discord_content_invalid');
      return post(recipient, JSON.stringify({ content: text }));
    },
    async sendFile(path, recipient, displayName) {
      if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 255) fail('discord_attachment_invalid');
      const file = await stat(path).catch(() => null);
      if (!file?.isFile() || file.size < 1 || file.size > maxAttachmentBytes) fail('discord_attachment_invalid');
      const raw = await readFile(path);
      if (raw.length !== file.size || raw.length > maxAttachmentBytes) fail('discord_attachment_invalid');
      const blobBytes = new Uint8Array(new ArrayBuffer(raw.length)); blobBytes.set(raw);
      const form = new FormData();
      form.set('payload_json', JSON.stringify({ content: '' }));
      form.set('files[0]', new Blob([blobBytes]), basename(displayName.replaceAll('\\', '/')));
      return post(recipient, form, true);
    },
  };
}
