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
   AND json_extract(NEW.record_json,'$.conversation_id')=NEW.conversation_id)
 AND NOT EXISTS(SELECT 1 FROM wb_discovery_work_grants g JOIN wb_discovery_work_cycles c ON c.cycle_id=g.cycle_id
  JOIN wb_task_prd_work_cycle_origins origin ON origin.cycle_id=c.cycle_id
  JOIN wb_persistent_tasks t ON t.task_id=c.task_id JOIN wb_agents a ON a.agent_id=c.agent_id
  JOIN wb_task_current_occurrences planning ON planning.occurrence_id=c.occurrence_id AND planning.task_id=c.task_id
  JOIN wb_task_subtask_scope ledger ON ledger.task_id=c.task_id AND ledger.occurrence_id=c.occurrence_id
  JOIN ga_runs r ON r.id=NEW.run_id JOIN ga_conversations conversation ON conversation.id=NEW.conversation_id
  WHERE g.grant_id=NEW.grant_id AND g.owner_id=NEW.owner_id AND c.owner_id=g.owner_id AND origin.owner_id=g.owner_id
   AND t.owner_id=g.owner_id AND t.task_id=NEW.task_id AND origin.task_id=t.task_id
   AND t.status='active' AND t.version=NEW.task_version AND t.generation=NEW.task_generation
   AND json_extract(g.grant_json,'$.task_id')=t.task_id AND json_extract(g.grant_json,'$.task_version')=t.version
   AND json_extract(g.grant_json,'$.task_generation')=t.generation AND c.task_version=t.version AND c.task_generation=t.generation
   AND c.admission_id IS NULL AND c.state='open' AND c.version=g.cycle_version
   AND json_type(g.grant_json,'$.admission_id')='null' AND json_type(g.grant_json,'$.policy_version')='null'
   AND json_type(g.grant_json,'$.report_sha256')='null' AND json_type(g.grant_json,'$.signal_revision')='null'
   AND json_type(g.grant_json,'$.signal_sha256')='null' AND json_extract(g.grant_json,'$.origin.kind')='task_prd'
   AND json_extract(g.grant_json,'$.origin.acceptance_id')=origin.acceptance_id
   AND json_extract(g.grant_json,'$.origin.acceptance_sha256')=origin.acceptance_sha256
   AND json_extract(g.grant_json,'$.origin.plan_id')=origin.plan_id AND json_extract(g.grant_json,'$.origin.plan_sha256')=origin.plan_sha256
   AND a.owner_id=g.owner_id AND a.status='active' AND a.version=c.role_version AND a.capability_epoch=c.role_epoch
   AND a.project_id=c.project_id AND a.workspace_id=c.workspace_id AND t.agent_id=a.agent_id
   AND g.agent_id=c.agent_id AND g.workspace_id=c.workspace_id AND g.project_id=c.project_id
   AND planning.generation=t.generation AND planning.root_run_id=c.root_run_id AND planning.run_id=c.current_run_id
   AND planning.run_id=json_extract(g.grant_json,'$.planning_current_run_id')
   AND r.conversation_id=NEW.conversation_id AND conversation.owner_id=NEW.owner_id
   AND conversation.workspace_id=c.workspace_id AND conversation.project_id=c.project_id
   AND json_extract(NEW.record_json,'$.grant_id')=NEW.grant_id AND json_extract(NEW.record_json,'$.task_id')=NEW.task_id
   AND json_extract(NEW.record_json,'$.task_version')=NEW.task_version AND json_extract(NEW.record_json,'$.task_generation')=NEW.task_generation
   AND json_extract(NEW.record_json,'$.occurrence_id')=NEW.occurrence_id AND json_extract(NEW.record_json,'$.run_id')=NEW.run_id
   AND json_extract(NEW.record_json,'$.conversation_id')=NEW.conversation_id
   AND NOT EXISTS(SELECT 1 FROM wb_discovery_task_bindings b WHERE b.task_id=t.task_id))`:'1'})
 BEGIN SELECT RAISE(ABORT,'work_admission_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_work_occurrence_required BEFORE INSERT ON wb_task_occurrences
 WHEN NEW.trigger_key LIKE 'prd-work:%' AND NOT EXISTS(
  SELECT 1 FROM wb_discovery_work_admissions a JOIN wb_discovery_work_grants g ON g.grant_id=a.grant_id
   JOIN wb_discovery_work_cycles c ON c.cycle_id=g.cycle_id JOIN wb_task_prd_work_cycle_origins origin ON origin.cycle_id=c.cycle_id
   JOIN wb_persistent_tasks t ON t.task_id=a.task_id
  WHERE a.task_id=NEW.task_id AND a.occurrence_id=NEW.occurrence_id AND a.run_id=NEW.run_id AND a.conversation_id=NEW.conversation_id
   AND a.task_generation=NEW.generation AND NEW.trigger_key='prd-work:'||a.grant_id
   AND c.admission_id IS NULL AND c.state='open' AND c.version=g.cycle_version AND origin.owner_id=a.owner_id
   AND g.owner_id=a.owner_id AND t.owner_id=a.owner_id AND c.task_id=t.task_id AND t.status='active'
   AND t.version=a.task_version AND t.generation=a.task_generation)
 BEGIN SELECT RAISE(ABORT,'work_admission_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_admission_no_update BEFORE UPDATE ON wb_discovery_work_admissions
 BEGIN SELECT RAISE(ABORT,'work_admission_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_admission_no_delete BEFORE DELETE ON wb_discovery_work_admissions
 BEGIN SELECT RAISE(ABORT,'work_admission_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_admission_no_replace BEFORE INSERT ON wb_discovery_work_admissions
 WHEN EXISTS(SELECT 1 FROM wb_discovery_work_admissions WHERE grant_id=NEW.grant_id OR occurrence_id=NEW.occurrence_id OR run_id=NEW.run_id)
 BEGIN SELECT RAISE(ABORT,'work_admission_immutable'); END;
 `);}
