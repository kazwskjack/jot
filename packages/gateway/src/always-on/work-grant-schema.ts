import type {DatabaseSync} from 'node:sqlite';
/** Explicit owner selection facts only. No run, occurrence, admission or Goal. */
export function installWorkGrants(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS wb_discovery_work_grants(
  grant_id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL UNIQUE REFERENCES wb_discovery_work_cycles(cycle_id),
  owner_id TEXT NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,
  cycle_version INTEGER NOT NULL CHECK(cycle_version>0),snapshot_id TEXT NOT NULL,
  grant_json TEXT NOT NULL,grant_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
  FOREIGN KEY(cycle_id,snapshot_id) REFERENCES wb_discovery_workspace_intents(cycle_id,snapshot_id));
 CREATE TABLE IF NOT EXISTS wb_discovery_work_grant_commands(
  owner_id TEXT NOT NULL,command_key TEXT NOT NULL,command_sha256 TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE REFERENCES wb_discovery_work_grants(grant_id),receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,command_key));
 CREATE TRIGGER IF NOT EXISTS wb_discovery_work_grant_scope BEFORE INSERT ON wb_discovery_work_grants
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_cycles c JOIN wb_discovery_workspace_records r ON r.cycle_id=c.cycle_id
  JOIN wb_discovery_work_cycle_sources s ON s.cycle_id=c.cycle_id
  WHERE c.cycle_id=NEW.cycle_id AND c.owner_id=NEW.owner_id AND c.project_id=NEW.project_id AND c.workspace_id=NEW.workspace_id
  AND c.agent_id=NEW.agent_id AND c.version=NEW.cycle_version AND c.state='open' AND r.snapshot_id=NEW.snapshot_id)
 BEGIN SELECT RAISE(ABORT,'work_grant_scope_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_discovery_work_grant_command_scope BEFORE INSERT ON wb_discovery_work_grant_commands
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_grants g WHERE g.grant_id=NEW.grant_id AND g.owner_id=NEW.owner_id AND g.grant_json=NEW.receipt_json)
 BEGIN SELECT RAISE(ABORT,'work_grant_scope_invalid'); END;`);
 for(const table of ['wb_discovery_work_grants','wb_discovery_work_grant_commands']){
  for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'work_grant_immutable'); END;`);
  const conflict=table.endsWith('_commands')?'owner_id=NEW.owner_id AND command_key=NEW.command_key OR grant_id=NEW.grant_id':'grant_id=NEW.grant_id OR cycle_id=NEW.cycle_id';
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'work_grant_immutable'); END;`);
 }
}
