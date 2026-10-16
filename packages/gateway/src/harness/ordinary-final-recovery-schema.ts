import type {DatabaseSync} from 'node:sqlite';
/** Observation coalescing, not an execution lease, model grant or native ACK. */
export function installOrdinaryFinalObservers(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS ga_ordinary_final_observers(
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,
  observer_id TEXT NOT NULL,token TEXT NOT NULL,lease_until INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL,attempts INTEGER NOT NULL,
  last_phase TEXT NOT NULL,last_outcome TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_ordinary_final_observers_due ON ga_ordinary_final_observers(next_check_at,lease_until,updated_at);
 CREATE INDEX IF NOT EXISTS idx_ga_runs_conversation_order ON ga_runs(conversation_id);
 CREATE TRIGGER IF NOT EXISTS ordinary_final_observer_identity BEFORE UPDATE ON ga_ordinary_final_observers
 WHEN NEW.run_id IS NOT OLD.run_id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.session_id IS NOT OLD.session_id
 BEGIN SELECT RAISE(ABORT,'ordinary_final_observer_identity_immutable'); END;
 `);}
