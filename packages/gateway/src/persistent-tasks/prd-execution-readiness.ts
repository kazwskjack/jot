import type {DatabaseSync} from 'node:sqlite';

const terminal=['succeeded','partial','failed','cancelled','interrupted'];
/** Shared original task execution and fee drain checks. */
export function prdExecutionReasons(db:DatabaseSync,owner:string,taskId:string){
 const installed=(name:string)=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name);
 const reasons:string[]=[];
 if(db.prepare(`SELECT 1 FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id WHERE o.task_id=?
  AND (r.reason_code='OUTCOME_UNKNOWN' OR o.status='outcome_unknown' OR r.status NOT IN (${terminal.map(()=>'?').join(',')})) LIMIT 1`).get(taskId,...terminal))reasons.push('PRD_EXECUTION_UNRESOLVED');
 // A terminal root does not close an already reserved native child. Only the
 // original trusted abort/closure receipts can establish its quiescence.
 if(installed('wb_native_child_reservations')&&db.prepare(`SELECT 1 FROM wb_native_child_reservations q
  LEFT JOIN wb_native_creation_aborts a ON a.reservation_id=q.reservation_id LEFT JOIN wb_native_child_closures c ON c.reservation_id=q.reservation_id
  WHERE q.task_id=? AND q.owner_id=? AND a.reservation_id IS NULL AND c.reservation_id IS NULL LIMIT 1`).get(taskId,owner))reasons.push('PRD_EXECUTION_UNRESOLVED');
 if(installed('wb_native_execution_runs')&&db.prepare(`SELECT 1 FROM wb_native_execution_runs n
  JOIN ga_runs r ON r.id=n.run_id LEFT JOIN wb_native_execution_closures c ON c.run_id=n.run_id WHERE n.task_id=? AND n.owner_id=?
  AND (c.run_id IS NULL OR r.reason_code='OUTCOME_UNKNOWN' OR r.status NOT IN (${terminal.map(()=>'?').join(',')})) LIMIT 1`).get(taskId,owner,...terminal))reasons.push('PRD_EXECUTION_UNRESOLVED');
 if(installed('wb_task_auxiliary_runs')&&db.prepare(`SELECT 1 FROM wb_task_auxiliary_runs a JOIN ga_runs r ON r.id=a.run_id
  WHERE a.task_id=? AND a.owner_id=? AND (r.reason_code='OUTCOME_UNKNOWN' OR r.status NOT IN (${terminal.map(()=>'?').join(',')})) LIMIT 1`).get(taskId,owner,...terminal))reasons.push('PRD_EXECUTION_UNRESOLVED');
 const runs=['wb_task_run_occurrences','wb_native_execution_runs','wb_task_auxiliary_runs'].filter(installed).map(name=>`SELECT run_id,task_id FROM ${name}`).join(' UNION ALL ');
 if(installed('wb_model_budget_attempts')){
  if(db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN (${runs}) o ON o.run_id=a.run_id WHERE o.task_id=? AND a.state IN ('reserved','in_flight','unknown') LIMIT 1`).get(taskId))reasons.push('PRD_BUDGET_UNRESOLVED');
 }
 if(installed('ga_web_operation_cursors')&&db.prepare(`SELECT 1 FROM ga_web_operation_cursors c JOIN (${runs}) o ON o.run_id=c.run_id WHERE o.task_id=?
  AND (c.last_status IS NULL OR c.last_status NOT IN ('succeeded','partial','failed','cancelled') OR c.items_settled<>1) LIMIT 1`).get(taskId))reasons.push('PRD_EXECUTION_UNRESOLVED');
 return [...new Set(reasons)];
}
