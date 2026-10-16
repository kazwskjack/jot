import type {DatabaseSync} from 'node:sqlite';
export function installOrdinarySteeringReconciliations(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS ga_ordinary_steering_reconciliations (
  command_id TEXT PRIMARY KEY REFERENCES ga_run_commands(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,session_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,observation_sha256 TEXT NOT NULL,
  source_json TEXT NOT NULL,observation_json TEXT NOT NULL,created_at TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_reconciliation_update BEFORE UPDATE ON ga_ordinary_steering_reconciliations
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_reconciliation_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_reconciliation_replace BEFORE INSERT ON ga_ordinary_steering_reconciliations
 WHEN EXISTS(SELECT 1 FROM ga_ordinary_steering_reconciliations WHERE command_id=NEW.command_id)
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_reconciliation_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ga_ordinary_steering_reconciliation_delete BEFORE DELETE ON ga_ordinary_steering_reconciliations
 WHEN EXISTS(SELECT 1 FROM ga_runs WHERE id=OLD.run_id) AND EXISTS(SELECT 1 FROM ga_run_commands WHERE id=OLD.command_id)
  AND EXISTS(SELECT 1 FROM ga_conversations WHERE id=OLD.conversation_id)
 BEGIN SELECT RAISE(ABORT,'ordinary_steering_reconciliation_immutable'); END;
 `);}
