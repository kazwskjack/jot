import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import type { EventStore } from '../events/event-store.ts';
import type { ChannelDeliveryService } from '../channels/delivery.ts';

const ACTIVE = new Set(['pending', 'running', 'cancelling', 'unknown']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

export type CrawlBatchEvent = {
  batch_id: string;
  event_id: string;
  event_seq: number;
  type: 'batch.started' | 'item.updated' | 'batch.completed' | 'batch.failed' | 'batch.cancelled';
  status?: string;
  input_index?: number;
  item_id?: string;
  url?: string;
  title?: string;
  source_id?: string;
  result_ref?: string;
  error_code?: string;
  excerpt?: string;
  requested_count?: number;
}

function identifier(value: unknown, pattern: RegExp, name: string): string {
  const text = String(value ?? '');
  if (!pattern.test(text)) throw new Error(`${name}_invalid`);
  return text;
}

function nowIso() { return new Date().toISOString(); }

/**
 * Durable J-side projection for the C native crawl batch.
 *
 * The service never decides that a Harness run is complete.  It only records
 * the batch, emits activity/source events, and leaves run publication to the
 * existing Harness worker.
 */
export class CrawlBatchService {
  private readonly db: DatabaseSync;
  private readonly events: EventStore;
  private readonly delivery: ChannelDeliveryService | undefined;

  constructor(db: DatabaseSync, events: EventStore, delivery?: ChannelDeliveryService) {
    this.db = db; this.events = events; this.delivery = delivery;
  }

  bind(input: { batch_id: string; run_id: string; owner_id: string; conversation_id: string; requested_count: number; generation?: number }) {
    const batchId = identifier(input.batch_id, /^batch-[A-Za-z0-9-]{8,128}$/, 'batch_id');
    const runId = identifier(input.run_id, /^run-[A-Za-z0-9-]{8,128}$/, 'run_id');
    const ownerId = identifier(input.owner_id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'owner_id');
    const conversationId = identifier(input.conversation_id, /^conv-[A-Za-z0-9-]{8,128}$/, 'conversation_id');
    if (!Number.isInteger(input.requested_count) || input.requested_count < 1 || input.requested_count > 50) {
      throw new Error('requested_count_invalid');
    }
    return withImmediateTransaction(this.db, () => {
      const run = this.db.prepare(`SELECT r.id,r.conversation_id,c.owner_id FROM ga_runs r
        JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.conversation_id=? AND c.owner_id=?`)
        .get(runId, conversationId, ownerId) as { id: string } | undefined;
      if (!run) throw new Error('crawl_batch_owner_mismatch');
      const existing = this.db.prepare('SELECT * FROM ga_crawl_batches WHERE batch_id=?').get(batchId) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.run_id) !== runId || String(existing.owner_id) !== ownerId) throw new Error('crawl_batch_owner_mismatch');
        return this.batchValue(existing);
      }
      const now = nowIso();
      this.db.prepare(`INSERT INTO ga_crawl_batches(
        batch_id,run_id,conversation_id,owner_id,status,requested_count,generation,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(batchId, runId, conversationId, ownerId, 'pending', input.requested_count,
        Number.isInteger(input.generation) ? Number(input.generation) : 0, now, now);
      const value = this.batchValue(this.batch(batchId)!);
      this.events.append(conversationId, runId, 'activity.upsert', this.activity(value));
      return value;
    });
  }

  ingest(ownerId: string, event: CrawlBatchEvent) {
    const owner = identifier(ownerId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'owner_id');
    const batchId = identifier(event.batch_id, /^batch-[A-Za-z0-9-]{8,128}$/, 'batch_id');
    const eventId = identifier(event.event_id, /^evt-[A-Za-z0-9-]{8,160}$/, 'event_id');
    if (!Number.isInteger(event.event_seq) || event.event_seq < 1) throw new Error('event_seq_invalid');
    return withImmediateTransaction(this.db, () => {
      const batch = this.db.prepare('SELECT * FROM ga_crawl_batches WHERE batch_id=? AND owner_id=?').get(batchId, owner) as Record<string, unknown> | undefined;
      if (!batch) throw new Error('crawl_batch_not_found');
      const duplicate = this.db.prepare('SELECT event_seq FROM ga_crawl_events WHERE event_id=?').get(eventId) as { event_seq: number } | undefined;
      if (duplicate) return { ...this.batchValue(batch), duplicate: true };
      if (event.event_seq <= Number(batch.last_event_seq)) return { ...this.batchValue(batch), stale: true };
      const created = nowIso();
      this.db.prepare(`INSERT INTO ga_crawl_events(batch_id,event_seq,event_id,event_type,payload_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(batchId, event.event_seq, eventId, event.type, JSON.stringify(event), created);
      if (event.type === 'item.updated') this.upsertItem(batch, event, created);
      const nextStatus = this.statusFor(event, String(batch.status));
      this.db.prepare(`UPDATE ga_crawl_batches SET status=?,last_event_seq=?,completed_count=(
        SELECT COUNT(*) FROM ga_crawl_items WHERE batch_id=? AND status IN ('succeeded','failed','cancelled')
      ),failed_count=(SELECT COUNT(*) FROM ga_crawl_items WHERE batch_id=? AND status='failed'),updated_at=? WHERE batch_id=?`)
        .run(nextStatus, event.event_seq, batchId, batchId, created, batchId);
      const updatedRow = this.batch(batchId)!;
      const updated = this.batchValue(updatedRow);
      this.enqueueTerminalSummary(batch, updatedRow, updated);
      this.events.append(String(updated.conversation_id), String(updated.run_id), 'activity.upsert', this.activity(updated));
      if (event.type === 'item.updated' && event.source_id && event.url) {
        const access = event.error_code ? 'failed' : 'read';
        this.upsertSource(updated, event, access, created);
      }
      if (event.type === 'item.updated' && event.source_id && event.url) {
        this.events.append(String(updated.conversation_id), String(updated.run_id), 'source.upsert', this.source(event, updated, created));
      }
      return updated;
    });
  }

  get(ownerId: string, batchId: string) {
    const owner = identifier(ownerId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'owner_id');
    const id = identifier(batchId, /^batch-[A-Za-z0-9-]{8,128}$/, 'batch_id');
    const value = this.batch(id);
    if (!value || String(value.owner_id) !== owner) throw new Error('crawl_batch_not_found');
    const items = this.db.prepare('SELECT * FROM ga_crawl_items WHERE batch_id=? ORDER BY input_index').all(id);
    const events = this.db.prepare('SELECT event_seq,event_id,event_type,created_at FROM ga_crawl_events WHERE batch_id=? ORDER BY event_seq DESC LIMIT 100').all(id);
    return { ...value, items, recent_events: events.reverse() };
  }

  private enqueueTerminalSummary(
    before: Record<string, unknown>,
    row: Record<string, unknown>,
    value: ReturnType<CrawlBatchService['batchValue']>,
  ): void {
    if (!this.delivery || !TERMINAL.has(value.status) || row.summary_delivery_effect_id) return;
    const owner = String(before.owner_id ?? '');
    const prefix = 'channel:wecom:';
    if (!owner.startsWith(prefix) || owner.length <= prefix.length) return;
    const recipient = owner.slice(prefix.length);
    const status = value.status === 'cancelled' ? '已取消'
      : value.status === 'partial' ? '部分完成'
        : value.status === 'failed' ? '失败' : '完成';
    const text = `并行采集${status}：${value.completed_count}/${value.requested_count} 项已结束，失败 ${value.failed_count} 项。`;
    const delivery = this.delivery.enqueueText({
      runId: value.run_id,
      messageId: `crawl-summary:${value.batch_id}`,
      destination: 'wecom',
      recipient,
      text,
    });
    if (delivery?.effect_id) {
      this.db.prepare('UPDATE ga_crawl_batches SET summary_delivery_effect_id=?,updated_at=? WHERE batch_id=? AND summary_delivery_effect_id IS NULL')
        .run(String(delivery.effect_id), nowIso(), value.batch_id);
    }
  }

  cancel(ownerId: string, runId: string, reason = 'USER_CANCELLED') {
    const owner = identifier(ownerId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'owner_id');
    const run = identifier(runId, /^run-[A-Za-z0-9-]{8,128}$/, 'run_id');
    const cleanReason = /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : 'USER_CANCELLED';
    return withImmediateTransaction(this.db, () => {
      const rows = this.db.prepare(`SELECT * FROM ga_crawl_batches WHERE run_id=? AND owner_id=? AND status IN ('pending','running','unknown','cancelling')`)
        .all(run, owner) as Array<Record<string, unknown>>;
      const result = [];
      for (const row of rows) {
        if (Boolean(row.cancel_requested) && String(row.status) === 'cancelling') {
          result.push(this.batchValue(row));
          continue;
        }
        const at = nowIso();
        this.db.prepare("UPDATE ga_crawl_batches SET status='cancelling',cancel_requested=1,updated_at=? WHERE batch_id=?").run(at, String(row.batch_id));
        this.db.prepare(`INSERT INTO ga_outbox(conversation_id,aggregate_type,aggregate_id,event_type,payload_json,created_at)
          VALUES(?,?,?,?,?,?)`).run(String(row.conversation_id), 'crawl_batch', String(row.batch_id), 'crawl.cancel', JSON.stringify({ batch_id: row.batch_id, reason: cleanReason }), at);
        const updated = this.batchValue(this.batch(String(row.batch_id))!);
        this.events.append(String(row.conversation_id), run, 'activity.upsert', this.activity(updated));
        result.push(updated);
      }
      return { accepted: true, batches: result };
    });
  }

  private batch(id: string) { return this.db.prepare('SELECT * FROM ga_crawl_batches WHERE batch_id=?').get(id) as Record<string, unknown> | undefined; }

  private batchValue(row: Record<string, unknown>) {
    return { batch_id: String(row.batch_id), run_id: String(row.run_id), conversation_id: String(row.conversation_id),
      owner_id: String(row.owner_id), status: String(row.status), requested_count: Number(row.requested_count),
      completed_count: Number(row.completed_count), failed_count: Number(row.failed_count),
      cancel_requested: Boolean(row.cancel_requested), last_event_seq: Number(row.last_event_seq),
      generation: Number(row.generation), created_at: String(row.created_at), updated_at: String(row.updated_at) };
  }

  private statusFor(event: CrawlBatchEvent, current: string) {
    if (event.type === 'batch.started') return 'running';
    if (event.type === 'batch.completed') return event.status && TERMINAL.has(event.status) ? event.status : 'succeeded';
    if (event.type === 'batch.failed') return 'failed';
    if (event.type === 'batch.cancelled') return 'cancelled';
    return ACTIVE.has(current) ? 'running' : current;
  }

  private upsertItem(batch: Record<string, unknown>, event: CrawlBatchEvent, at: string) {
    if (!Number.isInteger(event.input_index) || event.input_index! < 0 || event.input_index! >= Number(batch.requested_count)) throw new Error('input_index_invalid');
    const inputIndex = Number(event.input_index);
    const itemId = identifier(event.item_id, /^item-[A-Za-z0-9-]{4,160}$/, 'item_id');
    const url = new URL(String(event.url ?? ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('crawl_url_invalid');
    const status = ['succeeded', 'failed', 'cancelled', 'running', 'pending'].includes(String(event.status)) ? String(event.status) : 'failed';
    this.db.prepare(`INSERT INTO ga_crawl_items(batch_id,input_index,item_id,url,status,title,source_id,result_ref,error_code,excerpt,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,input_index) DO UPDATE SET item_id=excluded.item_id,url=excluded.url,
      status=excluded.status,title=excluded.title,source_id=excluded.source_id,result_ref=excluded.result_ref,
      error_code=excluded.error_code,excerpt=excluded.excerpt,updated_at=excluded.updated_at`)
      .run(String(batch.batch_id), inputIndex, itemId, url.href, status, event.title ?? null, event.source_id ? String(event.source_id) : null,
        event.result_ref ? String(event.result_ref) : null, event.error_code ? String(event.error_code) : null, event.excerpt ? String(event.excerpt).slice(0, 8000) : null, at);
  }

  private activity(value: ReturnType<CrawlBatchService['batchValue']>) {
    const items = this.db.prepare('SELECT input_index,url,status,error_code FROM ga_crawl_items WHERE batch_id=? ORDER BY input_index')
      .all(value.batch_id) as Array<{ input_index: number; url: string; status: string; error_code?: string | null }>;
    const errors = items.filter(item => item.status === 'failed' && item.error_code).map(item => ({
      input_index: Number(item.input_index), error_code: String(item.error_code), url: String(item.url)
    }));
    return { activity_id: `crawl:${value.batch_id}`, run_id: value.run_id, tool_call_id: value.batch_id,
      // Preserve partial as a first-class UI status. Mapping it to succeeded
      // hides failed items and makes a batch look fully complete after replay.
      status: value.status === 'succeeded' ? 'succeeded' : value.status === 'partial' ? 'partial' : value.status === 'failed' ? 'failed' : value.status === 'cancelled' ? 'cancelled' : value.status,
      title: `并行采集 ${value.completed_count}/${value.requested_count}`, started_at: value.created_at,
      ...(TERMINAL.has(value.status) ? { ended_at: value.updated_at } : {}), kind: 'crawl',
      detail: { tool_name: 'universe_crawl', action: value.status, urls: items.map(item => String(item.url)), operation: 'fetch',
        requested_count: value.requested_count, completed_count: value.completed_count, failed_count: value.failed_count,
        ...(errors.length ? { errors } : {}), batch_id: value.batch_id } };
  }

  private upsertSource(batch: ReturnType<CrawlBatchService['batchValue']>, event: CrawlBatchEvent, access: string, at: string) {
    const id = String(event.source_id);
    this.db.prepare(`INSERT INTO ga_sources(id,conversation_id,run_id,url,access,runtime_evidence_ref,metadata_json,runtime_revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET access=excluded.access,metadata_json=excluded.metadata_json,
      runtime_revision=excluded.runtime_revision,updated_at=excluded.updated_at WHERE excluded.runtime_revision>ga_sources.runtime_revision`)
      .run(id, batch.conversation_id, batch.run_id, new URL(String(event.url)).href, access, event.result_ref ?? null,
        JSON.stringify({ activity_id: `crawl:${batch.batch_id}`, title: event.title ?? '', host: new URL(String(event.url)).hostname,
          retrieved_at: at, excerpt: event.excerpt ? String(event.excerpt).slice(0, 8000) : undefined, error_code: event.error_code }),
        Number(event.event_seq ?? 0), at, at);
  }

  private source(event: CrawlBatchEvent, batch: ReturnType<CrawlBatchService['batchValue']>, at: string) {
    const url = new URL(String(event.url));
    return { source_id: event.source_id, activity_id: `crawl:${batch.batch_id}`, url: url.href,
      title: event.title ?? '', host: url.hostname, access: event.error_code ? 'failed' : 'read', retrieved_at: at,
      ...(event.excerpt ? { excerpt: String(event.excerpt).slice(0, 8000) } : {}), ...(event.error_code ? { error_code: event.error_code } : {}) };
  }
}

export function isCrawlBatchActive(status: string): boolean { return ACTIVE.has(status); }
