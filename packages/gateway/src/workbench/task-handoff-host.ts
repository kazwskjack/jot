import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {WorkbenchService} from './service.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';
import type {TaskCollaborationService} from './task-collaboration.ts';
import type {ModelBudgetLedger} from './model-budget.ts';
import {normalizeExecutionLease,assertExecutionLease} from './execution-lease.ts';
import {TaskHandoffController} from './task-handoff.ts';
/** Bind management to an existing task/worker policy. This is not member
 * execution permission; concrete Session execution binding remains required. */
export function createTaskHandoffHost(options:{db:DatabaseSync;workbench:WorkbenchService;tasks:PersistentTaskService;collaboration:TaskCollaborationService;ledger:ModelBudgetLedger;owner:string;rootRun:string;policyVersion:number;executionLease:unknown;model:{provider:string;model:string}}){
 const {db,workbench,tasks,collaboration,ledger,owner,rootRun,policyVersion}=options;
 const lease=normalizeExecutionLease(options.executionLease),model=Object.freeze({...options.model});
 const authorize=(requestedOwner:string,requestedRun:string)=>{
  if(requestedOwner!==owner||requestedRun!==rootRun)throw new Error('handoff_identity_forbidden');
  assertExecutionLease(db,rootRun,lease);workbench.assertRunActive(rootRun);tasks.assertRunActive(rootRun);
  const context=workbench.contextForRun(rootRun);
  if(!context||context.owner_id!==owner||context.kind!=='task')throw new Error('handoff_identity_forbidden');
  const current=db.prepare('SELECT task_id,occurrence_id FROM wb_task_current_occurrences WHERE run_id=?').get(rootRun) as {task_id:string;occurrence_id:string}|undefined;
  if(!current)throw new Error('handoff_identity_forbidden');const policy=collaboration.get(owner,current.task_id);
  if(!policy.enabled||policy.version!==policyVersion)throw new Error('task_collaboration_revoked');
  for(const member of policy.member_ids)collaboration.authorizeNativeMember(owner,rootRun,member,policyVersion);
  if(!ledger.isBound(owner,rootRun))throw new Error('budget_binding_missing');
  return {owner,root_run:rootRun,lease_generation:lease.generation,lead:context.agent_id,members:policy.member_ids};
 };
 const control=new TaskHandoffController(db,authorize);
 const ready=()=>{
  authorize(owner,rootRun);
  const pending=db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN (
   SELECT run_id,occurrence_id FROM wb_task_run_occurrences UNION ALL SELECT run_id,occurrence_id FROM wb_native_execution_runs
   UNION ALL SELECT run_id,occurrence_id FROM wb_task_auxiliary_runs) o ON o.run_id=a.run_id
   WHERE o.occurrence_id=(SELECT occurrence_id FROM wb_task_current_occurrences WHERE run_id=?) AND a.state IN ('in_flight','unknown') LIMIT 1`).get(rootRun);
  if(pending)throw new Error('handoff_usage_unresolved');ledger.previewCall(owner,rootRun,model);
 };
 return Object.freeze({
  get:()=>control.get(owner,rootRun),
  start:(input:Parameters<TaskHandoffController['start']>[2])=>withImmediateTransaction(db,()=>{ready();return control.start(owner,rootRun,input);}),
  transfer:(input:Parameters<TaskHandoffController['transfer']>[2])=>withImmediateTransaction(db,()=>{ready();return control.transfer(owner,rootRun,input);}),
  stop:(input:Parameters<TaskHandoffController['stop']>[2])=>control.stop(owner,rootRun,input),
 });
}
