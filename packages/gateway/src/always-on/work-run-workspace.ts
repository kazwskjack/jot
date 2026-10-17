import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import type {TrustedWorkRunWorkspace} from '../harness/worker.ts';
import {assertExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';
import type {WorkbenchService} from '../workbench/service.ts';
import type {DiscoveryPolicies} from './discovery-policy.ts';
import {DiscoveryHistory} from './discovery-history.ts';
import {DiscoverySourceCollector} from './source-collector.ts';
import {WorkAdmissionRecords,freezeWorkAdmission} from './work-admission-records.ts';
import {WorkGrants} from './work-grants.ts';
import {WorkspaceJournal} from './workspace-journal.ts';
import type {LogicalWorkCycleWorkspaceManager} from './logical-work-cycle-workspace.ts';
import type {IsolatedFileIdentity,ResolvedIsolatedFiles} from './isolated-work-files.ts';
import type {WorkspaceManifest} from './workspace-provider.ts';

type Options={db:DatabaseSync;workbench:Pick<WorkbenchService,'assertRunActive'>;policies:DiscoveryPolicies;workspace:Pick<LogicalWorkCycleWorkspaceManager,'inspect'>};
type FullPlan=ReturnType<DiscoveryHistory['detail']>['plans'][number];
const fail=(reason:string)=>Error('work_workspace_'+reason);
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Versioned complete plan serialization. Changing this format requires native
 * Goal compatibility; it is shared by initial prompts and private guard context. */
export function selectedWorkObjective(plans:readonly FullPlan[]):string{
 const objective=canonicalJson({protocol:1,kind:'selected_discovery_work',plans});
 if(!plans.length||objective.length>65536)throw fail('objective_limit');
 return objective;
}

/** A single original admission derivation for synchronous authenticated context
 * and asynchronous native/IO entry. No public path mapping or snapshot creation. */
export class TrustedWorkRunWorkspaceResolver{
 private readonly o:Options;private readonly records:WorkAdmissionRecords;private readonly grants:WorkGrants;private readonly journal:WorkspaceJournal;private readonly history:DiscoveryHistory;private readonly sources:DiscoverySourceCollector;
 constructor(options:Options){this.o=options;this.records=new WorkAdmissionRecords(options.db);this.grants=new WorkGrants(options.db);this.journal=new WorkspaceJournal(options.db);this.history=new DiscoveryHistory(options.db);this.sources=new DiscoverySourceCollector(options.db,options.policies);}
 context(runId:string,lease?:ExecutionLease){
  const {db}=this.o;if(db.isTransaction)return this.derive(runId,lease);
  db.exec('BEGIN DEFERRED');try{return this.derive(runId,lease);}finally{db.exec('ROLLBACK');}
 }
 private derive(runId:string,lease?:ExecutionLease){
  const {db}=this.o;
  const run=db.prepare('SELECT c.owner_id,r.conversation_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?').get(runId) as {owner_id:string;conversation_id:string}|undefined;
  if(!run)throw fail('run_missing');
  const admission=this.records.byRun(run.owner_id,runId);
  if(!admission){if(db.prepare("SELECT 1 FROM wb_task_run_occurrences WHERE run_id=? AND trigger_key LIKE 'discovery-work:%'").get(runId))throw fail('admission_missing');return null;}
  if(lease)assertExecutionLease(db,runId,lease);
  this.o.workbench.assertRunActive(runId);this.records.guard(run.owner_id,runId);
  if(db.prepare("SELECT 1 FROM wb_model_budget_attempts a JOIN wb_model_budget_bindings b ON b.run_id=a.run_id JOIN json_each(b.scopes_json) s WHERE b.owner_id=? AND a.state='unknown' AND s.value=? LIMIT 1").get(run.owner_id,admission.task_budget_scope_id))throw fail('budget_usage_unknown');
  const grant=this.grants.get(run.owner_id,admission.scope,admission.grant_id),intent=this.journal.intent(run.owner_id,admission.scope,admission.cycle_id),record=this.journal.record(run.owner_id,admission.scope,admission.cycle_id,admission.snapshot_id);
  if(!intent||!record||intent.snapshot_id!==admission.snapshot_id||record.snapshot_id!==admission.snapshot_id||digest(record)!==grant.snapshot_record_sha256)throw fail('journal_changed');
  const session=db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE owner_id=? AND conversation_id=?').get(run.owner_id,run.conversation_id) as {session_id:string}|undefined;
  if(!session?.session_id)throw fail('session_missing');
  const selected=new Map<string,FullPlan>();let cursor:string|undefined;const seen=new Set<string>();
  do{
   const page=this.history.detail(run.owner_id,admission.scope,grant.admission_id,cursor);
   if(!page.cycle.accepted||page.report?.sha256!==grant.report_sha256)throw fail('plans_unaccepted');
   for(const plan of page.plans){const expected=grant.plans.find(p=>p.plan_id===plan.plan_id);if(!expected)continue;
    const paths=[...new Set(plan.changes.map(c=>c.path))].sort();
    if(selected.has(plan.plan_id)||expected.sha256!==plan.sha256||canonicalJson(paths)!==canonicalJson([...expected.paths].sort())||!page.report.plan_ids.includes(plan.plan_id))throw fail('plan_changed');selected.set(plan.plan_id,plan);
   }
   const next=page.next_after_plan_id;if(next&&seen.has(next))throw fail('plan_cursor');if(next)seen.add(next);cursor=next??undefined;
  }while(cursor);
  if(selected.size!==grant.plans.length)throw fail('plan_missing');
  const objective=selectedWorkObjective(grant.plans.map(plan=>selected.get(plan.plan_id)!));
  return freezeWorkAdmission({work_binding:{kind:'isolated_work' as const,original_run_id:admission.run_id,occurrence_id:admission.occurrence_id},native_workspace:{protocol:1 as const,cwd:record.isolated_root.path},objective,admission,grant,record,sessionRef:session.session_id});
 }
 private pending(cycleId:string){if(this.o.db.prepare('SELECT 1 FROM wb_isolated_file_pending WHERE cycle_id=?').get(cycleId))throw fail('pending');}
 private reconcile(binding:NonNullable<ReturnType<TrustedWorkRunWorkspaceResolver['context']>>,manifest:WorkspaceManifest){
  const {db}=this.o,{grant,record,admission}=binding,expected=new Map(record.manifest.entries.map(entry=>[entry.path,entry]));
  const plans=new Set(grant.plan_paths);
  for(const path of plans){
   const row=db.prepare('SELECT r.*,i.identity_json FROM wb_isolated_file_results r JOIN wb_isolated_file_intents i ON i.call_key=r.call_key WHERE r.cycle_id=? AND r.snapshot_id=? AND r.path=? AND r.version IS NOT NULL ORDER BY r.version DESC LIMIT 1').get(admission.cycle_id,admission.snapshot_id,path) as Record<string,any>|undefined;
   if(!row)continue;
   const identity=JSON.parse(row.identity_json),response=JSON.parse(row.response_json),producer=this.records.byRun(admission.owner_id,identity.run_id),bytes=Buffer.from(row.bytes);
   if(!producer||producer.grant_id!==admission.grant_id||identity.owner_id!==admission.owner_id||identity.workspace_id!==admission.scope.workspace_id||identity.project_id!==admission.scope.project_id||identity.agent_id!==admission.scope.agent_id||identity.cycle_id!==admission.cycle_id||identity.snapshot_id!==admission.snapshot_id||identity.occurrence_id!==admission.occurrence_id||response.receipt_id!==row.receipt_id||response.run_id!==identity.run_id||response.call_id!==identity.call_id||response.sha256!==row.sha256||response.version!==row.version||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw fail('version_changed');
   expected.set(path,{path,kind:'file',sha256:row.sha256,bytes:bytes.length,executable:false});
   const parts=path.split('/');parts.pop();while(parts.length){const directory=parts.join('/');if(!expected.has(directory))expected.set(directory,{path:directory,kind:'directory'});parts.pop();}
  }
  if(manifest.entries.length!==expected.size)throw fail('isolated_changed');
  for(const actual of manifest.entries){const saved=expected.get(actual.path);if(!saved||canonicalJson(saved)!==canonicalJson(actual))throw fail('isolated_changed');}
 }
 async inspectForRun(runId:string,lease:ExecutionLease){
  if(this.o.db.isTransaction)throw fail('outer_transaction_forbidden');
  let binding=this.context(runId,lease);if(!binding)return null;
  const source=this.sources.collect(binding.admission.owner_id,binding.admission.scope);if(!source.caught_up||source.reason)throw fail('source_unconfirmed');
  binding=this.context(runId,lease)!;this.pending(binding.admission.cycle_id);const frozen=digest(binding);
  const inspected=await this.o.workspace.inspect(binding.admission.owner_id,binding.admission.scope,binding.admission.cycle_id,{signal:new AbortController().signal});
  const sourceNow=this.sources.collect(binding.admission.owner_id,binding.admission.scope);if(!sourceNow.caught_up||sourceNow.reason)throw fail('source_unconfirmed');
  const current=this.context(runId,lease);if(!current||digest(current)!==frozen)throw fail('binding_changed');this.pending(binding.admission.cycle_id);
  if(inspected.workspace.snapshot.isolated_root!==binding.record.isolated_root.path||inspected.workspace.source_sha256!==binding.grant.source_sha256||inspected.workspace.snapshot.receipt.snapshot_id!==binding.admission.snapshot_id||inspected.result.snapshot_id!==binding.admission.snapshot_id||canonicalJson(inspected.workspace.plan_paths)!==canonicalJson(binding.grant.plan_paths))throw fail('snapshot_changed');
  this.reconcile(binding,inspected.result.manifest);
  return Object.freeze({...binding,binding:binding.work_binding,journalRecord:binding.record,workspace:inspected.workspace,inspection:inspected.result});
 }
 async resolve(runId:string,lease:ExecutionLease):Promise<TrustedWorkRunWorkspace|null>{
  const bound=await this.inspectForRun(runId,lease);if(!bound)return null;const a=bound.admission;
  return freezeWorkAdmission({kind:'isolated_work',runId,originalRunId:a.run_id,ownerId:a.owner_id,conversationId:a.conversation_id,taskId:a.task_id,occurrenceId:a.occurrence_id,sessionRef:bound.sessionRef,cwd:bound.native_workspace.cwd,objective:bound.objective});
 }
 async resolveFiles(identity:IsolatedFileIdentity,lease:ExecutionLease):Promise<ResolvedIsolatedFiles>{
  const bound=await this.inspectForRun(identity.run_id,lease);if(!bound)throw fail('admission_missing');const a=bound.admission;
  const binding={owner_id:a.owner_id,...a.scope,cycle_id:a.cycle_id,snapshot_id:a.snapshot_id,run_id:identity.run_id,occurrence_id:a.occurrence_id};
  for(const key of Object.keys(binding) as (keyof typeof binding)[])if(identity[key]!==binding[key])throw fail('file_identity');
  const expected=digest(this.context(identity.run_id,lease));
  return {workspace:bound.workspace,record:bound.record,binding,guard:()=>{if(digest(this.context(identity.run_id,lease))!==expected)throw fail('binding_changed');}};
 }
}
