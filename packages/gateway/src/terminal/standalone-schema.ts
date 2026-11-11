import type {DatabaseSync} from 'node:sqlite';

/** Independent user-terminal admission never borrows or fabricates a model run. */
export function installStandaloneTerminalAdmissions(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ga_standalone_terminal_admissions(
  owner_id TEXT NOT NULL,request_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
  authority_sha256 TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','ready','unknown','cancelled')),
  version INTEGER NOT NULL CHECK(version>=1),native_identity_sha256 TEXT,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,request_id),
  CHECK((state='ready' AND native_identity_sha256 IS NOT NULL) OR (state<>'ready' AND native_identity_sha256 IS NULL)));
  CREATE TABLE IF NOT EXISTS ga_standalone_terminal_native_attempts(
   owner_id TEXT NOT NULL,request_id TEXT NOT NULL,session_id TEXT NOT NULL,authority_sha256 TEXT NOT NULL,attempted_at TEXT NOT NULL,
   PRIMARY KEY(owner_id,request_id),FOREIGN KEY(owner_id,request_id) REFERENCES ga_standalone_terminal_admissions(owner_id,request_id));
  CREATE TRIGGER IF NOT EXISTS ga_standalone_terminal_attempt_immutable BEFORE UPDATE ON ga_standalone_terminal_native_attempts
   BEGIN SELECT RAISE(ABORT,'standalone_terminal_attempt_immutable'); END;
  CREATE INDEX IF NOT EXISTS idx_ga_standalone_terminal_owner ON ga_standalone_terminal_admissions(owner_id,workspace_id,request_id);
  CREATE TRIGGER IF NOT EXISTS ga_standalone_terminal_identity BEFORE UPDATE ON ga_standalone_terminal_admissions
  WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.request_id IS NOT OLD.request_id
   OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.authority_sha256 IS NOT OLD.authority_sha256
   OR NEW.session_id IS NOT OLD.session_id OR NEW.created_at IS NOT OLD.created_at
   OR NEW.version<>OLD.version+1
   OR NOT ((OLD.state='prepared' AND NEW.state IN ('dispatched','cancelled'))
    OR (OLD.state='dispatched' AND NEW.state IN ('ready','unknown')) OR (OLD.state='unknown' AND NEW.state='ready'))
  BEGIN SELECT RAISE(ABORT,'standalone_terminal_transition_invalid'); END;`);
}
