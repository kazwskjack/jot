import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {TaskExecutionEvidence} from '../persistent-tasks/execution-evidence.ts';
import {taskDependencyReasons,assertDependencyReasons} from '../persistent-tasks/execution-eligibility.ts';
import type {WorkbenchService} from './service.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';
import type {TaskCollaborationService} from './task-collaboration.ts';
type Input={request_id:string;subtask_id:string;expected_subtask_version:number;recipient_agent_id:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export type NativeTaskAssignment={task_id:string;occurrence_id:string;subtask_id:string;subtask_version:number;title:string;acceptance:string;dependencies:string[]};
export function assertNativeTaskAssignment(db:DatabaseSync,owner:string,assignment:NativeTaskAssignment){
 const step=db.prepare(`SELECT s.version,s.status,s.dependencies_json FROM wb_task_subtasks s JOIN wb_persistent_tasks t ON t.task_id=s.task_id
   WHERE t.owner_id=? AND s.task_id=? AND s.subtask_id=?`).get(owner,assignment.task_id,assignment.subtask_id) as {version:number;status:string;dependencies_json:string}|undefined;
 if(!step||step.version!==assignment.subtask_version||step.status!=='running')throw new Error('task_assignment_revoked');
 assertDependencyReasons(taskDependencyReasons(db,new TaskExecutionEvidence(db),owner,assignment.task_id,JSON.parse(step.dependencies_json),assignment.occurrence_id));
 return assignment;
}
/** Planning journal only. No child admission, mailbox dispatch or completion. */
export class NativeTaskIntents {
 private db:DatabaseSync;private workbench:WorkbenchService;private tasks:PersistentTaskService;private collaboration:TaskCollaborationService;
 constructor(db:DatabaseSync,workbench:WorkbenchService,tasks:PersistentTaskService,collaboration:TaskCollaborationService){
  this.db=db;this.workbench=workbench;this.tasks=tasks;this.collaboration=collaboration;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_native_task_intents(
    owner_id TEXT NOT NULL,root_run_id TEXT NOT NULL REFERENCES ga_runs(id),request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,plan_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,root_run_id,request_id));
    CREATE TRIGGER IF NOT EXISTS wb_native_task_intent_no_update BEFORE UPDATE ON wb_native_task_intents BEGIN SELECT RAISE(ABORT,'native_task_intent_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_native_task_intent_no_delete BEFORE DELETE ON wb_native_task_intents BEGIN SELECT RAISE(ABORT,'native_task_intent_immutable'); END;`);
 }
 prepare(owner:string,runId:string,input:Input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['request_id','subtask_id','expected_subtask_version','recipient_agent_id'].includes(k))
    ||['request_id','subtask_id','recipient_agent_id'].some(k=>typeof input[k as keyof Input]!=='string'||!ID.test(String(input[k as keyof Input])))
    ||!Number.isSafeInteger(input.expected_subtask_version)||input.expected_subtask_version<1)throw new Error('native_task_intent_invalid');
  return withImmediateTransaction(this.db,()=>{
   const context=this.workbench.contextForRun(runId);
   if(!context||context.owner_id!==owner||context.kind!=='task')throw new Error('task_collaboration_forbidden');
   const current=this.db.prepare('SELECT task_id,occurrence_id FROM wb_task_current_occurrences WHERE run_id=?').get(runId) as {task_id:string;occurrence_id:string}|undefined;
   if(!current)throw new Error('task_execution_revoked');
   const prior=this.db.prepare('SELECT input_hash,plan_json FROM wb_native_task_intents WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,runId,input.request_id) as {input_hash:string;plan_json:string}|undefined;
   const policy=this.collaboration.get(owner,current.task_id),saved=prior?JSON.parse(prior.plan_json):undefined;
   this.collaboration.authorizeNativeMember(owner,runId,input.recipient_agent_id,saved?.expected_policy_version??policy.version);
   if(!this.db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,runId))throw new Error('budget_service_unavailable');
   const digest=createHash('sha256').update(JSON.stringify([input.request_id,input.subtask_id,input.expected_subtask_version,input.recipient_agent_id])).digest('hex');
   if(prior&&prior.input_hash!==digest)throw new Error('idempotency_conflict');
   const step=this.tasks.subtasks(owner,current.task_id).items.find(s=>s.subtask_id===input.subtask_id);
   const bound=prior&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_reservations'").get()&&this.db.prepare('SELECT snapshot_json FROM wb_native_child_reservations WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,runId,input.request_id) as {snapshot_json:string}|undefined;
   if(bound){const reservation=JSON.parse(bound.snapshot_json);
     if(reservation.role_id!==input.recipient_agent_id||reservation.task_assignment?.subtask_id!==input.subtask_id)throw new Error('task_assignment_revoked');
     assertNativeTaskAssignment(this.db,owner,reservation.task_assignment);return saved;}
   if(!step||step.version!==input.expected_subtask_version||!['pending','blocked'].includes(step.status))throw new Error('task_assignment_revoked');
   if(saved)return saved;
   const role=this.workbench.getAgent(owner,input.recipient_agent_id);
   const plan={protocol:1,request_id:input.request_id,role_ref:role.agent_id,expected_policy_version:policy.version,
     task_id:current.task_id,occurrence_id:current.occurrence_id,subtask_id:step.subtask_id,expected_subtask_version:step.version,
     dependencies:step.dependencies,name:role.name,description:`Task member: ${role.name}`,
     text:`Execute the assigned step: ${step.title}\nAcceptance: ${step.acceptance}\nReturn materials, source references and remaining limitations to the lead. Do not declare the parent task complete, delegate more members or expand authorization.`,execution_authorized:false};
   this.db.prepare('INSERT INTO wb_native_task_intents VALUES(?,?,?,?,?,?)').run(owner,runId,input.request_id,digest,JSON.stringify(plan),new Date().toISOString());
   return plan;
  });
 }
 /** Read the existing immutable journal under the current original authority.
  * A pending row is a scheduling hint, never child/model execution permission. */
 list(owner:string,runId:string,input:{limit?:number;after_request_id?:string}={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['limit','after_request_id'].includes(k))
    ||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>50)
    ||input.after_request_id!==undefined&&(typeof input.after_request_id!=='string'||!ID.test(input.after_request_id)))throw Error('native_task_intent_invalid');
  return withImmediateTransaction(this.db,()=>{
   const context=this.workbench.contextForRun(runId);
   if(!context||context.owner_id!==owner||context.kind!=='task')throw Error('task_collaboration_forbidden');
   this.workbench.assertRunActive(runId);this.tasks.assertRunActive(runId);
   const current=this.db.prepare('SELECT task_id,occurrence_id FROM wb_task_current_occurrences WHERE run_id=?').get(runId) as {task_id:string;occurrence_id:string}|undefined;
   if(!current||!this.db.prepare("SELECT 1 FROM ga_runs WHERE id=? AND status IN ('starting','running')").get(runId))throw Error('task_execution_revoked');
   if(!this.collaboration.get(owner,current.task_id).enabled)throw Error('task_collaboration_revoked');
   if(!this.db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,runId))throw Error('budget_service_unavailable');
   const after=input.after_request_id===undefined?undefined:this.db.prepare('SELECT created_at,request_id FROM wb_native_task_intents WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,runId,input.after_request_id) as {created_at:string;request_id:string}|undefined;
   if(input.after_request_id!==undefined&&!after)throw Error('native_task_intent_invalid');
   const limit=input.limit??20;
   const rows=this.db.prepare(`SELECT request_id,plan_json FROM wb_native_task_intents WHERE owner_id=? AND root_run_id=?
     ${after?'AND (created_at>? OR (created_at=? AND request_id>?))':''} ORDER BY created_at,request_id LIMIT ?`)
     .all(owner,runId,...(after?[after.created_at,after.created_at,after.request_id]:[]),limit+1) as {request_id:string;plan_json:string}[];
   const hasReservations=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_reservations'").get();
   const items=rows.slice(0,limit).map(row=>{
    const plan=JSON.parse(row.plan_json);
    if(plan.task_id!==current.task_id||plan.occurrence_id!==current.occurrence_id||plan.request_id!==row.request_id||plan.execution_authorized!==false)throw Error('task_assignment_revoked');
    this.collaboration.authorizeNativeMember(owner,runId,plan.role_ref,plan.expected_policy_version);
    const reserved=hasReservations&&!!this.db.prepare('SELECT 1 FROM wb_native_child_reservations WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,runId,row.request_id);
    if(!reserved){const step=this.tasks.subtasks(owner,current.task_id).items.find(s=>s.subtask_id===plan.subtask_id);
     if(!step||step.version!==plan.expected_subtask_version||!['pending','blocked'].includes(step.status))throw Error('task_assignment_revoked');}
    return {plan,state:reserved?'reserved':'pending',execution_authorized:false};
   });
   return {items,next_request_id:rows.length>limit?rows[limit-1]!.request_id:null};
  });
 }
 bind(owner:string,runId:string,requestId:string,roleRef:string,policyVersion:number):NativeTaskAssignment|undefined{
  if(!this.db.isTransaction)throw new Error('native_assignment_transaction_required');
  const row=this.db.prepare('SELECT plan_json FROM wb_native_task_intents WHERE owner_id=? AND root_run_id=? AND request_id=?').get(owner,runId,requestId) as {plan_json:string}|undefined;
  if(!row)return;
  const plan=JSON.parse(row.plan_json);
  if(plan.role_ref!==roleRef||plan.expected_policy_version!==policyVersion)throw new Error('task_assignment_revoked');
  this.prepare(owner,runId,{request_id:requestId,subtask_id:plan.subtask_id,expected_subtask_version:plan.expected_subtask_version,recipient_agent_id:roleRef});
  const assigned=this.tasks.upsertSubtask(owner,plan.task_id,{subtask_id:plan.subtask_id,expected_version:plan.expected_subtask_version,status:'running'},runId);
  return {task_id:plan.task_id,occurrence_id:plan.occurrence_id,subtask_id:assigned.subtask_id,subtask_version:assigned.version,
    title:assigned.title,acceptance:assigned.acceptance,dependencies:assigned.dependencies};
 }

}
