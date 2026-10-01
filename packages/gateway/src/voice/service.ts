import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { VoiceAdapter, VoiceCatalog } from './adapter-client.ts';
import { VOICE_MAX_BYTES, VOICE_MAX_DURATION_SECONDS } from './wav.ts';

const RESULT_TTL_MS = 10 * 60_000;
const JOB_TTL_MS = 60 * 60_000;
const ACTIVE_LIMIT = 1;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

type StoredJob = {
  id: string; owner_id: string; conversation_id: string; client_request_id: string;
  request_sha256: string; status: string; language: string; error_code: string | null;
  created_at: string; updated_at: string; expires_at: string;
};
type ActiveJob = {
  controller: AbortController; audio: Buffer; providerId: string; language: string; done: Promise<void>;
};
type Result = { text: string; language: string; expiresAt: number };

function nowIso() { return new Date().toISOString(); }

export class VoiceTranscriptionService {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly results = new Map<string, Result>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly db: DatabaseSync;
  private readonly adapter: VoiceAdapter | undefined;

  constructor(db: DatabaseSync, adapter?: VoiceAdapter) {
    this.db = db;
    this.adapter = adapter;
    // Text is intentionally process-memory-only. Do not claim a prior success after its result vanished on restart.
    this.db.prepare("UPDATE ga_voice_transcriptions SET status='failed',error_code='result_expired',updated_at=? WHERE status='succeeded'").run(nowIso());
    this.db.prepare("UPDATE ga_voice_transcriptions SET status='failed',error_code='worker_restarted',updated_at=? WHERE status IN ('queued','transcribing')").run(nowIso());
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  isEnabled() { return !!this.adapter; }

  async catalog(signal?: AbortSignal): Promise<VoiceCatalog | null> {
    if (!this.adapter) return null;
    return this.adapter.catalog(signal);
  }

  async capability() {
    const disabled = { enabled: false, status: 'disabled', max_duration_ms: VOICE_MAX_DURATION_SECONDS * 1000,
      max_bytes: VOICE_MAX_BYTES, accepted_mime_types: ['audio/wav'], languages: [] as string[] };
    if (!this.adapter) return disabled;
    try {
      const catalog = await this.adapter.catalog(AbortSignal.timeout(5_000));
      const selected = catalog.providers.find(provider => provider.id === catalog.selection.providerId);
      if (!selected) return { ...disabled, status: 'unavailable' };
      const ready = ['ready', 'standby'].includes(selected.preparation.phase);
      const preparing = ['unprepared', 'downloading', 'checking', 'loading', 'waking', 'cancelling']
        .includes(selected.preparation.phase);
      const status = ready ? 'ready' : preparing ? 'preparing' : 'unavailable';
      return { ...disabled, enabled: ready, status,
        max_duration_ms: Math.min(VOICE_MAX_DURATION_SECONDS, catalog.maxDurationSeconds) * 1000,
        max_bytes: Math.min(VOICE_MAX_BYTES, catalog.maxAudioBytes), languages: selected.languages };
    } catch {
      return { ...disabled, status: 'unavailable' };
    }
  }

  enqueue(input: { ownerId: string; conversationId: string; clientRequestId: string; audio: Buffer; language?: string;
    catalog: VoiceCatalog }): Record<string, unknown> {
    this.cleanup();
    if (!SAFE_REQUEST_ID.test(input.clientRequestId)) throw new Error('voice_request_id_invalid');
    const selected = input.catalog.providers.find(provider => provider.id === input.catalog.selection.providerId);
    if (!selected || !['ready', 'standby'].includes(selected.preparation.phase)) throw new Error('voice_provider_not_ready');
    const language = input.language || input.catalog.selection.language;
    if (!selected.languages.includes(language)) throw new Error('voice_language_unsupported');
    const requestHash = createHash('sha256').update(input.audio).update('\0').update(language).digest('hex');
    const existing = this.db.prepare(`SELECT * FROM ga_voice_transcriptions
      WHERE owner_id=? AND conversation_id=? AND client_request_id=?`)
      .get(input.ownerId, input.conversationId, input.clientRequestId) as StoredJob | undefined;
    if (existing) {
      if (existing.request_sha256 !== requestHash) throw new Error('voice_idempotency_conflict');
      return this.publicState(existing);
    }
    if (this.jobs.size >= ACTIVE_LIMIT) throw new Error('voice_busy');
    const id = randomUUID();
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const expiresAt = new Date(now + JOB_TTL_MS).toISOString();
    this.db.prepare(`INSERT INTO ga_voice_transcriptions
      (id,owner_id,conversation_id,client_request_id,request_sha256,status,language,error_code,created_at,updated_at,expires_at)
      VALUES(?,?,?,?,?,'queued',?,NULL,?,?,?)`).run(id, input.ownerId, input.conversationId, input.clientRequestId,
      requestHash, language, iso, iso, expiresAt);
    const active: ActiveJob = { controller: new AbortController(), audio: input.audio, providerId: selected.id,
      language, done: Promise.resolve() };
    this.jobs.set(id, active);
    active.done = Promise.resolve().then(() => this.run(id, active));
    return { transcription_id: id, status: 'queued', created_at: iso };
  }

  get(ownerId: string, conversationId: string, id: string): Record<string, unknown> {
    this.cleanup();
    const row = this.find(ownerId, conversationId, id);
    if (!row) throw new Error('voice_transcription_not_found');
    if (row.status === 'succeeded') {
      const result = this.results.get(id);
      if (!result || result.expiresAt <= Date.now()) {
        this.results.delete(id);
        this.fail(id, 'result_expired');
        return { transcription_id: id, status: 'failed', error_code: 'result_expired', updated_at: nowIso() };
      }
      return { transcription_id: id, status: 'succeeded', text: result.text, language: result.language,
        created_at: row.created_at, updated_at: row.updated_at };
    }
    return this.publicState(row);
  }

  async cancel(ownerId: string, conversationId: string, id: string): Promise<Record<string, unknown>> {
    const row = this.find(ownerId, conversationId, id);
    if (!row) throw new Error('voice_transcription_not_found');
    const active = this.jobs.get(id);
    if (active) {
      active.controller.abort();
      await active.done;
    }
    return this.get(ownerId, conversationId, id);
  }

  async close() {
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job => job.done));
    this.results.clear();
  }

  private async run(id: string, active: ActiveJob) {
    this.update(id, 'transcribing', null);
    try {
      if (active.controller.signal.aborted) {
        this.update(id, 'cancelled', null);
        return;
      }
      const audio = active.audio;
      const transcript = await this.adapter!.transcribe({ audio, provider_id: active.providerId, language: active.language }, active.controller.signal);
      if (active.controller.signal.aborted) {
        this.update(id, 'cancelled', null);
        return;
      }
      if (typeof transcript.text !== 'string' || transcript.text.length > 100_000) throw new Error('voice_transcription_invalid');
      this.results.set(id, { text: transcript.text, language: active.language, expiresAt: Date.now() + RESULT_TTL_MS });
      this.update(id, 'succeeded', null);
    } catch {
      if (active.controller.signal.aborted) this.update(id, 'cancelled', null);
      else this.update(id, 'failed', 'transcription_failed');
    } finally {
      active.audio = Buffer.alloc(0);
      this.jobs.delete(id);
    }
  }

  private find(ownerId: string, conversationId: string, id: string): StoredJob | undefined {
    return this.db.prepare(`SELECT * FROM ga_voice_transcriptions WHERE id=? AND owner_id=? AND conversation_id=?`)
      .get(id, ownerId, conversationId) as StoredJob | undefined;
  }

  private update(id: string, status: string, errorCode: string | null) {
    this.db.prepare('UPDATE ga_voice_transcriptions SET status=?,error_code=?,updated_at=? WHERE id=?')
      .run(status, errorCode, nowIso(), id);
  }

  private fail(id: string, errorCode: string) {
    this.update(id, 'failed', errorCode);
  }

  private publicState(row: StoredJob): Record<string, unknown> {
    return { transcription_id: row.id, status: row.status, ...(row.error_code ? { error_code: row.error_code } : {}),
      ...(row.status === 'succeeded' ? { language: row.language } : {}), created_at: row.created_at, updated_at: row.updated_at };
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, result] of this.results) if (result.expiresAt <= now) this.results.delete(id);
    const iso = new Date(now).toISOString();
    this.db.prepare(`DELETE FROM ga_voice_transcriptions WHERE expires_at<? AND id NOT IN
      (SELECT id FROM ga_voice_transcriptions WHERE status IN ('queued','transcribing'))`).run(iso);
  }
}
