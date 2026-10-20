import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {WorkAdmissionRecords,freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import {projectWorkReviewEvidence} from './review-work-evidence.ts';
import {readIsolatedTaskFileVersion} from './isolated-output-source.ts';
import {validateTaskCompletionBoundary} from './completion-handshake.ts';
import {validateCheckpoint} from '../harness/session-checkpoints.ts';
import type {TaskFileSource} from './task-file-source.ts';
import {readHistoricalWorkSnapshot} from '../always-on/work-snapshot-history.ts';

type Row=Record<string,any>;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function requireFact(value:unknown):asserts value{if(!value)throw Error('completed_work_source_unavailable');}
function originalJson(value:string):Row{const parsed=JSON.parse(value);requireFact(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&canonicalJson(parsed)===value);return parsed;}

/** Historical source facts for a future distinct publication review. It never
 * calls the live waiting-approval reader, restores authority, reads mutable
 * trees, acquires a lease, installs schema or publishes anything. */
export class FinalizedWorkSources{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;}
 private snapshot<T>(read:()=>T):T{
  const outer=this.db.isTransaction;if(!outer)this.db.exec('BEGIN DEFERRED');
  try{return read();}catch(error){
   if(error instanceof Error&&['completed_work_source_not_found','completed_work_source_conflict','completed_work_source_unsupported'].includes(error.message))throw error;
   throw Error('completed_work_source_unavailable',{cause:error});
  }finally{if(!outer&&this.db.isTransaction)this.db.exec('ROLLBACK');}
 }
 private original(owner:string,runId:string){
  const db=this.db;
  const f=db.prepare(`SELECT f.*,r.conversation_id,r.status AS run_status,r.checkpoint_id AS completed_checkpoint_id,
   c.workspace_id,c.project_id,o.task_id,o.run_id AS root_run_id,o.status AS occurrence_status,o.business_state
   FROM wb_task_finalizations f JOIN ga_runs r ON r.id=f.run_id JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN ga_projects p ON p.id=c.project_id AND p.owner_id=c.owner_id
   JOIN wb_task_occurrences o ON o.occurrence_id=f.occurrence_id
   JOIN wb_persistent_tasks t ON t.task_id=o.task_id AND t.owner_id=c.owner_id
   WHERE f.run_id=? AND f.owner_id=? AND c.owner_id=?`).get(runId,owner,owner) as Row|undefined;
  if(!f)throw Error('completed_work_source_not_found');
  requireFact(f.run_status==='succeeded'&&f.occurrence_status==='succeeded'&&f.business_state==='completed');
  const receipt=originalJson(f.receipt_json);
  for(const key of ['occurrence_id','run_id','message_id','certificate_id','intent_id'])requireFact(receipt[key]===f[key]);
  requireFact(receipt.status==='succeeded'&&Array.isArray(receipt.delivery_effect_ids)&&receipt.delivery_effect_ids.every((id:unknown)=>typeof id==='string'));
  const cert=db.prepare(`SELECT cert.*,v.owner_id AS review_owner,v.verdict,v.evaluations_json,i.kind,i.status AS review_status,
   w.purpose,w.checkpoint_id AS review_checkpoint_id,w.expected_run_version
   FROM wb_task_business_certificates cert JOIN wb_task_business_reviews v ON v.interaction_id=cert.interaction_id AND v.candidate_id=cert.candidate_id
   JOIN ga_interactions i ON i.id=v.interaction_id AND i.run_id=cert.run_id
   JOIN wb_task_wait_interactions w ON w.interaction_id=i.id AND w.run_id=cert.run_id WHERE cert.certificate_id=?`).get(f.certificate_id) as Row|undefined;
  requireFact(cert&&cert.run_id===runId&&cert.occurrence_id===f.occurrence_id&&cert.review_owner===owner&&cert.verdict==='accepted'
   &&cert.kind==='question'&&cert.review_status==='answered'&&cert.purpose==='task_acceptance_review');
  const candidate=db.prepare('SELECT * FROM wb_task_completion_candidates WHERE candidate_id=? AND run_id=?').get(cert.candidate_id,runId) as Row|undefined;
  requireFact(candidate&&candidate.occurrence_id===f.occurrence_id);
  const s=originalJson(candidate.snapshot_json),answer=originalJson(candidate.candidate_json),context=JSON.parse(s.frozen_context);
  requireFact(hash(s)===cert.snapshot_hash&&hash(answer)===cert.candidate_hash&&hash(answer)===candidate.candidate_hash
   &&s.owner_id===owner&&s.task_id===f.task_id&&s.occurrence_id===f.occurrence_id&&s.root_run_id===f.root_run_id
   &&context.workspace_id===f.workspace_id&&context.project_id===f.project_id&&candidate.checkpoint_id===s.checkpoint_id
   &&cert.review_checkpoint_id===s.checkpoint_id&&cert.expected_run_version===s.run_version);
  const binding=db.prepare("SELECT context_json,agent_id,epoch FROM wb_run_bindings WHERE run_id=? AND owner_id=? AND kind='task'").get(runId,owner) as Row|undefined;
  requireFact(binding&&binding.context_json===s.frozen_context&&binding.agent_id===s.agent_id&&binding.epoch===s.epoch);
  const judgments=JSON.parse(cert.evaluations_json);
  requireFact(Array.isArray(s.steps)&&s.steps.length>0&&Array.isArray(judgments)&&judgments.length===s.steps.length);
  for(const [i,step] of s.steps.entries()){
   const judgment=judgments[i];requireFact(step.status==='completed'&&judgment&&judgment.subtask_id===step.subtask_id&&judgment.subtask_version===step.version
    &&judgment.acceptance===step.acceptance&&canonicalJson(judgment.evidence)===canonicalJson(step.evidence)
    &&judgment.method==='owner_confirmation'&&judgment.verdict==='accepted'&&typeof judgment.note==='string'&&judgment.note.length<=10000);
  }
  const proposal=db.prepare("SELECT * FROM wb_task_goal_proposals WHERE proposal_id=? AND run_id=? AND intent='complete'").get(candidate.proposal_id,runId) as Row|undefined;
  requireFact(proposal&&proposal.occurrence_id===s.occurrence_id&&proposal.goal_id===s.goal_id&&proposal.goal_revision<=s.goal_revision);
  // The original proposal writer uses JSON.stringify, whereas the candidate
  // and certificate use canonical JSON. Compare the original semantic pins.
  const proposed=JSON.parse(proposal.snapshot_json);
  requireFact(proposed&&typeof proposed==='object'&&!Array.isArray(proposed)
   &&Object.keys(proposed).every(key=>['isolated_work_evidence','objective','task_version','generation','steps','workspace_files','workspace_file_outputs'].includes(key)));
  requireFact(proposed.objective===s.objective&&proposed.task_version===s.task_version&&proposed.generation===s.generation
   &&canonicalJson(proposed.steps)===canonicalJson(s.steps.map(({subtask_id,version,acceptance,status,evidence}:Row)=>({subtask_id,version,acceptance,status,evidence})))
   &&canonicalJson(proposed.isolated_work_evidence??null)===canonicalJson(s.isolated_work_evidence??null)
   &&canonicalJson(proposed.workspace_file_outputs??[])===canonicalJson(s.workspace_file_outputs??[])
   &&canonicalJson(proposed.workspace_files??[])===canonicalJson(answer.workspace_files??[]));
  if(!s.isolated_work_evidence)throw Error('completed_work_source_unsupported');
  if(s.file_outputs?.length||s.artifact_outputs?.length)throw Error('completed_work_source_unsupported');
  const work=projectWorkReviewEvidence(s.isolated_work_evidence);requireFact(work&&s.objective===work.selected_objective);
  const intent=db.prepare('SELECT * FROM wb_task_completion_intents WHERE intent_id=? AND owner_id=? AND run_id=?').get(f.intent_id,owner,runId) as Row|undefined;
  const native=db.prepare('SELECT * FROM wb_task_native_completions WHERE intent_id=?').get(f.intent_id) as Row|undefined;
  requireFact(intent&&native&&intent.certificate_id===f.certificate_id&&intent.occurrence_id===f.occurrence_id
   &&intent.snapshot_hash===cert.snapshot_hash&&intent.candidate_hash===cert.candidate_hash);
  const before=validateTaskCompletionBoundary(originalJson(intent.before_json)),originalCheckpoint=validateCheckpoint(originalJson(intent.checkpoint_json)),proof=originalJson(native.proof_json);
  requireFact(Object.keys(proof).sort().join(',')==='checkpoint,goal,host_status'&&hash(proof)===native.proof_hash);
  const after=validateTaskCompletionBoundary({host_status:proof.host_status,goal:proof.goal}),completedCheckpoint=validateCheckpoint(proof.checkpoint);
  requireFact(before.goal.phase!=='complete'&&before.goal.goal_id===s.goal_id&&before.goal.goal_revision===s.goal_revision
   &&after.goal.phase==='complete'&&after.goal.goal_id===before.goal.goal_id&&after.goal.goal_revision===before.goal.goal_revision+1
   &&after.goal.rounds_started===before.goal.rounds_started&&after.goal.max_goal_rounds===before.goal.max_goal_rounds
   &&originalCheckpoint.session_ref===intent.session_ref&&originalCheckpoint.goal_id===before.goal.goal_id&&originalCheckpoint.goal_revision===before.goal.goal_revision
   &&originalCheckpoint.seq_exclusive===s.seq_exclusive&&originalCheckpoint.turn_end_seq===s.turn_end_seq
   &&completedCheckpoint.session_ref===intent.session_ref&&completedCheckpoint.goal_id===after.goal.goal_id&&completedCheckpoint.goal_revision===after.goal.goal_revision
   &&completedCheckpoint.turn_end_seq===originalCheckpoint.turn_end_seq&&completedCheckpoint.seq_exclusive>originalCheckpoint.seq_exclusive);
  for(const [id,expected] of [[s.checkpoint_id,originalCheckpoint],[f.completed_checkpoint_id,completedCheckpoint]] as const){
   const cp=db.prepare('SELECT * FROM ga_session_checkpoints WHERE checkpoint_id=? AND run_id=? AND conversation_id=?').get(id,runId,f.conversation_id) as Row|undefined;
   requireFact(cp&&Object.entries(expected).every(([key,value])=>cp[key]===value));
  }
  const message=db.prepare("SELECT * FROM ga_messages WHERE id=? AND run_id=? AND conversation_id=? AND role='assistant' AND status='complete'").get(f.message_id,runId,f.conversation_id) as Row|undefined;
  requireFact(message);const published=JSON.parse(message.content_json);
  requireFact(typeof answer.text==='string'&&Array.isArray(published.blocks)&&published.blocks.length===1&&published.blocks[0].kind==='text'&&published.blocks[0].text===answer.text);
  return {f,s,cert,candidate,native,work};
 }
 private material(owner:string,runId:string){
  const {f,s,cert,candidate,native,work}=this.original(owner,runId),db=this.db,evidence=s.isolated_work_evidence;
  const admission=new WorkAdmissionRecords(db).byRun(owner,runId);
  requireFact(admission&&admission.task_id===s.task_id&&admission.occurrence_id===s.occurrence_id&&admission.run_id===s.root_run_id
   &&admission.scope.workspace_id===f.workspace_id&&admission.scope.project_id===f.project_id&&admission.scope.agent_id===s.agent_id
   &&admission.grant_id===work.grant_id&&admission.cycle_id===work.cycle_id&&admission.snapshot_id===work.snapshot_id);
  const rows=db.prepare('SELECT * FROM wb_discovery_work_inspections WHERE run_id=? AND inspection_sha256=?').all(runId,work.inspection_sha256) as Row[];
  requireFact(rows.length===1);const row=rows[0]!,inputs=originalJson(row.inputs_json);
  requireFact(row.owner_id===owner&&row.task_id===s.task_id&&row.occurrence_id===s.occurrence_id&&row.cycle_id===work.cycle_id&&row.snapshot_id===work.snapshot_id
   &&row.evidence_json===canonicalJson(evidence)&&row.inputs_sha256===hash(inputs)&&inputs.protocol===1&&inputs.run_id===runId
   &&inputs.binding_sha256===evidence.binding_sha256&&Array.isArray(inputs.calls)&&hash(inputs.calls)===work.call_set_sha256);
  const writeIds:string[]=[];
  for(const call of inputs.calls){
   requireFact(call&&call.intent&&call.proof&&call.ledger);
   const actual=db.prepare(`SELECT i.*,r.receipt_id,r.path,r.version,r.sha256,r.bytes,r.response_json FROM wb_isolated_file_intents i
    LEFT JOIN wb_isolated_file_results r ON r.call_key=i.call_key WHERE i.call_key=?`).get(call.intent.call_key) as Row|undefined;
   requireFact(actual);const {bytes,...intent}=actual;
   const proof=db.prepare('SELECT * FROM wb_task_execution_receipts WHERE receipt_id=?').get(call.proof.receipt_id);
   const ledger=db.prepare('SELECT * FROM wb_tool_receipts WHERE run_id=? AND call_id=?').get(call.proof.run_id,call.proof.call_id);
   requireFact(canonicalJson(intent)===canonicalJson(call.intent)&&canonicalJson(proof)===canonicalJson(call.proof)&&canonicalJson(ledger)===canonicalJson(call.ledger)
    &&(bytes===null?null:bytesHash(Buffer.from(bytes)))===call.bytes_sha256);
   if(call.proof.operation==='files.write')writeIds.push(call.proof.receipt_id);
  }
  requireFact(Array.isArray(evidence.write_receipt_ids)&&new Set(writeIds).size===writeIds.length&&canonicalJson(writeIds.sort())===canonicalJson(evidence.write_receipt_ids));
  const versions=new Map<string,{source:TaskFileSource;content:string}>();
  for(const id of writeIds){
   const value=db.prepare('SELECT * FROM wb_task_isolated_file_execution_receipts WHERE receipt_id=?').get(id) as Row|undefined;
   requireFact(value&&value.owner_id===owner&&value.workspace_id===f.workspace_id&&value.project_id===f.project_id&&value.task_id===s.task_id
    &&value.occurrence_id===s.occurrence_id&&value.cycle_id===work.cycle_id&&value.snapshot_id===work.snapshot_id);
   const source={...value,source:'isolated',conversation_id:f.conversation_id,native:value.run_id!==runId} as TaskFileSource;
   const verified=readIsolatedTaskFileVersion(db,source),previous=versions.get(value.path);
   if(previous)requireFact(previous.source.version!==value.version);
   if(!previous||previous.source.version<value.version)versions.set(value.path,{source,content:verified.content});
  }
  for(const output of s.workspace_file_outputs??[]){
   const file=versions.get(output.path);requireFact(output.verified===true&&output.content_verified===true&&output.source==='isolated'&&file
    &&file.source.receipt_id===output.receipt_id&&file.source.version===output.version&&file.source.sha256===output.sha256&&file.source.size===output.size);
  }
  const files=[...versions].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,{source}])=>{
   const entry=work.result_manifest.entries.find(e=>e.path===path);requireFact(entry?.kind==='file'&&entry.sha256===source.sha256&&entry.bytes===source.size);
   return {path,version:source.version,sha256:source.sha256,size_bytes:source.size,receipt_id:source.receipt_id,producing_run_id:source.run_id};
  });
  // Unsupported changes stay explicit. A future publisher must reject this list,
  // not quietly turn partial text provenance into full-tree apply permission.
  const unsupported_changes=work.diff.changes.filter(change=>!(change.kind==='add'&&change.after.kind==='file'&&!change.after.executable&&versions.has(change.path)
   ||change.kind==='modify'&&!change.mode_changed&&versions.has(change.path))).map(change=>({kind:change.kind,path:change.path}));
  const facts={protocol:1 as const,source:'isolated' as const,owner_id:owner,workspace_id:f.workspace_id,project_id:f.project_id,agent_id:s.agent_id,
   task_id:s.task_id,occurrence_id:s.occurrence_id,run_id:runId,final_message_id:f.message_id,candidate_id:candidate.candidate_id,certificate_id:f.certificate_id,
   completion_intent_id:f.intent_id,snapshot_sha256:cert.snapshot_hash,candidate_sha256:cert.candidate_hash,native_proof_sha256:native.proof_hash,
   work_review:work,files,unsupported_changes,execution_authorized:false as const};
  const completed_checkpoint=validateCheckpoint(originalJson(native.proof_json).checkpoint);
  return {summary:freezeWorkAdmission({...facts,source_sha256:hash(facts)}),versions,admission,session_ref:completed_checkpoint.session_ref,completed_checkpoint};
 }
 summary(owner:string,runId:string){return this.snapshot(()=>this.material(owner,runId).summary);}
 /** HOST-PRIVATE historical placement. Never project these paths into a tool,
  * public review or response. The root comes from the original immutable
  * snapshot/grant and native completion, not a current tree or caller root. */
 nativePlacement(owner:string,runId:string,expectedSourceSha256:string){return this.snapshot(()=>{
  const {summary,admission,session_ref,completed_checkpoint}=this.material(owner,runId);if(summary.source_sha256!==expectedSourceSha256)throw Error('completed_work_source_conflict');
  const history=readHistoricalWorkSnapshot(this.db,owner,runId),{record}=history;
  requireFact(canonicalJson(history.admission)===canonicalJson(admission)&&history.project_id===summary.project_id&&history.workspace_id===summary.workspace_id
   &&history.admission.scope.agent_id===summary.agent_id&&canonicalJson(record.manifest)===canonicalJson(summary.work_review.base_manifest));
  const facts={protocol:1 as const,owner_id:owner,project_id:summary.project_id,source_sha256:summary.source_sha256,snapshot_id:admission.snapshot_id,session_ref,completed_checkpoint,
   storage_root:record.storage_root,isolated_root:record.isolated_root,record_sha256:history.record_sha256,execution_authorized:false as const};
  return freezeWorkAdmission({...facts,placement_sha256:hash(facts)});
 });}
 readSelection(owner:string,runId:string,paths:readonly string[],expectedSourceSha256:string){
  return this.snapshot(()=>{
   if(!Array.isArray(paths)||!paths.length||paths.length>100||new Set(paths).size!==paths.length)throw Error('completed_work_source_not_found');
   const value=this.material(owner,runId);if(value.summary.source_sha256!==expectedSourceSha256)throw Error('completed_work_source_conflict');
   const files=new Map<string,Buffer>();for(const path of paths){const file=value.versions.get(path);if(!file)throw Error('completed_work_source_not_found');files.set(path,Buffer.from(file.content,'utf8'));}
   return{summary:value.summary,files};
  });
 }
 content(owner:string,runId:string,path:string,expectedSourceSha256:string):Buffer{
  return this.readSelection(owner,runId,[path],expectedSourceSha256).files.get(path)!;
 }
}
export type FinalizedWorkNativePlacement=ReturnType<FinalizedWorkSources['nativePlacement']>;
