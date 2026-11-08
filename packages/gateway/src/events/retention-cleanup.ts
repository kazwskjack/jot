import type { DatabaseSync } from 'node:sqlite';
import { collectProofBoundRetentionEventKeys } from './retention-plan.ts';

const maximumCleanupEvents = 1000;

/** Explicit, one-conversation cleanup. It never runs from the dry-run report path. */
export function cleanupEventRetention(db: DatabaseSync, options: {
  ownerId: string;
  conversationId: string;
  restoreVerification?: unknown;
  explicit?: boolean;
  maxEvents?: number;
  now?: string;
  signal?: { readonly aborted: boolean };
}) {
  if (options.explicit !== true) throw new Error('retention_cleanup_explicit_opt_in_required');
  if (typeof options.ownerId !== 'string' || !options.ownerId.trim()
    || typeof options.conversationId !== 'string' || !options.conversationId.trim()) {
    throw new Error('retention_cleanup_scope_required');
  }
  const maxEvents = options.maxEvents ?? 100;
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > maximumCleanupEvents) {
    throw new Error('retention_cleanup_batch_limit');
  }
  if (db.isTransaction) throw new Error('retention_cleanup_requires_own_transaction');
  if (options.signal?.aborted) throw new Error('retention_cleanup_interrupted');

  try {
    db.exec('BEGIN IMMEDIATE');
    const snapshot = collectProofBoundRetentionEventKeys(db, {
      ownerId: options.ownerId,
      conversationId: options.conversationId,
      now: options.now ?? new Date().toISOString(),
      restoreVerification: options.restoreVerification,
    });
    if (snapshot.event_keys.length > maxEvents) throw new Error('retention_cleanup_batch_limit');
    if (options.signal?.aborted) throw new Error('retention_cleanup_interrupted');

    const remove = db.prepare(`DELETE FROM ga_events
      WHERE conversation_id=? AND seq=? AND event_id=?
        AND EXISTS (SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?)`);
    for (const event of snapshot.event_keys) {
      if (options.signal?.aborted) throw new Error('retention_cleanup_interrupted');
      const result = remove.run(options.conversationId, event.seq, event.event_id,
        options.conversationId, options.ownerId) as { changes: number | bigint };
      if (Number(result.changes) !== 1) throw new Error('retention_cleanup_stale_snapshot');
    }
    if (options.signal?.aborted) throw new Error('retention_cleanup_interrupted');
    db.exec('COMMIT');
    return { schema_version: 1 as const, deleted_event_count: snapshot.event_keys.length, backup_id: snapshot.backup_id };
  } catch (error) {
    try { if (db.isTransaction) db.exec('ROLLBACK'); }
    catch { throw new Error('retention_cleanup_rollback_failed'); }
    if (error instanceof Error && error.message.startsWith('retention_cleanup_')) throw error;
    throw new Error('retention_cleanup_failed');
  }
}
