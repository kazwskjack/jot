import { timingSafeEqual } from 'node:crypto';
import type { DeliveryProvider } from '../worker.ts';
import { localProviderReceipt, type ProviderDeliveryContext } from './delivery-context.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type FetchLike = typeof fetch;
export type VerifiedHomeAssistantEvent = Readonly<{
  channel: 'homeassistant'; principal: string; providerThreadId: string; providerMessageId: string;
  text: string; attachments: readonly []; authenticated: true;
}>;
export type HomeAssistantBinding = { principal: string; threadId: string };
export type HomeAssistantConfig = { baseUrl: string; accessToken: string; notifyService: string; receiptNamespace: string;
  timeoutMs?: number; principal?: string };
function fail(code: string): never { throw new Error(code); }
function secretMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8'); const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}

/** The webhook ID is the Home Assistant credential; principal and thread come from trusted setup. */
export function verifyHomeAssistantWebhook(pathId: string, expectedId: string, payload: unknown,
  binding: HomeAssistantBinding): VerifiedHomeAssistantEvent {
  if (typeof pathId !== 'string' || typeof expectedId !== 'string' || !secretMatches(pathId, expectedId)) {
    fail('homeassistant_unauthorized');
  }
  if (!binding || typeof binding.principal !== 'string' || !ID.test(binding.principal)
    || typeof binding.threadId !== 'string' || !ID.test(binding.threadId)
    || !payload || typeof payload !== 'object' || Array.isArray(payload)) fail('homeassistant_event_invalid');
  const row = payload as Record<string, unknown>;
  if (Object.keys(row).some(key => !['context', 'event_id', 'id', 'message', 'text', 'attachments'].includes(key))) {
    fail('homeassistant_event_invalid');
  }
  if (Array.isArray(row.attachments) && row.attachments.length) fail('homeassistant_attachment_unsupported');
  if (row.attachments !== undefined && !Array.isArray(row.attachments)) fail('homeassistant_event_invalid');
  const context = row.context && typeof row.context === 'object' && !Array.isArray(row.context)
    ? row.context as Record<string, unknown> : {};
  const eventId = row.event_id ?? row.id ?? context.id;
  const text = typeof row.text === 'string' ? row.text : row.message;
  if (typeof eventId !== 'string' || !ID.test(eventId) || typeof text !== 'string'
    || text.length > 4000 || !text.trim()) fail('homeassistant_event_invalid');
  return Object.freeze({ channel: 'homeassistant', principal: binding.principal, providerThreadId: binding.threadId,
    providerMessageId: eventId, text: text.trim(), attachments: Object.freeze([]) as readonly [], authenticated: true });
}

function safeBase(value: unknown): URL {
  if (typeof value !== 'string') fail('homeassistant_config_invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('homeassistant_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('homeassistant_config_invalid');
  return url;
}

/** Text-only HA notification sender. HTTP acceptance is recorded locally because HA exposes no message ID. */
export function createHomeAssistantProvider(config: HomeAssistantConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string, context?: ProviderDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string, context?: ProviderDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  if (!config || typeof config.accessToken !== 'string' || !config.accessToken.trim() || /[\r\n]/.test(config.accessToken)
    || typeof config.notifyService !== 'string' || !/^[a-z0-9_]+$/.test(config.notifyService)
    || typeof config.receiptNamespace !== 'string' || !ID.test(config.receiptNamespace)
    || (config.principal !== undefined && !ID.test(config.principal))) fail('homeassistant_config_invalid');
  const base = safeBase(config.baseUrl);
  const timeout = config.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000) fail('homeassistant_config_invalid');
  return {
    async send(text, recipient, context) {
      if (typeof recipient !== 'string' || !ID.test(recipient) || (config.principal && recipient !== config.principal)
        || typeof text !== 'string' || !text.trim() || text.length > 120000) fail('homeassistant_delivery_invalid');
      const localReceipt = localProviderReceipt('homeassistant', context, config.receiptNamespace);
      const url = new URL(`/api/services/notify/${encodeURIComponent(config.notifyService)}`, base);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${config.accessToken}`,
          accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, title: 'Jot' }), redirect: 'error', signal: controller.signal });
      } catch { throw new Error('network_homeassistant_delivery_ambiguous'); }
      finally { clearTimeout(timer); }
      if (!response.ok) fail('homeassistant_provider_rejected');
      return { provider_message_id: localReceipt };
    },
    async sendFile(_path, _recipient, _displayName, _context) { fail('homeassistant_attachment_unsupported'); },
  };
}
