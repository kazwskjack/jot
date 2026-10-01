export type VoiceProvider = {
  id: string;
  name: string;
  location: 'host-local' | 'cloud';
  languages: string[];
  preparation: { phase: string };
};

export type VoiceCatalog = {
  providers: VoiceProvider[];
  selection: { providerId: string; language: string };
  maxAudioBytes: number;
  maxDurationSeconds: number;
};

export type VoiceTranscript = { text: string; audio_seconds: number; inference_seconds: number };
export type VoiceAdapter = {
  catalog(signal?: AbortSignal): Promise<VoiceCatalog>;
  transcribe(input: { audio: Buffer; provider_id: string; language: string }, signal: AbortSignal): Promise<VoiceTranscript>;
};

export type AdapterFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function loopbackEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('voice_adapter_endpoint_not_loopback');
  }
  return url.toString().replace(/\/$/, '');
}

function asCatalog(value: unknown): VoiceCatalog {
  const row = value as Record<string, any> | null;
  if (!row || !Array.isArray(row.providers) || !row.selection
    || typeof row.selection.providerId !== 'string' || typeof row.selection.language !== 'string'
    || !Number.isSafeInteger(row.maxAudioBytes) || row.maxAudioBytes < 1
    || !Number.isFinite(row.maxDurationSeconds) || row.maxDurationSeconds <= 0) {
    throw new Error('voice_adapter_unavailable');
  }
  const providers = row.providers.map((provider: any) => {
    if (!provider || typeof provider.id !== 'string' || typeof provider.name !== 'string'
      || !['host-local', 'cloud'].includes(provider.location) || !Array.isArray(provider.languages)
      || typeof provider.preparation?.phase !== 'string') throw new Error('voice_adapter_unavailable');
    return { id: provider.id, name: provider.name, location: provider.location,
      languages: provider.languages.filter((language: unknown): language is string => typeof language === 'string'),
      preparation: { phase: provider.preparation.phase } };
  });
  return { providers, selection: { providerId: row.selection.providerId, language: row.selection.language },
    maxAudioBytes: row.maxAudioBytes, maxDurationSeconds: row.maxDurationSeconds };
}

export class VoiceAdapterClient implements VoiceAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: AdapterFetch;

  constructor(baseUrl: string, token: string, fetchImpl: AdapterFetch = globalThis.fetch) {
    this.baseUrl = loopbackEndpoint(baseUrl);
    if (token.length < 32) throw new Error('voice_adapter_token_invalid');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(`voice_adapter_http_${response.status}:${String(value?.error ?? 'unavailable')}`);
    return value;
  }

  async catalog(signal?: AbortSignal): Promise<VoiceCatalog> {
    return asCatalog(await this.post('/v1/voice/catalog', {}, signal));
  }

  async transcribe(input: { audio: Buffer; provider_id: string; language: string }, signal: AbortSignal): Promise<VoiceTranscript> {
    const value = await this.post('/v1/voice/transcribe', {
      audio_base64: input.audio.toString('base64'), provider_id: input.provider_id, language: input.language,
    }, signal) as Record<string, unknown> | null;
    if (!value || typeof value.text !== 'string' || typeof value.audio_seconds !== 'number'
      || typeof value.inference_seconds !== 'number') throw new Error('voice_adapter_response_invalid');
    return { text: value.text, audio_seconds: value.audio_seconds, inference_seconds: value.inference_seconds };
  }
}
