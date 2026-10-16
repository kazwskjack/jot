import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {installSessionCheckpoints} from '../harness/session-checkpoints.ts';
import {installTaskWaitInteractions} from '../persistent-tasks/task-wait-schema.ts';
import {migrateHostDeliveries} from './host-delivery-migration.ts';
import {installOrdinarySteeringReconciliations} from '../harness/ordinary-steering-reconciliation-schema.ts';
import {installOrdinaryFinalPublications} from '../harness/ordinary-final-publication-schema.ts';
import {installHistoricalFinalDeliveryIntents} from '../channels/historical-final-intents-schema.ts';
import {installOrdinaryFinalObservers} from '../harness/ordinary-final-recovery-schema.ts';
import {installHistoricalDispatchProtocol} from '../channels/historical-final-queue.ts';
import {installOrdinarySteeringCustody} from '../harness/ordinary-steering-custody.ts';

const schemaUrl = new URL('./schema.sql', import.meta.url);
let savepointSequence = 0;

export function openProductDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=75; PRAGMA foreign_keys=ON;');
  db.exec(readFileSync(schemaUrl, 'utf8'));
  installOrdinarySteeringReconciliations(db);
  installOrdinarySteeringCustody(db);
  installOrdinaryFinalPublications(db);
  installHistoricalFinalDeliveryIntents(db);
  installOrdinaryFinalObservers(db);
  ensureColumn(db,'ga_conversation_goal_controls','dispatch_observer_id','TEXT');
  db.exec(`CREATE TRIGGER IF NOT EXISTS ga_goal_control_observer BEFORE UPDATE ON ga_conversation_goal_controls
    WHEN OLD.state<>'queued' AND NEW.dispatch_observer_id IS NOT OLD.dispatch_observer_id
    BEGIN SELECT RAISE(ABORT,'goal_control_observer_immutable'); END;`);
  installSessionCheckpoints(db);
  installTaskWaitInteractions(db);
  ensureColumn(db, 'ga_conversations', 'project_id', 'TEXT');
  ensureColumn(db, 'ga_conversations', 'pinned_at', 'TEXT');
  ensureColumn(db, 'ga_conversations', 'archived_at', 'TEXT');
  ensureColumn(db, 'ga_channel_deliveries', 'payload_json', 'TEXT');
  ensureColumn(db, 'ga_idempotency', 'receipt_protocol', 'TEXT');
  ensureColumn(db, 'ga_uploads', 'writer_token', 'TEXT');
  ensureColumn(db, 'ga_uploads', 'writer_lease_until', 'TEXT');
  migrateHostDeliveries(db);
  withImmediateTransaction(db,()=>installHistoricalDispatchProtocol(db));
  ensureColumn(db, 'ga_crawl_batches', 'summary_delivery_effect_id', 'TEXT');
  ensureColumn(db, 'ga_web_operation_cursors', 'last_status', 'TEXT');
  ensureColumn(db, 'ga_web_operation_cursors', 'items_settled', 'INTEGER NOT NULL DEFAULT 0');
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
  if (db.isTransaction) {
    const savepoint = `ga_nested_${++savepointSequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const value = operation();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
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
