import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { decodeStoredContent } from '../messages/content.ts';
import { ProjectRepository } from '../projects/repository.ts';

export class ConversationRepository {
  private readonly db: DatabaseSync;
  private readonly projects: ProjectRepository;
  constructor(db: DatabaseSync, projects = new ProjectRepository(db)) { this.db = db; this.projects = projects; }

  create(ownerId: string, input: Record<string, unknown>) {
    const id = `conv-${randomUUID()}`;
    const now = new Date().toISOString();
    const model = input.model as Record<string, unknown>;
    const projectId = input.project_id === undefined
      ? this.projects.ensureDefault(ownerId).project_id
      : String(input.project_id);
    this.projects.assertOwned(projectId, ownerId);
    this.db.prepare(
      'INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, ownerId, String(input.workspace_id), String(input.title || 'New conversation'), JSON.stringify(model), 1, now, now, projectId);
    return this.get(id, ownerId);
  }

  get(id: string, ownerId: string) {
    this.projects.ensureDefault(ownerId);
    const row = this.db.prepare('SELECT * FROM ga_conversations WHERE id=? AND owner_id=?').get(id, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('conversation_not_found');
    return {
      conversation_id: String(row.id), title: String(row.title), workspace_id: String(row.workspace_id),
      model: JSON.parse(String(row.model)), created_at: String(row.created_at), updated_at: String(row.updated_at),
      version: Number(row.version), project_id: String(row.project_id), pinned: row.pinned_at !== null,
      pinned_at: row.pinned_at === null ? null : String(row.pinned_at), archived: row.archived_at !== null,
      archived_at: row.archived_at === null ? null : String(row.archived_at),
    };
  }

  list(ownerId: string, query: number | { limit?: number; project_id?: string; state?: string } = {}) {
    this.projects.ensureDefault(ownerId);
    const options = typeof query === 'number' ? { limit: query } : query;
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 100));
    const state = options.state ?? 'active';
    if (!['active', 'archived', 'all'].includes(state)) throw new Error('invalid_conversation_state');
    if (options.project_id) this.projects.assertOwned(options.project_id, ownerId);
    const clauses = ['owner_id=?'];
    const parameters: Array<string | number> = [ownerId];
    if (options.project_id) { clauses.push('project_id=?'); parameters.push(options.project_id); }
    if (state === 'active') clauses.push('archived_at IS NULL');
    if (state === 'archived') clauses.push('archived_at IS NOT NULL');
    parameters.push(limit);
    const rows = this.db.prepare(`SELECT id FROM ga_conversations WHERE ${clauses.join(' AND ')}
      ORDER BY CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END,pinned_at DESC,updated_at DESC,id DESC LIMIT ?`)
      .all(...parameters) as Array<{ id: string }>;
    return { items: rows.map(row => this.get(row.id, ownerId)) };
  }

  update(id: string, ownerId: string, input: Record<string, unknown>) {
    const current = this.db.prepare('SELECT version FROM ga_conversations WHERE id=? AND owner_id=?').get(id, ownerId) as { version: number } | undefined;
    if (!current) throw new Error('conversation_not_found');
    if (current.version !== Number(input.expected_version)) throw new Error('version_conflict');
    if (input.model !== undefined) {
      const active = this.db.prepare("SELECT 1 FROM ga_runs WHERE conversation_id=? AND status IN ('starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1").get(id);
      if (active) throw new Error('active_run_model_change');
    }
    const prior = this.get(id, ownerId);
    const projectId = input.project_id === undefined ? prior.project_id : String(input.project_id);
    this.projects.assertOwned(projectId, ownerId);
    const now = new Date().toISOString();
    const pinnedAt = input.pinned === undefined ? prior.pinned_at : input.pinned === true ? now : null;
    const archivedAt = input.archived === undefined ? prior.archived_at : input.archived === true ? now : null;
    const updated = this.db.prepare(`UPDATE ga_conversations SET
      title=?,model=?,project_id=?,pinned_at=?,archived_at=?,version=version+1,updated_at=?
      WHERE id=? AND owner_id=? AND version=?`)
      .run(String(input.title ?? prior.title), JSON.stringify(input.model ?? prior.model), projectId,
        pinnedAt, archivedAt, now, id, ownerId, current.version);
    if (updated.changes !== 1) throw new Error('version_conflict');
    return this.get(id, ownerId);
  }

  messages(id: string, ownerId: string, limit = 50) {
    this.get(id, ownerId);
    const rows = this.db.prepare('SELECT * FROM ga_messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(id, Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return { items: rows.reverse().map(row => {
      const content = decodeStoredContent(String(row.content_json));
      return { message_id: row.id, run_id: row.run_id, role: row.role,
        status: row.status, blocks: content.blocks,
        ...(content.attachments.length ? { attachments: content.attachments } : {}), created_at: row.created_at };
    }) };
  }
}
