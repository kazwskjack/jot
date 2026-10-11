import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {occurrenceSubtaskRows} from './subtask-state.ts';
import {TaskExecutionEvidence} from './execution-evidence.ts';
import {assertDependencyReasons,taskDependencyReasons} from './execution-eligibility.ts';
import {verifyTaskOutputContent} from './output-content.ts';
import {freezeGeneratedOutputs,type GeneratedOutput} from './generated-output-content.ts';

export type TaskCompletionCandidate={text:string;blocks?:Array<{kind:'text'|'reasoning';text:string}>;
 artifact_refs?:string[];presented_files?:Array<{path:string;description?:string}>};
type CompletionScope={owner_id:string;task_id:string;objective:string;task_version:number;generation:number;
 occurrence_id:string;root_run_id:string;checkpoint_id:string;run_version:number;agent_id:string;frozen_context:string;epoch:number;
 goal_id:string;goal_revision:number;turn_end_seq:number;seq_exclusive:number};
type FileOutput={path:string;verified:boolean;content_verified?:true;version?:number;sha256?:string;size?:number;receipt_id?:string};

function fileOutputs(db:DatabaseSync,snapshot:ReturnType<typeof completionSnapshot>,files:Array<{path:string}>,runId:string,pinned?:FileOutput[]):FileOutput[]{
 if(files.length>100)throw new Error('task_completion_candidate_invalid');
 const context=JSON.parse(snapshot.frozen_context) as {workspace_id:string;project_id:string};
 const references=new Set(snapshot.steps.flatMap(step=>step.evidence as Array<{kind:string;reference:string}>).filter(ref=>ref.kind==='tool_receipt').map(ref=>ref.reference));
 return files.map((file,index)=>{
  if(!file||typeof file.path!=='string'||!file.path.length||file.path.length>1000)throw new Error('task_completion_candidate_invalid');
  const prior=pinned?.[index];
  if(pinned&&(!prior||prior.path!==file.path))throw new Error('task_completion_state_conflict');
  if(prior?.verified===false)return prior;
  const rows=db.prepare(`SELECT e.receipt_id,e.version,e.sha256,e.size FROM wb_task_file_execution_receipts e
    JOIN wb_task_execution_receipts r ON r.receipt_id=e.receipt_id AND r.run_id=e.run_id AND r.operation='files.write'
    JOIN wb_task_run_occurrences o ON o.run_id=e.run_id
    JOIN wb_file_write_runs w ON w.run_id=e.run_id AND w.path=e.path AND w.version=e.version
      AND w.owner_id=e.owner_id AND w.workspace_id=e.workspace_id AND w.project_id=e.project_id AND w.sha256=e.sha256 AND w.size=e.size
    JOIN wb_file_versions v ON v.owner_id=e.owner_id AND v.workspace_id=e.workspace_id AND v.project_id=e.project_id
      AND v.path=e.path AND v.version=e.version AND v.sha256=e.sha256 AND v.size=e.size
    WHERE o.task_id=? AND o.occurrence_id=? AND e.owner_id=? AND e.workspace_id=? AND e.project_id=? AND e.path=?
    ORDER BY e.version DESC,e.receipt_id`).all(snapshot.task_id,snapshot.occurrence_id,snapshot.owner_id,context.workspace_id,context.project_id,file.path) as Array<{receipt_id:string;version:number;sha256:string;size:number}>;
  const row=rows.find(row=>references.has(row.receipt_id)&&(!prior||row.receipt_id===prior.receipt_id));
  if(!row){if(prior?.verified)throw new Error('task_completion_state_conflict');return {path:file.path,verified:false};}
  verifyTaskOutputContent(db,{owner:snapshot.owner_id,workspace:context.workspace_id,project:context.project_id,path:file.path,version:row.version,runId},row);
  const output={path:file.path,verified:true,content_verified:true as const,...row};
  if(prior&&canonicalJson(output)!==canonicalJson(prior))throw new Error('task_completion_state_conflict');
  return output;
 });
}

export function installTaskCompletionCandidates(db:DatabaseSync):void {
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_completion_candidates (
  candidate_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),
  occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),
  proposal_id TEXT NOT NULL REFERENCES wb_task_goal_proposals(proposal_id),
  checkpoint_id TEXT NOT NULL REFERENCES ga_session_checkpoints(checkpoint_id),
  snapshot_json TEXT NOT NULL,candidate_json TEXT NOT NULL,candidate_hash TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS wb_task_completion_candidates_no_update BEFORE UPDATE ON wb_task_completion_candidates
   BEGIN SELECT RAISE(ABORT,'task_completion_candidate_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_completion_candidates_no_delete BEFORE DELETE ON wb_task_completion_candidates
   BEGIN SELECT RAISE(ABORT,'task_completion_candidate_immutable'); END;`);
}

function completionSnapshot(db:DatabaseSync,runId:string) {
 const scope=db.prepare(`SELECT c.owner_id,t.task_id,t.objective,t.version AS task_version,t.generation,
  o.occurrence_id,o.root_run_id,r.checkpoint_id,r.version AS run_version,b.agent_id,b.context_json AS frozen_context,b.epoch,
  cp.goal_id,cp.goal_revision,cp.turn_end_seq,cp.seq_exclusive
  FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
  JOIN wb_task_current_occurrences o ON o.run_id=r.id
  JOIN wb_persistent_tasks t ON t.task_id=o.task_id AND t.owner_id=c.owner_id AND t.generation=o.generation
  JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='task'
  JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id AND a.status='active' AND a.capability_epoch=b.epoch
  JOIN ga_session_checkpoints cp ON cp.checkpoint_id=r.checkpoint_id AND cp.run_id=r.id AND cp.conversation_id=c.id
  JOIN ga_harness_session_bindings s ON s.conversation_id=c.id AND s.owner_id=c.owner_id AND s.session_id=cp.session_ref
  JOIN wb_native_goal_bindings g ON g.run_id=o.root_run_id AND g.occurrence_id=o.occurrence_id
   AND g.goal_id=cp.goal_id AND g.goal_revision=cp.goal_revision
  WHERE r.id=? AND r.status='waiting_approval' AND t.status IN ('active','budget_exhausted')`).get(runId) as CompletionScope|undefined;
 if(!scope)throw new Error('task_completion_state_conflict');
 const occurrenceRuns=`(SELECT run_id,occurrence_id FROM wb_task_run_occurrences UNION ALL SELECT run_id,occurrence_id FROM wb_task_auxiliary_runs)`;
 if(db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN ${occurrenceRuns} o ON o.run_id=a.run_id
  WHERE o.occurrence_id=? AND (a.state IN ('reserved','unknown','in_flight') OR a.bound_exceeded=1) LIMIT 1`).get(scope.occurrence_id!))throw new Error('budget_usage_unknown');
 if(db.prepare(`SELECT 1 FROM wb_mailbox_task_roots t JOIN wb_agent_messages m ON m.thread_id=t.thread_id
  WHERE t.occurrence_id=? AND (m.status IN ('processing','outcome_unknown') OR (m.status='pending' AND m.auto_reply=1)) LIMIT 1`).get(scope.occurrence_id!))throw new Error('task_auxiliary_pending');
 const proof=new TaskExecutionEvidence(db),steps=occurrenceSubtaskRows(db,String(scope.task_id),String(scope.occurrence_id));
 if(!steps.length||steps.some(step=>step.status!=='completed'||!proof.completionVerified(String(scope.owner_id),String(scope.task_id),JSON.parse(step.evidence_json),String(scope.occurrence_id))))throw new Error('task_completion_evidence_required');
 assertDependencyReasons(taskDependencyReasons(db,proof,String(scope.owner_id),String(scope.task_id),steps.flatMap(step=>JSON.parse(step.dependencies_json) as string[]),String(scope.occurrence_id)));
 // Bind this occurrence's exact receipt set, including auxiliary calls and
 // inherited parent runs. Other tasks' shared scope balances must not make a
 // valid result stale. A later reconciled receipt requires a new review.
 const budget_attempts=db.prepare(`SELECT a.run_id,a.attempt_id,a.request_json,a.route_json,a.state,
  a.held_tokens,a.held_nano_usd,a.usage_json,a.actual_tokens,a.actual_nano_usd,a.bound_exceeded
  FROM wb_model_budget_attempts a JOIN ${occurrenceRuns} o ON o.run_id=a.run_id
  WHERE o.occurrence_id=? ORDER BY a.run_id,a.attempt_id`).all(scope.occurrence_id);
 return {...scope,budget_attempts,steps:steps.map(step=>({subtask_id:String(step.subtask_id),version:Number(step.version),title:String(step.title),
  acceptance:String(step.acceptance),status:String(step.status),dependencies:JSON.parse(step.dependencies_json) as string[],
  evidence:JSON.parse(step.evidence_json),business_verdict:'unreviewed' as const}))};
}

/** Freeze only after the existing stop/checkpoint transaction has proved
 * quiescence. Operation receipts remain unreviewed business evidence. */
export function freezeTaskCompletionCandidate(db:DatabaseSync,runId:string,candidate:TaskCompletionCandidate):string|undefined {
 if(!db.isTransaction)throw new Error('task_completion_state_conflict');
 const proposal=db.prepare('SELECT * FROM wb_task_goal_proposals WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId) as Record<string,string|number>|undefined;
 if(!proposal||proposal.intent!=='complete')return;
 if(!candidate||typeof candidate.text!=='string'||!candidate.text.trim())throw new Error('task_completion_candidate_invalid');
 const snapshot=completionSnapshot(db,runId);
 const proposed=JSON.parse(String(proposal.snapshot_json)) as Record<string,unknown>;
 const steps=snapshot.steps.map(({subtask_id,version,acceptance,status,evidence})=>({subtask_id,version,acceptance,status,evidence}));
 if(snapshot.occurrence_id!==proposal.occurrence_id||snapshot.goal_id!==proposal.goal_id
  ||Number(snapshot.goal_revision)<Number(proposal.goal_revision)||snapshot.objective!==proposed.objective
  ||snapshot.task_version!==proposed.task_version||snapshot.generation!==proposed.generation
  ||canonicalJson(steps)!==canonicalJson(proposed.steps))throw new Error('task_completion_state_conflict');
 const value={...candidate,text:candidate.text.trim()},candidateJson=canonicalJson(value);
 const candidateHash=createHash('sha256').update(candidateJson).digest('hex');
 const prior=db.prepare('SELECT candidate_id,candidate_hash,snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(runId) as {candidate_id:string;candidate_hash:string;snapshot_json:string}|undefined;
 const artifactOutputs=candidate.artifact_refs?.length?freezeGeneratedOutputs(db,snapshot,runId,candidate.artifact_refs):undefined;
 const snapshotJson=canonicalJson({...snapshot,...(candidate.presented_files?.length?{file_outputs:fileOutputs(db,snapshot,candidate.presented_files,runId)}:{}),
  ...(artifactOutputs?{artifact_outputs:artifactOutputs}:{})});
 if(prior){if(prior.candidate_hash!==candidateHash||prior.snapshot_json!==snapshotJson)throw new Error('task_completion_state_conflict');return prior.candidate_id;}
 const id=`task-candidate-${randomUUID()}`;
 // Keep source bytes through the existing seven-day owner review window.
 // Reads of a frozen candidate never renew retention or change authority.
 const stamp=new Date().toISOString(),expires=new Date(Date.now()+7*86400000+60000).toISOString();
 for(const output of artifactOutputs??[])if(output.verified)db.prepare('INSERT INTO ga_artifact_leases(artifact_id,lease_id,expires_at,created_at) VALUES(?,?,?,?)')
  .run(output.artifact_id!,`task-review:${runId}`,expires,stamp);
 db.prepare('INSERT INTO wb_task_completion_candidates VALUES(?,?,?,?,?,?,?,?,?)').run(id,runId,snapshot.occurrence_id!,String(proposal.proposal_id),String(snapshot.checkpoint_id),snapshotJson,candidateJson,candidateHash,new Date().toISOString());
 return id;
}

/** Internal evidence read for the subsequent owner review path. This does not
 * issue a certificate or authorize final publication. */
export function currentTaskCompletionCandidate(db:DatabaseSync,owner:string,runId:string) {
 const row=db.prepare(`SELECT f.* FROM wb_task_completion_candidates f JOIN ga_runs r ON r.id=f.run_id
  JOIN ga_conversations c ON c.id=r.conversation_id WHERE f.run_id=? AND c.owner_id=?`).get(runId,owner) as Record<string,string>|undefined;
 if(!row)throw new Error('task_completion_candidate_not_found');
 const current=completionSnapshot(db,runId),candidate=JSON.parse(row.candidate_json!) as TaskCompletionCandidate;
 const saved=JSON.parse(row.snapshot_json!) as {file_outputs?:FileOutput[];artifact_outputs?:GeneratedOutput[]};
 // Never backfill an old frozen candidate from today's latest file metadata.
 if(candidate.presented_files?.length&&!saved.file_outputs)throw new Error('task_completion_state_conflict');
 if(candidate.artifact_refs?.length&&!saved.artifact_outputs)throw new Error('task_completion_state_conflict');
 const snapshot={...current,...(candidate.presented_files?.length?{file_outputs:fileOutputs(db,current,candidate.presented_files,runId,saved.file_outputs)}:{}),
  ...(candidate.artifact_refs?.length?{artifact_outputs:freezeGeneratedOutputs(db,current,runId,candidate.artifact_refs,saved.artifact_outputs)}:{})};
 if(row.snapshot_json!==canonicalJson(snapshot)||row.candidate_hash!==createHash('sha256').update(row.candidate_json!).digest('hex'))throw new Error('task_completion_state_conflict');
 return {candidate_id:row.candidate_id!,snapshot,candidate};
}
