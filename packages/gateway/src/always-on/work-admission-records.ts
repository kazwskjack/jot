import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {taskBudgetKey} from '../workbench/model-budget-policy.ts';
import {WorkGrants,type WorkGrant} from './work-grants.ts';
import {WorkCycles,type WorkCycleScope} from './work-cycles.ts';
import {WorkCycleSources} from './work-cycle-sources.ts';
import {WorkspaceJournal} from './workspace-journal.ts';
type Row=Record<string,any>;
export type WorkAdmissionObservation=Readonly<{activity_sha256:string;native_sha256:string;capacity_sha256:string;source_verified_sha256:string;snapshot_verified_sha256:string;budget_policy_revision:number;observed_at:number}>;
export type WorkAdmissionRecord=Readonly<{protocol:1;grant_id:string;grant_sha256:string;owner_id:string;scope:Readonly<WorkCycleScope>;cycle_id:string;snapshot_id:string;source_sha256:string;plans_sha256:string;paths_sha256:string;task_id:string;task_version:number;task_generation:number;task_budget_scope_id:string;occurrence_id:string;run_id:string;conversation_id:string;observation:WorkAdmissionObservation;created_at:string;execution_authorized:false}>;
export const workAdmissionDigest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function freezeWorkAdmission<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeWorkAdmission(child);Object.freeze(value);}return value;}
export function validateWorkObservation(value:unknown):asserts value is WorkAdmissionObservation{
 const keys=['activity_sha256','native_sha256','capacity_sha256','source_verified_sha256','snapshot_verified_sha256','budget_policy_revision','observed_at'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('work_admission_invalid');
 const row=value as Row;for(const key of keys.filter(key=>key.endsWith('sha256')))if(typeof row[key]!=='string'||!/^[a-f0-9]{64}$/.test(row[key]))throw Error('work_admission_invalid');
 if(!Number.isSafeInteger(row.budget_policy_revision)||row.budget_policy_revision<1||!Number.isSafeInteger(row.observed_at)||row.observed_at<1||row.observed_at>Date.now())throw Error('work_admission_invalid');
}
/** Live original authority only, deliberately excludes new-occurrence budget
 * readiness: an admitted run's own in-flight usage is legitimate. No byte IO. */
export function assertWorkGrantAuthority(db:DatabaseSync,grant:WorkGrant){
 const cycle=new WorkCycles(db).guard(grant.owner_id,grant.scope,grant.cycle_id),row=db.prepare('SELECT * FROM wb_discovery_work_cycles WHERE cycle_id=?').get(grant.cycle_id) as Row;
 if(cycle.version!==grant.cycle_version||cycle.task_id!==grant.task_id||cycle.admission_id!==grant.admission_id||cycle.report_sha256!==grant.report_sha256||workAdmissionDigest(cycle.plans)!==grant.plans_sha256)throw Error('work_admission_authority_revoked');
 for(const key of ['task_version','task_generation','task_budget_scope_id','signal_revision','signal_sha256'])if(row[key]!==grant[key as keyof WorkGrant])throw Error('work_admission_authority_revoked');
 const planning=db.prepare('SELECT o.generation,c.generation AS current_generation,c.run_id FROM wb_task_occurrences o JOIN wb_task_current_occurrences c ON c.occurrence_id=o.occurrence_id WHERE o.occurrence_id=? AND o.task_id=?').get(grant.planning_occurrence_id,grant.task_id) as Row|undefined;
 if(!planning||planning.generation<0||planning.generation!==grant.planning_source_generation||planning.current_generation!==grant.planning_occurrence_generation||planning.run_id!==grant.planning_current_run_id)throw Error('work_admission_authority_revoked');
 const source=new WorkCycleSources(db).get(grant.owner_id,grant.scope,grant.cycle_id),journal=new WorkspaceJournal(db),intent=journal.intent(grant.owner_id,grant.scope,grant.cycle_id),record=journal.record(grant.owner_id,grant.scope,grant.cycle_id,grant.snapshot_id);
 if(!source||!intent||!record||workAdmissionDigest(source)!==grant.source_record_sha256||workAdmissionDigest(record)!==grant.snapshot_record_sha256||intent.root_binding_sha256!==grant.root_binding_sha256||intent.selection_sha256!==grant.selection_sha256)throw Error('work_admission_authority_revoked');
 const inventory=db.prepare('SELECT path,version,sha256,size,blob_name FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? ORDER BY path COLLATE BINARY').all(grant.owner_id,grant.scope.workspace_id,grant.scope.project_id);
 if(canonicalJson(inventory)!==canonicalJson(source.files))throw Error('work_admission_source_changed');
}
export function assertWorkBudgetBinding(db:DatabaseSync,owner:string,runId:string,taskId:string,scopeId:string){
 try{const allocation=db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE owner_id=? AND run_id=?').get(owner,runId) as Row|undefined,binding=db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,runId) as Row|undefined;
 const a=JSON.parse(allocation!.allocation_json),bound=JSON.parse(binding!.scopes_json),selected=a.scopes.filter((scope:Row)=>scope.key===taskBudgetKey(taskId));
 if(a.run_id!==runId||selected.length!==1||selected[0].scope_id!==scopeId||!Array.isArray(bound)||!bound.includes(scopeId)||!db.prepare('SELECT 1 FROM wb_model_budget_scopes WHERE owner_id=? AND scope_id=? AND scope_key=?').get(owner,scopeId,taskBudgetKey(taskId)))throw Error();
 }catch{throw Error('work_admission_budget_binding_unconfirmed');}
}
/** Historical reads never renew admission. Running guards are DB authority
 * checks only; callers must additionally enforce native leases and byte guards. */
export class WorkAdmissionRecords{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;}
 private read<T>(fn:()=>T):T{if(this.db.isTransaction)return fn();this.db.exec('BEGIN DEFERRED');try{return fn();}finally{this.db.exec('ROLLBACK');}}
 private decode(row:Row):WorkAdmissionRecord{
  try{const record=JSON.parse(row.record_json);if(canonicalJson(record)!==row.record_json||workAdmissionDigest(record)!==row.record_sha256||record.protocol!==1||record.execution_authorized!==false)throw Error();
   for(const key of ['grant_id','owner_id','task_id','task_version','task_generation','occurrence_id','run_id','conversation_id','created_at'])if(record[key]!==row[key])throw Error();
   validateWorkObservation(record.observation);const grant=new WorkGrants(this.db).get(record.owner_id,record.scope,record.grant_id);
   if(record.grant_sha256!==workAdmissionDigest(grant))throw Error();for(const key of ['cycle_id','snapshot_id','source_sha256','plans_sha256','paths_sha256','task_id','task_version','task_generation','task_budget_scope_id'])if(record[key]!==grant[key as keyof WorkGrant])throw Error();
   return freezeWorkAdmission(record);
  }catch{throw Error('work_admission_corrupt');}
 }
 get(owner:string,scope:WorkCycleScope,grantId:string):WorkAdmissionRecord{return this.read(()=>{new WorkGrants(this.db).get(owner,scope,grantId);const row=this.db.prepare('SELECT * FROM wb_discovery_work_admissions WHERE owner_id=? AND grant_id=?').get(owner,grantId) as Row|undefined;if(!row)throw Error('work_admission_not_found');return this.decode(row);});}
 byRun(owner:string,runId:string):WorkAdmissionRecord|null{return this.read(()=>{
  const row=this.db.prepare(`SELECT a.* FROM wb_discovery_work_admissions a JOIN wb_task_run_occurrences o ON o.occurrence_id=a.occurrence_id AND o.task_id=a.task_id WHERE a.owner_id=? AND o.run_id=?`).get(owner,runId) as Row|undefined;
  if(!row)return null;const record=this.decode(row),seen=new Set<string>();let current=runId;
  for(;;){
   if(seen.has(current)||seen.size>50)throw Error('work_admission_lineage_invalid');seen.add(current);
   const run=this.db.prepare(`SELECT r.conversation_id,r.continuation_of,c.owner_id,c.workspace_id,c.project_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?`).get(current) as Row|undefined;
   if(!run||run.owner_id!==owner||run.conversation_id!==record.conversation_id||run.workspace_id!==record.scope.workspace_id||run.project_id!==record.scope.project_id)throw Error('work_admission_lineage_invalid');
   if(current===record.run_id){if(run.continuation_of)throw Error('work_admission_lineage_invalid');break;}
   const continuation=this.db.prepare('SELECT parent_run_id,occurrence_id FROM wb_task_continuations WHERE run_id=?').get(current) as Row|undefined;
   if(!continuation||continuation.occurrence_id!==record.occurrence_id||continuation.parent_run_id!==run.continuation_of)throw Error('work_admission_lineage_invalid');current=continuation.parent_run_id;
  }
  return record;
 });}
 guard(owner:string,runId:string):WorkAdmissionRecord{return this.read(()=>{
  const record=this.byRun(owner,runId);if(!record)throw Error('work_admission_not_found');const grant=new WorkGrants(this.db).get(owner,record.scope,record.grant_id);assertWorkGrantAuthority(this.db,grant);
  const occurrence=this.db.prepare(`SELECT o.*,c.run_id AS current_run_id,c.generation AS current_generation FROM wb_task_occurrences o JOIN wb_task_current_occurrences c ON c.occurrence_id=o.occurrence_id WHERE o.occurrence_id=? AND o.task_id=?`).get(record.occurrence_id,record.task_id) as Row|undefined;
  if(!occurrence||occurrence.generation!==record.task_generation||occurrence.current_generation!==record.task_generation||occurrence.current_run_id!==runId||occurrence.run_id!==record.run_id||occurrence.conversation_id!==record.conversation_id||occurrence.trigger_key!=='discovery-work:'+record.grant_id)throw Error('work_admission_authority_revoked');
  assertWorkBudgetBinding(this.db,owner,record.run_id,record.task_id,record.task_budget_scope_id);assertWorkBudgetBinding(this.db,owner,runId,record.task_id,record.task_budget_scope_id);return record;
 });}
}
