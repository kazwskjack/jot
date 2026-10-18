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
  ensureColumn(db,'ga_conversations','mode',"TEXT NOT NULL DEFAULT 'work'");
  ensureColumn(db,'ga_runs','execution_policy_json','TEXT');
  ensureColumn(db,'ga_runs','chat_context_json','TEXT');
  ensureColumn(db,'ga_runs','chat_context_sha256','TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS ga_chat_compaction_intents (
    intent_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,
    source_json TEXT NOT NULL,source_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS ga_chat_compaction_intent_immutable BEFORE UPDATE ON ga_chat_compaction_intents
    BEGIN SELECT RAISE(ABORT,'chat_compaction_intent_immutable'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS ga_chat_web_groups (
    run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('search','fetch')),session_id TEXT NOT NULL,
    native_turn INTEGER NOT NULL,native_step INTEGER NOT NULL,assistant_seq INTEGER NOT NULL,
    group_json TEXT NOT NULL,group_sha256 TEXT NOT NULL,policy_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(run_id,kind));
   CREATE TABLE IF NOT EXISTS ga_chat_web_calls (
    run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,call_id TEXT NOT NULL,
    kind TEXT NOT NULL,request_sha256 TEXT NOT NULL,url_sha256 TEXT,created_at TEXT NOT NULL,
    PRIMARY KEY(run_id,call_id),UNIQUE(run_id,url_sha256),
    FOREIGN KEY(run_id,kind) REFERENCES ga_chat_web_groups(run_id,kind) ON DELETE CASCADE);
   CREATE TRIGGER IF NOT EXISTS ga_chat_web_group_immutable BEFORE UPDATE ON ga_chat_web_groups
    BEGIN SELECT RAISE(ABORT,'chat_web_group_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS ga_chat_web_call_immutable BEFORE UPDATE ON ga_chat_web_calls
    BEGIN SELECT RAISE(ABORT,'chat_web_call_immutable'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ga_chat_context_immutable BEFORE UPDATE OF chat_context_json,chat_context_sha256 ON ga_runs
   WHEN NEW.chat_context_json IS NOT OLD.chat_context_json OR NEW.chat_context_sha256 IS NOT OLD.chat_context_sha256
   BEGIN SELECT RAISE(ABORT,'chat_context_immutable'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS ga_conversation_mode_sessions (
    conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('work','chat')),
    session_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,PRIMARY KEY(conversation_id,mode));
    CREATE TRIGGER IF NOT EXISTS ga_mode_session_immutable BEFORE UPDATE ON ga_conversation_mode_sessions
      BEGIN SELECT RAISE(ABORT,'mode_session_immutable'); END;
    INSERT OR IGNORE INTO ga_conversation_mode_sessions(conversation_id,owner_id,mode,session_id,created_at)
      SELECT b.conversation_id,b.owner_id,'work',b.session_id,b.created_at FROM ga_harness_session_bindings b
      JOIN ga_conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id;
    CREATE TRIGGER IF NOT EXISTS ga_execution_policy_immutable BEFORE UPDATE OF execution_policy_json ON ga_runs
      WHEN NEW.execution_policy_json IS NOT OLD.execution_policy_json
      BEGIN SELECT RAISE(ABORT,'execution_policy_immutable'); END;`);
  ensureColumn(db,'ga_runs','model_policy_json','TEXT');
  ensureColumn(db,'ga_runs','model_resolution_json','TEXT');
  ensureColumn(db,'ga_runs','native_session_ref','TEXT');
  ensureColumn(db,'ga_runs','native_owner_id','TEXT');
  ensureColumn(db,'ga_runs','native_conversation_id','TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ga_runs_native_session ON ga_runs(native_session_ref,native_owner_id,native_conversation_id) WHERE native_session_ref IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS ga_run_native_session_immutable BEFORE UPDATE OF native_session_ref,native_owner_id,native_conversation_id ON ga_runs
    WHEN OLD.native_session_ref IS NOT NULL AND (NEW.native_session_ref IS NOT OLD.native_session_ref
      OR NEW.native_owner_id IS NOT OLD.native_owner_id OR NEW.native_conversation_id IS NOT OLD.native_conversation_id)
    BEGIN SELECT RAISE(ABORT,'run_native_session_immutable'); END;
    CREATE VIEW IF NOT EXISTS ga_run_native_sessions AS
      SELECT r.id AS run_id,r.conversation_id,c.owner_id,
        COALESCE(r.native_session_ref,b.session_id) AS session_id,
        r.created_at,r.updated_at
      FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
      LEFT JOIN ga_harness_session_bindings b ON b.conversation_id=c.id
      WHERE COALESCE(r.native_session_ref,b.session_id) IS NOT NULL
        AND (b.owner_id IS NULL OR b.owner_id=c.owner_id)
        AND (r.native_session_ref IS NULL OR (r.native_owner_id=c.owner_id AND r.native_conversation_id=c.id));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ga_run_model_policy_immutable BEFORE UPDATE OF model_policy_json ON ga_runs
    WHEN NEW.model_policy_json IS NOT OLD.model_policy_json
    BEGIN SELECT RAISE(ABORT,'model_policy_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ga_run_model_resolution_immutable BEFORE UPDATE OF model_resolution_json ON ga_runs
    WHEN OLD.model_resolution_json IS NOT NULL AND NEW.model_resolution_json IS NOT OLD.model_resolution_json
    BEGIN SELECT RAISE(ABORT,'model_resolution_immutable'); END;`);
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
