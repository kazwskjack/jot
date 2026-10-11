import type {DatabaseSync} from 'node:sqlite';
import type {TaskExecutionEvidence,ExecutionEvidence} from './execution-evidence.ts';

/** Execution budget exhaustion stops new triggers, not an admitted occurrence.
 * This lookup grants no tool authority; the Gateway guard still checks role,
 * owner, generation, policy and actual model reservation before execution. */
export function eligibleTaskOccurrence(db:DatabaseSync,owner:string,taskId:string,runId?:string):{run_id:string;occurrence_id:string}|null{
 const row=db.prepare(`SELECT o.run_id,o.occurrence_id FROM wb_task_current_occurrences o
  JOIN wb_persistent_tasks t ON t.task_id=o.task_id JOIN ga_runs r ON r.id=o.run_id
  JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=t.owner_id
  WHERE t.owner_id=? AND t.task_id=? AND t.status IN ('active','budget_exhausted') AND o.generation=t.generation
  AND o.status!='outcome_unknown' AND COALESCE(r.reason_code,'')!='OUTCOME_UNKNOWN'
  AND r.status IN ('queued','starting','running','waiting_user','waiting_approval')
  ${runId===undefined?'':'AND r.id=?'} ORDER BY o.created_at DESC LIMIT 1`).get(owner,taskId,...(runId===undefined?[]:[runId])) as {run_id:string;occurrence_id:string}|undefined;
 return row??null;
}

/** Check all prerequisite ancestors, including completed intermediate steps.
 * Results are diagnostic; this never grants role/tool or model authority. */
export function taskDependencyReasons(db:DatabaseSync,evidence:TaskExecutionEvidence,owner:string,taskId:string,dependencies:string[],occurrenceId?:string):string[]{
 const reasons:string[]=[],visited=new Set<string>(),visiting=new Set<string>();
 const visit=(id:string):void=>{
  if(visiting.has(id)){reasons.push(`dependency_cycle:${id}`);return;}
  if(visited.has(id))return;
  visiting.add(id);
  const dependency=db.prepare('SELECT status,evidence_json,dependencies_json FROM wb_task_subtasks WHERE task_id=? AND subtask_id=?').get(taskId,id) as {status:string;evidence_json:string;dependencies_json:string}|undefined;
  if(!dependency||dependency.status!=='completed')reasons.push(`dependency_not_completed:${id}`);
  else{
   const refs=JSON.parse(dependency.evidence_json) as ExecutionEvidence[];
   if(!refs.length)reasons.push(`dependency_evidence_missing:${id}`);
   else if(!evidence.completionVerified(owner,taskId,refs,occurrenceId))reasons.push(`dependency_evidence_unverified:${id}`);
  }
  if(dependency)for(const parent of JSON.parse(dependency.dependencies_json) as string[])visit(parent);
  visiting.delete(id);visited.add(id);
 };
 for(const id of dependencies)visit(id);
 return reasons;
}

export function assertDependencyReasons(reasons:string[]):void{
 if(!reasons.length)return;
 const reason=reasons[0]!.split(':')[0]!;
 throw new Error(reason==='dependency_evidence_missing'?'dependency_evidence_unverified':reason);
}

/** Revalidate dependencies of admitted work at every effect boundary. Ledger
 * repairs remain available so DSH can suspend a step and gather fresh proof. */
export function assertTaskDependenciesReady(db:DatabaseSync,evidence:TaskExecutionEvidence,owner:string,taskId:string,runId:string):void{
 const occurrence=eligibleTaskOccurrence(db,owner,taskId,runId);
 if(!occurrence)throw new Error('task_execution_revoked');
 const steps=db.prepare("SELECT dependencies_json FROM wb_task_subtasks WHERE task_id=? AND status='running'").all(taskId) as {dependencies_json:string}[];
 assertDependencyReasons(taskDependencyReasons(db,evidence,owner,taskId,steps.flatMap(step=>JSON.parse(step.dependencies_json) as string[]),occurrence.occurrence_id));
}
