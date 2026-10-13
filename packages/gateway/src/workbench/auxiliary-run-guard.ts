import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from './service.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';

/** Freeze the existing worker identity; never acquire/renew a lease from a UI read. */
export function createAuxiliaryRunGuard(db:DatabaseSync,workbench:Pick<WorkbenchService,'assertRunActive'>,
  tasks:Pick<PersistentTaskService,'assertRunActive'>,owner:string,runId:string,now:()=>number=Date.now) {
  const native=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_runs'").get()
    ?db.prepare('SELECT root_run_id FROM wb_native_execution_runs WHERE run_id=? AND owner_id=?').get(runId,owner):undefined;
  const leaseRunId=String(native?.root_run_id??runId);
  const original=db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(leaseRunId);
  return {
    scopeKey:JSON.stringify([original?.owner??null,original?.generation??null]),
    guard:()=>{
      workbench.assertRunActive(runId);tasks.assertRunActive(runId);
      const run=db.prepare(`SELECT r.status,r.reason_code FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
        WHERE r.id=? AND c.owner_id=?`).get(runId,owner);
      if(!run||!['starting','running'].includes(String(run.status))||run.reason_code==='OUTCOME_UNKNOWN')throw new Error('budget_run_inactive');
      const lease=db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(leaseRunId);
      if(!original||!lease||lease.owner!==original.owner||lease.generation!==original.generation
        ||!Number.isFinite(Number(lease.expires_at))||Number(lease.expires_at)<=now())throw new Error('auxiliary_lease_revoked');
      const task=db.prepare(`SELECT o.occurrence_id,c.run_id AS current_run,t.status FROM wb_task_run_occurrences o
        JOIN wb_persistent_tasks t ON t.task_id=o.task_id
        LEFT JOIN wb_task_current_occurrences c ON c.occurrence_id=o.occurrence_id WHERE o.run_id=?`).get(runId);
      if(task&&(task.current_run!==runId||task.status!=='active'))throw new Error('task_generation_revoked');
    },
  };
}
