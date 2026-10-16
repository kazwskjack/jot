import type {DatabaseSync} from 'node:sqlite';

/** Called within the original task schema transaction. A reservation cannot
 * commit without its exact original occurrence; it is not a second task store. */
export function installDiscoveryAdmissions(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_discovery_admissions(
  admission_id TEXT PRIMARY KEY,policy_id TEXT NOT NULL REFERENCES wb_discovery_policies(policy_id),
  task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),
  occurrence_id TEXT NOT NULL UNIQUE REFERENCES wb_task_occurrences(occurrence_id) DEFERRABLE INITIALLY DEFERRED,
  owner_id TEXT NOT NULL,policy_version INTEGER NOT NULL,role_version INTEGER NOT NULL,role_epoch INTEGER NOT NULL,
  task_version INTEGER NOT NULL,task_generation INTEGER NOT NULL,signal_revision INTEGER NOT NULL CHECK(signal_revision>=0),
  signal_sha256 TEXT NOT NULL,activity_sha256 TEXT NOT NULL,budget_policy_revision INTEGER NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(policy_id,task_generation,signal_revision));
 CREATE TRIGGER IF NOT EXISTS wb_discovery_admission_valid BEFORE INSERT ON wb_discovery_admissions
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_task_bindings b JOIN wb_discovery_policies p ON p.policy_id=b.policy_id
  JOIN wb_persistent_tasks t ON t.task_id=b.task_id
  WHERE b.policy_id=NEW.policy_id AND b.task_id=NEW.task_id AND b.owner_id=NEW.owner_id
   AND p.state='active' AND p.version=NEW.policy_version AND p.role_version=NEW.role_version AND p.role_epoch=NEW.role_epoch
   AND t.status='active' AND t.version=NEW.task_version AND t.generation=NEW.task_generation
   AND NEW.signal_revision=coalesce((SELECT max(revision) FROM wb_discovery_signals WHERE policy_id=p.policy_id),0))
 BEGIN SELECT RAISE(ABORT,'discovery_admission_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_admission_no_update BEFORE UPDATE ON wb_discovery_admissions
 BEGIN SELECT RAISE(ABORT,'discovery_admission_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_admission_no_delete BEFORE DELETE ON wb_discovery_admissions
 BEGIN SELECT RAISE(ABORT,'discovery_admission_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_admission_no_replace BEFORE INSERT ON wb_discovery_admissions
 WHEN EXISTS(SELECT 1 FROM wb_discovery_admissions WHERE admission_id=NEW.admission_id OR occurrence_id=NEW.occurrence_id
  OR (policy_id=NEW.policy_id AND task_generation=NEW.task_generation AND signal_revision=NEW.signal_revision))
 BEGIN SELECT RAISE(ABORT,'discovery_admission_immutable'); END;
 DROP TRIGGER IF EXISTS wb_discovery_occurrence_closed;
 CREATE TRIGGER wb_discovery_occurrence_closed BEFORE INSERT ON wb_task_occurrences
 WHEN EXISTS(SELECT 1 FROM wb_discovery_task_bindings WHERE task_id=NEW.task_id)
  AND NOT EXISTS(SELECT 1 FROM wb_discovery_admissions a JOIN wb_discovery_policies p ON p.policy_id=a.policy_id
   JOIN wb_persistent_tasks t ON t.task_id=a.task_id
   WHERE a.task_id=NEW.task_id AND a.occurrence_id=NEW.occurrence_id AND a.task_generation=NEW.generation
    AND NEW.trigger_key='discovery:'||a.admission_id AND t.owner_id=a.owner_id AND t.status='active'
    AND p.state='active' AND p.version=a.policy_version AND t.version=a.task_version AND t.generation=a.task_generation
    AND a.signal_revision=coalesce((SELECT max(revision) FROM wb_discovery_signals WHERE policy_id=p.policy_id),0))
 BEGIN SELECT RAISE(ABORT,'task_discovery_admission_required'); END;`);
}
