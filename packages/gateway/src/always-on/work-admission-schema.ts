import type {DatabaseSync} from 'node:sqlite';
/** An immutable receipt, never a second execution lifecycle. Installed inside
 * the original persistent-task schema transaction, before reopening its gate. */
export function installWorkAdmissions(db:DatabaseSync){
 // Original task facades may intentionally omit Workbench authority tables.
 // Keep their schema migratable while refusing every work receipt there.
 const roleAvailable=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_agents'").get();
 db.exec(`
 CREATE TABLE IF NOT EXISTS wb_discovery_work_admissions(
  grant_id TEXT PRIMARY KEY REFERENCES wb_discovery_work_grants(grant_id),
  owner_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),
  task_version INTEGER NOT NULL,task_generation INTEGER NOT NULL,
  occurrence_id TEXT NOT NULL UNIQUE REFERENCES wb_task_occurrences(occurrence_id) DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),conversation_id TEXT NOT NULL REFERENCES ga_conversations(id),
  record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 DROP TRIGGER IF EXISTS wb_work_admission_valid;
 CREATE TRIGGER wb_work_admission_valid BEFORE INSERT ON wb_discovery_work_admissions
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_admissions WHERE grant_id=NEW.grant_id OR occurrence_id=NEW.occurrence_id OR run_id=NEW.run_id)
 AND (${roleAvailable?`NOT EXISTS(SELECT 1 FROM wb_discovery_work_grants g JOIN wb_discovery_work_cycles c ON c.cycle_id=g.cycle_id
  JOIN wb_discovery_task_bindings b ON b.task_id=NEW.task_id JOIN wb_discovery_policies p ON p.policy_id=b.policy_id
  JOIN wb_persistent_tasks t ON t.task_id=b.task_id JOIN wb_agents a ON a.agent_id=b.agent_id
  JOIN ga_runs r ON r.id=NEW.run_id JOIN ga_conversations conversation ON conversation.id=NEW.conversation_id
  WHERE g.grant_id=NEW.grant_id AND g.owner_id=NEW.owner_id AND b.owner_id=g.owner_id AND t.owner_id=g.owner_id
   AND json_extract(g.grant_json,'$.task_id')=NEW.task_id AND c.task_id=NEW.task_id AND c.state='open' AND c.version=g.cycle_version
   AND t.status='active' AND t.version=NEW.task_version AND t.generation=NEW.task_generation
   AND json_extract(g.grant_json,'$.task_version')=t.version AND json_extract(g.grant_json,'$.task_generation')=t.generation
   AND p.state='active' AND p.version=c.policy_version AND p.role_version=c.role_version AND p.role_epoch=c.role_epoch
   AND a.owner_id=g.owner_id AND a.status='active' AND a.version=c.role_version AND a.capability_epoch=c.role_epoch
   AND b.project_id=g.project_id AND b.workspace_id=g.workspace_id AND b.agent_id=g.agent_id
   AND c.signal_revision=coalesce((SELECT max(revision) FROM wb_discovery_signals WHERE policy_id=p.policy_id),0)
   AND r.conversation_id=NEW.conversation_id AND conversation.owner_id=NEW.owner_id
   AND conversation.workspace_id=b.workspace_id AND conversation.project_id=b.project_id
   AND json_extract(NEW.record_json,'$.grant_id')=NEW.grant_id
   AND json_extract(NEW.record_json,'$.task_id')=NEW.task_id
   AND json_extract(NEW.record_json,'$.task_version')=NEW.task_version
   AND json_extract(NEW.record_json,'$.task_generation')=NEW.task_generation
   AND json_extract(NEW.record_json,'$.occurrence_id')=NEW.occurrence_id
   AND json_extract(NEW.record_json,'$.run_id')=NEW.run_id
   AND json_extract(NEW.record_json,'$.conversation_id')=NEW.conversation_id)`:'1'})
 BEGIN SELECT RAISE(ABORT,'work_admission_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_admission_no_update BEFORE UPDATE ON wb_discovery_work_admissions
 BEGIN SELECT RAISE(ABORT,'work_admission_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_admission_no_delete BEFORE DELETE ON wb_discovery_work_admissions
 BEGIN SELECT RAISE(ABORT,'work_admission_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_admission_no_replace BEFORE INSERT ON wb_discovery_work_admissions
 WHEN EXISTS(SELECT 1 FROM wb_discovery_work_admissions WHERE grant_id=NEW.grant_id OR occurrence_id=NEW.occurrence_id OR run_id=NEW.run_id)
 BEGIN SELECT RAISE(ABORT,'work_admission_immutable'); END;
 `);}
