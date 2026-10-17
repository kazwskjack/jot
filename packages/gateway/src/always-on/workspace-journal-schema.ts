import type {DatabaseSync} from 'node:sqlite';
/** Private artifact preparation facts only; original WorkCycles own lifecycle. */
export function installWorkspaceJournal(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS wb_discovery_workspace_intents(
  cycle_id TEXT PRIMARY KEY REFERENCES wb_discovery_work_cycles(cycle_id),owner_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,
  cycle_version INTEGER NOT NULL CHECK(cycle_version>0),snapshot_id TEXT NOT NULL UNIQUE,root_binding_sha256 TEXT NOT NULL,selection_sha256 TEXT NOT NULL,
  intent_json TEXT NOT NULL,intent_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(cycle_id,snapshot_id));
 CREATE TABLE IF NOT EXISTS wb_discovery_workspace_records(
  cycle_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
  FOREIGN KEY(cycle_id,snapshot_id) REFERENCES wb_discovery_workspace_intents(cycle_id,snapshot_id));
 CREATE TRIGGER IF NOT EXISTS wb_discovery_workspace_intent_scope BEFORE INSERT ON wb_discovery_workspace_intents
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_cycles c WHERE c.cycle_id=NEW.cycle_id AND c.owner_id=NEW.owner_id
  AND c.project_id=NEW.project_id AND c.workspace_id=NEW.workspace_id AND c.agent_id=NEW.agent_id AND c.version=NEW.cycle_version AND c.state='open')
 BEGIN SELECT RAISE(ABORT,'workspace_journal_scope_invalid'); END;`);
 for(const table of ['wb_discovery_workspace_intents','wb_discovery_workspace_records']){
  for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'workspace_journal_immutable'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
   WHEN EXISTS(SELECT 1 FROM ${table} WHERE cycle_id=NEW.cycle_id OR snapshot_id=NEW.snapshot_id)
   BEGIN SELECT RAISE(ABORT,'workspace_journal_immutable'); END;`);
 }
}
