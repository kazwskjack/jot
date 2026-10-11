import type {DatabaseSync} from 'node:sqlite';

export function installTaskWaitInteractions(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_wait_interactions (
    interaction_id TEXT PRIMARY KEY REFERENCES ga_interactions(id),
    run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),
    proposal_id TEXT NOT NULL,checkpoint_id TEXT NOT NULL REFERENCES ga_session_checkpoints(checkpoint_id),
    expected_run_version INTEGER NOT NULL,purpose TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wb_task_wait_responses (
    interaction_id TEXT PRIMARY KEY REFERENCES wb_task_wait_interactions(interaction_id),
    new_run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),response_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wb_task_wait_receipts (
    interaction_id TEXT PRIMARY KEY REFERENCES wb_task_wait_interactions(interaction_id),
    operation TEXT NOT NULL CHECK(operation IN ('interaction_response','interaction_decision')),
    idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS wb_task_wait_interactions_no_update BEFORE UPDATE ON wb_task_wait_interactions
      BEGIN SELECT RAISE(ABORT,'task_wait_binding_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_task_wait_interactions_no_delete BEFORE DELETE ON wb_task_wait_interactions
      BEGIN SELECT RAISE(ABORT,'task_wait_binding_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_task_wait_responses_no_update BEFORE UPDATE ON wb_task_wait_responses
      BEGIN SELECT RAISE(ABORT,'task_wait_response_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_task_wait_responses_no_delete BEFORE DELETE ON wb_task_wait_responses
      BEGIN SELECT RAISE(ABORT,'task_wait_response_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_task_wait_receipts_no_update BEFORE UPDATE ON wb_task_wait_receipts
      BEGIN SELECT RAISE(ABORT,'task_wait_receipt_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_task_wait_receipts_no_delete BEFORE DELETE ON wb_task_wait_receipts
      BEGIN SELECT RAISE(ABORT,'task_wait_receipt_immutable'); END;`);
}
