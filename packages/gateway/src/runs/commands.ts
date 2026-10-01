import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import type { EventStore } from '../events/event-store.ts';

export class RunCommandService {
  private readonly db: DatabaseSync;
  private readonly events: EventStore;
  constructor(db: DatabaseSync, events: EventStore) { this.db = db; this.events = events; }

  private row(runId: string, ownerId: string) {
    const row = this.db.prepare('SELECT r.* FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?')
      .get(runId, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('run_not_found');
    return row;
  }

  private insert(runId: string, kind: string, payload: unknown, key: string, now: string) {
    const idempotency = `${kind}:${key}`;
    const existing = this.db.prepare('SELECT id FROM ga_run_commands WHERE run_id=? AND idempotency_key=?').get(runId, idempotency) as { id: string } | undefined;
    if (existing) return existing.id;
    const commandId = `cmd-${randomUUID()}`;
    this.db.prepare('INSERT INTO ga_run_commands(id,run_id,kind,payload_json,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(commandId, runId, kind, JSON.stringify(payload), 'pending', idempotency, now);
    return commandId;
  }

  steer(runId: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(runId, ownerId);
    if (row.status !== 'running') throw new Error('run_state_conflict');
    if (Number(row.version) !== Number(input.expected_run_version)) throw new Error('run_version_conflict');
    const commandId = withImmediateTransaction(this.db, () => this.insert(runId, 'steer', input, key, new Date().toISOString()));
    return { accepted: true, command_id: commandId, run_id: runId };
  }

  cancel(runId: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(runId, ownerId);
    if (Number(row.version) !== Number(input.expected_run_version)) throw new Error('run_version_conflict');
    if (['succeeded', 'failed', 'cancelled'].includes(String(row.status))) throw new Error('run_state_conflict');
    const now = new Date().toISOString();
    return withImmediateTransaction(this.db, () => {
      const commandId = this.insert(runId, 'cancel', input, key, now);
      const status = row.status === 'queued' ? 'cancelled' : 'cancelling';
      this.db.prepare('UPDATE ga_runs SET status=?,version=version+1,updated_at=? WHERE id=?').run(status, now, runId);
      const updated = this.row(runId, ownerId);
      this.events.append(String(row.conversation_id), runId, 'run.state', {
        run_id: runId, conversation_id: row.conversation_id, input_message_id: row.input_message_id,
        status, version: updated.version, created_at: row.created_at, updated_at: now,
      });
      return { accepted: true, command_id: commandId, run_id: runId };
    });
  }

  resume(runId: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(runId, ownerId);
    if (!['failed', 'interrupted'].includes(String(row.status))) throw new Error('run_state_conflict');
    if (Number(row.version) !== Number(input.expected_run_version)) throw new Error('run_version_conflict');
    if (!row.checkpoint_id || row.checkpoint_id !== input.checkpoint_id) throw new Error('checkpoint_invalid');
    if (row.reason_code === 'OUTCOME_UNKNOWN') throw new Error('reconciliation_required');
    const newRunId = `run-${randomUUID()}`;
    const now = new Date().toISOString();
    const conversationId = String(row.conversation_id);
    const inputMessageId = String(row.input_message_id);
    const checkpointId = String(row.checkpoint_id);
    return withImmediateTransaction(this.db, () => {
      this.db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,continuation_of,checkpoint_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(newRunId, conversationId, inputMessageId, 'queued', runId, checkpointId, 1, now, now);
      this.db.prepare('INSERT INTO ga_outbox(conversation_id,aggregate_type,aggregate_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(conversationId, 'run', newRunId, 'run.resumed', JSON.stringify({ continuation_of: runId, checkpoint_id: checkpointId, key }), now);
      this.events.append(conversationId, newRunId, 'run.state', {
        run_id: newRunId, conversation_id: conversationId, input_message_id: inputMessageId,
        status: 'queued', continuation_of: runId, checkpoint_id: checkpointId,
        version: 1, created_at: now, updated_at: now,
      });
      return { accepted: true, run_id: newRunId, continuation_of: runId };
    });
  }
}
