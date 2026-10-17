import type {DatabaseSync} from 'node:sqlite';
/** Resource identities only. Original tasks, native Goal and budget ledgers stay
 * authoritative; this table does not represent another execution lifecycle. */
export function installWorkCycles(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS wb_discovery_work_cycles(
  cycle_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,
  admission_id TEXT NOT NULL REFERENCES wb_discovery_admissions(admission_id),occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),
  task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),root_run_id TEXT NOT NULL REFERENCES ga_runs(id),current_run_id TEXT NOT NULL REFERENCES ga_runs(id),
  report_sha256 TEXT NOT NULL,policy_version INTEGER NOT NULL,role_version INTEGER NOT NULL,role_epoch INTEGER NOT NULL,
  task_version INTEGER NOT NULL,task_generation INTEGER NOT NULL,signal_revision INTEGER NOT NULL,signal_sha256 TEXT NOT NULL,
  task_budget_scope_id TEXT NOT NULL,plans_json TEXT NOT NULL,plans_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),state TEXT NOT NULL CHECK(state IN ('open','closed')),created_at TEXT NOT NULL,closed_at TEXT,
  CHECK((state='open' AND closed_at IS NULL) OR (state='closed' AND closed_at IS NOT NULL)));
 CREATE UNIQUE INDEX IF NOT EXISTS wb_work_cycle_open_slot ON wb_discovery_work_cycles(owner_id,project_id,workspace_id) WHERE state='open';
 CREATE TABLE IF NOT EXISTS wb_discovery_work_cycle_commands(owner_id TEXT NOT NULL,command_key TEXT NOT NULL,command_sha256 TEXT NOT NULL,
  cycle_id TEXT NOT NULL REFERENCES wb_discovery_work_cycles(cycle_id),receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,command_key));
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_identity BEFORE UPDATE ON wb_discovery_work_cycles
 WHEN NEW.cycle_id IS NOT OLD.cycle_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.agent_id IS NOT OLD.agent_id OR NEW.admission_id IS NOT OLD.admission_id OR NEW.occurrence_id IS NOT OLD.occurrence_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.root_run_id IS NOT OLD.root_run_id OR NEW.current_run_id IS NOT OLD.current_run_id OR NEW.report_sha256 IS NOT OLD.report_sha256
  OR NEW.policy_version IS NOT OLD.policy_version OR NEW.role_version IS NOT OLD.role_version OR NEW.role_epoch IS NOT OLD.role_epoch
  OR NEW.task_version IS NOT OLD.task_version OR NEW.task_generation IS NOT OLD.task_generation OR NEW.signal_revision IS NOT OLD.signal_revision
  OR NEW.signal_sha256 IS NOT OLD.signal_sha256 OR NEW.task_budget_scope_id IS NOT OLD.task_budget_scope_id
  OR NEW.plans_json IS NOT OLD.plans_json OR NEW.plans_sha256 IS NOT OLD.plans_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR OLD.state<>'open' OR NEW.state<>'closed' OR NEW.version<>OLD.version+1 OR NEW.closed_at IS NULL
 BEGIN SELECT RAISE(ABORT,'work_cycle_identity_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_no_delete BEFORE DELETE ON wb_discovery_work_cycles BEGIN SELECT RAISE(ABORT,'work_cycle_identity_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_no_replace BEFORE INSERT ON wb_discovery_work_cycles WHEN EXISTS(SELECT 1 FROM wb_discovery_work_cycles WHERE cycle_id=NEW.cycle_id)
 BEGIN SELECT RAISE(ABORT,'work_cycle_identity_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_command_no_update BEFORE UPDATE ON wb_discovery_work_cycle_commands BEGIN SELECT RAISE(ABORT,'work_cycle_command_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_command_no_delete BEFORE DELETE ON wb_discovery_work_cycle_commands BEGIN SELECT RAISE(ABORT,'work_cycle_command_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_command_no_replace BEFORE INSERT ON wb_discovery_work_cycle_commands
 WHEN EXISTS(SELECT 1 FROM wb_discovery_work_cycle_commands WHERE owner_id=NEW.owner_id AND command_key=NEW.command_key)
 BEGIN SELECT RAISE(ABORT,'work_cycle_command_immutable'); END;
 `);}
