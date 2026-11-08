import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {nativeIdleSessionId,validateNativeIdleObservation,type NativeIdleObservation} from '../harness/native-idle-observation.ts';
import {validateTaskGoalStatus} from '../harness/task-goal-status.ts';
import {normalizeBrowserDriverScope,validateBrowserDriverObservation,type BrowserDriverScope,type SessionControllerClient} from '../harness/session-controller-client.ts';
import {inspectOrdinaryExecutionPolicy} from '../conversations/execution-policy.ts';
import {executionPolicy} from '../conversations/mode-policy.ts';
import {acceptedModelPolicyCandidates,canonicalModelJson} from '../conversations/model-policy.ts';
import {WorkAdmissionRecords} from '../always-on/work-admission-records.ts';
import {assertExecutionLease,normalizeExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';
import {hasRequiredColumns,SESSION_BINDING_SCHEMA} from './runtime-readiness-schema.ts';
import {
  collectRuntimeReadinessObservations,
  RUNTIME_READINESS_MAX_AGE_MS,
  RUNTIME_READINESS_MAX_FUTURE_SKEW_MS,
  type CollectRuntimeReadinessOptions,
  type RuntimeReadinessSample,
} from './runtime-readiness-observations.ts';
import type {RuntimeDependency,RuntimeDependencyStatus,RuntimeReadiness} from './runtime-readiness.ts';

export interface RuntimeReadinessScope {
  owner_id:string;
  workspace_id:string;
}

export interface RuntimeReadinessRunScope extends RuntimeReadinessScope {
  run_id:string;
}

export interface RuntimeReadinessBoundSample {
  protocol:1;
  scope:Readonly<RuntimeReadinessRunScope>;
  status:RuntimeDependencyStatus;
  required:boolean;
  observed_at:string;
  reason?:string;
}

export type RuntimeReadinessBoundStatusPort=(scope:Readonly<RuntimeReadinessRunScope>,signal:AbortSignal)=>RuntimeReadinessBoundSample|Promise<RuntimeReadinessBoundSample>;

export type RuntimeReadinessSources={
  native?:Pick<SessionControllerClient,'observeNativeIdle'>;
  workbench?:Pick<SessionControllerClient,'goalStatus'>;
  consumer?:RuntimeReadinessBoundStatusPort;
  storage?:RuntimeReadinessBoundStatusPort;
  driver?:RuntimeReadinessBoundStatusPort;
};

export interface RuntimeReadinessSourceGap {
  component:Exclude<RuntimeDependency,'db'|'schema'>;
  code:string;
  source_symbol:string;
}

export interface RuntimeReadinessFreshness {
  host:null|{
    observed_at_earliest:string;
    observed_at_latest:string;
    max_age_ms:number;
    session_count:number;
    bindings_stable:boolean|null;
  };
  native:null|{
    observed_at_earliest:string;
    observed_at_latest:string;
    max_age_ms:number;
    session_count:number;
    bindings_stable:boolean|null;
  };
}

export interface RuntimeReadinessComposition {
  protocol:1;
  scope:Readonly<RuntimeReadinessScope>;
  collected_at:string|null;
  freshness:RuntimeReadinessFreshness;
  readiness:RuntimeReadiness;
  source_gaps:RuntimeReadinessSourceGap[];
  execution_authorized:false;
}

const SCOPE_KEYS='owner_id,run_id,workspace_id';
const BOUND_SAMPLE_KEYS='observed_at,protocol,required,scope,status';
const BOUND_SAMPLE_REASON_KEYS='observed_at,protocol,reason,required,scope,status';
const SAFE_BOUND_REASON=/^[a-z][a-z0-9_]{0,63}$/;
const ACTIVE_RUN_STATUSES=new Set(['starting','running','waiting_user','waiting_approval','cancelling']);
const STORAGE_FAILURE_CODES=new Set([
  'logical_workspace_storage_changed','logical_workspace_storage_invalid','logical_workspace_storage_unsafe',
  'workspace_path_unsafe','workspace_inspection_failed','workspace_snapshot_failed',
  'workspace_recovery_storage_changed','workspace_recovery_root_changed',
]);

const UNBOUND_SOURCE_GAPS:RuntimeReadinessSourceGap[]=[
  {component:'host',code:'host_status_port_missing',source_symbol:'SessionControllerClient.goalStatus(sessionId,signal) is the existing authenticated status read for an exact Workbench run only. It does not report generic Host lifecycle; nativeIdleObservationReadiness() is configuration-derived and host resource observations are per-run measurements, so unsupported scopes stay unknown.'},
  {component:'consumer',code:'consumer_status_port_missing',source_symbol:'HarnessWorker.observeConsumerReadiness(scope,signal) reads the active in-process run and exact ga_runs/ga_conversations/ga_worker_leases binding. packages/gateway/src/harness/main.ts registers runtimeReadinessSources.consumer after worker construction; if that source is not supplied, readiness stays unknown.'},
  {component:'storage',code:'storage_status_port_missing',source_symbol:'packages/gateway/src/harness/main.ts registers createRuntimeReadinessStorageSource(db,nativeWork.resolver) only when createNativeWorkRuntime returns nativeWork. The read-only path is TrustedWorkRunWorkspaceResolver.inspectForRun(run_id,lease) → LogicalWorkCycleWorkspaceManager.inspect() → SnapshotCopyWorkspaceProvider.inspect(); it requires the exact active Workbench discovery run and verified snapshot/manifest receipt. Missing or unsupported source remains unknown.'},
  {component:'driver',code:'driver_status_port_missing',source_symbol:'SessionControllerClient.observeBrowserDriver(sessionId, exact scope, signal) and packages/gateway/src/harness/main.ts register the passive run-bound Host read through createBrowserDriverReadinessSource(db, sessionClient). If the source is absent or observation/binding is unconfirmed, driver remains unknown. NativeGitClient.execute() is an operation, not readiness evidence.'},
];

function scopeOf(value:unknown):Readonly<RuntimeReadinessRunScope>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('runtime_readiness_scope_invalid');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!==SCOPE_KEYS||['run_id','owner_id','workspace_id'].some(key=>
    typeof row[key]!=='string'||!(row[key] as string).trim()||(row[key] as string).length>256||/[\u0000-\u001f\u007f]/.test(row[key] as string)))
    throw Error('runtime_readiness_scope_invalid');
  return Object.freeze({run_id:row.run_id as string,owner_id:row.owner_id as string,workspace_id:row.workspace_id as string});
}

function validateBoundSample(value:unknown,expectedScope:Readonly<RuntimeReadinessRunScope>,component:'consumer'|'storage'|'driver'):RuntimeReadinessSample{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${component}_sample_invalid`);
  const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(',');
  if((keys!==BOUND_SAMPLE_KEYS&&keys!==BOUND_SAMPLE_REASON_KEYS)||row.protocol!==1
    ||!['ready','disabled','unknown','failed'].includes(String(row.status))||typeof row.required!=='boolean'
    ||typeof row.observed_at!=='string'||row.observed_at.length>64
    ||(row.reason!==undefined&&(typeof row.reason!=='string'||!SAFE_BOUND_REASON.test(row.reason))))
    throw Error(`${component}_sample_invalid`);
  let observed:Readonly<RuntimeReadinessRunScope>;
  try{observed=scopeOf(row.scope);}catch{throw Error(`${component}_sample_invalid`);}
  if(observed.run_id!==expectedScope.run_id||observed.owner_id!==expectedScope.owner_id||observed.workspace_id!==expectedScope.workspace_id)
    throw Error(`${component}_scope_mismatch`);
  return{status:row.status as RuntimeDependencyStatus,required:row.required,observed_at:row.observed_at as string,
    ...(typeof row.reason==='string'?{reason:row.reason}:{})};
}

function unknownSample(reason:string,observedAt:Date):RuntimeReadinessSample{
  const time=observedAt.getTime();
  return{status:'unknown',required:true,...(Number.isFinite(time)?{observed_at:observedAt.toISOString()}:{}),reason};
}

function boundStatusPort(component:'consumer'|'storage'|'driver',source:RuntimeReadinessBoundStatusPort,
  scope:Readonly<RuntimeReadinessRunScope>,now:()=>Date):(signal:AbortSignal)=>Promise<RuntimeReadinessSample>{
  return async signal=>{
    signal.throwIfAborted();
    try{
      const sample=validateBoundSample(await source(scope,signal),scope,component);
      signal.throwIfAborted();
      return sample;
    }catch(error){
      if(signal.aborted)throw error;
      let observedAt:Date;try{observedAt=now();}catch{observedAt=new Date(Number.NaN);}
      const detail=error instanceof Error?error.message:'';
      return unknownSample(detail===`${component}_scope_mismatch`?detail:`${component}_sample_invalid`,observedAt);
    }
  };
}

type RunBinding=Readonly<{run_id:string;conversation_id:string;owner_id:string;workspace_id:string;status:string;
  session_id:string|null;workbench:boolean;lease:ExecutionLease}>;

function readRunBinding(db:DatabaseSync,scope:Readonly<RuntimeReadinessRunScope>,schemaValidated=false):RunBinding|undefined{
  if(!schemaValidated&&!hasRequiredColumns(db,SESSION_BINDING_SCHEMA))return;
  const row=db.prepare(`SELECT r.id AS run_id,r.conversation_id,r.status,c.owner_id,c.workspace_id,c.archived_at,
      n.session_id,
      EXISTS(SELECT 1 FROM ga_conversation_mode_sessions m WHERE m.conversation_id=c.id AND m.owner_id=c.owner_id
        AND m.mode='work' AND m.session_id=n.session_id) AS workbench,
      l.owner AS lease_owner,l.generation AS lease_generation,l.expires_at
    FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    LEFT JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
    LEFT JOIN ga_worker_leases l ON l.resource_id=r.id WHERE r.id=?`).get(scope.run_id) as
    {run_id?:unknown;conversation_id?:unknown;status?:unknown;owner_id?:unknown;workspace_id?:unknown;archived_at?:unknown;
      session_id?:unknown;workbench?:unknown;lease_owner?:unknown;lease_generation?:unknown;expires_at?:unknown}|undefined;
  if(!row||row.run_id!==scope.run_id||typeof row.conversation_id!=='string'||row.archived_at!==null
    ||row.owner_id!==scope.owner_id||row.workspace_id!==scope.workspace_id||typeof row.status!=='string'
    ||!ACTIVE_RUN_STATUSES.has(row.status))return;
  const lease=normalizeExecutionLease({owner:row.lease_owner,generation:row.lease_generation});
  assertExecutionLease(db,scope.run_id,lease);
  let sessionId:string|null=null;
  if(row.session_id!==null){if(typeof row.session_id!=='string')return;nativeIdleSessionId(row.session_id);sessionId=row.session_id;}
  return Object.freeze({run_id:scope.run_id,conversation_id:row.conversation_id,owner_id:scope.owner_id,workspace_id:scope.workspace_id,
    status:row.status,session_id:sessionId,workbench:row.workbench===1,lease});
}

function sameRunBinding(left:RunBinding|undefined,right:RunBinding|undefined):right is RunBinding{
  return !!left&&!!right&&left.run_id===right.run_id&&left.conversation_id===right.conversation_id
    &&left.owner_id===right.owner_id&&left.workspace_id===right.workspace_id&&left.status===right.status
    &&left.session_id===right.session_id&&left.workbench===right.workbench
    &&left.lease.owner===right.lease.owner&&left.lease.generation===right.lease.generation;
}

function runBindingFingerprint(binding:RunBinding):string{
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

function storageSample(scope:Readonly<RuntimeReadinessRunScope>,status:RuntimeDependencyStatus,observedAt:Date,reason?:string):RuntimeReadinessBoundSample{
  if(!(observedAt instanceof Date)||!Number.isFinite(observedAt.getTime()))throw Error('runtime_readiness_clock_invalid');
  return Object.freeze({protocol:1,scope,status,required:true,observed_at:observedAt.toISOString(),...(reason?{reason}:{})});
}

function withReadSnapshot<T>(db:DatabaseSync,read:()=>T):T{
  if(db.isTransaction)return read();
  db.exec('BEGIN DEFERRED');
  try{return read();}finally{db.exec('ROLLBACK');}
}

/** Discovery-work has a verifiable immutable admission; other task kinds stay
 * unknown until they expose an equivalent read-only admission receipt. */
function inspectAdmittedTaskPolicy(db:DatabaseSync,scope:Readonly<RuntimeReadinessRunScope>,before:RunBinding):string{
  return withReadSnapshot(db,()=>{
    const current=readRunBinding(db,scope,true);
    if(!sameRunBinding(before,current))throw Error('policy_scope_changed');
    if(!current?.workbench||!current.session_id||current.status!=='running')throw Error('policy_scope_unsupported');
    const admissionTables=['wb_run_bindings','wb_task_current_occurrences','wb_persistent_tasks','wb_agents','wb_discovery_work_admissions'];
    if(admissionTables.some(name=>!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name)))
      throw Error('policy_admission_unavailable');
    const row=db.prepare(`SELECT b.owner_id,b.agent_id,b.epoch,b.kind,b.context_json,
        o.task_id,o.occurrence_id,o.generation,o.root_run_id,o.conversation_id,o.trigger_key,
        t.owner_id AS task_owner,t.agent_id AS task_agent,t.status AS task_status,t.version AS task_version,t.generation AS task_generation,
        a.workspace_id AS agent_workspace,a.project_id AS agent_project,a.status AS agent_status,a.capability_epoch,
        c.owner_id AS conversation_owner,c.workspace_id,c.project_id,
        r.execution_policy_json,r.model_policy_json
      FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=r.conversation_id
      JOIN wb_task_current_occurrences o ON o.run_id=r.id JOIN wb_persistent_tasks t ON t.task_id=o.task_id
      JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id
      WHERE b.run_id=? AND b.owner_id=? AND b.kind='task'`).get(scope.run_id,scope.owner_id) as Record<string,unknown>|undefined;
    if(!row||row.owner_id!==scope.owner_id||row.task_owner!==scope.owner_id||row.conversation_owner!==scope.owner_id
      ||row.workspace_id!==scope.workspace_id||row.agent_workspace!==scope.workspace_id||row.agent_project!==row.project_id
      ||row.task_agent!==row.agent_id||row.agent_status!=='active'||row.epoch!==row.capability_epoch
      ||!['active','budget_exhausted'].includes(String(row.task_status))||row.generation!==row.task_generation
      ||typeof row.trigger_key!=='string'||(!row.trigger_key.startsWith('discovery-work:')&&!row.trigger_key.startsWith('prd-work:'))
      ||row.root_run_id===undefined||row.conversation_id!==current.conversation_id)
      throw Error('policy_admission_unconfirmed');
    let context:Record<string,unknown>;
    try{context=JSON.parse(String(row.context_json));}catch{throw Error('policy_admission_unconfirmed');}
    if(context.run_id!==scope.run_id||context.owner_id!==scope.owner_id||context.agent_id!==row.agent_id
      ||context.workspace_id!==scope.workspace_id||context.project_id!==row.project_id
      ||context.capability_epoch!==row.capability_epoch||context.kind!=='task')throw Error('policy_admission_unconfirmed');
    if(!db.prepare('SELECT 1 FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=? AND session_id=?')
      .get(current.conversation_id,scope.owner_id,current.session_id))throw Error('policy_session_unconfirmed');
    const admission=new WorkAdmissionRecords(db).guard(scope.owner_id,scope.run_id);
    if(admission.task_id!==row.task_id||admission.occurrence_id!==row.occurrence_id
      ||admission.run_id!==row.root_run_id||admission.conversation_id!==row.conversation_id
      ||admission.task_version!==row.task_version||admission.task_generation!==row.generation)throw Error('policy_admission_unconfirmed');
    if(typeof row.execution_policy_json!=='string'||typeof row.model_policy_json!=='string')throw Error('execution_policy_missing');
    acceptedModelPolicyCandidates(row.model_policy_json);
    const policy=executionPolicy(JSON.parse(row.execution_policy_json),row.model_policy_json);
    if(policy.mode!=='work'||canonicalModelJson(policy)!==row.execution_policy_json)throw Error('execution_policy_invalid');
    return JSON.stringify({row,admission});
  });
}

export interface RuntimeReadinessStorageInspector {
  inspectForRun(runId:string,lease:ExecutionLease):Promise<Readonly<{
    sessionRef:string;
    inspection:Readonly<{snapshot_id:string;manifest_sha256:string;execution_authorized:false}>;
  }>|null>;
}

/** Adapt the admitted native-work inspector as passive, run-bound storage evidence. */
export function createRuntimeReadinessStorageSource(db:DatabaseSync,inspector:RuntimeReadinessStorageInspector,
  now:()=>Date=()=>new Date()):RuntimeReadinessBoundStatusPort{
  // shortcut: worker6 inspection cannot stop mid-scan; upgrade when that owner adds AbortSignal support.
  let inspectionActive=false;
  return async(scope,signal)=>{
    const boundScope=Object.freeze({run_id:scope.run_id,owner_id:scope.owner_id,workspace_id:scope.workspace_id});
    signal.throwIfAborted();
    const sample=(status:RuntimeDependencyStatus,reason?:string)=>storageSample(boundScope,status,now(),reason);
    if(inspectionActive)return sample('unknown','storage_inspection_busy');
    let before:RunBinding|undefined;
    try{before=readRunBinding(db,boundScope);}catch{return sample('unknown','storage_binding_unavailable');}
    if(!before)return sample('unknown','storage_binding_unavailable');
    if(before.status!=='running'||!before.session_id||!before.workbench)
      return sample('unknown','storage_scope_unsupported');
    try{
      inspectionActive=true;
      const inspection=Promise.resolve().then(()=>{
        signal.throwIfAborted();
        return inspector.inspectForRun(boundScope.run_id,before!.lease);
      });
      void inspection.then(()=>{inspectionActive=false;},()=>{inspectionActive=false;});
      let onAbort:()=>void=()=>{};
      const aborted=new Promise<{cancelled:true}>(resolve=>{
        if(signal.aborted){resolve({cancelled:true});return;}
        onAbort=()=>resolve({cancelled:true});signal.addEventListener('abort',onAbort,{once:true});
      });
      let outcome:{inspection:Awaited<ReturnType<RuntimeReadinessStorageInspector['inspectForRun']>>}|{error:unknown}|{cancelled:true};
      try{
        outcome=await Promise.race([
          inspection.then(value=>({inspection:value}),error=>({error})),aborted,
        ]);
      }finally{signal.removeEventListener('abort',onAbort);}
      if('cancelled'in outcome)return sample('unknown','storage_observation_cancelled');
      if('error'in outcome)throw outcome.error;
      const inspected=outcome.inspection;
      signal.throwIfAborted();
      const after=readRunBinding(db,boundScope);
      if(!sameRunBinding(before,after))return sample('unknown','storage_scope_changed');
      if(!inspected)return sample('unknown','storage_scope_unsupported');
      const receipt=inspected.inspection;
      if(inspected.sessionRef!==before.session_id||!receipt||typeof receipt.snapshot_id!=='string'||!receipt.snapshot_id
        ||typeof receipt.manifest_sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.manifest_sha256)
        ||receipt.execution_authorized!==false)return sample('unknown','storage_observation_unconfirmed');
      return sample('ready');
    }catch(error){
      if(signal.aborted)throw error;
      let after:RunBinding|undefined;try{after=readRunBinding(db,boundScope);}catch{}
      if(!sameRunBinding(before,after))return sample('unknown','storage_scope_changed');
      const code=error instanceof Error?error.message:'';
      return STORAGE_FAILURE_CODES.has(code)?sample('failed','storage_unavailable')
        :sample('unknown','storage_observation_unconfirmed');
    }
  };
}

/** Adapt the authenticated Host status read into exact run-bound readiness evidence. */
export function createBrowserDriverReadinessSource(db:DatabaseSync,host:Pick<SessionControllerClient,'observeBrowserDriver'>,
  now:()=>Date=()=>new Date()):RuntimeReadinessBoundStatusPort{
  const instant=()=>{try{const value=now();if(value instanceof Date&&Number.isFinite(value.getTime()))return value;}catch{}return new Date();};
  return async(scopeValue,signal)=>{
    const scope=scopeOf(scopeValue);
    const sample=(status:RuntimeDependencyStatus,reason?:string,observed_at?:string):RuntimeReadinessBoundSample=>Object.freeze({
      protocol:1,scope,status,required:true,observed_at:observed_at??instant().toISOString(),...(reason?{reason}:{})
    });
    let before:RunBinding|undefined;
    try{signal.throwIfAborted();before=readRunBinding(db,scope);}catch(error){if(signal.aborted)throw error;return sample('unknown','driver_binding_unavailable');}
    if(!before?.session_id)return sample('unknown','driver_binding_unavailable');
    const bound=normalizeBrowserDriverScope({run_id:before.run_id,owner_id:before.owner_id,workspace_id:before.workspace_id,
      session_id:before.session_id,lease_owner:before.lease.owner,lease_generation:before.lease.generation});
    try{
      const observation=await host.observeBrowserDriver(bound.session_id,bound,signal);
      signal.throwIfAborted();
      const after=readRunBinding(db,scope);
      if(!sameRunBinding(before,after))return sample('unknown','driver_scope_changed');
      const verified=validateBrowserDriverObservation(observation,bound,instant().getTime());
      return sample(verified.status,verified.reason,verified.observed_at);
    }catch(error){
      if(signal.aborted)throw error;
      return sample('unknown','driver_observation_unconfirmed');
    }
  };
}

function scopedPolicyObservation(db:DatabaseSync,scope:Readonly<RuntimeReadinessRunScope>,signal:AbortSignal,now:()=>Date):{
  sample:RuntimeReadinessSample;scopeState:'supported'|'unsupported'|'unconfirmed'|'unstable';
}{
  const instant=()=>{try{return now();}catch{return new Date(Number.NaN);}};
  let before:RunBinding|undefined;
  try{before=readRunBinding(db,scope);}catch{return{sample:unknownSample('policy_observation_unconfirmed',instant()),scopeState:'unsupported'};}
  if(!before||!before.session_id)return{sample:unknownSample('policy_scope_unsupported',instant()),scopeState:'unsupported'};
  let taskPolicyFingerprint:string|undefined;
  signal.throwIfAborted();
  try{
    const bindingsInstalled=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_run_bindings'").get();
    const taskBinding=bindingsInstalled
      ?db.prepare('SELECT kind FROM wb_run_bindings WHERE run_id=? AND owner_id=?').get(scope.run_id,scope.owner_id) as {kind:string}|undefined
      :undefined;
    const taskRunsInstalled=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name='wb_task_current_occurrences'").get();
    const taskOccurrence=taskRunsInstalled&&!!db.prepare('SELECT 1 FROM wb_task_current_occurrences WHERE run_id=?').get(scope.run_id);
    if(taskOccurrence||taskBinding?.kind==='task'){
      if(taskBinding?.kind!=='task')throw Error('policy_admission_unconfirmed');
      taskPolicyFingerprint=inspectAdmittedTaskPolicy(db,scope,before);
    }
    else{
      const inspected=inspectOrdinaryExecutionPolicy(db,scope.run_id,before.session_id,before.lease);
      if(inspected.execution_authorized!==false||!inspected.policy||!['chat','work'].includes(inspected.policy.mode))
        return{sample:unknownSample('policy_observation_unconfirmed',instant()),scopeState:'unconfirmed'};
    }
  }catch(error){
    if(signal.aborted)throw error;
    const code=error instanceof Error?error.message:'';
    if(code==='policy_scope_changed')return{sample:unknownSample(code,instant()),scopeState:'unstable'};
    if(code==='policy_scope_unsupported')return{sample:unknownSample(code,instant()),scopeState:'unsupported'};
    return{sample:unknownSample('policy_observation_unconfirmed',instant()),scopeState:'unconfirmed'};
  }
  signal.throwIfAborted();
  let after:RunBinding|undefined;
  try{after=readRunBinding(db,scope);}catch{return{sample:unknownSample('policy_observation_unconfirmed',instant()),scopeState:'unsupported'};}
  if(!sameRunBinding(before,after))return{sample:unknownSample('policy_scope_changed',instant()),scopeState:'unstable'};
  // A task continuation can replace its current occurrence without changing this run/session/lease tuple.
  if(taskPolicyFingerprint!==undefined){
    try{
      if(inspectAdmittedTaskPolicy(db,scope,after)!==taskPolicyFingerprint)
        return{sample:unknownSample('policy_scope_changed',instant()),scopeState:'unstable'};
    }catch(error){
      if(signal.aborted)throw error;
      return{sample:unknownSample('policy_scope_changed',instant()),scopeState:'unstable'};
    }
  }
  const observedAt=instant();
  if(!Number.isFinite(observedAt.getTime()))return{sample:unknownSample('policy_clock_invalid',observedAt),scopeState:'unconfirmed'};
  return{sample:{status:'ready',required:true,observed_at:observedAt.toISOString()},scopeState:'supported'};
}

function unknownNative(reason:string,observedAt:Date):RuntimeReadinessSample{
  const time=observedAt.getTime();
  return{status:'unknown',required:true,...(Number.isFinite(time)?{observed_at:observedAt.toISOString()}:{}),reason};
}

function sessionBindings(db:DatabaseSync,scope:Readonly<RuntimeReadinessRunScope>):{ids:string[];fingerprint:string}|undefined{
  const binding=readRunBinding(db,scope);
  if(!binding)return;
  const ids=binding.session_id?[binding.session_id]:[];
  return{ids,fingerprint:runBindingFingerprint(binding)};
}

function sampleTime(value:NativeIdleObservation):number|undefined{
  return Number.isSafeInteger(value.observed_at)&&value.observed_at>=0?value.observed_at:undefined;
}

/**
 * Compose only scoped, read-only service evidence into the original readiness
 * aggregate. This is diagnostic data only; it cannot authorize execution.
 */
export async function composeScopedRuntimeReadiness(
  db:DatabaseSync,
  scopeValue:RuntimeReadinessRunScope,
  sources:RuntimeReadinessSources={},
  options:CollectRuntimeReadinessOptions={},
):Promise<RuntimeReadinessComposition>{
  const scope=scopeOf(scopeValue);
  const now=options.now??(()=>new Date());
  let hostFreshness:RuntimeReadinessFreshness['host']=null;
  let nativeFreshness:RuntimeReadinessFreshness['native']=null;
  const ports:Parameters<typeof collectRuntimeReadinessObservations>[1]={};
  type ScopedObservationState='not_observed'|'supported'|'unsupported'|'unconfirmed'|'unstable'|'failed';
  const scopedObservationState:{host:ScopedObservationState;policy:ScopedObservationState;storage:ScopedObservationState}={
    host:'not_observed',policy:'not_observed',storage:'not_observed',
  };

  ports.policy=async signal=>{
    signal.throwIfAborted();
    const result=scopedPolicyObservation(db,scope,signal,now);
    scopedObservationState.policy=result.scopeState;
    return result.sample;
  };
  if(typeof sources.consumer==='function')ports.consumer=boundStatusPort('consumer',sources.consumer,scope,now);
  if(typeof sources.storage==='function')ports.storage=async signal=>{
    const sample=await boundStatusPort('storage',sources.storage!,scope,now)(signal);
    scopedObservationState.storage=sample.status==='ready'?'supported':sample.status==='failed'?'failed'
      :sample.reason==='storage_scope_unsupported'?'unsupported'
      :sample.reason==='storage_scope_changed'||sample.reason==='storage_scope_mismatch'?'unstable':'unconfirmed';
    return sample;
  };
  if(typeof sources.driver==='function')ports.driver=boundStatusPort('driver',sources.driver,scope,now);

  if(sources.workbench&&typeof sources.workbench.goalStatus==='function')ports.host=async signal=>{
    signal.throwIfAborted();
    let before:RunBinding|undefined;
    try{before=readRunBinding(db,scope);}catch{scopedObservationState.host='unsupported';return unknownSample('workbench_scope_unavailable',now());}
    if(!before||!before.workbench||!before.session_id){scopedObservationState.host='unsupported';return unknownSample('workbench_scope_unsupported',now());}
    scopedObservationState.host='supported';
    try{
      const state=validateTaskGoalStatus(await sources.workbench!.goalStatus(before.session_id,signal));
      signal.throwIfAborted();
      const instant=now();
      if(!Number.isFinite(instant.getTime()))return unknownSample('workbench_clock_invalid',new Date(Number.NaN));
      if(state.task.run_status!==before.status)return unknownSample('workbench_run_status_changed',instant);
      const after=readRunBinding(db,scope);
      const stable=sameRunBinding(before,after);
      hostFreshness={observed_at_earliest:instant.toISOString(),observed_at_latest:instant.toISOString(),
        max_age_ms:RUNTIME_READINESS_MAX_AGE_MS,session_count:1,bindings_stable:stable};
      if(!stable){scopedObservationState.host='unstable';return unknownSample('workbench_scope_changed',instant);}
      return{status:'ready',required:true,observed_at:instant.toISOString()};
    }catch(error){
      if(signal.aborted)throw error;
      scopedObservationState.host='unconfirmed';
      return unknownSample('workbench_observation_unconfirmed',now());
    }
  };

  if(sources.native&&typeof sources.native.observeNativeIdle==='function'){
    ports.native=async signal=>{
      signal.throwIfAborted();
      let before;
      try{before=sessionBindings(db,scope);}catch{return unknownNative('native_binding_unavailable',now());}
      if(!before)return unknownNative('native_binding_unavailable',now());
      if(!before.ids.length)return unknownNative('native_session_binding_missing',now());

      const facts:NativeIdleObservation[]=[];
      for(const sessionId of before.ids){
        signal.throwIfAborted();
        let fact:NativeIdleObservation;
        try{fact=validateNativeIdleObservation(await sources.native!.observeNativeIdle(sessionId,signal),sessionId);}
        catch(error){
          if(signal.aborted)throw error;
          return unknownNative('native_observation_unconfirmed',now());
        }
        const observedAt=sampleTime(fact);
        let current:number;
        try{current=now().getTime();}catch{return unknownNative('native_clock_invalid',new Date(Number.NaN));}
        if(observedAt===undefined||!Number.isFinite(current)||observedAt>current+RUNTIME_READINESS_MAX_FUTURE_SKEW_MS)
          return unknownNative('native_observation_time_invalid',now());
        facts.push(fact);
        const oldest=Math.min(...facts.map(item=>item.observed_at));
        const latest=Math.max(...facts.map(item=>item.observed_at));
        nativeFreshness={observed_at_earliest:new Date(oldest).toISOString(),observed_at_latest:new Date(latest).toISOString(),
          max_age_ms:RUNTIME_READINESS_MAX_AGE_MS,session_count:facts.length,bindings_stable:null};
      }

      signal.throwIfAborted();
      let after;
      try{after=sessionBindings(db,scope);}catch{return unknownNative('native_binding_unavailable',now());}
      if(!after||after.fingerprint!==before.fingerprint){
        if(nativeFreshness)nativeFreshness={...nativeFreshness,bindings_stable:false};
        return unknownNative('native_scope_changed',now());
      }
      if(nativeFreshness)nativeFreshness={...nativeFreshness,bindings_stable:true};

      const times=facts.map(item=>item.observed_at);
      const oldest=Math.min(...times);
      let current:number;
      try{current=now().getTime();}catch{return unknownNative('native_clock_invalid',new Date(Number.NaN));}
      if(!Number.isFinite(current))return unknownNative('native_clock_invalid',new Date(Number.NaN));
      if(current-oldest>RUNTIME_READINESS_MAX_AGE_MS)return{
        status:'unknown',required:true,observed_at:new Date(oldest).toISOString(),reason:'observation_stale',
      };
      const status=facts.every(item=>item.native_idle==='idle')?'ready':'unknown';
      const reason=status==='ready'?undefined:facts.some(item=>item.native_idle==='busy')?'native_busy':'native_state_unavailable';
      return{status,required:true,observed_at:new Date(oldest).toISOString(),...(reason?{reason}:{})};
    };
  }

  const readiness=await collectRuntimeReadinessObservations(db,ports,options);
  let collectedAt:string|null=null;
  try{const instant=now();if(Number.isFinite(instant.getTime()))collectedAt=instant.toISOString();}catch{}
  const sourceGaps=[
    ...(!sources.native||typeof sources.native.observeNativeIdle!=='function'?
      [{component:'native' as const,code:'native_status_port_missing',source_symbol:'packages/gateway/src/harness/session-controller-client.ts::SessionControllerClient.observeNativeIdle(sessionId, signal)'}]:[]),
    ...UNBOUND_SOURCE_GAPS.filter(gap=>{
      if(gap.component==='host')return typeof sources.workbench?.goalStatus!=='function';
      if(gap.component==='consumer')return typeof sources.consumer!=='function';
      if(gap.component==='storage')return typeof sources.storage!=='function';
      if(gap.component==='driver')return typeof sources.driver!=='function';
      return true;
    }).map(gap=>({...gap})),
    ...(scopedObservationState.host==='unsupported'?
      [{component:'host' as const,code:'workbench_scope_unsupported',source_symbol:'SessionControllerClient.goalStatus() is used only for the exact run-bound Workbench mode session.'}]:[]),
    ...(scopedObservationState.host==='unstable'?
      [{component:'host' as const,code:'workbench_scope_changed',source_symbol:'The run/session/lease binding changed while the existing Host status read was in flight.'}]:[]),
    ...(scopedObservationState.host==='unconfirmed'?
      [{component:'host' as const,code:'workbench_status_unconfirmed',source_symbol:'The authenticated goal-status response did not confirm the exact run state.'}]:[]),
    ...(scopedObservationState.policy==='unsupported'?
      [{component:'policy' as const,code:'policy_scope_unsupported',source_symbol:'The exact run has no supported current session and execution lease for ordinary policy inspection or admitted Workbench task policy observation.'}]:[]),
    ...(scopedObservationState.policy==='unstable'?
      [{component:'policy' as const,code:'policy_scope_changed',source_symbol:'The run/session/lease binding changed while the accepted policy was being inspected.'}]:[]),
    ...(scopedObservationState.policy==='unconfirmed'?
      [{component:'policy' as const,code:'policy_status_unconfirmed',source_symbol:'The accepted policy could not be validated against the exact run/session/lease and, for task runs, its immutable Workbench admission.'}]:[]),
    ...(scopedObservationState.storage==='unsupported'?
      [{component:'storage' as const,code:'storage_scope_unsupported',source_symbol:'The exact active run is not an admitted isolated-work storage scope for the existing inspector.'}]:[]),
    ...(scopedObservationState.storage==='unstable'?
      [{component:'storage' as const,code:'storage_scope_changed',source_symbol:'The exact run/session/lease binding changed during isolated-work storage inspection.'}]:[]),
    ...(scopedObservationState.storage==='unconfirmed'?
      [{component:'storage' as const,code:'storage_status_unconfirmed',source_symbol:'The existing isolated-work inspector did not confirm its immutable snapshot and manifest receipt.'}]:[]),
    ...(scopedObservationState.storage==='failed'?
      [{component:'storage' as const,code:'storage_status_failed',source_symbol:'The existing isolated-work inspector reported a sanitized current storage failure.'}]:[]),
  ];
  const gapSymbols:Partial<Record<RuntimeDependency,string>>={
    host:'SessionControllerClient.goalStatus() reads the authenticated Host status endpoint for the exact Workbench run.',
    native:'SessionControllerClient.observeNativeIdle(sessionId, signal) reads the exact run-bound native session.',
    consumer:'HarnessWorker.observeConsumerReadiness(scope, signal) requires its current in-process run and live lease.',
    policy:'inspectOrdinaryExecutionPolicy() validates ordinary runs; WorkAdmissionRecords.guard() and the canonical accepted policy validate admitted Workbench discovery-work task runs.',
    storage:'TrustedWorkRunWorkspaceResolver.inspectForRun(run_id, lease) inspects an already admitted isolated-work scope.',
    driver:'SessionControllerClient.observeBrowserDriver(session_id, exact scope, signal) via createBrowserDriverReadinessSource(db, sessionClient) supplies status bound to the current run/session/lease.',
  };
  for(const component of ['host','native','consumer','policy','storage','driver'] as const){
    const observation=readiness.components.find(item=>item.component===component)!;
    if(observation.status!=='ready'&&!sourceGaps.some(gap=>gap.component===component))
      sourceGaps.push({component,code:observation.reason??`${component}_unconfirmed`,source_symbol:gapSymbols[component]!});
  }
  return Object.freeze({protocol:1,scope:Object.freeze({owner_id:scope.owner_id,workspace_id:scope.workspace_id}),collected_at:collectedAt,freshness:Object.freeze({host:hostFreshness,native:nativeFreshness}),
    readiness,source_gaps:sourceGaps,execution_authorized:false as const});
}
