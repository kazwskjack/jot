import type {DatabaseSync} from 'node:sqlite';
import {TaskExecutionEvidence,type ExecutionEvidence} from './execution-evidence.ts';

export type TaskFileScope={owner_id:string;task_id:string;occurrence_id:string;frozen_context:string;
 steps:Array<{subtask_id:string;version:number;status?:string;evidence:ExecutionEvidence[]}>};
export type TaskFileSource={receipt_id:string;run_id:string;owner_id:string;workspace_id:string;project_id:string;path:string;
 version:number;sha256:string;size:number;conversation_id:string;native:boolean};

/** One receipt, exact step evidence and actual write/version lineage. No file
 * access or publication authority follows from a native run ID alone. */
export function taskFileSource(db:DatabaseSync,scope:TaskFileScope,receiptId:string,targetRunId:string):TaskFileSource|undefined{
 const context=JSON.parse(scope.frozen_context) as {workspace_id:string;project_id:string};
 const source=db.prepare(`SELECT e.*,b.kind,b.context_json,r.conversation_id FROM wb_task_file_execution_receipts e
  JOIN wb_task_execution_receipts proof ON proof.receipt_id=e.receipt_id AND proof.run_id=e.run_id AND proof.operation='files.write'
  JOIN wb_file_write_runs w ON w.run_id=e.run_id AND w.owner_id=e.owner_id AND w.workspace_id=e.workspace_id AND w.project_id=e.project_id
   AND w.path=e.path AND w.version=e.version AND w.sha256=e.sha256 AND w.size=e.size
  JOIN wb_file_versions v ON v.owner_id=e.owner_id AND v.workspace_id=e.workspace_id AND v.project_id=e.project_id
   AND v.path=e.path AND v.version=e.version AND v.sha256=e.sha256 AND v.size=e.size
  JOIN wb_run_bindings b ON b.run_id=e.run_id AND b.owner_id=e.owner_id
  JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=e.owner_id
  WHERE e.receipt_id=? AND e.owner_id=? AND e.workspace_id=? AND e.project_id=?
   AND c.workspace_id=e.workspace_id AND c.project_id=e.project_id
   AND json_extract(b.context_json,'$.workspace_id')=e.workspace_id AND json_extract(b.context_json,'$.project_id')=e.project_id`)
  .get(receiptId,scope.owner_id,context.workspace_id,context.project_id) as (TaskFileSource&{kind:string;context_json:string})|undefined;
 if(!source)return;
 const target=db.prepare(`SELECT o.root_run_id,r.conversation_id FROM wb_task_run_occurrences o
  JOIN wb_persistent_tasks t ON t.task_id=o.task_id JOIN ga_runs r ON r.id=o.run_id
  JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=t.owner_id
  WHERE o.run_id=? AND o.task_id=? AND o.occurrence_id=? AND t.owner_id=? AND c.workspace_id=? AND c.project_id=?`)
  .get(targetRunId,scope.task_id,scope.occurrence_id,scope.owner_id,context.workspace_id,context.project_id) as {root_run_id:string;conversation_id:string}|undefined;
 if(!target)return;
 const references=scope.steps.flatMap(step=>step.evidence.filter(ref=>ref.kind==='tool_receipt'&&ref.reference===receiptId).map(ref=>({step,ref})));
 if(!references.length)return;
 const evidence=new TaskExecutionEvidence(db);
 if(references.some(({step,ref})=>!evidence.completionVerified(scope.owner_id,scope.task_id,[ref],scope.occurrence_id,step.subtask_id)))return;
 if(source.kind==='task'){
  if(source.conversation_id!==target.conversation_id||!db.prepare('SELECT 1 FROM wb_task_run_occurrences WHERE run_id=? AND task_id=? AND occurrence_id=? AND root_run_id=?').get(source.run_id,scope.task_id,scope.occurrence_id,target.root_run_id))return;
 }else if(source.kind==='native_team'){
  const native=db.prepare(`SELECT n.snapshot_json FROM wb_native_execution_runs n
   JOIN wb_task_run_occurrences p ON p.run_id=n.root_run_id
   JOIN ga_runs parent ON parent.id=p.run_id JOIN ga_conversations c ON c.id=parent.conversation_id AND c.owner_id=n.owner_id
   JOIN wb_native_execution_closures closed ON closed.run_id=n.run_id
   WHERE n.run_id=? AND n.owner_id=? AND n.task_id=? AND n.occurrence_id=?
    AND p.task_id=n.task_id AND p.occurrence_id=n.occurrence_id AND p.root_run_id=? AND c.id=?`)
   .get(source.run_id,scope.owner_id,scope.task_id,scope.occurrence_id,target.root_run_id,target.conversation_id) as {snapshot_json:string}|undefined;
  if(!native)return;const assignment=JSON.parse(native.snapshot_json).task_assignment;
  if(!assignment||references.some(({step})=>step.subtask_id!==assignment.subtask_id||!Number.isSafeInteger(step.version)||step.version<=assignment.subtask_version))return;
 }else return;
 const {kind,context_json,...file}=source;return {...file,conversation_id:target.conversation_id,native:kind==='native_team'};
}
