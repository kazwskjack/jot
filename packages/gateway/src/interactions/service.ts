import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import type { EventStore } from '../events/event-store.ts';

export class InteractionService {
  private readonly db: DatabaseSync;
  private readonly events: EventStore;
  constructor(db: DatabaseSync, events: EventStore) { this.db = db; this.events = events; }

  list(conversationId: string, ownerId: string, status = 'pending') {
    const owner = this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId, ownerId);
    if (!owner) throw new Error('conversation_not_found');
    const rows = this.db.prepare('SELECT * FROM ga_interactions WHERE conversation_id=? AND (?=\'all\' OR status=?) ORDER BY created_at,id')
      .all(conversationId, status, status) as Array<Record<string, unknown>>;
    return { items: rows.map(row => this.value(row)) };
  }

  respond(id: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(id, ownerId);
    if (row.kind !== 'question') throw new Error('interaction_kind_conflict');
    this.assertPending(row, input);
    const request = JSON.parse(String(row.request_json)) as Record<string, any>;
    const questions = new Map((request.questions || []).map((item: any) => [item.question_id, item]));
    const answers = input.answers as Array<Record<string, unknown>>;
    if (!Array.isArray(answers) || answers.length === 0) throw new Error('interaction_answer_invalid');
    for (const answer of answers) {
      const question: any = questions.get(answer.question_id);
      if (!question) throw new Error('interaction_answer_invalid');
      const selected = answer.selected_option_ids;
      if (!Array.isArray(selected) || (!question.multiple && selected.length > 1)) throw new Error('interaction_answer_invalid');
      const allowed = new Set((question.options || []).map((option: any) => option.option_id));
      if (selected.some(option => !allowed.has(option))) throw new Error('interaction_answer_invalid');
      if (answer.custom_text && !question.allow_custom) throw new Error('interaction_answer_invalid');
    }
    return this.resolve(row, 'answered', input, key, 'interaction_response');
  }

  decide(id: string, ownerId: string, input: Record<string, unknown>, key: string) {
    const row = this.row(id, ownerId);
    if (row.kind !== 'approval') throw new Error('interaction_kind_conflict');
    this.assertPending(row, input);
    if (row.action_digest !== input.action_digest) throw new Error('action_digest_mismatch');
    if (!['approve', 'deny'].includes(String(input.decision))) throw new Error('interaction_decision_invalid');
    return this.resolve(row, input.decision === 'deny' ? 'denied' : 'answered', input, key, 'interaction_decision');
  }

  private row(id: string, ownerId: string) {
    const row = this.db.prepare('SELECT i.* FROM ga_interactions i JOIN ga_conversations c ON c.id=i.conversation_id WHERE i.id=? AND c.owner_id=?')
      .get(id, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('interaction_not_found');
    return row;
  }
  private assertPending(row: Record<string, unknown>, input: Record<string, unknown>) {
    if (row.status !== 'pending') throw new Error('interaction_state_conflict');
    if (Number(row.version) !== Number(input.expected_version)) throw new Error('interaction_version_conflict');
    if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) throw new Error('interaction_expired');
  }
  private resolve(row: Record<string, unknown>, status: string, payload: unknown, key: string, commandKind: string) {
    const now = new Date().toISOString(); const commandId = `cmd-${randomUUID()}`;
    return withImmediateTransaction(this.db, () => {
      this.db.prepare('UPDATE ga_interactions SET status=?,version=version+1,response_json=?,resolved_at=? WHERE id=? AND status=\'pending\'')
        .run(status, JSON.stringify(payload), now, String(row.id));
      this.db.prepare('INSERT INTO ga_run_commands(id,run_id,kind,payload_json,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(commandId, String(row.run_id), commandKind, JSON.stringify({ interaction_id: row.id, ...payload as object }), 'pending', `${commandKind}:${key}`, now);
      const updated = this.row(String(row.id), this.ownerFor(String(row.conversation_id)));
      this.events.append(String(row.conversation_id), String(row.run_id), 'interaction.resolved', this.value(updated));
      return { accepted: true, interaction_id: row.id, run_id: row.run_id, status, version: Number(updated.version) };
    });
  }
  private ownerFor(conversationId: string) {
    return String((this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(conversationId) as { owner_id: string }).owner_id);
  }
  private value(row: Record<string, unknown>) {
    const value = JSON.parse(String(row.request_json)) as Record<string, unknown>;
    value.status = row.status; value.version = Number(row.version);
    if (row.response_json) Object.assign(value, JSON.parse(String(row.response_json)));
    return value;
  }
}
