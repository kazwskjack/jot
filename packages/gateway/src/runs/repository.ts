import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import { EventStore } from '../events/event-store.ts';
import { decodeStoredContent, encodeInputContent } from '../messages/content.ts';

const AUTOMATIC_TITLES = new Set(['New conversation', '新对话']);

function automaticTitle(input: unknown): string | null {
  const text = (Array.isArray(input) ? input : [])
    .filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
    .map(item => String((item as Record<string, unknown>).text ?? ''))
    .join(' ')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const characters = [...text];
  if (characters.length <= 30) return text;
  let prefix = characters.slice(0, 29).join('');
  const wordBoundary = prefix.lastIndexOf(' ');
  if (wordBoundary >= 15) prefix = prefix.slice(0, wordBoundary);
  return `${prefix.trimEnd()}…`;
}

export class RunRepository {
  private readonly db: DatabaseSync;
  private readonly events: EventStore;
  constructor(db: DatabaseSync, events: EventStore) { this.db = db; this.events = events; }

  enqueue(conversationId: string, ownerId: string, input: Record<string, unknown>) {
    const conversation = this.db.prepare('SELECT id,title FROM ga_conversations WHERE id=? AND owner_id=?')
      .get(conversationId, ownerId) as { id: string; title: string } | undefined;
    if (!conversation) throw new Error('conversation_not_found');
    const duplicate = this.db.prepare('SELECT id,run_id FROM ga_messages WHERE conversation_id=? AND client_message_id=?')
      .get(conversationId, String(input.client_message_id)) as Record<string, unknown> | undefined;
    if (duplicate) return { accepted: true, message_id: duplicate.id, run_id: duplicate.run_id, conversation_id: conversationId };
    const messageId = `msg-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const now = new Date().toISOString();
    const content = encodeInputContent(messageId, input.content);
    const generatedTitle = AUTOMATIC_TITLES.has(conversation.title) ? automaticTitle(input.content) : null;
    withImmediateTransaction(this.db, () => {
      if (generatedTitle) {
        this.db.prepare(`UPDATE ga_conversations
          SET title=?,version=version+1,updated_at=?
          WHERE id=? AND owner_id=? AND title IN ('New conversation','新对话')
            AND NOT EXISTS (
              SELECT 1 FROM ga_messages WHERE conversation_id=? AND role='user'
                AND json_array_length(json_extract(content_json,'$.blocks')) > 0
            )`)
          .run(generatedTitle, now, conversationId, ownerId, conversationId);
      }
      this.db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(messageId, conversationId, runId, 'user', 'complete', JSON.stringify(content), String(input.client_message_id), now, now);
      this.db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(runId, conversationId, messageId, 'queued', 1, now, now);
      this.events.append(conversationId, runId, 'message.created', this.message(messageId));
      this.events.append(conversationId, runId, 'run.state', this.get(runId, ownerId));
      this.db.prepare('INSERT INTO ga_outbox(conversation_id,aggregate_type,aggregate_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(conversationId, 'run', runId, 'run.queued', JSON.stringify({ run_id: runId }), now);
    });
    return { accepted: true, message_id: messageId, run_id: runId, conversation_id: conversationId };
  }

  get(runId: string, ownerId: string) {
    const row = this.db.prepare('SELECT r.* FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?')
      .get(runId, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('run_not_found');
    return this.runValue(row);
  }

  applyRuntimeOutcome(runId: string, outcome: { status: string; runtime_revision: number; reason_code: string | null }, guard?: () => void) {
    const row = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('run_not_found');
    if (outcome.runtime_revision <= Number(row.runtime_revision)) return this.runValue(row);
    let nextStatus = String(row.status);
    if (outcome.status === 'running') nextStatus = 'running';
    // Runtime completion is an execution fact, not authority to publish a product answer.
    else if (['failed', 'cancelled'].includes(outcome.status)) nextStatus = outcome.status;
    const now = new Date().toISOString();
    return withImmediateTransaction(this.db, () => {
      guard?.();
      this.db.prepare('UPDATE ga_runs SET status=?,runtime_revision=?,reason_code=?,version=version+1,updated_at=? WHERE id=?')
        .run(nextStatus, outcome.runtime_revision, outcome.reason_code, now, runId);
      this.events.append(String(row.conversation_id), runId, 'runtime.outcome', { revision: outcome.runtime_revision, value: outcome });
      if (nextStatus !== row.status) this.events.append(String(row.conversation_id), runId, 'run.state', this.getById(runId));
      return this.getById(runId);
    });
  }

  appendAssistant(runId: string, text: string, settledBlocks?: Array<{ kind: 'text' | 'reasoning'; text: string }>,
    attachmentIds: string[] = []) {
    const value = text.trim();
    if (!value) throw new Error('assistant_text_empty');
    const existing = this.db.prepare("SELECT id FROM ga_messages WHERE run_id=? AND role='assistant' ORDER BY created_at LIMIT 1")
      .get(runId) as { id: string } | undefined;
    if (existing) return this.message(existing.id);
    const run = this.db.prepare('SELECT conversation_id FROM ga_runs WHERE id=?').get(runId) as { conversation_id: string } | undefined;
    if (!run) throw new Error('run_not_found');
    const messageId = `msg-${randomUUID()}`;
    const now = new Date().toISOString();
    const sourceBlocks = settledBlocks?.filter(block => (block.kind === 'text' || block.kind === 'reasoning') && block.text.trim())
      ?? [{ kind: 'text' as const, text: value }];
    const attachments = [...new Set(attachmentIds.filter(id => /^artifact-[A-Za-z0-9-]+$/.test(id)))];
    const content = { blocks: sourceBlocks.map((block, index) => ({ block_id: `${messageId}:${index}`,
      kind: block.kind, text: block.text, exposure: block.kind === 'reasoning' ? 'provider' : 'public' })), attachments };
    this.db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(messageId, run.conversation_id, runId, 'assistant', 'complete', JSON.stringify(content), null, now, now);
    const message = this.message(messageId);
    this.events.append(run.conversation_id, runId, 'message.created', message);
    return message;
  }

  saveCandidate(runId: string, text: string, attempt = 1, source = 'dsh-headless', sourceVersion = '1') {
    const value = text.trim();
    if (!value) throw new Error('candidate_text_empty');
    const run = this.db.prepare('SELECT input_message_id FROM ga_runs WHERE id=?').get(runId) as { input_message_id: string } | undefined;
    if (!run) throw new Error('run_not_found');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO ga_candidate_answers(
      id,run_id,input_message_id,turn_id,attempt,source,source_version,status,text,evidence_refs_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id,attempt,source,source_version) DO UPDATE SET
      text=excluded.text,updated_at=excluded.updated_at
    WHERE ga_candidate_answers.status='pending' AND ga_candidate_answers.text=excluded.text`)
      .run(`candidate-${randomUUID()}`, runId, run.input_message_id, runId, attempt,
        source, sourceVersion, 'pending', value, '[]', now, now);
    return this.db.prepare(`SELECT * FROM ga_candidate_answers
      WHERE run_id=? AND attempt=? AND source=? AND source_version=?`)
      .get(runId, attempt, source, sourceVersion) as Record<string, unknown>;
  }

  setCandidateStatus(runId: string, status: 'verified' | 'partial' | 'failed' | 'outcome_unknown', evidenceRefs: string[]) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE ga_candidate_answers SET status=?,evidence_refs_json=?,updated_at=? WHERE run_id=? AND status='pending'")
      .run(status, JSON.stringify(evidenceRefs), now, runId);
  }

  finalizePublication(runId: string, status: 'succeeded' | 'partial' | 'failed' | 'interrupted' | 'running', reasonCode: string | null) {
    const row = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('run_not_found');
    if (status === 'running' || row.status === status) return;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE ga_runs SET status=?,reason_code=?,version=version+1,updated_at=? WHERE id=?')
      .run(status, reasonCode, now, runId);
    this.events.append(String(row.conversation_id), runId, 'run.state', this.getById(runId));
  }

  message(id: string) {
    const row = this.db.prepare('SELECT * FROM ga_messages WHERE id=?').get(id) as Record<string, unknown>;
    const content = decodeStoredContent(String(row.content_json));
    return { message_id: row.id, run_id: row.run_id, role: row.role, status: row.status,
      blocks: content.blocks, ...(content.attachments.length ? { attachments: content.attachments } : {}), created_at: row.created_at };
  }
  private getById(id: string) { return this.runValue(this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(id) as Record<string, unknown>); }
  private runValue(row: Record<string, unknown>) {
    const value: Record<string, unknown> = { run_id: row.id, conversation_id: row.conversation_id,
      input_message_id: row.input_message_id, status: row.status, version: Number(row.version),
      created_at: row.created_at, updated_at: row.updated_at };
    if (row.continuation_of) value.continuation_of = row.continuation_of;
    if (row.checkpoint_id) value.checkpoint_id = row.checkpoint_id;
    if (row.reason_code) value.error_code = row.reason_code;
    return value;
  }
}
