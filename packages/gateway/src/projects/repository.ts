import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';

type ProjectRow = {
  id: string; owner_id: string; title: string; is_default: number; version: number;
  created_at: string; updated_at: string;
};

export class ProjectRepository {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  ensureDefault(ownerId: string) {
    const operation = () => {
      let row = this.db.prepare('SELECT * FROM ga_projects WHERE owner_id=? AND is_default=1').get(ownerId) as ProjectRow | undefined;
      if (!row) {
        const now = new Date().toISOString();
        const id = `project-${randomUUID()}`;
        this.db.prepare('INSERT INTO ga_projects(id,owner_id,title,is_default,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, ownerId, 'jotV0', 1, 1, now, now);
        row = this.db.prepare('SELECT * FROM ga_projects WHERE id=?').get(id) as ProjectRow;
      }
      this.db.prepare('UPDATE ga_conversations SET project_id=? WHERE owner_id=? AND project_id IS NULL').run(row.id, ownerId);
      return this.serialize(row);
    };
    return this.db.isTransaction ? operation() : withImmediateTransaction(this.db, operation);
  }

  create(ownerId: string, input: Record<string, unknown>) {
    const title = this.title(input.title);
    const id = `project-${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO ga_projects(id,owner_id,title,is_default,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, ownerId, title, 0, 1, now, now);
    return this.get(id, ownerId);
  }

  get(id: string, ownerId: string) {
    const row = this.db.prepare('SELECT * FROM ga_projects WHERE id=? AND owner_id=?').get(id, ownerId) as ProjectRow | undefined;
    if (!row) throw new Error('project_not_found');
    return this.serialize(row);
  }

  list(ownerId: string) {
    this.ensureDefault(ownerId);
    const rows = this.db.prepare(`SELECT p.*,
      SUM(CASE WHEN c.id IS NOT NULL AND c.archived_at IS NULL THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN c.id IS NOT NULL AND c.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count
      FROM ga_projects p LEFT JOIN ga_conversations c ON c.project_id=p.id AND c.owner_id=p.owner_id
      WHERE p.owner_id=? GROUP BY p.id ORDER BY p.is_default DESC,p.updated_at DESC,p.id DESC`).all(ownerId) as Array<ProjectRow & { active_count: number; archived_count: number }>;
    return { items: rows.map(row => ({ ...this.serialize(row), active_conversation_count: Number(row.active_count), archived_conversation_count: Number(row.archived_count) })) };
  }

  update(id: string, ownerId: string, input: Record<string, unknown>) {
    const current = this.get(id, ownerId);
    if (current.version !== Number(input.expected_version)) throw new Error('version_conflict');
    const title = this.title(input.title);
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE ga_projects SET title=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=?')
      .run(title, now, id, ownerId, current.version);
    if (result.changes !== 1) throw new Error('version_conflict');
    return this.get(id, ownerId);
  }

  assertOwned(id: string, ownerId: string): void { this.get(id, ownerId); }

  private title(value: unknown): string {
    const title = String(value ?? '').trim();
    if (!title || title.length > 100) throw new Error('invalid_project_title');
    return title;
  }

  private serialize(row: ProjectRow) {
    return { project_id: row.id, title: row.title, is_default: Boolean(row.is_default), version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at };
  }
}
