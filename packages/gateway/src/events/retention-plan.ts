import type { DatabaseSync } from 'node:sqlite';
import { isHostRestoreVerificationReceipt } from '../maintenance/host-backup.ts';

export interface RetentionCandidate {
  category: 'ga_events' | 'cold_conversation';
  conversation_id: string;
  observed_at: string;
  protected: boolean;
  deletable: false;
  cleanup_eligible: boolean;
  backup_verified: boolean;
  reasons: string[];
  event_count?: number;
  payload_bytes?: number;
  oldest_seq?: number;
  newest_seq?: number;
}

interface RetainedEventKey { seq: number; event_id: string; }
interface EventRetentionInspection {
  event_count: number;
  payload_bytes: number;
  oldest_seq: number | null;
  newest_seq: number | null;
  active_run_count: number;
  cleanup_eligible: boolean;
  reasons: string[];
  event_keys: RetainedEventKey[];
}

const terminalRunStatuses = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);
const maximumCleanupEvents = 1000;
const maximumCleanupPayloadBytes = 1024 * 1024;
const sensitiveNamePattern = /(?:secret|token|password|credential|authorization|api[_-]?key|private[_-]?key|bearer)/i;

function isSensitiveName(value: string) { return sensitiveNamePattern.test(value); }

function inspectOldEvents(db: DatabaseSync, conversationId: string, eventCutoff: string, backupVerified: boolean): EventRetentionInspection {
  const counts = db.prepare(`SELECT
    COUNT(*) AS event_count, COALESCE(SUM(length(CAST(e.payload_json AS BLOB))),0) AS payload_bytes,
    MIN(e.seq) AS oldest_seq, MAX(e.seq) AS newest_seq,
    COALESCE(SUM(julianday(e.created_at) IS NULL),0) AS invalid_dates,
    COALESCE(SUM(r.id IS NULL),0) AS missing_runs
    FROM ga_events e LEFT JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=e.conversation_id
    WHERE e.conversation_id=? AND (julianday(e.created_at)<julianday(?) OR julianday(e.created_at) IS NULL)`)
    .get(conversationId, eventCutoff) as { event_count: number; payload_bytes: number;
      oldest_seq: number | null; newest_seq: number | null; invalid_dates: number; missing_runs: number };
  const active = db.prepare(`SELECT COUNT(*) AS n FROM ga_runs WHERE conversation_id=?
    AND (status IS NULL OR status NOT IN ('succeeded','partial','failed','cancelled','interrupted'))`)
    .get(conversationId) as { n: number };
  const bounded = counts.event_count > 0 && counts.event_count <= maximumCleanupEvents
    && counts.payload_bytes <= maximumCleanupPayloadBytes;
  const reasons: string[] = [];
  if (!backupVerified) reasons.push('complete_checkpoint_and_restore_verification_missing');
  if (Number(active.n) > 0) reasons.push('nonterminal_run_present');
  if (Number(counts.missing_runs) > 0) reasons.push('event_run_missing_or_mismatched');
  if (Number(counts.invalid_dates) > 0) reasons.push('event_timestamp_invalid');
  if (counts.event_count > maximumCleanupEvents) reasons.push('cleanup_event_batch_limit_exceeded');
  if (counts.payload_bytes > maximumCleanupPayloadBytes) reasons.push('cleanup_payload_limit_exceeded');

  let secretLogs = false;
  const eventKeys: RetainedEventKey[] = [];
  for (const event of db.prepare(`SELECT e.seq,e.event_id,e.type,e.payload_json FROM ga_events e
    WHERE e.conversation_id=? AND (julianday(e.created_at)<julianday(?) OR julianday(e.created_at) IS NULL)
    ORDER BY e.seq`).iterate(conversationId, eventCutoff) as Iterable<{
      seq: number; event_id: string; type: string; payload_json: string;
    }>) {
    if (hasSensitivePayload(event.type, event.payload_json)) { secretLogs = true; break; }
    if (bounded && backupVerified && Number.isSafeInteger(event.seq) && typeof event.event_id === 'string') {
      eventKeys.push({ seq: event.seq, event_id: event.event_id });
    }
  }
  if (secretLogs) reasons.push('secret_log_present');
  if (backupVerified && bounded && eventKeys.length !== counts.event_count) reasons.push('cleanup_snapshot_incomplete');
  const cleanupEligible = reasons.length === 0 && eventKeys.length === counts.event_count;
  return { event_count: counts.event_count, payload_bytes: counts.payload_bytes,
    oldest_seq: counts.oldest_seq, newest_seq: counts.newest_seq,
    active_run_count: Number(active.n),
    cleanup_eligible: cleanupEligible, reasons, event_keys: cleanupEligible ? eventKeys : [] };
}

/** Collects the current proof-bound event keys while the caller holds BEGIN IMMEDIATE. */
export function collectProofBoundRetentionEventKeys(db: DatabaseSync, input: {
  conversationId: string; ownerId: string; now: string; restoreVerification: unknown;
}): { backup_id: string; event_keys: RetainedEventKey[] } {
  if (!db.isTransaction) throw new Error('retention_cleanup_requires_immediate_transaction');
  if (!isHostRestoreVerificationReceipt(input.restoreVerification, db)) {
    throw new Error(input.restoreVerification ? 'retention_cleanup_restore_proof_stale' : 'retention_cleanup_restore_proof_missing');
  }
  const conversation = db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(input.conversationId) as
    { owner_id: string } | undefined;
  if (!conversation || conversation.owner_id !== input.ownerId) throw new Error('retention_cleanup_owner_scope_mismatch');
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error('invalid_retention_time');
  const eventCutoff = new Date(nowMs - 7 * 86400000).toISOString();
  const inspected = inspectOldEvents(db, input.conversationId, eventCutoff, true);
  if (inspected.event_count === 0) throw new Error('retention_cleanup_not_eligible');
  if (inspected.reasons.includes('cleanup_event_batch_limit_exceeded')
    || inspected.reasons.includes('cleanup_payload_limit_exceeded')) throw new Error('retention_cleanup_batch_limit');
  if (!inspected.cleanup_eligible) throw new Error('retention_cleanup_not_eligible');
  const receipt = input.restoreVerification as { backup_id: string };
  return { backup_id: receipt.backup_id, event_keys: inspected.event_keys };
}

function hasSensitivePayload(type: string, payload: string) {
  if (isSensitiveName(type)) return true;
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return true; }
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (isSensitiveName(key)) return true;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

// This is deliberately an inventory, not a deletion API. ga_runs.checkpoint_id is
// a runtime reference, not proof that product event projections can be restored.
export function buildEventRetentionPlan(db: DatabaseSync, options: {
  now?: string; limit?: number; afterConversationId?: string; restoreVerification?: unknown;
} = {}) {
  if (Object.hasOwn(options, 'restoreProofs')) throw new Error('retention_restore_proofs_unsupported');
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const limit = options.limit ?? 100;
  if (!Number.isFinite(nowMs)) throw new Error('invalid_retention_time');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_retention_limit');
  if (db.isTransaction) throw new Error('retention_inventory_requires_own_transaction');
  const observedAt = new Date(nowMs).toISOString();
  const eventCutoff = new Date(nowMs - 7 * 86400000).toISOString();
  const coldCutoff = new Date(nowMs - 90 * 86400000).toISOString();
  db.exec('BEGIN');
  try {
    const backupVerified = isHostRestoreVerificationReceipt(options.restoreVerification, db);
    const conversations = db.prepare(`SELECT id,updated_at FROM ga_conversations
      WHERE id>? ORDER BY id LIMIT ?`).all(options.afterConversationId ?? '', limit + 1) as Array<{ id: string; updated_at: string }>;
    const candidates: RetentionCandidate[] = [];
    for (const conversation of conversations.slice(0, limit)) {
      const eventPlan = inspectOldEvents(db, conversation.id, eventCutoff, backupVerified);
      const active = eventPlan.active_run_count;
      const base = { conversation_id: conversation.id, observed_at: observedAt,
        protected: true, deletable: false as const, cleanup_eligible: false, backup_verified: false };
      if (eventPlan.event_count) {
        candidates.push({ ...base, protected: !eventPlan.cleanup_eligible, category: 'ga_events',
          cleanup_eligible: eventPlan.cleanup_eligible, backup_verified: backupVerified, reasons: eventPlan.reasons,
          event_count: eventPlan.event_count, payload_bytes: eventPlan.payload_bytes,
          ...(eventPlan.oldest_seq === null ? {} : { oldest_seq: eventPlan.oldest_seq }),
          ...(eventPlan.newest_seq === null ? {} : { newest_seq: eventPlan.newest_seq }) });
      }
      const updatedMs = Date.parse(conversation.updated_at);
      if (!Number.isFinite(updatedMs) || updatedMs < Date.parse(coldCutoff)) {
        const reasons = ['remote_copy_and_on_demand_restore_unverified'];
        if (!Number.isFinite(updatedMs)) reasons.push('conversation_timestamp_invalid');
        if (active) reasons.push('nonterminal_run_present');
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
