import type {DatabaseSync} from 'node:sqlite';
export function installTaskMailbox(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS wb_mailbox_task_roots (
  thread_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL REFERENCES ga_runs(id),source_run_id TEXT NOT NULL REFERENCES ga_runs(id),generation INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS wb_task_auxiliary_runs (
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),thread_id TEXT NOT NULL REFERENCES wb_mailbox_task_roots(thread_id),
  owner_id TEXT NOT NULL,task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,root_run_id TEXT NOT NULL REFERENCES ga_runs(id),created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_mailbox_task_roots_no_update BEFORE UPDATE ON wb_mailbox_task_roots BEGIN SELECT RAISE(ABORT,'task_mailbox_binding_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_mailbox_task_roots_no_delete BEFORE DELETE ON wb_mailbox_task_roots BEGIN SELECT RAISE(ABORT,'task_mailbox_binding_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_task_auxiliary_runs_no_update BEFORE UPDATE ON wb_task_auxiliary_runs BEGIN SELECT RAISE(ABORT,'task_mailbox_binding_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_task_auxiliary_runs_no_delete BEFORE DELETE ON wb_task_auxiliary_runs BEGIN SELECT RAISE(ABORT,'task_mailbox_binding_immutable'); END;`);
}
export function bindTaskMailbox(db:DatabaseSync,owner:string,thread:string,sourceRun:string,sender:string):void{
 if(!db.isTransaction)throw new Error('task_mailbox_transaction_required');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_completion_candidates'").get()
  &&db.prepare('SELECT 1 FROM wb_task_completion_candidates WHERE run_id=?').get(sourceRun))throw new Error('task_mailbox_binding_invalid');
 const scope=db.prepare(`SELECT o.task_id,o.occurrence_id,o.root_run_id,o.generation FROM wb_task_current_occurrences o
  JOIN wb_persistent_tasks t ON t.task_id=o.task_id AND t.owner_id=? AND t.generation=o.generation AND t.status='active'
  JOIN wb_run_bindings b ON b.run_id=o.run_id AND b.owner_id=t.owner_id AND b.agent_id=t.agent_id AND b.kind='task'
  JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id AND a.status='active' AND a.capability_epoch=b.epoch
  JOIN ga_runs r ON r.id=o.run_id
  WHERE o.run_id=? AND b.agent_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval')`).get(owner,sourceRun,sender) as {task_id:string;occurrence_id:string;root_run_id:string;generation:number}|undefined;
 if(!scope)throw new Error('task_mailbox_binding_invalid');
 db.prepare('INSERT INTO wb_mailbox_task_roots VALUES(?,?,?,?,?,?,?,?)').run(thread,owner,scope.task_id,scope.occurrence_id,scope.root_run_id,sourceRun,scope.generation,new Date().toISOString());
}
export function currentTaskMailbox(db:DatabaseSync,owner:string,thread:string){
 const root=db.prepare('SELECT * FROM wb_mailbox_task_roots WHERE thread_id=? AND owner_id=?').get(thread,owner) as {task_id:string;occurrence_id:string;root_run_id:string;source_run_id:string;generation:number}|undefined;
 if(!root)return;
 const active=db.prepare(`SELECT 1 FROM wb_persistent_tasks t JOIN wb_task_current_occurrences o ON o.task_id=t.task_id AND o.occurrence_id=?
  JOIN ga_runs r ON r.id=o.run_id JOIN wb_run_bindings b ON b.run_id=? AND b.owner_id=t.owner_id AND b.agent_id=t.agent_id
  JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id AND a.status='active' AND a.capability_epoch=b.epoch
  WHERE t.task_id=? AND t.owner_id=? AND t.generation=? AND o.generation=t.generation AND t.status='active'
  AND o.root_run_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval')`)
  .get(root.occurrence_id,root.source_run_id,root.task_id,owner,root.generation,root.root_run_id);
 if(!active)throw new Error('task_mailbox_revoked');return root;
}

/** Count durable execution records, not UI/message status or expiring leases.
 * An unresolved side effect must never be treated as a free slot to retry. */
export function taskMemberCapacityAvailable(db:DatabaseSync,owner:string,occurrenceId:string,maximum=2):boolean {
 if(!db.isTransaction)throw new Error('task_mailbox_transaction_required');
 if(![1,2].includes(maximum))throw new Error('invalid_task_collaboration');
 const usage=db.prepare(`SELECT COUNT(*) AS n FROM wb_task_auxiliary_runs a JOIN ga_runs r ON r.id=a.run_id
   WHERE a.owner_id=? AND a.occurrence_id=? AND
   (r.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling') OR r.reason_code='OUTCOME_UNKNOWN')`)
   .get(owner,occurrenceId) as {n:number};
 return usage.n<maximum;
}
