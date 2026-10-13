import type {DatabaseSync} from 'node:sqlite';
import {assertExecutionLease,type ExecutionLease} from './execution-lease.ts';
import {assertNativeTaskAssignment,type NativeTaskAssignment} from './native-task-intents.ts';
import {assertNativeCollaborationPolicy} from './task-collaboration.ts';
export type NativeReservation={reservation_id:string;owner_id:string;root_run_id:string;task_id:string;occurrence_id:string;generation:number;
 role_id:string;role_version:number;role_epoch:number;policy_version:number;parent_session_ref:string;child_session_ref:string;
 workspace_id:string;project_id:string;execution_lease:ExecutionLease;root_budget_scope_ids:string[];task_assignment?:NativeTaskAssignment};
export function installNativeChildRuns(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_native_child_reservations(
   reservation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL REFERENCES ga_runs(id),
   task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,child_session_ref TEXT NOT NULL UNIQUE,
   request_id TEXT NOT NULL,input_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,
   UNIQUE(root_run_id,request_id));
  CREATE TRIGGER IF NOT EXISTS wb_native_child_reservation_no_update BEFORE UPDATE ON wb_native_child_reservations BEGIN SELECT RAISE(ABORT,'native_child_reservation_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_native_child_reservation_no_delete BEFORE DELETE ON wb_native_child_reservations BEGIN SELECT RAISE(ABORT,'native_child_reservation_immutable'); END;
  CREATE TABLE IF NOT EXISTS wb_native_child_runs(
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),reservation_id TEXT NOT NULL UNIQUE REFERENCES wb_native_child_reservations(reservation_id),
  owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL,task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,
  role_id TEXT NOT NULL,child_session_ref TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_native_child_run_no_update BEFORE UPDATE ON wb_native_child_runs BEGIN SELECT RAISE(ABORT,'native_child_identity_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_native_child_run_no_delete BEFORE DELETE ON wb_native_child_runs BEGIN SELECT RAISE(ABORT,'native_child_identity_immutable'); END;`);
 db.exec(`CREATE TABLE IF NOT EXISTS wb_native_child_closures(
  reservation_id TEXT PRIMARY KEY REFERENCES wb_native_child_reservations(reservation_id),run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),
  receipt_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_native_child_closure_no_update BEFORE UPDATE ON wb_native_child_closures BEGIN SELECT RAISE(ABORT,'native_child_closure_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_native_child_closure_no_delete BEFORE DELETE ON wb_native_child_closures BEGIN SELECT RAISE(ABORT,'native_child_closure_immutable'); END;`);
 db.exec(`CREATE TABLE IF NOT EXISTS wb_native_child_activations(
  run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),activation_id TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES wb_native_child_reservations(reservation_id),
  previous_run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,role_id TEXT NOT NULL,child_session_ref TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_native_activation_no_update BEFORE UPDATE ON wb_native_child_activations BEGIN SELECT RAISE(ABORT,'native_activation_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_native_activation_no_delete BEFORE DELETE ON wb_native_child_activations BEGIN SELECT RAISE(ABORT,'native_activation_immutable'); END;
  CREATE TABLE IF NOT EXISTS wb_native_activation_closures(
   run_id TEXT PRIMARY KEY REFERENCES wb_native_child_activations(run_id),receipt_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_native_activation_closure_no_update BEFORE UPDATE ON wb_native_activation_closures BEGIN SELECT RAISE(ABORT,'native_activation_closure_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_native_activation_closure_no_delete BEFORE DELETE ON wb_native_activation_closures BEGIN SELECT RAISE(ABORT,'native_activation_closure_immutable'); END;
  CREATE VIEW IF NOT EXISTS wb_native_execution_runs AS
   SELECT n.run_id,n.reservation_id,NULL AS activation_id,NULL AS previous_run_id,n.owner_id,n.root_run_id,n.task_id,n.occurrence_id,n.role_id,n.child_session_ref,q.snapshot_json,n.created_at
    FROM wb_native_child_runs n JOIN wb_native_child_reservations q ON q.reservation_id=n.reservation_id
   UNION ALL SELECT run_id,reservation_id,activation_id,previous_run_id,owner_id,root_run_id,task_id,occurrence_id,role_id,child_session_ref,snapshot_json,created_at FROM wb_native_child_activations;
  CREATE VIEW IF NOT EXISTS wb_native_execution_closures AS
   SELECT run_id,receipt_sha256,receipt_json,created_at FROM wb_native_child_closures
   UNION ALL SELECT run_id,receipt_sha256,receipt_json,created_at FROM wb_native_activation_closures;`);
}
/** Revalidate persisted identity before native preparation, model or tools.
 * Accounting closure must not call this: dispatched spend survives revocation.
 */
export function assertNativeReservation(db:DatabaseSync,owner:string,reservationId:string):NativeReservation{
 const row=db.prepare('SELECT snapshot_json FROM wb_native_child_reservations WHERE owner_id=? AND reservation_id=?').get(owner,reservationId) as {snapshot_json:string}|undefined;
 if(!row)throw new Error('workbench_identity_forbidden');
 if(db.prepare('SELECT 1 FROM wb_native_child_closures WHERE reservation_id=?').get(reservationId))throw new Error('native_child_closed');
 const saved=JSON.parse(row.snapshot_json) as NativeReservation;
 return assertNativeSnapshot(db,owner,saved);
}
/** Per-activation authority. Reading original creation identity is insufficient
 * once a durable child Session has entered more than one native activation. */
export function assertNativeRun(db:DatabaseSync,owner:string,runId:string):NativeReservation{
 const row=db.prepare('SELECT snapshot_json FROM wb_native_execution_runs WHERE owner_id=? AND run_id=?').get(owner,runId) as {snapshot_json:string}|undefined;
 if(!row)throw new Error('workbench_identity_forbidden');
 if(db.prepare('SELECT 1 FROM wb_native_execution_closures WHERE run_id=?').get(runId))throw new Error('native_child_closed');
 return assertNativeSnapshot(db,owner,JSON.parse(row.snapshot_json) as NativeReservation);
}
export function assertNativeSnapshot(db:DatabaseSync,owner:string,saved:NativeReservation):NativeReservation{
 assertNativeCollaborationPolicy(db,owner,saved.task_id,saved.policy_version,saved.role_id);
 assertExecutionLease(db,saved.root_run_id,saved.execution_lease);
 const root=db.prepare(`SELECT r.status,c.owner_id,c.workspace_id,c.project_id,b.kind,b.epoch,a.capability_epoch,a.status AS role_status,
  t.generation,t.status AS task_status,o.generation AS occurrence_generation,o.occurrence_id
  FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id
  JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id
  JOIN wb_task_current_occurrences o ON o.run_id=r.id JOIN wb_persistent_tasks t ON t.task_id=o.task_id AND t.owner_id=c.owner_id
  JOIN ga_harness_session_bindings s ON s.conversation_id=c.id AND s.owner_id=c.owner_id AND s.session_id=? WHERE r.id=?`).get(saved.parent_session_ref,saved.root_run_id) as Record<string,unknown>|undefined;
 if(!root||root.owner_id!==owner||root.kind!=='task'||!['starting','running'].includes(String(root.status))||root.role_status!=='active'||root.epoch!==root.capability_epoch
  ||root.workspace_id!==saved.workspace_id||root.project_id!==saved.project_id||root.generation!==saved.generation||root.occurrence_generation!==saved.generation
  ||root.occurrence_id!==saved.occurrence_id||!['active','budget_exhausted'].includes(String(root.task_status)))throw new Error('native_child_parent_revoked');
 const budget=db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,saved.root_run_id) as {scopes_json:string}|undefined;
 if(!budget||JSON.stringify(saved.root_budget_scope_ids)!==budget.scopes_json)throw new Error('budget_binding_invalid');
 const unresolved=db.prepare(`SELECT a.state FROM wb_model_budget_attempts a
  JOIN (SELECT run_id,occurrence_id FROM wb_task_run_occurrences UNION ALL SELECT run_id,occurrence_id FROM wb_native_execution_runs
    UNION ALL SELECT run_id,occurrence_id FROM wb_task_auxiliary_runs) o ON o.run_id=a.run_id
  WHERE o.occurrence_id=? AND (a.state='unknown' OR a.bound_exceeded=1) LIMIT 1`).get(saved.occurrence_id);
 if(unresolved)throw new Error(unresolved.state==='unknown'?'budget_usage_unknown':'model_budget_exhausted');
 if(saved.task_assignment)assertNativeTaskAssignment(db,owner,saved.task_assignment);
 return saved;
}
