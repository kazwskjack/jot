import type {DatabaseSync} from 'node:sqlite';
/** Internal isolated tool journal; never projects rows into the shared wb_files store. */
export function installIsolatedWorkFiles(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_isolated_file_intents(
 call_key TEXT PRIMARY KEY,cycle_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,identity_json TEXT NOT NULL,
 operation_json TEXT NOT NULL,digest TEXT NOT NULL,before_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS wb_isolated_file_pending(cycle_id TEXT PRIMARY KEY,call_key TEXT NOT NULL UNIQUE REFERENCES wb_isolated_file_intents(call_key));
 CREATE TABLE IF NOT EXISTS wb_isolated_file_results(call_key TEXT PRIMARY KEY REFERENCES wb_isolated_file_intents(call_key),receipt_id TEXT NOT NULL UNIQUE,
 cycle_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,path TEXT,version INTEGER,sha256 TEXT,bytes BLOB,response_json TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS wb_isolated_file_version ON wb_isolated_file_results(cycle_id,snapshot_id,path,version) WHERE version IS NOT NULL;`);
 for(const table of ['wb_isolated_file_intents','wb_isolated_file_results'])for(const op of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'isolated_file_immutable'); END;`);
 for(const table of ['wb_isolated_file_intents','wb_isolated_file_results'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE call_key=NEW.call_key) BEGIN SELECT RAISE(ABORT,'isolated_file_immutable'); END;`);
 db.exec(`CREATE TRIGGER IF NOT EXISTS wb_isolated_file_results_receipt_replace BEFORE INSERT ON wb_isolated_file_results WHEN EXISTS(SELECT 1 FROM wb_isolated_file_results WHERE receipt_id=NEW.receipt_id OR (cycle_id=NEW.cycle_id AND snapshot_id=NEW.snapshot_id AND path=NEW.path AND version=NEW.version)) BEGIN SELECT RAISE(ABORT,'isolated_file_immutable'); END;`);
}
