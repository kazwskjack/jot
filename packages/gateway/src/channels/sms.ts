import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MEDIA = 10;
const MAX_SMS_CHARS = 1600;
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01/Accounts/';
const E164 = /^\+[1-9][0-9]{1,14}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const MESSAGE_SID = /^(?:SM|MM)[0-9a-fA-F]{32}$/;
const TWIML_ACK = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

export type TwilioSmsWebhookHeaders = Headers | Record<string, string | string[] | undefined>;
export type TwilioFormParams = Record<string, string | string[]>;

export interface TwilioSmsIntake {
  accept(input: Record<string, unknown>, options: { providerSignatureVerified: boolean }): unknown | Promise<unknown>;
}

/** The route can inject Twilio's SDK validator; production uses the standard-library implementation. */
export type TwilioRequestValidator = (
  authToken: string,
  signature: string,
  webhookUrl: string,
  params: TwilioFormParams,
) => boolean;

export interface TwilioSmsWebhookConfig {
  accountSid: string;
  authToken: string;
  /** Exact externally configured HTTPS webhook URL, including query string. */
  webhookUrl: string;
  validateRequest: TwilioRequestValidator;
  intake: TwilioSmsIntake;
}

export interface TwilioSmsWebhookRequest {
  headers: TwilioSmsWebhookHeaders;
  body: Uint8Array;
}

export interface TwilioSmsWebhookResponse {
  status: number;
  contentType: 'application/xml; charset=utf-8';
  body: string;
  intake_result?: unknown;
  ignored?: true;
}

export type TwilioSmsTransport = (url: URL, init: RequestInit) => Promise<Response>;

interface TwilioSmsReplyContext {
  recipient: string;
  from: string;
  to: string;
}

/**
 * Accept signed Twilio form webhooks and pass their stable message identities into Jot intake.
 * This module owns no conversation, message-event, owner, or outbox tables.
 */
export function createTwilioSmsWebhookAdapter(config: TwilioSmsWebhookConfig) {
  const accountSid = checkedAccountSid(config?.accountSid, 'sms_config_invalid');
  const authToken = checkedCredential(config?.authToken, 'sms_config_invalid');
  const webhookUrl = checkedWebhookUrl(config?.webhookUrl);
  if (typeof config?.validateRequest !== 'function' || !config.intake
    || typeof config.intake.accept !== 'function') throw new Error('sms_config_invalid');

  return {
    async handle(request: TwilioSmsWebhookRequest): Promise<TwilioSmsWebhookResponse> {
      if (!request || !(request.body instanceof Uint8Array) || request.body.byteLength < 1
        || request.body.byteLength > MAX_CALLBACK_BYTES) throw new Error('sms_callback_body_invalid');
      if (!isFormContentType(header(request.headers, 'content-type'))) throw new Error('sms_content_type_invalid');

      const params = parseTwilioForm(request.body);
      const signature = header(request.headers, 'x-twilio-signature');
      if (!/^[A-Za-z0-9+/]{27}=$/.test(signature)) throw new Error('sms_signature_invalid');
      let verified = false;
      try { verified = config.validateRequest(authToken, signature, webhookUrl, params); }
      catch { verified = false; }
      if (verified !== true) throw new Error('sms_signature_invalid');

      const receivedAccountSid = formValue(params, 'AccountSid', 'sms_account_sid_invalid');
      if (receivedAccountSid !== accountSid) throw new Error('sms_account_sid_mismatch');
      const messageSid = formValue(params, 'MessageSid', 'sms_message_sid_invalid');
      if (!MESSAGE_SID.test(messageSid)) throw new Error('sms_message_sid_invalid');
      const from = checkedPhone(formValue(params, 'From', 'sms_from_invalid'), 'sms_from_invalid');
      const to = checkedPhone(formValue(params, 'To', 'sms_to_invalid'), 'sms_to_invalid');
      const text = optionalFormValue(params, 'Body', 'sms_body_invalid');
      if (text.length > MAX_SMS_CHARS || /[\u0000\u007f]/.test(text)) throw new Error('sms_body_invalid');
      const attachments = parseTwilioSmsMedia(params, accountSid, messageSid);
      if (!text.trim() && !attachments.length) return ack({ ignored: true });

      const normalized = {
        channel: 'sms',
        principal: `sms:${accountSid}:${from}`,
        thread_id: to,
        message_id: messageSid,
        text,
        ...(attachments.length ? { attachments } : {}),
      };
      const intakeResult = await config.intake.accept(normalized, { providerSignatureVerified: true });
      return ack({ intake_result: intakeResult });
    },
  };
}

/** Send only as a reply to a Jot outbox effect correlated with an authenticated inbound message. */
export function createTwilioSmsDeliveryProvider(
  config: { accountSid: string; apiKeySid: string; apiKeySecret: string; timeoutMs?: number },
  db: DatabaseSync,
  transport: TwilioSmsTransport = fetch,
) {
  const accountSid = checkedAccountSid(config?.accountSid, 'sms_config_invalid');
  const apiKeySid = checkedApiKeySid(config?.apiKeySid, 'sms_config_invalid');
  const apiKeySecret = checkedCredential(config?.apiKeySecret, 'sms_config_invalid');
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) {
    throw new Error('sms_config_invalid');
  }

  const sendWithKey = async (text: string, recipient: string, effectId: string) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value || value.length > MAX_SMS_CHARS || typeof effectId !== 'string' || !effectId
      || effectId.length > 512 || /[\u0000-\u001f\u007f]/.test(effectId)) {
      throw new Error('sms_message_invalid');
    }
    const context = resolveTwilioSmsReplyContext(db, effectId);
    if (!context || context.recipient !== recipient || !context.recipient.startsWith(`sms:${accountSid}:`)) {
      throw new Error('sms_reply_context_missing');
    }

    const body = new URLSearchParams({ To: context.from, From: context.to, Body: value });
    const response = await transport(new URL(`${accountSid}/Messages.json`, TWILIO_API_BASE), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return {};
    const receipt = await responseObject(response);
    if (typeof receipt.sid !== 'string' || !MESSAGE_SID.test(receipt.sid)) return {};
    return { provider_message_id: receipt.sid };
  };

  return {
    async send(): Promise<Record<string, unknown>> {
      throw new Error('sms_reply_context_required');
    },
    sendWithKey,
    async sendFile(): Promise<Record<string, unknown>> {
      throw new Error('sms_file_delivery_not_supported');
    },
  };
}

/** Resolve both phone numbers from the original event; never take an arbitrary send destination. */
export function resolveTwilioSmsReplyContext(db: DatabaseSync, effectId: string): TwilioSmsReplyContext | undefined {
  const rows = db.prepare(`SELECT e.recipient,v.principal,v.provider_thread_id,v.provider_message_id
    FROM ga_channel_deliveries e
    JOIN ga_channel_message_events v ON v.channel='sms' AND v.run_id=e.run_id AND v.principal=e.recipient
    JOIN ga_runs r ON r.id=e.run_id AND r.id=v.run_id AND r.conversation_id=v.conversation_id
      AND r.input_message_id=v.message_id
    JOIN ga_conversations c ON c.id=r.conversation_id AND c.id=v.conversation_id
    JOIN ga_messages source ON source.id=v.message_id AND source.run_id=r.id
      AND source.conversation_id=c.id AND source.role='user'
    JOIN ga_messages reply ON reply.id=e.message_id AND reply.run_id=r.id
      AND reply.conversation_id=c.id AND reply.role='assistant'
    JOIN ga_owner_channel_bindings b ON b.channel_binding_id=v.channel_binding_id
      AND b.owner_id=c.owner_id AND b.channel='sms' AND b.principal=v.principal
      AND b.status='verified' AND b.version=v.binding_version
    JOIN ga_channel_threads t ON t.channel='sms' AND t.principal=v.principal
      AND t.provider_thread_id=v.provider_thread_id AND t.conversation_id=c.id
      AND t.channel_binding_id=b.channel_binding_id AND t.binding_version=b.version
    WHERE e.effect_id=? AND e.destination='sms' AND e.status='sending'
      AND e.provider_receipt_json IS NULL AND e.artifact_ref IS NULL
      AND CASE WHEN json_valid(e.payload_json)=1 THEN json_extract(e.payload_json,'$.kind')='text' ELSE 0 END`)
    .all(effectId) as Array<Record<string, unknown>>;
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (typeof row.recipient !== 'string' || row.recipient !== row.principal
    || typeof row.provider_thread_id !== 'string' || typeof row.provider_message_id !== 'string'
    || !MESSAGE_SID.test(row.provider_message_id)) return undefined;
  const target = parsePrincipal(row.recipient);
  if (!target || !E164.test(row.provider_thread_id)) return undefined;
  return { recipient: row.recipient, from: target.phone, to: row.provider_thread_id };
}

export function validateTwilioRequestSignature(
  authToken: string,
  signature: string,
  webhookUrl: string,
  params: TwilioFormParams,
): boolean {
  if (!authToken || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(signature)) return false;
  const suffix = Object.keys(params).sort().map(key => {
    const value = params[key];
    return Array.isArray(value)
      ? [...new Set(value)].sort().map(item => key + item).join('')
      : key + value;
  }).join('');
  const expected = createHmac('sha1', authToken).update(webhookUrl + suffix, 'utf8').digest();
  const received = Buffer.from(signature, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseTwilioSmsMedia(params: TwilioFormParams, accountSid: string, messageSid: string): Array<{
  provider_file_id: string;
  file_name: string;
  media_type: string;
  media_url: string;
}> {
  const countText = optionalFormValue(params, 'NumMedia', 'sms_media_count_invalid');
  const count = countText === '' ? 0 : /^\d{1,2}$/.test(countText) ? Number(countText) : -1;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_MEDIA) throw new Error('sms_media_count_invalid');
  const attachments = [];
  for (let index = 0; index < count; index++) {
    const url = formValue(params, `MediaUrl${index}`, 'sms_media_invalid');
    const mediaType = formValue(params, `MediaContentType${index}`, 'sms_media_invalid');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('sms_media_invalid'); }
    const expectedPath = `/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/ME[0-9a-fA-F]{32}`;
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.twilio.com' || parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !new RegExp(`^${expectedPath}$`).test(parsed.pathname)
      || !mediaType || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)
      || mediaType.length > 200
      || /[\u0000-\u001f\u007f]/.test(mediaType)) throw new Error('sms_media_invalid');
    attachments.push({ provider_file_id: `${messageSid}:media:${index}`,
      file_name: `media-${index}`, media_type: mediaType.toLowerCase(), media_url: parsed.toString() });
  }
  return attachments;
}

export const twilioSmsLimits = Object.freeze({ maxMedia: MAX_MEDIA, maxMediaBytes: 20 * 1024 * 1024,
  maxAggregateMediaBytes: 100 * 1024 * 1024 });

function parseTwilioForm(body: Uint8Array): TwilioFormParams {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new Error('sms_form_invalid'); }
  if (/%(?![0-9A-Fa-f]{2})/.test(text)) throw new Error('sms_form_invalid');
  const params: TwilioFormParams = {};
  for (const [key, value] of new URLSearchParams(text)) {
    if (!key || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('sms_form_invalid');
    const previous = params[key];
    if (previous === undefined) params[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else params[key] = [previous, value];
  }
  return params;
}

function isFormContentType(value: string): boolean {
  const [mediaType, ...parameters] = value.split(';');
  return mediaType?.trim().toLowerCase() === 'application/x-www-form-urlencoded'
    && parameters.every(parameter => /^\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(parameter));
}

function formValue(params: TwilioFormParams, name: string, error: string): string {
  const value = params[name];
  if (typeof value !== 'string') throw new Error(value === undefined ? error : 'sms_parameter_duplicate');
  return value;
}

function optionalFormValue(params: TwilioFormParams, name: string, error: string): string {
  return params[name] === undefined ? '' : formValue(params, name, error);
}

function checkedPhone(value: string, error: string): string {
  if (!E164.test(value)) throw new Error(error);
  return value;
}

function checkedAccountSid(value: unknown, error: string): string {
  if (typeof value !== 'string' || !ACCOUNT_SID.test(value)) throw new Error(error);
  return value;
}

function checkedApiKeySid(value: unknown, error: string): string {
  if (typeof value !== 'string' || !API_KEY_SID.test(value)) throw new Error(error);
  return value;
}

function checkedCredential(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new Error(error);
  }
  return value;
}

function checkedWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('sms_config_invalid');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('sms_config_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('sms_config_invalid');
  }
  return value;
}

function parsePrincipal(value: string): { accountSid: string; phone: string } | undefined {
  const match = /^sms:(AC[0-9a-fA-F]{32}):(\+[1-9][0-9]{1,14})$/.exec(value);
  return match ? { accountSid: match[1]!, phone: match[2]! } : undefined;
}

function header(headers: TwilioSmsWebhookHeaders, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

function ack(extra: { intake_result?: unknown; ignored?: true }): TwilioSmsWebhookResponse {
  return { status: 200, contentType: 'application/xml; charset=utf-8', body: TWIML_ACK, ...extra };
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await response.text(); } catch { return {}; }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
