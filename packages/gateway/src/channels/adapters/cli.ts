import { timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type CliAttachment = Readonly<{
  providerFileId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  contentBase64: string;
}>;
export type VerifiedCliEvent = Readonly<{
  channel: 'cli';
  principal: 'local-installation';
  providerThreadId: string;
  providerMessageId: string;
  text: string;
  attachments: readonly CliAttachment[];
  authenticated: true;
}>;
export type CliFrame = Readonly<Record<string, unknown>>;
export type CliFrameWriter = (frame: CliFrame) => Promise<Record<string, unknown>>;

function fail(code: string): never { throw new Error(code); }
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}
function safeFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255
    && !/[\u0000-\u001f\u007f/\\]/.test(value) && value !== '.' && value !== '..';
}

/** Decode a CLI frame only after the local session token has been checked. */
export function verifyCliEnvelope(rawBody: string | Uint8Array, suppliedToken: string, expectedToken: string): VerifiedCliEvent {
  if (typeof suppliedToken !== 'string' || typeof expectedToken !== 'string' || !equalSecret(suppliedToken, expectedToken)) {
    fail('cli_unauthorized');
  }
  const raw = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!raw.length || raw.length > 32 * 1024 * 1024) fail('cli_envelope_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { fail('cli_envelope_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('cli_envelope_invalid');
  const input = parsed as Record<string, unknown>;
  if (Object.keys(input).some(key => !['session_id', 'message_id', 'text', 'attachments'].includes(key))
    || typeof input.session_id !== 'string' || !ID.test(input.session_id)
    || typeof input.message_id !== 'string' || !ID.test(input.message_id)
    || typeof input.text !== 'string' || input.text.length > 4000) fail('cli_envelope_invalid');
  const text = input.text.trim();
  const source = input.attachments === undefined ? [] : input.attachments;
  if (!Array.isArray(source) || source.length > 10) fail('cli_attachment_invalid');
  const attachments = source.map((value, index): CliAttachment => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('cli_attachment_invalid');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'content_base64,file_name,media_type'
      || !safeFileName(row.file_name) || typeof row.media_type !== 'string'
      || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(row.media_type)
      || typeof row.content_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content_base64)) {
      fail('cli_attachment_invalid');
    }
    const bytes = Buffer.from(row.content_base64, 'base64');
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== row.content_base64) {
      fail('cli_attachment_invalid');
    }
    return Object.freeze({ providerFileId: `${input.message_id}:${index + 1}`, fileName: row.file_name,
      mediaType: row.media_type.toLowerCase(), sizeBytes: bytes.length, contentBase64: row.content_base64 });
  });
  if (!text && !attachments.length) fail('cli_envelope_invalid');
  return Object.freeze({ channel: 'cli', principal: 'local-installation', providerThreadId: input.session_id,
    providerMessageId: input.message_id, text, attachments: Object.freeze(attachments), authenticated: true });
}

function acceptedReceipt(value: Record<string, unknown>): string {
  const id = value.provider_message_id ?? value.frame_id;
  if (typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    fail('cli_provider_receipt_unconfirmed');
  }
  return id;
}

/** Bridge to the local CLI process through its framed, acknowledged writer. */
export function createCliProvider(writeFrame: CliFrameWriter, options: { maxAttachmentBytes?: number } = {}): DeliveryProvider {
  if (typeof writeFrame !== 'function') fail('cli_config_invalid');
  const maxAttachmentBytes = options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > 100 * 1024 * 1024) {
    fail('cli_config_invalid');
  }
  async function transmit(frame: CliFrame): Promise<Record<string, unknown> & { provider_message_id: string }> {
    let ack: Record<string, unknown>;
    try { ack = await writeFrame(Object.freeze(frame)); }
    catch { throw new Error('network_cli_delivery_ambiguous'); }
    if (!ack || ack.accepted !== true) fail('cli_provider_rejected');
    return { provider_message_id: acceptedReceipt(ack) };
  }
  return {
    async send(text, recipient) {
      if (!ID.test(recipient) || typeof text !== 'string' || !text.trim() || text.length > 120000) fail('cli_delivery_invalid');
      return transmit({ type: 'text', session_id: recipient, text });
    },
    async sendFile(path, recipient, displayName) {
      if (!ID.test(recipient) || typeof displayName !== 'string' || !displayName.trim() || displayName.length > 255) {
        fail('cli_delivery_invalid');
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size < 1 || info.size > maxAttachmentBytes) fail('cli_attachment_invalid');
      const content = await readFile(path);
      if (content.length !== info.size || content.length > maxAttachmentBytes) fail('cli_attachment_invalid');
      return transmit({ type: 'file', session_id: recipient, file_name: basename(displayName.replaceAll('\\', '/')),
        size_bytes: content.length, content_base64: content.toString('base64') });
    },
  };
}
