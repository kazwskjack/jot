import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';
import type {HarnessCoordinator} from '../harness/coordinator.ts';
import {TaskBudgetService} from '../workbench/budget-public.ts';
import type {WorkbenchBudgetPolicy} from '../workbench/model-budget-policy.ts';
import type {DiscoveryPolicies} from './discovery-policy.ts';
import type {ProjectActivityObserver} from './project-activity.ts';
import type {LogicalWorkCycleWorkspaceManager} from './logical-work-cycle-workspace.ts';
import {evaluateDiscoveryGates} from './discovery-gates.ts';
import {WorkGrants} from './work-grants.ts';
import {WorkAdmissionRecords,type WorkAdmissionRecord} from './work-admission-records.ts';
import type {WorkCycleScope} from './work-cycles.ts';
import {DiscoverySourceCollector} from './source-collector.ts';

type Options={db:DatabaseSync;tasks:PersistentTaskService;policies:DiscoveryPolicies;activity:ProjectActivityObserver;
 coordinator:HarnessCoordinator;workspace:Pick<LogicalWorkCycleWorkspaceManager,'inspect'>;budgetPolicy:WorkbenchBudgetPolicy;maxAgeMs:number};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const refused=(reason:string)=>Object.freeze({admitted:false as const,reason,execution_authorized:false as const});
const accepted=(admission:WorkAdmissionRecord)=>Object.freeze({admitted:true as const,reason:null,admission,execution_authorized:false as const});

/** Internal original-occurrence admission prerequisite, deliberately not wired
 * to public tools, maintenance or Worker dispatch. A queue receipt is not a
 * completed native-work integration: isolated tools, evidence and trusted
 * Session/Goal bindings must all be configured before that path is exposed.
 * Every awaited source/artifact/native observation occurs outside SQL locks. */
export class WorkAdmissionController{
 private readonly o:Options;private readonly grants:WorkGrants;private readonly records:WorkAdmissionRecords;private readonly budgets:TaskBudgetService;private readonly sources:DiscoverySourceCollector;
 constructor(options:Options){
  if(!Number.isSafeInteger(options.maxAgeMs)||options.maxAgeMs<1)throw Error('work_admission_config_invalid');
  this.o=Object.freeze({...options});this.grants=new WorkGrants(options.db,options.budgetPolicy);this.records=new WorkAdmissionRecords(options.db);this.budgets=new TaskBudgetService(options.db,options.budgetPolicy);this.sources=new DiscoverySourceCollector(options.db,options.policies);
 }
 async admit(owner:string,inputScope:WorkCycleScope,grantId:string,signal:AbortSignal){
  const o=this.o;if(o.db.isTransaction)throw Error('work_admission_transaction_active');
  if(!(signal instanceof AbortSignal))throw Error('work_admission_signal_required');signal.throwIfAborted();
  const scope=Object.freeze({...inputScope});
  // Recover a committed response without observing or replaying any new work.
  try{return accepted(this.records.get(owner,scope,grantId));}catch(error){if(!(error instanceof Error)||error.message!=='work_admission_not_found')throw error;}
  const source=this.sources.collect(owner,scope);if(!source.caught_up||source.reason)return refused(source.reason??'SOURCE_PENDING');
  const grant=this.grants.guard(owner,scope,grantId),observation=await o.activity.observe({owner_id:owner,...scope},signal);
  if(observation.reason)return refused(observation.reason);signal.throwIfAborted();
  const inspected=await o.workspace.inspect(owner,scope,grant.cycle_id,{signal});signal.throwIfAborted();
  if(inspected.workspace.source_sha256!==grant.source_sha256||inspected.workspace.snapshot.receipt.snapshot_id!==grant.snapshot_id
    ||inspected.result.snapshot_id!==grant.snapshot_id||inspected.result.manifest_sha256!==inspected.workspace.snapshot.receipt.manifest_sha256)
   throw Error('work_admission_snapshot_changed');
  // inspect recovers the private journaled root, re-reads all original version
  // bytes and hashes the entire isolated tree. Never recopy or rebase on drift.
  const sourceVerified=digest({source_sha256:grant.source_sha256,manifest:inspected.workspace.source_manifest});
  try{
   const admission=o.tasks.enqueueDiscoveryWork(owner,grantId,(task,current)=>{
    signal.throwIfAborted();
    const sourceNow=this.sources.collect(owner,scope);
    if(!sourceNow.caught_up||sourceNow.reason)throw Error('work_admission_gate:'+(sourceNow.reason??'SOURCE_PENDING'));
    const fresh=this.grants.guard(owner,scope,grantId);
    if(digest(fresh)!==digest(grant)||digest(current)!==digest(grant))throw Error('work_admission_authority_revoked');
    const deny=(reason:string):never=>{throw Error('work_admission_gate:'+reason);};
    if(!o.activity.isCurrent(observation))deny('SOURCE_CHANGED');
    const policy=o.policies.get(owner,scope).policy;if(!policy||policy.version!==grant.policy_version)deny('AUTHORITY_CHANGED');
    const p=policy!,budget=this.budgets.observeAdmission(owner,grant.task_id),capacity=o.coordinator.observeBackgroundCapacity(owner),facts=observation.facts;
    const advice=evaluateDiscoveryGates({protocol:1,enabled:p.effective_state==='active',scope:{owner_id:owner,...scope},revision:p.version,
     role_version:p.role_version,role_epoch:p.role_epoch,cooldown_ms:p.cooldown_ms,recent_input_ms:p.recent_input_ms},
    {protocol:1,scope:{owner_id:owner,...scope},policy_revision:p.version,role_version:facts.role_version,role_epoch:facts.role_epoch,
     observed_at:Math.min(observation.observed_at,budget.observed_at,capacity.observed_at),project_present:true,workspace_ready:facts.workspace_ready,
     role_active:facts.role_active,host_ready:facts.host_ready,native_idle:facts.native_idle,run_busy:facts.run_busy,
     last_user_input_at:facts.last_user_input_at,last_completed_at:facts.last_terminal_at,budget:budget.budget,background_slots:capacity.available,
     // This is work within an already admitted cycle, not a fresh cycle.
     // The original task still counts and limits its occurrences independently.
     dormant_at_revision:null,signal_revision:grant.signal_revision,cycle_slots:null,reservation:'available'},
    {now:Date.now(),max_age_ms:o.maxAgeMs});
    if(!advice.eligible)deny(advice.reason!);
    if(budget.budget_policy_revision===null)throw Error('work_admission_budget_unconfirmed');
    return {activity_sha256:observation.source_sha256,native_sha256:digest(observation),capacity_sha256:digest(capacity),
     source_verified_sha256:sourceVerified,snapshot_verified_sha256:inspected.result.manifest_sha256,
     budget_policy_revision:budget.budget_policy_revision,observed_at:Math.min(observation.observed_at,budget.observed_at,capacity.observed_at)};
   });return accepted(admission);
  }catch(error){if(error instanceof Error&&error.message.startsWith('work_admission_gate:'))return refused(error.message.slice('work_admission_gate:'.length));throw error;}
 }
}
