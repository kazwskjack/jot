import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';

export type MemoryRow = Record<string, string | number | null>;
export type MemoryValue = Record<string, unknown>;
export interface MemoryRankAdapter {
  /** Only authorized, unexpired database candidates are supplied. No global index lookup is permitted. */
  rank(input: { query: string; candidates: ReadonlyArray<Readonly<MemoryValue>> }): unknown;
}

export function memoryExpired(row: MemoryRow, now = new Date().toISOString()): boolean {
  return row.expires_at != null && String(row.expires_at) <= now;
}
export function memoryMetadata(input: MemoryValue, old?: MemoryRow): { provenance_json: string; source_revision: string | null; expires_at: string | null; supersedes: string | null } {
  let provenance: unknown = old ? JSON.parse(String(old.provenance_json ?? '[]')) : [];
  if (input.provenance !== undefined) {
    if (!Array.isArray(input.provenance) || input.provenance.length > 20) throw new Error('invalid_memory_provenance');
    provenance = input.provenance.map(entry => {
      if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string' || !entry.kind.trim() || entry.kind.length > 60
        || typeof entry.reference !== 'string' || !entry.reference.trim() || entry.reference.length > 2048) throw new Error('invalid_memory_provenance');
      return { kind: entry.kind.trim(), reference: entry.reference.trim() };
    });
  }
  const sourceRevision = input.source_revision === undefined ? old?.source_revision ?? null : input.source_revision;
  if (sourceRevision !== null && (typeof sourceRevision !== 'string' || sourceRevision.length > 128)) throw new Error('invalid_memory_source_revision');
  let expiresAt = input.expires_at === undefined ? old?.expires_at ?? null : input.expires_at;
  if (expiresAt !== null) {
    if (typeof expiresAt !== 'string') throw new Error('invalid_memory_expires_at');
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(expiresAt);
    if (!parts) throw new Error('invalid_memory_expires_at');
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const zone = String(parts[7]);
    if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0) || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59
      || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) throw new Error('invalid_memory_expires_at');
    const milliseconds = Date.parse(expiresAt);
    if (!Number.isFinite(milliseconds)) throw new Error('invalid_memory_expires_at');
    expiresAt = new Date(milliseconds).toISOString();
  }
  const supersedes = input.supersedes === undefined ? old?.supersedes ?? null : input.supersedes;
  if (supersedes !== null && (typeof supersedes !== 'string' || !supersedes.trim() || supersedes.length > 128)) throw new Error('invalid_memory_supersedes');
  return { provenance_json: JSON.stringify(provenance), source_revision: sourceRevision, expires_at: expiresAt as string | null, supersedes };
}

export function serializeMemory(row: MemoryRow): MemoryValue {
  return { memory_id: row.memory_id, workspace_id: row.workspace_id, project_id: row.project_id, scope: row.scope, agent_id: row.agent_id,
    content: row.content, verified: Boolean(row.verified), version: Number(row.version), status: row.status,
    provenance: JSON.parse(String(row.provenance_json ?? '[]')), source_revision: row.source_revision ?? null, expires_at: row.expires_at ?? null,
    supersedes: row.supersedes ?? null, verified_at: row.verified_at ?? null, expired: memoryExpired(row), created_at: row.created_at, updated_at: row.updated_at };
}

export function rankMemory(candidates: MemoryValue[], query: string, adapter?: MemoryRankAdapter): MemoryValue[] {
  if (!query) return candidates;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const keyword = () => candidates.map((entry, position) => ({ entry, position,
    score: terms.reduce((sum, term) => sum + (String(entry.content).toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.position - b.position).map(entry => entry.entry);
  if (!adapter) return keyword();
  try {
    // Clone the adapter boundary; adapter mutation can never change database-derived output.
    const result = adapter.rank({ query, candidates: structuredClone(candidates) });
    const authorized = new Map(candidates.map(entry => [String(entry.memory_id), entry]));
    if (!Array.isArray(result) || result.some(value => typeof value !== 'string' || !authorized.has(value)) || new Set(result).size !== result.length) return keyword();
    const ids = result as string[];
    return [...ids.map(value => authorized.get(value)!), ...candidates.filter(entry => !ids.includes(String(entry.memory_id)))];
  } catch { return keyword(); }
}

/** SQLite is authoritative; index jobs are version claims, never copies that can resurrect data. */
export class MemoryLifecycle {
  readonly legacyActive: boolean;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    const columns = new Set((db.prepare('PRAGMA table_info(wb_memories)').all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has('owner_id')) throw new Error('memory_owner_migration_required');
    this.legacyActive = columns.has('active');
    withImmediateTransaction(db, () => {
      const additions: Record<string, string> = { status: "TEXT NOT NULL DEFAULT 'active'", provenance_json: "TEXT NOT NULL DEFAULT '[]'", source_revision: 'TEXT', expires_at: 'TEXT', supersedes: 'TEXT', verified_at: 'TEXT' };
      for (const [column, definition] of Object.entries(additions)) if (!columns.has(column)) db.exec(`ALTER TABLE wb_memories ADD COLUMN ${column} ${definition}`);
      if (!columns.has('status') && this.legacyActive) db.exec("UPDATE wb_memories SET status=CASE WHEN active=1 THEN 'active' ELSE 'deleted' END");
      if (!columns.has('verified_at')) db.exec('UPDATE wb_memories SET verified_at=updated_at WHERE verified=1');
      db.exec(`CREATE INDEX IF NOT EXISTS wb_memory_scope ON wb_memories(owner_id,workspace_id,project_id,scope,agent_id,status,expires_at);
        CREATE TABLE IF NOT EXISTS wb_memory_revisions(memory_id TEXT NOT NULL,version INTEGER NOT NULL,owner_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(memory_id,version));
        CREATE TABLE IF NOT EXISTS wb_memory_index_jobs(memory_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,tombstone INTEGER NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wb_memory_restores(memory_id TEXT NOT NULL,owner_id TEXT NOT NULL,from_version INTEGER NOT NULL,source_version INTEGER NOT NULL,result_version INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(memory_id,result_version),
          FOREIGN KEY(memory_id,source_version) REFERENCES wb_memory_revisions(memory_id,version),FOREIGN KEY(memory_id,from_version) REFERENCES wb_memory_revisions(memory_id,version),FOREIGN KEY(memory_id,result_version) REFERENCES wb_memory_revisions(memory_id,version));
        CREATE TRIGGER IF NOT EXISTS wb_memory_restores_no_replace BEFORE INSERT ON wb_memory_restores
          WHEN EXISTS(SELECT 1 FROM wb_memory_restores WHERE memory_id=NEW.memory_id AND result_version=NEW.result_version)
          BEGIN SELECT RAISE(ABORT,'memory_restore_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS wb_memory_revisions_no_replace BEFORE INSERT ON wb_memory_revisions
          WHEN EXISTS(SELECT 1 FROM wb_memory_revisions WHERE memory_id=NEW.memory_id AND version=NEW.version)
          BEGIN SELECT RAISE(ABORT,'memory_revision_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS wb_memory_restores_no_update BEFORE UPDATE ON wb_memory_restores BEGIN SELECT RAISE(ABORT,'memory_restore_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS wb_memory_restores_no_delete BEFORE DELETE ON wb_memory_restores BEGIN SELECT RAISE(ABORT,'memory_restore_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS wb_memory_revisions_no_update BEFORE UPDATE ON wb_memory_revisions BEGIN SELECT RAISE(ABORT,'memory_revision_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS wb_memory_revisions_no_delete BEFORE DELETE ON wb_memory_revisions BEGIN SELECT RAISE(ABORT,'memory_revision_immutable'); END;`);
      const restoreKeys = db.prepare('PRAGMA foreign_key_list(wb_memory_restores)').all() as Array<{ id: number; table: string; from: string; to: string }>;
      for (const versionColumn of ['from_version', 'source_version', 'result_version']) {
        const versionKey = restoreKeys.find(key => key.table === 'wb_memory_revisions' && key.from === versionColumn && key.to === 'version');
        if (!versionKey || !restoreKeys.some(key => key.id === versionKey.id && key.table === 'wb_memory_revisions' && key.from === 'memory_id' && key.to === 'memory_id')) {
          throw new Error('memory_restore_schema_migration_required');
        }
      }
      for (const row of db.prepare('SELECT * FROM wb_memories').all() as MemoryRow[]) {
        if (!db.prepare('SELECT 1 FROM wb_memory_revisions WHERE memory_id=? AND version=?').get(String(row.memory_id), Number(row.version))) this.record(row);
        else this.queue(row);
      }
    });
  }
  record(row: MemoryRow): void {
    if (this.legacyActive) this.db.prepare('UPDATE wb_memories SET active=? WHERE memory_id=? AND owner_id=?').run(row.status === 'active' ? 1 : 0, String(row.memory_id), String(row.owner_id));
    const value = serializeMemory(row); delete value.expired;
    this.db.prepare('INSERT INTO wb_memory_revisions(memory_id,version,owner_id,snapshot_json,created_at) VALUES(?,?,?,?,?)')
      .run(String(row.memory_id), Number(row.version), String(row.owner_id), JSON.stringify(value), String(row.updated_at));
    this.queue(row);
  }
  private queue(row: MemoryRow): void {
    const tombstone = row.status !== 'active' || memoryExpired(row) ? 1 : 0;
    this.db.prepare(`INSERT INTO wb_memory_index_jobs(memory_id,owner_id,revision,tombstone,status,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET revision=excluded.revision,tombstone=excluded.tombstone,status=excluded.status,updated_at=excluded.updated_at
      WHERE wb_memory_index_jobs.revision<excluded.revision OR wb_memory_index_jobs.tombstone!=excluded.tombstone`)
      .run(String(row.memory_id), String(row.owner_id), Number(row.version), tombstone, 'pending', new Date().toISOString());
  }
  history(owner: string, memoryId: string): MemoryValue[] {
    return this.historyValues(this.db.prepare(`SELECT r.snapshot_json,a.source_version AS restored_from_version,a.from_version AS restored_over_version FROM wb_memory_revisions r
      LEFT JOIN wb_memory_restores a ON a.memory_id=r.memory_id AND a.owner_id=r.owner_id AND a.result_version=r.version
      WHERE r.owner_id=? AND r.memory_id=? ORDER BY r.version`).all(owner, memoryId) as MemoryRow[]);
  }
  historyPage(owner:string,memoryId:string,beforeVersion?:number){
    const rows=this.db.prepare(`SELECT r.version AS revision,r.snapshot_json,a.source_version AS restored_from_version,a.from_version AS restored_over_version FROM wb_memory_revisions r
      LEFT JOIN wb_memory_restores a ON a.memory_id=r.memory_id AND a.owner_id=r.owner_id AND a.result_version=r.version
      WHERE r.owner_id=? AND r.memory_id=? AND (? IS NULL OR r.version<?) ORDER BY r.version DESC LIMIT 51`).all(owner,memoryId,beforeVersion??null,beforeVersion??null) as MemoryRow[];
    const page=rows.slice(0,50);
    return {items:this.historyValues(page.reverse()),next_before_version:rows.length>50?Number(page[0]!.revision):null};
  }
  private historyValues(rows:MemoryRow[]):MemoryValue[]{
    return rows.map(row => {
        const snapshot = JSON.parse(String(row.snapshot_json)) as MemoryValue;
        const { version, content, verified, provenance, source_revision, expires_at, supersedes, verified_at, status, created_at, updated_at } = snapshot;
        return { version, content, verified, provenance, source_revision, expires_at, supersedes, verified_at, status, created_at, updated_at,
          ...(row.restored_from_version==null?{}:{restored_from_version:Number(row.restored_from_version),restored_over_version:Number(row.restored_over_version)}) };
      });
  }
  recordRestore(owner:string,memoryId:string,fromVersion:number,sourceVersion:number,resultVersion:number):void {
    if(!this.db.isTransaction)throw new Error('memory_restore_transaction_required');
    this.db.prepare('INSERT INTO wb_memory_restores VALUES(?,?,?,?,?,?)').run(memoryId,owner,fromVersion,sourceVersion,resultVersion,new Date().toISOString());
  }
  /** Restart/rebuild rechecks live state and expires tombstones before making any index claim. */
  rebuild(): void {
    withImmediateTransaction(this.db, () => { for (const row of this.db.prepare('SELECT * FROM wb_memories').all() as MemoryRow[]) this.queue(row); });
  }
  claim(owner: string, memoryId: string, revision: number): MemoryValue | null {
    const operation = () => {
      const row = this.db.prepare('SELECT * FROM wb_memories WHERE owner_id=? AND memory_id=?').get(owner, memoryId) as MemoryRow | undefined;
      if (!row) return null;
      this.queue(row);
      if (Number(row.version) !== revision || row.status !== 'active' || memoryExpired(row)) return null;
      if (row.scope === 'private' && !this.db.prepare("SELECT 1 FROM wb_agents WHERE owner_id=? AND agent_id=? AND status='active'").get(owner, String(row.agent_id))) return null;
      this.db.prepare("UPDATE wb_memory_index_jobs SET status='ready' WHERE owner_id=? AND memory_id=? AND revision=? AND tombstone=0").run(owner, memoryId, revision);
      return serializeMemory(row);
    };
    return this.db.isTransaction ? operation() : withImmediateTransaction(this.db, operation);
  }
}
