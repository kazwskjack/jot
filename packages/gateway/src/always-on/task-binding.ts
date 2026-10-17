import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {installDiscoveryPolicySchema} from './discovery-policy.ts';
import {installDiscoveryAdmissions} from './admission-schema.ts';
import {installDiscoveryPlanning} from './planning.ts';
import {installWorkCycles} from './work-cycle-schema.ts';
import {installWorkspaceJournal} from './workspace-journal-schema.ts';
import {installWorkCycleSources} from './work-cycle-source-schema.ts';
import {installWorkGrants} from './work-grant-schema.ts';
import {installWorkAdmissions} from './work-admission-schema.ts';
/** Stable task/budget identity. Generic occurrence admission stays closed;
 * the trusted planning path requires an immutable original-occurrence receipt. */
export function installDiscoveryTaskBindings(db:DatabaseSync){
 withImmediateTransaction(db,()=>{installDiscoveryPolicySchema(db);db.exec(`CREATE TABLE IF NOT EXISTS wb_discovery_task_bindings(
  policy_id TEXT PRIMARY KEY REFERENCES wb_discovery_policies(policy_id),task_id TEXT NOT NULL UNIQUE REFERENCES wb_persistent_tasks(task_id),
  owner_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,
  created_policy_version INTEGER NOT NULL CHECK(created_policy_version>0),created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_discovery_binding_valid BEFORE INSERT ON wb_discovery_task_bindings
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_policies p JOIN wb_persistent_tasks t ON t.task_id=NEW.task_id
  WHERE p.policy_id=NEW.policy_id AND p.owner_id=NEW.owner_id AND p.project_id=NEW.project_id
  AND p.workspace_id=NEW.workspace_id AND p.agent_id=NEW.agent_id AND p.version=NEW.created_policy_version AND p.state='active'
  AND t.owner_id=p.owner_id AND t.agent_id=p.agent_id
  AND t.next_due_at IS NULL AND t.runs_used=0 AND t.max_runs=0 AND t.run_limit_mode='unlimited'
  AND json_extract(t.trigger_json,'$.kind')='project_discovery' AND json_extract(t.trigger_json,'$.policy_id')=p.policy_id
  AND NOT EXISTS(SELECT 1 FROM wb_task_occurrences o WHERE o.task_id=t.task_id))
 BEGIN SELECT RAISE(ABORT,'discovery_task_binding_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_binding_no_replace BEFORE INSERT ON wb_discovery_task_bindings
 WHEN EXISTS(SELECT 1 FROM wb_discovery_task_bindings WHERE policy_id=NEW.policy_id OR task_id=NEW.task_id)
 BEGIN SELECT RAISE(ABORT,'discovery_task_binding_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_binding_no_update BEFORE UPDATE ON wb_discovery_task_bindings
 BEGIN SELECT RAISE(ABORT,'discovery_task_binding_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_binding_no_delete BEFORE DELETE ON wb_discovery_task_bindings
 BEGIN SELECT RAISE(ABORT,'discovery_task_binding_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_task_guard BEFORE UPDATE ON wb_persistent_tasks
 WHEN EXISTS(SELECT 1 FROM wb_discovery_task_bindings WHERE task_id=OLD.task_id)
 AND (NEW.task_id IS NOT OLD.task_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.title IS NOT OLD.title OR NEW.objective IS NOT OLD.objective OR NEW.priority IS NOT OLD.priority
  OR NEW.source_json IS NOT OLD.source_json OR NEW.trigger_json IS NOT OLD.trigger_json OR NEW.next_due_at IS NOT NULL OR NEW.max_runs<>0
  OR NEW.run_limit_mode<>'unlimited' OR NEW.runs_used<OLD.runs_used)
 BEGIN SELECT RAISE(ABORT,'task_discovery_managed'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_task_no_delete BEFORE DELETE ON wb_persistent_tasks
 WHEN EXISTS(SELECT 1 FROM wb_discovery_task_bindings WHERE task_id=OLD.task_id)
 BEGIN SELECT RAISE(ABORT,'task_discovery_managed'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_task_no_replace BEFORE INSERT ON wb_persistent_tasks
 WHEN EXISTS(SELECT 1 FROM wb_discovery_task_bindings WHERE task_id=NEW.task_id)
 BEGIN SELECT RAISE(ABORT,'task_discovery_managed'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_occurrence_closed BEFORE INSERT ON wb_task_occurrences
 WHEN EXISTS(SELECT 1 FROM wb_discovery_task_bindings WHERE task_id=NEW.task_id)
 BEGIN SELECT RAISE(ABORT,'task_discovery_admission_required'); END;`);installDiscoveryAdmissions(db);installDiscoveryPlanning(db);installWorkCycles(db);installWorkspaceJournal(db);installWorkCycleSources(db);installWorkGrants(db);installWorkAdmissions(db);});
}
