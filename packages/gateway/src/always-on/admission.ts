import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';
import type {HarnessCoordinator} from '../harness/coordinator.ts';
import {TaskBudgetService} from '../workbench/budget-public.ts';
import type {WorkbenchBudgetPolicy} from '../workbench/model-budget-policy.ts';
import {DiscoveryPolicies} from './discovery-policy.ts';
import {ProjectActivityObserver} from './project-activity.ts';
import {DiscoverySourceCollector} from './source-collector.ts';
import {evaluateDiscoveryGates} from './discovery-gates.ts';
import {discoveryPredecessorsAccepted,observeDiscoveryDormancy} from './dormancy.ts';

type Scope={project_id:string;workspace_id:string;agent_id:string};
type Row=Record<string,any>;
type Options={db:DatabaseSync;workbench:WorkbenchService;tasks:PersistentTaskService;policies:DiscoveryPolicies;
 coordinator:HarnessCoordinator;activity:ProjectActivityObserver;budgetPolicy:WorkbenchBudgetPolicy;maxAgeMs:number};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused=(reason:string)=>Object.freeze({admitted:false,reason,execution_authorized:false as const});
/** Original occurrence admission only, not an Agent/model loop. Not exposed as
 * a public/model tool and not automatically installed in Worker maintenance yet.
 * Discover-and-work waits for isolated-cycle/report/apply integration. */
export class DiscoveryAdmissionController{
 private readonly options:Options;
 private readonly sources:DiscoverySourceCollector;
 private readonly budgets:TaskBudgetService;
 constructor(options:Options){
  if(!Number.isSafeInteger(options.maxAgeMs)||options.maxAgeMs<1)throw Error('discovery_observation_config_invalid');
  this.options=Object.freeze({...options});this.sources=new DiscoverySourceCollector(options.db,options.policies);this.budgets=new TaskBudgetService(options.db,options.budgetPolicy);
 }
 async admit(owner:string,inputScope:Scope,signal?:AbortSignal){
  const o=this.options,initial=o.policies.get(owner,inputScope).policy;
  if(!initial||initial.effective_state!=='active')return refused('POLICY_DISABLED');
  const scope=Object.freeze({...initial.scope});
  if(initial.mode!=='discover_only')return refused('ISOLATED_WORK_CYCLE_REQUIRED');
  const source=this.sources.collect(owner,scope);if(!source.caught_up)return refused(source.reason??'SOURCE_PENDING');
  const observation=await o.activity.observe({owner_id:owner,...scope},signal);
  if(observation.reason)return refused(observation.reason);
  signal?.throwIfAborted();
  let occurrence;
  try{
   occurrence=o.tasks.enqueueDiscovery(owner,initial.policy_id,task=>{
    signal?.throwIfAborted();
    const policy=o.policies.get(owner,scope).policy;
    const deny=(reason:string):never=>{throw Error('discovery_gate:'+reason);};
    if(!policy||policy.version!==initial.version||policy.effective_state!=='active')deny('AUTHORITY_CHANGED');
    if(!o.activity.isCurrent(observation))deny('SOURCE_CHANGED');
    const current=this.sources.collect(owner,scope);
    if(!current.caught_up||current.signal_revision!==source.signal_revision)deny('SOURCE_CHANGED');
    const previous=o.db.prepare('SELECT signal_revision FROM wb_discovery_admissions WHERE policy_id=? ORDER BY rowid DESC LIMIT 1').get(initial.policy_id) as Row|undefined;
    if(!discoveryPredecessorsAccepted(o.db,owner,task.task_id))deny('PREVIOUS_CYCLE_UNACCEPTED');
    const dormancy=observeDiscoveryDormancy(o.db,owner,initial.policy_id);
    if(dormancy.state==='unknown')deny('DORMANCY_UNCONFIRMED');
    if(dormancy.state==='accepted'&&dormancy.revision===current.signal_revision)deny('DORMANT_NO_SIGNAL');
    if(previous?.signal_revision===current.signal_revision)deny('SIGNAL_ALREADY_ADMITTED');
    // Admission is not acceptance. Unaccepted or unknown predecessors hold even
    // when their native run has ended; no speculative new planning attempt.
    const budget=this.budgets.observeAdmission(owner,task.task_id),capacity=o.coordinator.observeBackgroundCapacity(owner),now=Date.now();
    const p=policy!,facts=observation.facts;
    const cycleCount=Number((o.db.prepare('SELECT count(*) n FROM wb_discovery_admissions WHERE owner_id=? AND policy_id=?').get(owner,p.policy_id) as Row).n);
    const advice=evaluateDiscoveryGates({protocol:1,enabled:p.effective_state==='active',scope:{owner_id:owner,...scope},revision:p.version,
      role_version:p.role_version,role_epoch:p.role_epoch,cooldown_ms:p.cooldown_ms,recent_input_ms:p.recent_input_ms},
     {protocol:1,scope:{owner_id:owner,...scope},policy_revision:p.version,role_version:facts.role_version,role_epoch:facts.role_epoch,
      observed_at:Math.min(observation.observed_at,budget.observed_at,capacity.observed_at),project_present:true,workspace_ready:facts.workspace_ready,
      role_active:facts.role_active,host_ready:facts.host_ready,native_idle:facts.native_idle,run_busy:facts.run_busy,
      last_user_input_at:facts.last_user_input_at,last_completed_at:facts.last_terminal_at,budget:budget.budget,background_slots:capacity.available,
      dormant_at_revision:dormancy.state==='accepted'?dormancy.revision:null,signal_revision:current.signal_revision,
      cycle_slots:p.max_cycles===null?null:Math.max(0,p.max_cycles-cycleCount),reservation:'available'},
     {now,max_age_ms:o.maxAgeMs});
    if(!advice.eligible)deny(advice.reason!);
    const head=o.db.prepare('SELECT * FROM wb_discovery_signals WHERE policy_id=? ORDER BY revision DESC LIMIT 1').get(p.policy_id);
    // Immutable ordered journal prefix is identified by its head and revision;
    // do not hash an unbounded source history under the writer lock.
    return {policy_version:p.version,role_version:p.role_version,role_epoch:p.role_epoch,signal_revision:current.signal_revision,
      signal_sha256:hash([p.policy_id,current.signal_revision,head??null]),activity_sha256:observation.source_sha256,budget_policy_revision:budget.budget_policy_revision};
   });
  }catch(error){if(error instanceof Error&&error.message.startsWith('discovery_gate:'))return refused(error.message.slice('discovery_gate:'.length));throw error;}
  return Object.freeze({admitted:true,reason:null,occurrence_id:occurrence.occurrence_id,execution_authorized:false as const});
 }
}
