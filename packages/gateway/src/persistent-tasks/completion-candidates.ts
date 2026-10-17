import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {DiscoveryPlanning} from '../always-on/planning.ts';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {occurrenceSubtaskRows} from './subtask-state.ts';
import {TaskExecutionEvidence} from './execution-evidence.ts';
import {assertDependencyReasons,taskDependencyReasons} from './execution-eligibility.ts';
import {verifyTaskOutputContent} from './output-content.ts';
import {freezeGeneratedOutputs,type GeneratedOutput} from './generated-output-content.ts';
import {taskFileSource,type TaskFileScope,type TaskFileSource,type TaskFileLocation} from './task-file-source.ts';

export type TaskCompletionCandidate={text:string;blocks?:Array<{kind:'text'|'reasoning';text:string}>;
 artifact_refs?:string[];presented_files?:Array<{path:string;description?:string}>;workspace_files?:Array<{path:string;description?:string}>};
type CompletionScope={owner_id:string;task_id:string;objective:string;task_version:number;generation:number;
 occurrence_id:string;root_run_id:string;checkpoint_id:string;run_version:number;agent_id:string;frozen_context:string;epoch:number;
 goal_id:string;goal_revision:number;turn_end_seq:number;seq_exclusive:number};
type FileOutput={path:string;verified:false}|(TaskFileLocation&{path:string;verified:true;content_verified:true;version:number;sha256:string;size:number;receipt_id:string});
// Legacy pins are accepted only after resolving their exact original shared proof.
type LegacyFileOutput=FileOutput|{path:string;verified:true;content_verified:true;version:number;sha256:string;size:number;receipt_id:string;source?:undefined};
export type TaskCompletionWorkScope=Pick<CompletionScope,'owner_id'|'task_id'|'occurrence_id'|'root_run_id'|'frozen_context'>&{runId:string};
const workEvidenceReaders=new WeakMap<DatabaseSync,(scope:TaskCompletionWorkScope)=>unknown>();
export function configureTaskCompletionWorkEvidence(db:DatabaseSync,reader:(scope:TaskCompletionWorkScope)=>unknown):void{
 if(workEvidenceReaders.has(db))throw new Error('task_completion_work_evidence_already_configured');
 workEvidenceReaders.set(db,reader);
}
type PresentedFile={path:string;description?:string};
type FileScope=TaskFileScope;

export function validateProposedFiles(value:unknown):PresentedFile[]{
 if(!Array.isArray(value)||!value.length||value.length>8||new Set(value.map(file=>file?.path)).size!==value.length
  ||!value.every(file=>file&&typeof file==='object'&&!Array.isArray(file)&&Object.keys(file).every(key=>['path','description'].includes(key))
   &&typeof file.path==='string'&&file.path.length>0&&file.path.length<=400&&!/[\\:\u0000-\u001f\u007f]/.test(file.path)
   &&file.path===file.path.trim()&&file.path.split('/').every((part:string)=>part&&!part.startsWith('.')&&!/[. ]$|[<>"|?*]/.test(part)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
   &&(file.description===undefined||typeof file.description==='string'&&file.description.length<=1000)))throw new Error('invalid_goal_files');
 return structuredClone(value) as PresentedFile[];
}

/** Pin real occurrence-owned versions before the native Goal pauses. */
export function prepareTaskPresentedFiles(db:DatabaseSync,scope:FileScope,value:unknown,runId:string){
 if(!db.isTransaction)throw new Error('task_completion_state_conflict');
 const workspace_files=validateProposedFiles(value),workspace_file_outputs=fileOutputs(db,scope,workspace_files,runId);
 if(workspace_file_outputs.some(output=>!output.verified))throw new Error('task_completion_evidence_required');
 return {workspace_files,workspace_file_outputs};
}

function fileOutputs(db:DatabaseSync,snapshot:FileScope,files:Array<{path:string}>,runId:string,pinned?:LegacyFileOutput[]):LegacyFileOutput[]{
 if(files.length>100)throw new Error('task_completion_candidate_invalid');
 const context=JSON.parse(snapshot.frozen_context) as {workspace_id:string;project_id:string};
 const references=new Set(snapshot.steps.flatMap(step=>step.evidence as Array<{kind:string;reference:string}>).filter(ref=>ref.kind==='tool_receipt').map(ref=>ref.reference));
 const sources=[...references].map(reference=>taskFileSource(db,snapshot,reference,runId)).filter((value):value is TaskFileSource=>!!value)
  .sort((a,b)=>b.version-a.version||a.receipt_id.localeCompare(b.receipt_id));
 return files.map((file,index)=>{
  if(!file||typeof file.path!=='string'||!file.path.length||file.path.length>1000)throw new Error('task_completion_candidate_invalid');
  const prior=pinned?.[index];
  if(pinned&&(!prior||prior.path!==file.path))throw new Error('task_completion_state_conflict');
  if(prior?.verified===false)return prior;
  const source=sources.find(row=>row.path===file.path&&(!prior||row.receipt_id===prior.receipt_id));
  if(!source){if(prior?.verified)throw new Error('task_completion_state_conflict');return {path:file.path,verified:false};}
  const location:TaskFileLocation=source.source==='isolated'?{source:'isolated',cycle_id:source.cycle_id,snapshot_id:source.snapshot_id,isolated_receipt_id:source.isolated_receipt_id}:{source:'workspace'};
  if(prior&&prior.source===undefined&&source.source!=='workspace')throw new Error('task_completion_state_conflict');
  const row={...(prior&&prior.source===undefined?{}:location),receipt_id:source.receipt_id,version:source.version,sha256:source.sha256,size:source.size};
  verifyTaskOutputContent(db,{owner:snapshot.owner_id,workspace:context.workspace_id,project:context.project_id,path:file.path,version:row.version,runId,source},row);
  const output={path:file.path,verified:true as const,content_verified:true as const,...row};
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
 if(db.prepare(`SELECT 1 FROM wb_native_child_reservations q WHERE q.owner_id=? AND q.occurrence_id=?
  AND NOT EXISTS (SELECT 1 FROM wb_native_child_closures c WHERE c.reservation_id=q.reservation_id)
  AND NOT EXISTS (SELECT 1 FROM wb_native_creation_aborts a WHERE a.reservation_id=q.reservation_id) LIMIT 1`).get(scope.owner_id,scope.occurrence_id))throw new Error('task_auxiliary_pending');
 if(db.prepare(`SELECT 1 FROM wb_native_child_activations a WHERE a.owner_id=? AND a.occurrence_id=?
  AND NOT EXISTS (SELECT 1 FROM wb_native_activation_closures c WHERE c.run_id=a.run_id) LIMIT 1`).get(scope.owner_id,scope.occurrence_id))throw new Error('task_auxiliary_pending');
 // One identity can be visible through more than one bookkeeping relation.
 // Freeze and check the same distinct run set, including closed activations.
 const occurrenceRuns=`(SELECT o.run_id,o.occurrence_id,t.owner_id FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id
  UNION SELECT run_id,occurrence_id,owner_id FROM wb_task_auxiliary_runs
  UNION SELECT run_id,occurrence_id,owner_id FROM wb_native_execution_runs)`;
 if(db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN ${occurrenceRuns} o ON o.run_id=a.run_id
  WHERE o.owner_id=? AND o.occurrence_id=? AND (a.state IN ('reserved','unknown','in_flight') OR a.bound_exceeded=1) LIMIT 1`).get(scope.owner_id,scope.occurrence_id!))throw new Error('budget_usage_unknown');
 if(db.prepare(`SELECT 1 FROM wb_mailbox_task_roots t JOIN wb_agent_messages m ON m.thread_id=t.thread_id
  WHERE t.occurrence_id=? AND (m.status IN ('processing','outcome_unknown') OR (m.status='pending' AND m.auto_reply=1)) LIMIT 1`).get(scope.occurrence_id!))throw new Error('task_auxiliary_pending');
 const proof=new TaskExecutionEvidence(db),steps=occurrenceSubtaskRows(db,String(scope.task_id),String(scope.occurrence_id));
 if(!steps.length||steps.some(step=>step.status!=='completed'||!proof.completionVerified(String(scope.owner_id),String(scope.task_id),JSON.parse(step.evidence_json),String(scope.occurrence_id),String(step.subtask_id))))throw new Error('task_completion_evidence_required');
 assertDependencyReasons(taskDependencyReasons(db,proof,String(scope.owner_id),String(scope.task_id),steps.flatMap(step=>JSON.parse(step.dependencies_json) as string[]),String(scope.occurrence_id)));
 // Bind this occurrence's exact receipt set, including auxiliary calls and
 // inherited parent runs. Other tasks' shared scope balances must not make a
 // valid result stale. A later reconciled receipt requires a new review.
 const budget_attempts=db.prepare(`SELECT a.run_id,a.attempt_id,a.request_json,a.route_json,a.state,
  a.held_tokens,a.held_nano_usd,a.usage_json,a.actual_tokens,a.actual_nano_usd,a.bound_exceeded
  FROM wb_model_budget_attempts a JOIN ${occurrenceRuns} o ON o.run_id=a.run_id
  WHERE o.owner_id=? AND o.occurrence_id=? ORDER BY a.run_id,a.attempt_id`).all(scope.owner_id,scope.occurrence_id);
 const isWork=!!db.prepare("SELECT 1 FROM wb_task_occurrences WHERE occurrence_id=? AND trigger_key LIKE 'discovery-work:%'").get(scope.occurrence_id);
 const isolated_work_evidence=isWork?workEvidenceReaders.get(db)?.({...scope,runId}):undefined;
 if(isWork&&types.isPromise(isolated_work_evidence)){
  void Promise.prototype.then.call(isolated_work_evidence,undefined,()=>{});
  throw new Error('task_completion_work_inspection_required');
 }
 if(isWork&&(!isolated_work_evidence||typeof isolated_work_evidence!=='object'||'then' in isolated_work_evidence))throw new Error('task_completion_work_inspection_required');
 const selectedObjective=(isolated_work_evidence as {selected_objective?:unknown}|undefined)?.selected_objective;
 if(isWork&&(typeof selectedObjective!=='string'||!selectedObjective.trim()||selectedObjective.length>65536))throw new Error('task_completion_work_inspection_required');
 const objective=isWork?selectedObjective as string:scope.objective;
 const discovery_report=new DiscoveryPlanning(db).completion(runId);
 return {...scope,objective,...(isolated_work_evidence?{isolated_work_evidence}:{}),...(discovery_report?{discovery_report}:{}),budget_attempts,steps:steps.map(step=>({subtask_id:String(step.subtask_id),version:Number(step.version),title:String(step.title),
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
  ||canonicalJson(steps)!==canonicalJson(proposed.steps)
  ||canonicalJson(snapshot.isolated_work_evidence??null)!==canonicalJson(proposed.isolated_work_evidence??null))throw new Error('task_completion_state_conflict');
 let workspaceFiles:PresentedFile[]=[];
 const pins=new Map<string,LegacyFileOutput>();
 if(proposed.workspace_files!==undefined||proposed.workspace_file_outputs!==undefined){
  const declared=validateProposedFiles(proposed.workspace_files),outputs=proposed.workspace_file_outputs;
  if(candidate.presented_files?.length)throw new Error('task_output_sources_conflict');
  if(!Array.isArray(outputs)||outputs.length!==declared.length)throw new Error('task_completion_state_conflict');
  for(const [index,file] of declared.entries()){
   const output=outputs[index] as LegacyFileOutput|undefined;
   if(!output||output.path!==file.path||!output.verified||output.content_verified!==true)throw new Error('task_completion_state_conflict');
   pins.set(file.path,output);
  }
  workspaceFiles=declared;
 }
 if(candidate.workspace_files!==undefined&&canonicalJson(candidate.workspace_files)!==canonicalJson(workspaceFiles))throw new Error('task_completion_state_conflict');
 const value={...candidate,text:candidate.text.trim(),...(workspaceFiles.length?{workspace_files:workspaceFiles}:{})},candidateJson=canonicalJson(value);
 const candidateHash=createHash('sha256').update(candidateJson).digest('hex');
 const prior=db.prepare('SELECT candidate_id,candidate_hash,snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(runId) as {candidate_id:string;candidate_hash:string;snapshot_json:string}|undefined;
 const artifactOutputs=candidate.artifact_refs?.length?freezeGeneratedOutputs(db,snapshot,runId,candidate.artifact_refs):undefined;
 const snapshotJson=canonicalJson({...snapshot,...(candidate.presented_files?.length?{file_outputs:fileOutputs(db,snapshot,candidate.presented_files,runId)}:{}),
  ...(workspaceFiles.length?{workspace_file_outputs:workspaceFiles.flatMap(file=>fileOutputs(db,snapshot,[file],runId,[pins.get(file.path)!]))}:{}),
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
 const saved=JSON.parse(row.snapshot_json!) as {file_outputs?:LegacyFileOutput[];workspace_file_outputs?:LegacyFileOutput[];artifact_outputs?:GeneratedOutput[];isolated_work_evidence?:unknown};
 const proposal=db.prepare("SELECT snapshot_json FROM wb_task_goal_proposals WHERE proposal_id=? AND run_id=? AND intent='complete'").get(row.proposal_id!,runId) as {snapshot_json:string}|undefined;
 if(!proposal)throw new Error('task_completion_state_conflict');
 const declared=JSON.parse(proposal.snapshot_json) as {workspace_files?:PresentedFile[];workspace_file_outputs?:LegacyFileOutput[];isolated_work_evidence?:unknown};
 if(canonicalJson(declared.isolated_work_evidence??null)!==canonicalJson(saved.isolated_work_evidence??null)
  ||canonicalJson(declared.isolated_work_evidence??null)!==canonicalJson(current.isolated_work_evidence??null))throw new Error('task_completion_state_conflict');
 if(candidate.workspace_files?.length||declared.workspace_files!==undefined||declared.workspace_file_outputs!==undefined){
  if(candidate.presented_files?.length)throw new Error('task_output_sources_conflict');
  validateProposedFiles(declared.workspace_files);
  if(!Array.isArray(candidate.workspace_files)||!saved.workspace_file_outputs||canonicalJson(candidate.workspace_files)!==canonicalJson(declared.workspace_files)
    ||canonicalJson(saved.workspace_file_outputs)!==canonicalJson(declared.workspace_file_outputs))throw new Error('task_completion_state_conflict');
 }
 // Never backfill an old frozen candidate from today's latest file metadata.
 if(candidate.presented_files?.length&&!saved.file_outputs)throw new Error('task_completion_state_conflict');
 if(candidate.artifact_refs?.length&&!saved.artifact_outputs)throw new Error('task_completion_state_conflict');
 const snapshot={...current,...(candidate.presented_files?.length?{file_outputs:fileOutputs(db,current,candidate.presented_files,runId,saved.file_outputs)}:{}),
  ...(candidate.workspace_files?.length?{workspace_file_outputs:fileOutputs(db,current,candidate.workspace_files,runId,saved.workspace_file_outputs)}:{}),
  ...(candidate.artifact_refs?.length?{artifact_outputs:freezeGeneratedOutputs(db,current,runId,candidate.artifact_refs,saved.artifact_outputs)}:{})};
 if(row.snapshot_json!==canonicalJson(snapshot)||row.candidate_hash!==createHash('sha256').update(row.candidate_json!).digest('hex'))throw new Error('task_completion_state_conflict');
 return {candidate_id:row.candidate_id!,snapshot,candidate};
}
