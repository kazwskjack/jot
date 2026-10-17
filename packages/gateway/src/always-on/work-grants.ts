import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {TaskBudgetService} from '../workbench/budget-public.ts';
import type {WorkbenchBudgetPolicy} from '../workbench/model-budget-policy.ts';
import {WorkCycles,type WorkCycleScope,type WorkCyclePlan} from './work-cycles.ts';
import {WorkCycleSources} from './work-cycle-sources.ts';
import {WorkspaceJournal} from './workspace-journal.ts';

type Row=Record<string,any>;
export type AuthorizeWork={expected_cycle_version:number;expected_policy_version:number;expected_role_version:number;expected_role_epoch:number;snapshot_id:string;source_sha256:string};
export type WorkGrant=Readonly<{
 protocol:1;grant_id:string;owner_id:string;scope:Readonly<WorkCycleScope>;cycle_id:string;cycle_version:number;
 admission_id:string;report_sha256:string;plans:readonly WorkCyclePlan[];plans_sha256:string;plan_paths:readonly string[];paths_sha256:string;
 task_id:string;task_version:number;task_generation:number;task_budget_scope_id:string;
 planning_occurrence_id:string;planning_source_generation:number;planning_occurrence_generation:number;planning_root_run_id:string;planning_current_run_id:string;
 policy_version:number;role_version:number;role_epoch:number;signal_revision:number;signal_sha256:string;
 snapshot_id:string;source_sha256:string;source_record_sha256:string;snapshot_record_sha256:string;root_binding_sha256:string;selection_sha256:string;
 created_at:string;execution_authorized:false;source_bytes_verified:false;
}>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>hash(canonicalJson(value));
function fail(code:string):never{throw Error(code);}
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail('work_grant_invalid');}
function identifier(value:unknown){if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f\x7f]/.test(value))fail('work_grant_invalid');}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Immutable owner selection prerequisite. Historical receipts never assert live
 * authority. Fresh guards check database facts only; admission must separately
 * verify source/artifact bytes and current native, capacity and tool authority.
 * Constructor and reads perform no schema installation, repair or allocation. */
export class WorkGrants{
 private readonly db:DatabaseSync;private readonly cycles:WorkCycles;private readonly sources:WorkCycleSources;private readonly journal:WorkspaceJournal;private readonly budgets:TaskBudgetService;
 constructor(db:DatabaseSync,budgetPolicy?:WorkbenchBudgetPolicy){this.db=db;this.cycles=new WorkCycles(db);this.sources=new WorkCycleSources(db);this.journal=new WorkspaceJournal(db);this.budgets=new TaskBudgetService(db,budgetPolicy);}
 private read<T>(fn:()=>T):T{if(this.db.isTransaction)return fn();this.db.exec('BEGIN DEFERRED');try{return fn();}finally{this.db.exec('ROLLBACK');}}
 private scoped(owner:string,scope:WorkCycleScope,grantId:string){identifier(grantId);exact(scope,['agent_id','project_id','workspace_id']);const row=this.db.prepare('SELECT * FROM wb_discovery_work_grants WHERE grant_id=? AND owner_id=? AND project_id=? AND workspace_id=? AND agent_id=?').get(grantId,owner,scope.project_id,scope.workspace_id,scope.agent_id) as Row|undefined;if(!row)fail('work_grant_not_found');this.cycles.get(owner,scope,row.cycle_id);return row;}
 private decode(row:Row):WorkGrant{
  try{const grant=JSON.parse(row.grant_json);if(hash(row.grant_json)!==row.grant_sha256||canonicalJson(grant)!==row.grant_json||grant.protocol!==1||grant.execution_authorized!==false||grant.source_bytes_verified!==false||grant.grant_id!==row.grant_id||grant.cycle_id!==row.cycle_id||grant.cycle_version!==row.cycle_version||grant.snapshot_id!==row.snapshot_id||grant.owner_id!==row.owner_id||canonicalJson(grant.scope)!==canonicalJson({project_id:row.project_id,workspace_id:row.workspace_id,agent_id:row.agent_id})||grant.created_at!==row.created_at||digest(grant.plans)!==grant.plans_sha256||digest(grant.plan_paths)!==grant.paths_sha256)throw Error();return frozen(grant) as WorkGrant;}catch{fail('work_grant_corrupt');}
 }
 private facts(owner:string,scope:WorkCycleScope,cycleId:string,input:AuthorizeWork){
  const cycle=this.cycles.guard(owner,scope,cycleId);
  if(cycle.version!==input.expected_cycle_version||cycle.policy_version!==input.expected_policy_version||cycle.role_version!==input.expected_role_version||cycle.role_epoch!==input.expected_role_epoch)fail('work_grant_version_conflict');
  const row=this.db.prepare('SELECT * FROM wb_discovery_work_cycles WHERE cycle_id=?').get(cycleId) as Row;
  const occurrence=this.db.prepare('SELECT generation FROM wb_task_current_occurrences WHERE occurrence_id=? AND task_id=?').get(cycle.occurrence_id,cycle.task_id) as Row|undefined;
  const original=this.db.prepare('SELECT generation FROM wb_task_occurrences WHERE occurrence_id=? AND task_id=?').get(cycle.occurrence_id,cycle.task_id) as Row|undefined;
  if(!occurrence||!original||occurrence.generation<0||original.generation<0)fail('work_grant_authority_revoked');
  const source=this.sources.get(owner,scope,cycleId),intent=this.journal.intent(owner,scope,cycleId);
  if(!source||!intent)fail('work_grant_artifact_required');
  if(source.sha256!==input.source_sha256)fail('work_grant_source_changed');
  if(intent.snapshot_id!==input.snapshot_id)fail('work_grant_snapshot_conflict');
  const record=this.journal.record(owner,scope,cycleId,input.snapshot_id);if(!record)fail('work_grant_artifact_required');
  // Compare identities in one byte order; persisted manifests retain their original ordering and hashes.
  const byPath=(a:{path:string},b:{path:string})=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path));
  const snapshotFiles=record.manifest.entries.filter(entry=>entry.kind==='file').map(entry=>({path:entry.path,sha256:entry.sha256,size:entry.bytes})).sort(byPath);
  const sourceFiles=source.files.map(file=>({path:file.path,sha256:file.sha256,size:file.size})).sort(byPath);
  if(canonicalJson(snapshotFiles)!==canonicalJson(sourceFiles))fail('work_grant_snapshot_source_mismatch');
  const inventory=this.db.prepare('SELECT path,version,sha256,size,blob_name FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? ORDER BY path COLLATE BINARY').all(owner,scope.workspace_id,scope.project_id);
  if(canonicalJson(inventory)!==canonicalJson(source.files))fail('work_grant_source_changed');
  const budget=this.budgets.observeAdmission(owner,cycle.task_id);if(budget.budget!=='allowed')fail('work_grant_budget_unconfirmed');
  return {cycle,row,occurrence,original,source,intent,record};
 }
 authorize(owner:string,scope:WorkCycleScope,cycleId:string,input:AuthorizeWork,key:string):WorkGrant{
  identifier(owner);identifier(cycleId);identifier(key);exact(scope,['agent_id','project_id','workspace_id']);Object.values(scope).forEach(identifier);
  exact(input,['expected_cycle_version','expected_policy_version','expected_role_version','expected_role_epoch','snapshot_id','source_sha256']);identifier(input.snapshot_id);
  for(const value of [input.expected_cycle_version,input.expected_policy_version,input.expected_role_version,input.expected_role_epoch])if(!Number.isSafeInteger(value)||value<1)fail('work_grant_invalid');
  if(typeof input.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.source_sha256))fail('work_grant_invalid');
  return withImmediateTransaction(this.db,()=>{
   this.cycles.get(owner,scope,cycleId);
   const fingerprint=digest({action:'authorize-work',scope,cycle_id:cycleId,input}),prior=this.db.prepare('SELECT * FROM wb_discovery_work_grant_commands WHERE owner_id=? AND command_key=?').get(owner,key) as Row|undefined;
   if(prior){if(prior.command_sha256!==fingerprint)fail('idempotency_conflict');const row=this.scoped(owner,scope,prior.grant_id),grant=this.decode(row);if(row.grant_json!==prior.receipt_json)fail('work_grant_corrupt');return grant;}
   if(this.db.prepare('SELECT 1 FROM wb_discovery_work_grants WHERE cycle_id=?').get(cycleId))fail('work_grant_exists');
   const {cycle,row,occurrence,original,source,intent,record}=this.facts(owner,scope,cycleId,input),paths=[...new Set(cycle.plans.flatMap(plan=>plan.paths))].sort();
   const grant:WorkGrant=frozen({protocol:1,grant_id:'work-grant-'+randomUUID(),owner_id:owner,scope:{...scope},cycle_id:cycleId,cycle_version:cycle.version,
    admission_id:cycle.admission_id,report_sha256:cycle.report_sha256,plans:cycle.plans,plans_sha256:digest(cycle.plans),plan_paths:paths,paths_sha256:digest(paths),
    task_id:cycle.task_id,task_version:row.task_version,task_generation:row.task_generation,task_budget_scope_id:row.task_budget_scope_id,
    planning_occurrence_id:cycle.occurrence_id,planning_source_generation:original.generation,planning_occurrence_generation:occurrence.generation,planning_root_run_id:cycle.root_run_id,planning_current_run_id:row.current_run_id,
    policy_version:cycle.policy_version,role_version:cycle.role_version,role_epoch:cycle.role_epoch,signal_revision:row.signal_revision,signal_sha256:row.signal_sha256,
    snapshot_id:input.snapshot_id,source_sha256:source.sha256,source_record_sha256:digest(source),snapshot_record_sha256:digest(record),root_binding_sha256:intent.root_binding_sha256,selection_sha256:intent.selection_sha256,
    created_at:new Date().toISOString(),execution_authorized:false,source_bytes_verified:false});
   const json=canonicalJson(grant);this.db.prepare('INSERT INTO wb_discovery_work_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(grant.grant_id,cycleId,owner,scope.project_id,scope.workspace_id,scope.agent_id,cycle.version,input.snapshot_id,json,hash(json),grant.created_at);
   this.db.prepare('INSERT INTO wb_discovery_work_grant_commands VALUES(?,?,?,?,?,?)').run(owner,key,fingerprint,grant.grant_id,json,grant.created_at);return grant;
  });
 }
 get(owner:string,scope:WorkCycleScope,grantId:string):WorkGrant{return this.read(()=>this.decode(this.scoped(owner,scope,grantId)));}
 guard(owner:string,scope:WorkCycleScope,grantId:string):WorkGrant{return this.read(()=>{
  const grant=this.decode(this.scoped(owner,scope,grantId)),{cycle,row,occurrence,original,source,intent,record}=this.facts(owner,scope,grant.cycle_id,{expected_cycle_version:grant.cycle_version,expected_policy_version:grant.policy_version,expected_role_version:grant.role_version,expected_role_epoch:grant.role_epoch,snapshot_id:grant.snapshot_id,source_sha256:grant.source_sha256});
  if(cycle.admission_id!==grant.admission_id||cycle.report_sha256!==grant.report_sha256||digest(cycle.plans)!==grant.plans_sha256||row.task_version!==grant.task_version||row.task_generation!==grant.task_generation||row.task_budget_scope_id!==grant.task_budget_scope_id||cycle.task_id!==grant.task_id||cycle.occurrence_id!==grant.planning_occurrence_id||original.generation!==grant.planning_source_generation||occurrence.generation!==grant.planning_occurrence_generation||cycle.root_run_id!==grant.planning_root_run_id||row.current_run_id!==grant.planning_current_run_id||row.signal_revision!==grant.signal_revision||row.signal_sha256!==grant.signal_sha256||digest(source)!==grant.source_record_sha256||digest(record)!==grant.snapshot_record_sha256||intent.root_binding_sha256!==grant.root_binding_sha256||intent.selection_sha256!==grant.selection_sha256)fail('work_grant_authority_revoked');
  return grant;
 });}
}




