import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import {assertWorkspaceWritable} from '../workbench/workspace-coordination.ts';

type ProjectRow = {
  id: string; owner_id: string; title: string; is_default: number; version: number;
  created_at: string; updated_at: string; archived_at: string | null; deleted_at: string | null;
};

export class ProjectRepository {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  ensureDefault(ownerId: string) {
    const current=this.db.prepare('SELECT * FROM ga_projects WHERE owner_id=? AND is_default=1').get(ownerId) as ProjectRow|undefined;
    const needsBackfill=()=>!!this.db.prepare('SELECT 1 FROM ga_conversations WHERE owner_id=? AND project_id IS NULL LIMIT 1').get(ownerId);
    // Initialized owners need no writer transaction on conversation/snapshot reads.
    if(current&&!needsBackfill())return this.serialize(current);
    const operation = () => {
      let row = this.db.prepare('SELECT * FROM ga_projects WHERE owner_id=? AND is_default=1').get(ownerId) as ProjectRow | undefined;
      if (!row) {
        const now = new Date().toISOString();
        const id = `project-${randomUUID()}`;
        this.db.prepare('INSERT INTO ga_projects(id,owner_id,title,is_default,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, ownerId, 'jotV0', 1, 1, now, now);
        row = this.db.prepare('SELECT * FROM ga_projects WHERE id=?').get(id) as ProjectRow;
      }
      if(needsBackfill())this.db.prepare('UPDATE ga_conversations SET project_id=? WHERE owner_id=? AND project_id IS NULL').run(row.id, ownerId);
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
    return this.serialize(this.read(id, ownerId));
  }

  lifecycle(ownerId: string) {
    this.ensureDefault(ownerId);
    const rows = this.db.prepare('SELECT * FROM ga_projects WHERE owner_id=? ORDER BY is_default DESC,updated_at DESC,id').all(ownerId) as ProjectRow[];
    return {items: rows.map(row => this.serializeLifecycle(row))};
  }

  list(ownerId: string) {
    this.ensureDefault(ownerId);
    const excludeInternal = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_memory_processing_runs'").get()
      ? 'AND NOT EXISTS (SELECT 1 FROM wb_memory_processing_runs processing WHERE processing.conversation_id=c.id)' : '';
    const rows = this.db.prepare(`SELECT p.*,
      SUM(CASE WHEN c.id IS NOT NULL AND c.archived_at IS NULL THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN c.id IS NOT NULL AND c.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count
      FROM ga_projects p LEFT JOIN ga_conversations c ON c.project_id=p.id AND c.owner_id=p.owner_id ${excludeInternal}
      WHERE p.owner_id=? AND p.archived_at IS NULL AND p.deleted_at IS NULL GROUP BY p.id ORDER BY p.is_default DESC,p.updated_at DESC,p.id DESC`).all(ownerId) as Array<ProjectRow & { active_count: number; archived_count: number }>;
    return { items: rows.map(row => ({ ...this.serialize(row), active_conversation_count: Number(row.active_count), archived_conversation_count: Number(row.archived_count) })) };
  }

  update(id: string, ownerId: string, input: Record<string, unknown>) {
    const row = this.read(id, ownerId);
    const current = this.serialize(row);
    if (row.deleted_at !== null) throw new Error('project_deleted');
    if (current.version !== Number(input.expected_version)) throw new Error('version_conflict');
    const title = this.title(input.title);
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE ga_projects SET title=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=?')
      .run(title, now, id, ownerId, current.version);
    if (result.changes !== 1) throw new Error('version_conflict');
    return this.get(id, ownerId);
  }

  archive(id: string, ownerId: string, input: Record<string, unknown>) {
    return this.transitionLifecycle(id, ownerId, input, 'archived');
  }

  restore(id: string, ownerId: string, input: Record<string, unknown>) {
    return this.transitionLifecycle(id, ownerId, input, 'active');
  }

  /** Deletion retains the original identity and linked records for restoration. */
  delete(id: string, ownerId: string, input: Record<string, unknown>) {
    return this.transitionLifecycle(id, ownerId, input, 'deleted');
  }

  assertOwned(id: string, ownerId: string): void {
    if (this.read(id, ownerId).deleted_at !== null) throw new Error('project_deleted');
  }

  private transitionLifecycle(id: string, ownerId: string, input: Record<string, unknown>, target: 'active' | 'archived' | 'deleted') {
    const expectedVersion = Number(input.expected_version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('invalid_project_version');
    return withImmediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM ga_projects WHERE id=? AND owner_id=?').get(id, ownerId) as ProjectRow | undefined;
      if (!row) throw new Error('project_not_found');
      const current = this.serialize(row);
      const state = row.deleted_at !== null ? 'deleted' : row.archived_at !== null ? 'archived' : 'active';
      if (state === target) {
        // Original requests recover through the atomic API receipt.
        if (expectedVersion === current.version) return this.serializeLifecycle(row);
        throw new Error('version_conflict');
      }
      if (current.version !== expectedVersion) throw new Error('version_conflict');
      if (row.is_default) throw new Error('default_project_lifecycle_forbidden');
      if (state === 'deleted' && target !== 'active') throw new Error('project_deleted');
      if (target === 'deleted') {
        assertWorkspaceWritable(this.db,ownerId,id);
        const activeTask = this.db.prepare(`SELECT 1 FROM ga_runs r JOIN ga_conversations c
          ON c.id=r.conversation_id AND c.owner_id=? AND c.project_id=?
          WHERE r.status NOT IN ('succeeded','failed','cancelled','interrupted','partial') LIMIT 1`).get(ownerId, id);
        if (activeTask) throw new Error('project_has_active_tasks');
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_persistent_tasks'").get()
          &&this.db.prepare(`SELECT 1 FROM wb_persistent_tasks t JOIN wb_agents a ON a.agent_id=t.agent_id AND a.owner_id=t.owner_id
            WHERE a.project_id=? AND t.status='active' LIMIT 1`).get(id))throw new Error('project_has_active_tasks');
        if(this.db.prepare(`SELECT 1 FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
          WHERE c.project_id=? AND r.reason_code='OUTCOME_UNKNOWN' LIMIT 1`).get(id))throw new Error('project_has_pending_operations');
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_attempts'").get()
          &&this.db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN ga_runs r ON r.id=a.run_id
            JOIN ga_conversations c ON c.id=r.conversation_id WHERE c.project_id=? AND a.state IN ('reserved','in_flight','unknown') LIMIT 1`).get(id))throw new Error('project_has_pending_operations');
      }
      const now = new Date().toISOString();
      const archivedAt = target === 'archived' ? now : null;
      const deletedAt = target === 'deleted' ? now : null;
      const result = this.db.prepare(`UPDATE ga_projects SET archived_at=?,deleted_at=?,version=version+1,updated_at=?
        WHERE id=? AND owner_id=? AND version=?`).run(archivedAt, deletedAt, now, id, ownerId, current.version);
      if (result.changes !== 1) throw new Error('version_conflict');
      return this.serializeLifecycle(this.read(id, ownerId));
    });
  }

  private read(id: string, ownerId: string): ProjectRow {
    const row = this.db.prepare('SELECT * FROM ga_projects WHERE id=? AND owner_id=?').get(id, ownerId) as ProjectRow | undefined;
    if (!row) throw new Error('project_not_found');
    return row;
  }

  private title(value: unknown): string {
    const title = String(value ?? '').trim();
    if (!title || title.length > 100) throw new Error('invalid_project_title');
    return title;
  }

  private serialize(row: ProjectRow) {
    return { project_id: row.id, title: row.title, is_default: Boolean(row.is_default), version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at };
  }

  private serializeLifecycle(row: ProjectRow) {
    return { ...this.serialize(row), archived_at: row.archived_at ?? null, deleted_at: row.deleted_at ?? null };
  }
}
