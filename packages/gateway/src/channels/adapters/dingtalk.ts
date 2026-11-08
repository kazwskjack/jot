import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DeliveryProvider } from '../worker.ts';
import { localProviderReceipt, type ProviderDeliveryContext } from './delivery-context.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;
const MAX_BODY = 1024 * 1024;
type FetchLike = typeof fetch;
export type VerifiedDingTalkEvent = Readonly<{ channel: 'dingtalk'; principal: string; providerThreadId: string;
  providerMessageId: string; text: string; attachments: readonly Readonly<{providerFileId:string;fileName:string;mediaType:string}>[]; authenticated: true }>;
export type DingTalkCallbackResult = Readonly<{ kind: 'event' | 'challenge'; event?: VerifiedDingTalkEvent;
  acknowledgement: Readonly<{ msg_signature: string; timeStamp: string; nonce: string; encrypt: string }> }>;
export type DingTalkVerificationOptions = { token: string; aesKey: string; ownerKey: string; nowSeconds?: number; maxSkewSeconds?: number };
export type DingTalkProviderConfig = { webhookUrl: string; secret: string; timeoutMs?: number };
function fail(code: string): never { throw new Error(code); }
function equal(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function params(value: URLSearchParams | Record<string, string | undefined>, key: string): string {
  if (value instanceof URLSearchParams) return value.get(key) ?? '';
  return value[key] ?? '';
}
function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}$/.test(value)) fail('dingtalk_config_invalid');
  const key = Buffer.from(`${value}=`, 'base64');
  if (key.length !== 32) fail('dingtalk_config_invalid');
  return key;
}
function signed(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex');
}
function decrypt(encrypt: string, key: Buffer, ownerKey: string): string {
  let ciphertext: Buffer;
  try { ciphertext = Buffer.from(encrypt, 'base64'); } catch { fail('dingtalk_event_invalid'); }
  if (ciphertext.length < 32 || ciphertext.length % 16 !== 0 || ciphertext.toString('base64') !== encrypt) fail('dingtalk_event_invalid');
  let plaintext: Buffer;
  try {
    const cipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
  } catch { fail('dingtalk_event_invalid'); }
  if (plaintext.length < 20) fail('dingtalk_event_invalid');
  const length = plaintext.readUInt32BE(16); const end = 20 + length;
  if (end > plaintext.length || plaintext.subarray(end).toString('utf8') !== ownerKey) fail('dingtalk_event_invalid');
  return plaintext.subarray(20, end).toString('utf8');
}
function encrypt(message: string, key: Buffer, ownerKey: string): string {
  const body = Buffer.from(message, 'utf8');
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const plain = Buffer.concat([randomBytes(16), size, body, Buffer.from(ownerKey, 'utf8')]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}
function parseJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail('dingtalk_event_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('dingtalk_event_invalid');
  return parsed as Record<string, unknown>;
}
function acknowledgement(token: string, aes: Buffer, ownerKey: string, timestamp: string, nonce: string) {
  const ciphertext = encrypt('success', aes, ownerKey);
  return Object.freeze({ msg_signature: signed(token, timestamp, nonce, ciphertext), timeStamp: timestamp, nonce, encrypt: ciphertext });
}

/** Verify DingTalk HTTP callback signatures and decrypt the AES-256-CBC envelope. */
export function verifyDingTalkCallback(rawBody: string | Uint8Array,
  query: URLSearchParams | Record<string, string | undefined>, options: DingTalkVerificationOptions): DingTalkCallbackResult {
  if (!options || typeof options.token !== 'string' || options.token.length < 3 || options.token.length > 32
    || !/^[A-Za-z0-9]+$/.test(options.token) || typeof options.ownerKey !== 'string' || !options.ownerKey) fail('dingtalk_config_invalid');
  const aes = decodeKey(options.aesKey);
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (!bytes.length || bytes.length > MAX_BODY) fail('dingtalk_event_invalid');
  const timestamp = params(query, 'timestamp'); const nonce = params(query, 'nonce'); const signature = params(query, 'signature');
  if (!/^\d{10,13}$/.test(timestamp) || !nonce || nonce.length > 256 || !/^[a-f0-9]{40}$/i.test(signature)) {
    fail('dingtalk_signature_invalid');
  }
  const suppliedSeconds = timestamp.length === 13 ? Number(timestamp) / 1000 : Number(timestamp);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000); const skew = options.maxSkewSeconds ?? 300;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 1 || skew > 3600
    || Math.abs(now - suppliedSeconds) > skew) fail('dingtalk_timestamp_invalid');
  const actual = Buffer.from(signature, 'hex');
  const outer = parseJson(bytes.toString('utf8'));
  if (typeof outer.encrypt !== 'string') fail('dingtalk_event_invalid');
  const signatureExpected = Buffer.from(signed(options.token, timestamp, nonce, outer.encrypt), 'hex');
  if (!equal(actual, signatureExpected)) fail('dingtalk_signature_invalid');
  const decoded = parseJson(decrypt(outer.encrypt, aes, options.ownerKey));
  if (typeof decoded.EventType !== 'string') fail('dingtalk_event_invalid');
  const ack = acknowledgement(options.token, aes, options.ownerKey, timestamp, nonce);
  if (decoded.EventType.startsWith('check_')) return Object.freeze({ kind: 'challenge', acknowledgement: ack });
  const principal = decoded.SenderId ?? decoded.senderId ?? decoded.UserId ?? decoded.userId;
  const thread = decoded.ConversationId ?? decoded.conversationId ?? decoded.ChatId ?? decoded.chatId;
  const message = decoded.MessageId ?? decoded.msgId ?? decoded.messageId ?? decoded.EventId;
  const text = decoded.Text ?? decoded.text ?? decoded.Content ?? decoded.content;
  if (typeof principal !== 'string' || !ID.test(principal) || typeof thread !== 'string' || !ID.test(thread)
    || typeof message !== 'string' || !ID.test(message) || typeof text !== 'string' || text.length > 4000) {
    fail('dingtalk_event_invalid');
  }
  if ((decoded.Attachments !== undefined && !Array.isArray(decoded.Attachments))
    || (decoded.attachments !== undefined && !Array.isArray(decoded.attachments))
    || (decoded.Attachments !== undefined && decoded.attachments !== undefined)) fail('dingtalk_attachment_invalid');
  const source = Array.isArray(decoded.Attachments) ? decoded.Attachments : Array.isArray(decoded.attachments) ? decoded.attachments : [];
  if (source.length > 10) fail('dingtalk_attachment_invalid');
  const attachments = source.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('dingtalk_attachment_invalid');
    const item = value as Record<string, unknown>;
    const id = item.fileId ?? item.mediaId ?? item.media_id;
    const name = item.fileName ?? item.file_name ?? 'attachment.bin';
    const mediaType = item.mediaType ?? item.media_type ?? 'application/octet-stream';
    if (typeof id !== 'string' || !ID.test(id) || typeof name !== 'string' || !name || name.length > 255
      || /[\u0000-\u001f\u007f/\\]/.test(name) || typeof mediaType !== 'string') fail('dingtalk_attachment_invalid');
    return Object.freeze({ providerFileId: id, fileName: name, mediaType });
  });
  if (!String(text).trim() && !attachments.length) fail('dingtalk_event_invalid');
  const event: VerifiedDingTalkEvent = Object.freeze({ channel: 'dingtalk', principal, providerThreadId: thread,
    providerMessageId: message, text: String(text).trim(), attachments: Object.freeze(attachments), authenticated: true });
  return Object.freeze({ kind: 'event', event, acknowledgement: ack });
}

function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { fail('dingtalk_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.searchParams.has('access_token')) fail('dingtalk_config_invalid');
  return url;
}
export function createDingTalkProvider(config: DingTalkProviderConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string, context?: ProviderDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string, context?: ProviderDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  if (!config || typeof config.secret !== 'string' || !config.secret.trim() || config.secret.length > 128) fail('dingtalk_config_invalid');
  const url = safeUrl(config.webhookUrl); const timeout = config.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000) fail('dingtalk_config_invalid');
  return {
    async send(text, recipient, context) {
      if (typeof recipient !== 'string' || !ID.test(recipient) || typeof text !== 'string' || !text.trim() || text.length > 20000) {
        fail('dingtalk_delivery_invalid');
      }
      const localReceipt = localProviderReceipt('dingtalk', context);
      const timestamp = String(Date.now());
      const sign = createHmac('sha256', config.secret).update(`${timestamp}\n${config.secret}`).digest('base64');
      const target = new URL(url); target.searchParams.set('timestamp', timestamp); target.searchParams.set('sign', sign);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
      let response: Response;
      try { response = await fetchImpl(target, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }), redirect: 'error', signal: controller.signal }); }
      catch { throw new Error('network_dingtalk_delivery_ambiguous'); }
      finally { clearTimeout(timer); }
      if (!response.ok) fail('dingtalk_provider_rejected');
      let data: unknown;
      try { data = await response.json(); } catch { fail('dingtalk_provider_receipt_unconfirmed'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Record<string, unknown>).errcode !== 0) {
        fail('dingtalk_provider_rejected');
      }
      return { provider_message_id: localReceipt };
    },
    async sendFile(_path, _recipient, _displayName, _context) { fail('dingtalk_attachment_unsupported'); },
  };
}
