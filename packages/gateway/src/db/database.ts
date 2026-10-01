import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schemaUrl = new URL('./schema.sql', import.meta.url);

export function openProductDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=75; PRAGMA foreign_keys=ON;');
  db.exec(readFileSync(schemaUrl, 'utf8'));
  ensureColumn(db, 'ga_conversations', 'project_id', 'TEXT');
  ensureColumn(db, 'ga_conversations', 'pinned_at', 'TEXT');
  ensureColumn(db, 'ga_conversations', 'archived_at', 'TEXT');
  ensureColumn(db, 'ga_channel_deliveries', 'payload_json', 'TEXT');
  ensureColumn(db, 'ga_crawl_batches', 'summary_delivery_effect_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ga_conversations_project_state
      ON ga_conversations(owner_id,project_id,archived_at,pinned_at DESC,updated_at DESC,id DESC);
  `);
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(value => value.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
