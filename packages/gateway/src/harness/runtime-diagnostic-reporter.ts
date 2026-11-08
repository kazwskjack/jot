import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {EventStore} from '../events/event-store.ts';
import {composeScopedRuntimeReadiness,type RuntimeReadinessRunScope,type RuntimeReadinessSources} from '../events/runtime-readiness-composition.ts';
import {hasRequiredColumns,SESSION_BINDING_SCHEMA} from '../events/runtime-readiness-schema.ts';
import {assertExecutionLease,normalizeExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';
import {createRunPreparationTimingReporter,type PreparationTimingRecord,type PreparationTimingReporter} from './preparation-timing.ts';

type DiagnosticRunBinding=Readonly<RuntimeReadinessRunScope&{
  conversation_id:string;
  status:string;
  session_id:string;
  lease:ExecutionLease;
  lease_expires_at:number;
}>;

const ACTIVE_RUN_STATUSES=new Set(['starting','running','waiting_user','waiting_approval','cancelling']);
const SAFE_GAP_CODE=/^[a-z][a-z0-9_]{0,63}$/;

function readDiagnosticBinding(db:DatabaseSync,runId:string):DiagnosticRunBinding|undefined{
  if(!hasRequiredColumns(db,SESSION_BINDING_SCHEMA)
    ||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_worker_leases'").get())return;
  const row=db.prepare(`SELECT r.id AS run_id,r.conversation_id,r.status,c.owner_id,c.workspace_id,c.archived_at,
      n.session_id,l.owner AS lease_owner,l.generation AS lease_generation,l.expires_at
    FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    LEFT JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
    LEFT JOIN ga_worker_leases l ON l.resource_id=r.id WHERE r.id=?`).get(runId) as
    {run_id?:unknown;conversation_id?:unknown;status?:unknown;owner_id?:unknown;workspace_id?:unknown;archived_at?:unknown;
      session_id?:unknown;lease_owner?:unknown;lease_generation?:unknown;expires_at?:unknown}|undefined;
  if(!row||row.run_id!==runId||row.archived_at!==null||typeof row.conversation_id!=='string'
    ||typeof row.owner_id!=='string'||typeof row.workspace_id!=='string'||typeof row.status!=='string'
    ||!ACTIVE_RUN_STATUSES.has(row.status)||typeof row.session_id!=='string'||!row.session_id.trim())return;
  const lease=normalizeExecutionLease({owner:row.lease_owner,generation:row.lease_generation});
  const expiry=Number(row.expires_at);
  if(!Number.isSafeInteger(expiry)||expiry<=Date.now())return;
  assertExecutionLease(db,runId,lease);
  return Object.freeze({run_id:runId,conversation_id:row.conversation_id,owner_id:row.owner_id,workspace_id:row.workspace_id,
    status:row.status,session_id:row.session_id,lease,lease_expires_at:expiry});
}

function sameBinding(left:DiagnosticRunBinding|undefined,right:DiagnosticRunBinding|undefined):boolean{
  return !!left&&!!right&&left.run_id===right.run_id&&left.conversation_id===right.conversation_id
    &&left.owner_id===right.owner_id&&left.workspace_id===right.workspace_id&&left.status===right.status
    &&left.session_id===right.session_id&&left.lease.owner===right.lease.owner
    &&left.lease.generation===right.lease.generation&&left.lease_expires_at===right.lease_expires_at;
}

function safeLine(value:unknown):string{
  try{return JSON.stringify(value)+'\n';}catch{return '{"event":"jot_runtime_readiness","observation":"unavailable","reason":"diagnostic_serialization_failed","execution_authorized":false}\n';}
}

function sourceGapCodes(value:unknown):string[]{
  if(!Array.isArray(value))return[];
  return [...new Set(value.flatMap(item=>{
    if(!item||typeof item!=='object'||typeof (item as {code?:unknown}).code!=='string')return[];
    const code=(item as {code:string}).code;
    return SAFE_GAP_CODE.test(code)?[code]:[];
  }))].sort();
}

/**
 * Persist the canonical preparation record first, then asynchronously collect
 * a run-bound, redacted diagnostic. This observer never authorizes execution.
 */
export function createRunRuntimeDiagnosticReporter(
  db:DatabaseSync,
  events:EventStore,
  sources:RuntimeReadinessSources={},
  write:(line:string)=>void=line=>process.stderr.write(line),
):PreparationTimingReporter{
  const timingReporter=createRunPreparationTimingReporter(db,events);
  let collecting=false;

  return(record:PreparationTimingRecord,{runId})=>{
    timingReporter(record,{runId});
    if(record.event!=='jot_preparation_timing'||record.phase!=='preparation_total')return;
    const runHash=createHash('sha256').update(runId).digest('hex');
    const emit=(value:unknown)=>{try{write(safeLine(value));}catch{}};
    if(collecting){emit({event:'jot_runtime_readiness',run_hash:runHash,observation:'not_sampled',reason:'collector_busy',execution_authorized:false});return;}
    collecting=true;
    void Promise.resolve().then(async()=>{
      const before=readDiagnosticBinding(db,runId);
      if(!before){emit({event:'jot_runtime_readiness',run_hash:runHash,observation:'unavailable',reason:'run_scope_unavailable',execution_authorized:false});return;}
      const scope:Readonly<RuntimeReadinessRunScope>=Object.freeze({
        run_id:before.run_id,owner_id:before.owner_id,workspace_id:before.workspace_id,
      });
      const readiness=await composeScopedRuntimeReadiness(db,scope,sources,{signal:AbortSignal.timeout(1000)});
      const after=readDiagnosticBinding(db,runId);
      if(!sameBinding(before,after)){
        emit({event:'jot_runtime_readiness',run_hash:runHash,observation:'discarded',reason:'run_scope_changed',execution_authorized:false});
        return;
      }
      emit({event:'jot_runtime_readiness',run_hash:runHash,observation:'observed',
        collected_at:readiness.collected_at,freshness:readiness.freshness,readiness:readiness.readiness,
        limitations:sourceGapCodes(readiness.source_gaps),execution_authorized:false});
    }).catch(()=>{
      emit({event:'jot_runtime_readiness',run_hash:runHash,observation:'unavailable',reason:'observation_failed',execution_authorized:false});
    }).finally(()=>{collecting=false;});
  };
}
