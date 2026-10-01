import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';

export class FutureCursorError extends Error {
  constructor() { super('event_cursor_in_future'); }
}

export class ExpiredCursorError extends Error {
  constructor() { super('event_cursor_expired'); }
}

export interface StoredAgentEvent {
  schema_version: '1.0';
  event_id: string;
  conversation_id: string;
  run_id: string;
  seq: string;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

export class EventStore {
  private readonly db: DatabaseSync;
  private readonly notifications = new EventEmitter();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  append(
    conversationId: string,
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): StoredAgentEvent {
    if (!this.db.isTransaction) throw new Error('event_append_requires_transaction');
    const sequence = this.db.prepare(
      'UPDATE ga_conversations SET next_seq=next_seq+1,updated_at=? WHERE id=? RETURNING next_seq-1 AS seq',
    ).get(new Date().toISOString(), conversationId) as { seq: number } | undefined;
    if (!sequence) throw new Error('conversation_not_found');
    const event: StoredAgentEvent = {
      schema_version: '1.0',
      event_id: `evt-${randomUUID()}`,
      conversation_id: conversationId,
      run_id: runId,
      seq: String(sequence.seq),
      at: new Date().toISOString(),
      type,
      payload,
    };
    this.db.prepare(
      'INSERT INTO ga_events(conversation_id,seq,event_id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(conversationId, sequence.seq, event.event_id, runId, type, JSON.stringify(payload), event.at);
    queueMicrotask(() => this.notifications.emit(conversationId));
    return event;
  }

  subscribe(conversationId: string, listener: () => void): () => void {
    this.notifications.on(conversationId, listener);
    return () => this.notifications.off(conversationId, listener);
  }

  head(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT next_seq-1 AS seq FROM ga_conversations WHERE id=?',
    ).get(conversationId) as { seq: number } | undefined;
    if (!row) throw new Error('conversation_not_found');
    return Number(row.seq);
  }

  replay(conversationId: string, afterSeq: number, limit: number): StoredAgentEvent[] {
    const head = this.head(conversationId);
    if (afterSeq > head) throw new FutureCursorError();
    const range = this.db.prepare(
      'SELECT MIN(seq) AS minimum FROM ga_events WHERE conversation_id=?',
    ).get(conversationId) as { minimum: number | null };
    if (range.minimum === null && afterSeq < head) throw new ExpiredCursorError();
    if (range.minimum !== null && afterSeq < Number(range.minimum) - 1) throw new ExpiredCursorError();
    const rows = this.db.prepare(
      'SELECT seq,event_id,run_id,type,payload_json,created_at FROM ga_events '
      + 'WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?',
    ).all(conversationId, Math.max(0, afterSeq), Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      schema_version: '1.0', event_id: String(row.event_id), conversation_id: conversationId,
      run_id: String(row.run_id ?? ''), seq: String(row.seq), at: String(row.created_at),
      type: String(row.type), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }
}
