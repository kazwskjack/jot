import type {DatabaseSync} from 'node:sqlite';
/** Separate original proof subtype: isolated versions never enter wb_file_versions. */
export function installIsolatedOutputSources(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_isolated_file_execution_receipts(
 receipt_id TEXT PRIMARY KEY REFERENCES wb_task_execution_receipts(receipt_id),isolated_receipt_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,
 cycle_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,path TEXT NOT NULL,version INTEGER NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,result_json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_task_isolated_receipt_no_replace BEFORE INSERT ON wb_task_isolated_file_execution_receipts
 WHEN EXISTS(SELECT 1 FROM wb_task_isolated_file_execution_receipts WHERE receipt_id=NEW.receipt_id OR isolated_receipt_id=NEW.isolated_receipt_id)
 BEGIN SELECT RAISE(ABORT,'isolated_execution_receipt_immutable'); END;`);
 for(const op of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS wb_task_isolated_receipt_no_${op.toLowerCase()} BEFORE ${op} ON wb_task_isolated_file_execution_receipts BEGIN SELECT RAISE(ABORT,'isolated_execution_receipt_immutable'); END;`);
}
