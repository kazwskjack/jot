import type {DatabaseSync} from 'node:sqlite';
/** Private logical source checkpoint. Installed by task setup, never by readers. */
export function installWorkCycleSources(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS wb_discovery_work_cycle_sources(
  cycle_id TEXT PRIMARY KEY REFERENCES wb_discovery_work_cycles(cycle_id),owner_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,
  record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL,source_manifest_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_discovery_work_cycle_sources_scope BEFORE INSERT ON wb_discovery_work_cycle_sources
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_cycles c WHERE c.cycle_id=NEW.cycle_id AND c.owner_id=NEW.owner_id
  AND c.project_id=NEW.project_id AND c.workspace_id=NEW.workspace_id AND c.agent_id=NEW.agent_id AND c.state='open')
  OR EXISTS(SELECT 1 FROM wb_discovery_workspace_intents WHERE cycle_id=NEW.cycle_id)
 BEGIN SELECT RAISE(ABORT,'work_cycle_source_scope_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_work_cycle_sources_no_replace BEFORE INSERT ON wb_discovery_work_cycle_sources
 WHEN EXISTS(SELECT 1 FROM wb_discovery_work_cycle_sources WHERE cycle_id=NEW.cycle_id)
 BEGIN SELECT RAISE(ABORT,'work_cycle_source_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_work_cycle_sources_no_update BEFORE UPDATE ON wb_discovery_work_cycle_sources
 BEGIN SELECT RAISE(ABORT,'work_cycle_source_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_work_cycle_sources_no_delete BEFORE DELETE ON wb_discovery_work_cycle_sources
 BEGIN SELECT RAISE(ABORT,'work_cycle_source_immutable'); END;`);}
