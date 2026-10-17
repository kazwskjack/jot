import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import type {ExecutionLease} from '../workbench/execution-lease.ts';
import type {TaskCompletionWorkScope} from '../persistent-tasks/completion-candidates.ts';
import {TaskExecutionEvidence} from '../persistent-tasks/execution-evidence.ts';
import {readIsolatedTaskFileVersion} from '../persistent-tasks/isolated-output-source.ts';
import {freezeWorkAdmission} from './work-admission-records.ts';
import type {TrustedWorkRunWorkspaceResolver} from './work-run-workspace.ts';
import {createWorkspaceDiff} from './workspace-diff.ts';
import {validateWorkspaceManifest,workspaceManifestHash,type WorkspaceManifest} from './workspace-provider.ts';

type Binding=NonNullable<ReturnType<TrustedWorkRunWorkspaceResolver['context']>>;
type Options={db:DatabaseSync;resolver:Pick<TrustedWorkRunWorkspaceResolver,'context'|'inspectForRun'>};
type Row=Record<string,any>;
export type FrozenIsolatedWorkEvidence=Readonly<{
 protocol:1;grant_id:string;work_occurrence_id:string;cycle_id:string;snapshot_id:string;selected_objective:string;
 source_sha256:string;source_record_sha256:string;plans_sha256:string;paths_sha256:string;
 base_manifest:WorkspaceManifest;base_manifest_sha256:string;result_manifest:WorkspaceManifest;result_manifest_sha256:string;
 diff:ReturnType<typeof createWorkspaceDiff>;write_receipt_ids:readonly string[];
 call_set_sha256:string;binding_sha256:string;inspection_sha256:string;
}>;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const fail=(cause?:unknown)=>Error('task_completion_work_inspection_required',{cause});

/** Full host inspection, outside SQL transactions, followed by a short original
 * authority fence. Evidence describes review bytes; it grants no apply permission. */
export class WorkInspections{
 private readonly db:DatabaseSync;private readonly resolver:Options['resolver'];
 constructor(options:Options){
  this.db=options.db;this.resolver=options.resolver;
  this.db.exec(`CREATE TABLE IF NOT EXISTS wb_discovery_work_inspections(
   inspection_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id),owner_id TEXT NOT NULL,
   task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,cycle_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
   inputs_json TEXT NOT NULL,inputs_sha256 TEXT NOT NULL,evidence_json TEXT NOT NULL,inspection_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS wb_work_inspections_run ON wb_discovery_work_inspections(run_id,created_at);
   CREATE TRIGGER IF NOT EXISTS wb_work_inspections_no_update BEFORE UPDATE ON wb_discovery_work_inspections BEGIN SELECT RAISE(ABORT,'work_inspection_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_work_inspections_no_delete BEFORE DELETE ON wb_discovery_work_inspections BEGIN SELECT RAISE(ABORT,'work_inspection_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_work_inspections_no_replace BEFORE INSERT ON wb_discovery_work_inspections WHEN EXISTS(SELECT 1 FROM wb_discovery_work_inspections WHERE inspection_id=NEW.inspection_id) BEGIN SELECT RAISE(ABORT,'work_inspection_immutable'); END;`);
 }
 private isWork(runId:string){return !!this.db.prepare("SELECT 1 FROM wb_task_run_occurrences WHERE run_id=? AND trigger_key LIKE 'discovery-work:%'").get(runId);}
 private quiescent(binding:Binding){
  const db=this.db,a=binding.admission;
  if(db.prepare(`SELECT 1 FROM wb_native_child_reservations q WHERE q.owner_id=? AND q.occurrence_id=?
   AND NOT EXISTS(SELECT 1 FROM wb_native_child_closures c WHERE c.reservation_id=q.reservation_id)
   AND NOT EXISTS(SELECT 1 FROM wb_native_creation_aborts x WHERE x.reservation_id=q.reservation_id) LIMIT 1`).get(a.owner_id,a.occurrence_id))throw fail();
  if(db.prepare(`SELECT 1 FROM wb_native_child_activations q WHERE q.owner_id=? AND q.occurrence_id=?
   AND NOT EXISTS(SELECT 1 FROM wb_native_activation_closures c WHERE c.run_id=q.run_id) LIMIT 1`).get(a.owner_id,a.occurrence_id))throw fail();
  const runs=`(SELECT o.run_id,o.occurrence_id,t.owner_id FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id
   UNION SELECT run_id,occurrence_id,owner_id FROM wb_task_auxiliary_runs UNION SELECT run_id,occurrence_id,owner_id FROM wb_native_execution_runs)`;
  if(db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN ${runs} o ON o.run_id=a.run_id WHERE o.owner_id=? AND o.occurrence_id=?
   AND(a.state IN('reserved','unknown','in_flight') OR a.bound_exceeded=1) LIMIT 1`).get(a.owner_id,a.occurrence_id))throw fail();
  if(db.prepare(`SELECT 1 FROM wb_mailbox_task_roots t JOIN wb_agent_messages m ON m.thread_id=t.thread_id WHERE t.occurrence_id=?
   AND(m.status IN('processing','outcome_unknown') OR(m.status='pending' AND m.auto_reply=1)) LIMIT 1`).get(a.occurrence_id))throw fail();
 }
 private inputs(runId:string,lease?:ExecutionLease){
  const db=this.db,binding=this.resolver.context(runId,lease);if(!binding)throw fail();const a=binding.admission;
  this.quiescent(binding);
  if(db.prepare('SELECT 1 FROM wb_isolated_file_pending WHERE cycle_id=? LIMIT 1').get(a.cycle_id))throw fail();
  const intents=db.prepare(`SELECT i.*,r.receipt_id,r.path,r.version,r.sha256,r.bytes,r.response_json FROM wb_isolated_file_intents i
   LEFT JOIN wb_isolated_file_results r ON r.call_key=i.call_key WHERE i.cycle_id=? ORDER BY i.call_key`).all(a.cycle_id) as Row[];
  const proofs=new TaskExecutionEvidence(db),writes:string[]=[];
  const calls=intents.map(row=>{
   if(!row.receipt_id||row.snapshot_id!==a.snapshot_id)throw fail();
   const identity=JSON.parse(row.identity_json),operation=JSON.parse(row.operation_json),result=JSON.parse(row.response_json);
   if(canonicalJson(identity)!==row.identity_json||canonicalJson(operation)!==row.operation_json||canonicalJson(result)!==row.response_json
    ||hash(identity)!==row.call_key||hash({identity,operation})!==row.digest)throw fail();
   for(const [key,value]of Object.entries({owner_id:a.owner_id,...a.scope,occurrence_id:a.occurrence_id,cycle_id:a.cycle_id,snapshot_id:a.snapshot_id}))if(identity[key]!==value)throw fail();
   for(const [key,value]of Object.entries(identity))if(result[key]!==value)throw fail();
   if(result.source!=='isolated'||result.receipt_id!==row.receipt_id||!['files.read','files.list','files.write'].includes(operation.operation))throw fail();
   const receipts=db.prepare('SELECT * FROM wb_task_execution_receipts WHERE run_id=? AND call_id=?').all(identity.run_id,identity.call_id) as Row[];
   if(receipts.length!==1)throw fail();const proof=receipts[0]!;
   const ref={kind:'tool_receipt' as const,reference:proof.receipt_id,hash:proof.result_hash};
   if(proof.operation!==operation.operation||!proofs.verified(a.owner_id,a.task_id,ref,a.occurrence_id))throw fail();
   const ledger=db.prepare('SELECT * FROM wb_tool_receipts WHERE run_id=? AND call_id=?').get(identity.run_id,identity.call_id) as Row|undefined;if(!ledger)throw fail();
   const response=JSON.parse(ledger.response_json),{execution_receipt,...original}=response,{operation:operationName,...args}=operation;
   if(ledger.request_hash!==hash({operation:operationName,args}))throw fail();
   if(canonicalJson(execution_receipt)!==canonicalJson(ref)||canonicalJson(original)!==canonicalJson(result)||bytesHash(JSON.stringify(original))!==proof.result_hash)throw fail();
   if(operation.operation==='files.write'){
    const source=db.prepare('SELECT * FROM wb_task_isolated_file_execution_receipts WHERE receipt_id=?').get(proof.receipt_id) as Row|undefined;if(!source)throw fail();
    readIsolatedTaskFileVersion(db,{...source,source:'isolated',conversation_id:a.conversation_id,native:identity.run_id!==runId} as Parameters<typeof readIsolatedTaskFileVersion>[1]);writes.push(proof.receipt_id);
   }
   const {bytes,...stored}=row;
   return {intent:stored,bytes_sha256:bytes===null?null:bytesHash(Buffer.from(bytes)),proof,ledger};
  });
  const externalInputs=db.prepare(`SELECT m.id,m.status,m.content_json,m.updated_at,b.epoch FROM ga_messages m JOIN ga_runs r ON r.id=m.run_id
   JOIN ga_conversations c ON c.id=r.conversation_id JOIN wb_run_bindings b ON b.run_id=r.id AND b.kind='chat'
   WHERE c.owner_id=? AND c.workspace_id=? AND c.project_id=? AND b.agent_id=? AND m.role='user' ORDER BY m.id`).all(a.owner_id,a.scope.workspace_id,a.scope.project_id,a.scope.agent_id);
  const value={protocol:1,run_id:runId,binding_sha256:hash(binding),calls,external_inputs:externalInputs};
  return {binding,value,sha256:hash(value),write_receipt_ids:writes.sort(),call_set_sha256:hash(calls)};
 }
 async collect(runId:string,lease:ExecutionLease):Promise<FrozenIsolatedWorkEvidence|undefined>{
  try{
   if(this.db.isTransaction)throw fail();if(!this.isWork(runId))return undefined;
   // The resolver ingests original source signals and fully verifies physical
   // source and result trees. No transaction survives this await.
   const before=this.inputs(runId,lease);
   const inspected=await this.resolver.inspectForRun(runId,lease);if(!inspected)throw fail();
   if(hash(before.binding)!==hash({work_binding:inspected.work_binding,native_workspace:inspected.native_workspace,objective:inspected.objective,
    admission:inspected.admission,grant:inspected.grant,record:inspected.record,sessionRef:inspected.sessionRef}))throw fail();
   const base=validateWorkspaceManifest(inspected.record.manifest),result=validateWorkspaceManifest(inspected.inspection.manifest);
   const baseHash=workspaceManifestHash(base),resultHash=workspaceManifestHash(result);
   if(resultHash!==inspected.inspection.manifest_sha256||inspected.inspection.snapshot_id!==before.binding.admission.snapshot_id)throw fail();
   const a=before.binding.admission,g=before.binding.grant;
   const payload={protocol:1 as const,selected_objective:before.binding.objective,grant_id:a.grant_id,work_occurrence_id:a.occurrence_id,cycle_id:a.cycle_id,snapshot_id:a.snapshot_id,
    source_sha256:g.source_sha256,source_record_sha256:g.source_record_sha256,plans_sha256:g.plans_sha256,paths_sha256:g.paths_sha256,
    base_manifest:base,base_manifest_sha256:baseHash,result_manifest:result,result_manifest_sha256:resultHash,
    diff:createWorkspaceDiff({base,base_sha256:baseHash,result,result_sha256:resultHash}),write_receipt_ids:before.write_receipt_ids,
    call_set_sha256:before.call_set_sha256,binding_sha256:before.value.binding_sha256};
   const evidence=freezeWorkAdmission({...payload,inspection_sha256:hash(payload)});
   return withImmediateTransaction(this.db,()=>{
    const final=this.inputs(runId,lease);if(final.sha256!==before.sha256)throw fail();
    const id='work-inspection-'+hash({runId,inputs:before.sha256,inspection:evidence.inspection_sha256});
    const prior=this.db.prepare('SELECT * FROM wb_discovery_work_inspections WHERE inspection_id=?').get(id) as Row|undefined;
    if(prior){if(prior.inputs_json!==canonicalJson(before.value)||prior.evidence_json!==canonicalJson(evidence))throw fail();return evidence;}
    this.db.prepare('INSERT INTO wb_discovery_work_inspections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,runId,a.owner_id,a.task_id,a.occurrence_id,a.cycle_id,a.snapshot_id,canonicalJson(before.value),before.sha256,canonicalJson(evidence),evidence.inspection_sha256,new Date().toISOString());return evidence;
   });
  }catch(error){throw fail(error);}
 }
 current(scope:TaskCompletionWorkScope):FrozenIsolatedWorkEvidence|undefined{
  const read=()=>{
   if(!this.isWork(scope.runId)){
    if(this.db.prepare("SELECT 1 FROM wb_task_occurrences WHERE occurrence_id=? AND trigger_key LIKE 'discovery-work:%'").get(scope.occurrence_id))throw fail();
    return undefined;
   }
   const facts=this.inputs(scope.runId),a=facts.binding.admission,context=JSON.parse(scope.frozen_context);
   if(scope.owner_id!==a.owner_id||scope.task_id!==a.task_id||scope.occurrence_id!==a.occurrence_id||scope.root_run_id!==a.run_id
    ||context.workspace_id!==a.scope.workspace_id||context.project_id!==a.scope.project_id)throw fail();
   const row=this.db.prepare('SELECT * FROM wb_discovery_work_inspections WHERE run_id=? AND inputs_sha256=? ORDER BY rowid DESC LIMIT 1').get(scope.runId,facts.sha256) as Row|undefined;if(!row)throw fail();
   const evidence=JSON.parse(row.evidence_json) as FrozenIsolatedWorkEvidence,{inspection_sha256,...payload}=evidence;
   if(row.owner_id!==a.owner_id||row.task_id!==a.task_id||row.occurrence_id!==a.occurrence_id||row.cycle_id!==a.cycle_id||row.snapshot_id!==a.snapshot_id
    ||row.inputs_json!==canonicalJson(facts.value)||hash(JSON.parse(row.inputs_json))!==row.inputs_sha256||canonicalJson(evidence)!==row.evidence_json
    ||hash(payload)!==inspection_sha256||inspection_sha256!==row.inspection_sha256||evidence.selected_objective!==facts.binding.objective||evidence.call_set_sha256!==facts.call_set_sha256||evidence.binding_sha256!==facts.value.binding_sha256)throw fail();
   return freezeWorkAdmission(evidence);
  };
  try{if(this.db.isTransaction)return read();this.db.exec('BEGIN DEFERRED');try{return read();}finally{this.db.exec('ROLLBACK');}}catch(error){throw fail(error);}
 }
}
