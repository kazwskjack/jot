import type { DatabaseSync } from 'node:sqlite';

interface RetentionCandidate {
  category: 'ga_events' | 'cold_conversation';
  conversation_id: string;
  observed_at: string;
  protected: true;
  deletable: false;
  backup_verified: false;
  reasons: string[];
  event_count?: number;
  payload_bytes?: number;
  oldest_seq?: number;
  newest_seq?: number;
}

// This is deliberately an inventory, not a deletion API. ga_runs.checkpoint_id is
// a runtime reference, not proof that product event projections can be restored.
export function buildEventRetentionPlan(db: DatabaseSync, options: { now?: string; limit?: number; afterConversationId?: string } = {}) {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const limit = options.limit ?? 100;
  if (!Number.isFinite(nowMs)) throw new Error('invalid_retention_time');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_retention_limit');
  if (db.isTransaction) throw new Error('retention_inventory_requires_own_transaction');
  const observedAt = new Date(nowMs).toISOString();
  const eventCutoff = new Date(nowMs - 7 * 86400000).toISOString();
  const coldCutoff = new Date(nowMs - 90 * 86400000).toISOString();
  const terminal = "'succeeded','partial','failed','cancelled','interrupted'";
  db.exec('BEGIN');
  try {
    const conversations = db.prepare(`SELECT id,updated_at FROM ga_conversations
      WHERE id>? ORDER BY id LIMIT ?`).all(options.afterConversationId ?? '', limit + 1) as Array<{ id: string; updated_at: string }>;
    const candidates: RetentionCandidate[] = [];
    for (const conversation of conversations.slice(0, limit)) {
      const counts = db.prepare(`SELECT
        COUNT(*) AS event_count, COALESCE(SUM(length(CAST(e.payload_json AS BLOB))),0) AS payload_bytes,
        MIN(e.seq) AS oldest_seq, MAX(e.seq) AS newest_seq,
        COALESCE(SUM(julianday(e.created_at) IS NULL),0) AS invalid_dates,
        COALESCE(SUM(r.id IS NULL),0) AS missing_runs
        FROM ga_events e LEFT JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=e.conversation_id
        WHERE e.conversation_id=? AND (julianday(e.created_at)<julianday(?) OR julianday(e.created_at) IS NULL)`)
        .get(conversation.id, eventCutoff) as { event_count: number; payload_bytes: number;
          oldest_seq: number; newest_seq: number; invalid_dates: number; missing_runs: number };
      const active = db.prepare(`SELECT COUNT(*) AS n FROM ga_runs WHERE conversation_id=?
        AND status NOT IN (${terminal})`).get(conversation.id) as { n: number };
      const base = { conversation_id: conversation.id, observed_at: observedAt,
        protected: true as const, deletable: false as const, backup_verified: false as const };
      if (counts.event_count) {
        const reasons = ['complete_checkpoint_and_restore_verification_missing'];
        if (active.n) reasons.push('nonterminal_run_present');
        if (counts.missing_runs) reasons.push('event_run_missing_or_mismatched');
        if (counts.invalid_dates) reasons.push('event_timestamp_invalid');
        candidates.push({ ...base, category: 'ga_events', reasons,
          event_count: counts.event_count, payload_bytes: counts.payload_bytes,
          oldest_seq: counts.oldest_seq, newest_seq: counts.newest_seq });
      }
      const updatedMs = Date.parse(conversation.updated_at);
      if (!Number.isFinite(updatedMs) || updatedMs < Date.parse(coldCutoff)) {
        const reasons = ['remote_copy_and_on_demand_restore_unverified'];
        if (!Number.isFinite(updatedMs)) reasons.push('conversation_timestamp_invalid');
        if (active.n) reasons.push('nonterminal_run_present');
        const binding = db.prepare(`SELECT
          (SELECT COUNT(*) FROM ga_harness_session_bindings WHERE conversation_id=?) +
          (SELECT COUNT(*) FROM ga_channel_bindings WHERE conversation_id=?) AS n`)
          .get(conversation.id, conversation.id) as { n: number };
        if (binding.n) reasons.push('runtime_or_channel_binding_present');
        candidates.push({ ...base, category: 'cold_conversation', reasons });
      }
    }
    db.exec('COMMIT');
    return { schema_version: 1, mode: 'dry-run' as const, observed_at: observedAt,
      event_cutoff: eventCutoff, cold_cutoff: coldCutoff, scanned_conversations: Math.min(conversations.length, limit),
      next_after_conversation_id: conversations.length > limit ? conversations[limit - 1]!.id : null,
      candidates };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
