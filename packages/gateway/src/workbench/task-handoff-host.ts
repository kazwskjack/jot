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
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_handoff_executions(owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL,revision INTEGER NOT NULL,run_id TEXT NOT NULL,session_ref TEXT NOT NULL,PRIMARY KEY(owner_id,root_run_id,revision));
  CREATE TRIGGER IF NOT EXISTS wb_task_handoff_execution_no_update BEFORE UPDATE ON wb_task_handoff_executions BEGIN SELECT RAISE(ABORT,'handoff_execution_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_handoff_execution_no_delete BEFORE DELETE ON wb_task_handoff_executions BEGIN SELECT RAISE(ABORT,'handoff_execution_immutable'); END;`);
 type Execution={expected_revision:number;run_id:string;session_ref:string};
 const execution=(input:Execution,bind=false)=>withImmediateTransaction(db,()=>{
  if(!input||Object.keys(input).some(k=>!['expected_revision','run_id','session_ref'].includes(k))||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||typeof input.run_id!=='string'||typeof input.session_ref!=='string')throw new Error('handoff_execution_forbidden');
  const state=control.get(owner,rootRun);if(state.revision!==input.expected_revision)throw new Error('handoff_revision_conflict');if(state.phase!=='active')throw new Error('handoff_closed');
  const ctx=workbench.contextForRun(input.run_id);workbench.assertRunActive(input.run_id);tasks.assertRunActive(input.run_id);assertExecutionLease(db,input.run_id,lease);
  const session=db.prepare(`SELECT 1 FROM ga_harness_session_bindings b JOIN ga_runs r ON r.conversation_id=b.conversation_id WHERE r.id=? AND b.owner_id=? AND b.session_id=?`).get(input.run_id,owner,input.session_ref);
  if(!ctx||!session||ctx.owner_id!==owner||ctx.agent_id!==state.controller)throw new Error('handoff_execution_forbidden');
  if(input.run_id!==rootRun){const child=db.prepare('SELECT root_run_id,owner_id,child_session_ref FROM wb_native_execution_runs WHERE run_id=?').get(input.run_id);if(!child||ctx.kind!=='native_team'||child.root_run_id!==rootRun||child.owner_id!==owner||child.child_session_ref!==input.session_ref)throw new Error('handoff_execution_forbidden');}
  else if(ctx.kind!=='task')throw new Error('handoff_execution_forbidden');
  const prior=db.prepare('SELECT run_id,session_ref FROM wb_task_handoff_executions WHERE owner_id=? AND root_run_id=? AND revision=?').get(owner,rootRun,state.revision) as {run_id:string;session_ref:string}|undefined;
  if(prior&&(prior.run_id!==input.run_id||prior.session_ref!==input.session_ref))throw new Error('handoff_execution_conflict');
  if(!prior&&!bind)throw new Error('handoff_execution_unbound');
  if(!prior)db.prepare('INSERT INTO wb_task_handoff_executions VALUES(?,?,?,?,?)').run(owner,rootRun,state.revision,input.run_id,input.session_ref);
  return {revision:state.revision,run_id:input.run_id,session_ref:input.session_ref};
 });
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
  bindExecution:(input:Execution)=>execution(input,true),
  assertExecution:(input:Execution)=>execution(input),
 });
}
