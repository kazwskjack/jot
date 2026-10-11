import type {DatabaseSync} from 'node:sqlite';

type Row=Record<string,any>;

/** The existing task ledger is the current projection. Immutable revisions keep
 * each occurrence's observed state without introducing another executor. */
export function installSubtaskState(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_subtask_scope (
  task_id TEXT PRIMARY KEY REFERENCES wb_persistent_tasks(task_id),
  occurrence_id TEXT NOT NULL UNIQUE REFERENCES wb_task_occurrences(occurrence_id));
  CREATE TABLE IF NOT EXISTS wb_task_subtask_states (
  occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),
  subtask_id TEXT NOT NULL REFERENCES wb_task_subtasks(subtask_id),version INTEGER NOT NULL CHECK(version>=1),
  snapshot_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(occurrence_id,subtask_id,version));
  CREATE TRIGGER IF NOT EXISTS wb_subtask_state_no_update BEFORE UPDATE ON wb_task_subtask_states
   BEGIN SELECT RAISE(ABORT,'subtask_state_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_subtask_state_no_delete BEFORE DELETE ON wb_task_subtask_states
   BEGIN SELECT RAISE(ABORT,'subtask_state_immutable'); END;`);
}

export function subtaskOccurrence(db:DatabaseSync,taskId:string):string|null{
 return (db.prepare('SELECT occurrence_id FROM wb_task_subtask_scope WHERE task_id=?').get(taskId) as {occurrence_id:string}|undefined)?.occurrence_id??null;
}

export function recordSubtaskState(db:DatabaseSync,taskId:string,subtaskId:string,now:string,observedOccurrenceId?:string):void{
 let scope=db.prepare(`SELECT s.occurrence_id FROM wb_task_subtask_scope s
  JOIN wb_task_occurrences o ON o.occurrence_id=s.occurrence_id AND o.task_id=s.task_id WHERE s.task_id=?`).get(taskId) as {occurrence_id:string}|undefined;
 // An authoritative active execution may record its newly observed edit after
 // upgrade. Do not copy any previous rows as purported historical observations.
 if(!scope&&observedOccurrenceId){
  if(!db.prepare('SELECT 1 FROM wb_task_current_occurrences WHERE task_id=? AND occurrence_id=?').get(taskId,observedOccurrenceId))throw new Error('occurrence_not_found');
  db.prepare('INSERT INTO wb_task_subtask_scope VALUES(?,?)').run(taskId,observedOccurrenceId);
  scope={occurrence_id:observedOccurrenceId};
 }
 if(scope&&observedOccurrenceId&&scope.occurrence_id!==observedOccurrenceId)throw new Error('task_execution_scope_conflict');
 // Older deployments have no provable occurrence history; never invent it.
 if(!scope)return;
 const row=db.prepare('SELECT * FROM wb_task_subtasks WHERE task_id=? AND subtask_id=?').get(taskId,subtaskId) as Row|undefined;
 if(!row)throw new Error('subtask_not_found');
 db.prepare('INSERT INTO wb_task_subtask_states VALUES(?,?,?,?,?)').run(scope.occurrence_id,subtaskId,row.version,JSON.stringify(row),now);
}

/** Called only from the existing new-occurrence admission transaction, never
 * from checkpoint continuation or an idempotent trigger retry. */
export function beginSubtaskOccurrence(db:DatabaseSync,taskId:string,occurrenceId:string,now:string):void{
 if(!db.prepare('SELECT 1 FROM wb_task_occurrences WHERE task_id=? AND occurrence_id=?').get(taskId,occurrenceId))throw new Error('occurrence_not_found');
 if(subtaskOccurrence(db,taskId)===occurrenceId)return;
 db.prepare(`INSERT INTO wb_task_subtask_scope VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET occurrence_id=excluded.occurrence_id`).run(taskId,occurrenceId);
 db.prepare(`UPDATE wb_task_subtasks SET status='pending',evidence_json='[]',version=version+1,created_at=?,updated_at=? WHERE task_id=?`).run(now,now,taskId);
 for(const row of db.prepare('SELECT subtask_id FROM wb_task_subtasks WHERE task_id=?').all(taskId) as {subtask_id:string}[])recordSubtaskState(db,taskId,row.subtask_id,now);
}

export function occurrenceSubtaskRows(db:DatabaseSync,taskId:string,occurrenceId:string):Row[]{
 if(!db.prepare('SELECT 1 FROM wb_task_occurrences WHERE task_id=? AND occurrence_id=?').get(taskId,occurrenceId))throw new Error('occurrence_not_found');
 const rows=db.prepare(`SELECT s.snapshot_json FROM wb_task_subtask_states s WHERE s.occurrence_id=?
  AND NOT EXISTS(SELECT 1 FROM wb_task_subtask_states n WHERE n.occurrence_id=s.occurrence_id AND n.subtask_id=s.subtask_id AND n.version>s.version)`)
  .all(occurrenceId) as {snapshot_json:string}[];
 return rows.map(row=>JSON.parse(row.snapshot_json) as Row).sort((a,b)=>b.priority-a.priority||String(a.created_at).localeCompare(String(b.created_at))||String(a.subtask_id).localeCompare(String(b.subtask_id)));
}
