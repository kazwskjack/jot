import type {DatabaseSync} from 'node:sqlite';
import {hasRequiredColumns,REQUIRED_SCHEMA} from './runtime-readiness-schema.ts';
import {
  aggregateRuntimeReadiness,
  type RuntimeDependency,
  type RuntimeDependencyObservation,
  type RuntimeDependencyStatus,
  type RuntimeReadiness,
} from './runtime-readiness.ts';

export interface RuntimeReadinessSample {
  status:RuntimeDependencyStatus|'not_started';
  required:boolean;
  observed_at?:string;
  reason?:string;
}
export type RuntimeStatusPort = (signal:AbortSignal)=>RuntimeReadinessSample|Promise<RuntimeReadinessSample>;
export type RuntimeStatusPorts = Partial<Record<Exclude<RuntimeDependency,'db'|'schema'>,RuntimeStatusPort>>;

export interface CollectRuntimeReadinessOptions {
  signal?:AbortSignal;
  now?:()=>Date;
}

const STATUS_COMPONENTS:Exclude<RuntimeDependency,'db'|'schema'>[]=['host','native','consumer','policy','storage','driver'];
export const RUNTIME_READINESS_MAX_AGE_MS=60_000;
export const RUNTIME_READINESS_MAX_FUTURE_SKEW_MS=5_000;
const SAFE_REASON=/^[a-z][a-z0-9_]{0,63}$/;
const ISO_TIMESTAMP=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;
function unknown(component:RuntimeDependency,reason:string,observedAt?:string):RuntimeDependencyObservation{
  return{component,status:'unknown',required:true,...(observedAt?{observed_at:observedAt}:{}),reason};
}

function cancelled():RuntimeReadiness{
  return aggregateRuntimeReadiness([
    ...(['db','schema'] as const).map(component=>unknown(component,'observation_cancelled')),
    ...STATUS_COMPONENTS.map(component=>unknown(component,'observation_cancelled')),
  ]);
}

function databaseObservation(db:DatabaseSync):RuntimeDependencyObservation{
  try{
    if(!db.isOpen)return{component:'db',status:'failed',required:true,reason:'database_closed'};
    if(db.isTransaction)return unknown('db','database_transaction_open');
    const row=db.prepare('SELECT 1 AS available').get() as {available?:unknown}|undefined;
    if(row?.available!==1)return{component:'db',status:'failed',required:true,reason:'database_unavailable'};
    return{component:'db',status:'ready',required:true};
  }catch{
    return{component:'db',status:'failed',required:true,reason:'database_unavailable'};
  }
}

function schemaObservation(db:DatabaseSync):RuntimeDependencyObservation{
  try{
    if(!db.isOpen||db.isTransaction)return unknown('schema','schema_unavailable');
    if(!hasRequiredColumns(db,REQUIRED_SCHEMA))return{component:'schema',status:'failed',required:true,reason:'schema_incompatible'};
    return{component:'schema',status:'ready',required:true};
  }catch{
    return{component:'schema',status:'failed',required:true,reason:'schema_unavailable'};
  }
}

function normalizePortObservation(component:RuntimeDependency,value:unknown,now:number):RuntimeDependencyObservation{
  if(!value||typeof value!=='object'||Array.isArray(value))return unknown(component,'source_invalid');
  const row=value as Record<string,unknown>;
  if(row.status==='not_started')return unknown(component,'source_not_started');
  if(!['ready','disabled','unknown','failed'].includes(String(row.status))||typeof row.required!=='boolean')return unknown(component,'source_invalid');
  if(typeof row.observed_at!=='string'||row.observed_at.length>64)return unknown(component,'observation_time_missing');
  if(!ISO_TIMESTAMP.test(row.observed_at))return unknown(component,'observation_time_invalid');
  const observedAt=Date.parse(row.observed_at);
  if(!Number.isFinite(observedAt)||observedAt>now+RUNTIME_READINESS_MAX_FUTURE_SKEW_MS)return unknown(component,'observation_time_invalid');
  if(now-observedAt>RUNTIME_READINESS_MAX_AGE_MS)return unknown(component,'observation_stale',row.observed_at as string);
  if(row.reason!==undefined&&(typeof row.reason!=='string'||!SAFE_REASON.test(row.reason)))return unknown(component,'source_invalid');
  return{
    component,
    status:row.status as RuntimeDependencyStatus,
    required:row.required,
    observed_at:row.observed_at,
    ...(typeof row.reason==='string'?{reason:row.reason}:{}),
  };
}

/**
 * Read current database/schema facts and snapshots from existing trusted status
 * ports. Ports must read an existing trusted status source, never infer readiness
 * from config or process health. This collector never probes providers, starts
 * Sessions, downloads assets, or changes policy.
 */
export async function collectRuntimeReadinessObservations(
  db:DatabaseSync,
  ports:RuntimeStatusPorts={},
  options:CollectRuntimeReadinessOptions={},
):Promise<RuntimeReadiness>{
  const signal=options.signal??new AbortController().signal;
  if(signal.aborted)return cancelled();

  const observations:RuntimeDependencyObservation[]=[databaseObservation(db),schemaObservation(db)];
  const now=options.now??(()=>new Date());
  for(const component of STATUS_COMPONENTS){
    if(signal.aborted){observations.push(unknown(component,'observation_cancelled'));continue;}
    let port:RuntimeStatusPort|undefined;
    try{port=ports?.[component];}
    catch{observations.push({component,status:'failed',required:true,reason:'source_failed'});continue;}
    if(typeof port!=='function'){
      observations.push(unknown(component,'source_missing'));
      continue;
    }
    try{
      const value=await port(signal);
      if(signal.aborted){observations.push(unknown(component,'observation_cancelled'));continue;}
      let instant:number;
      try{instant=now().getTime();}catch{observations.push(unknown(component,'observation_clock_invalid'));continue;}
      observations.push(Number.isFinite(instant)
        ?normalizePortObservation(component,value,instant)
        :unknown(component,'observation_clock_invalid'));
    }catch{
      observations.push(signal.aborted?unknown(component,'observation_cancelled'):{component,status:'failed',required:true,reason:'source_failed'});
    }
  }
  return aggregateRuntimeReadiness(observations);
}

export interface RecordedRuntimeReadiness {
  collected_at:string;
  stale:boolean;
  execution_authorized:false;
  readiness:RuntimeReadiness;
}

/** Read the original run's bounded diagnostic sample and apply current freshness limits. */
export function readRecordedRuntimeReadiness(db:DatabaseSync,runId:string,now=new Date()):RecordedRuntimeReadiness|null {
  const row=db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='runtime.readiness' ORDER BY seq DESC LIMIT 1")
    .get(runId) as {payload_json:unknown}|undefined;
  if(typeof row?.payload_json!=='string'||Buffer.byteLength(row.payload_json,'utf8')>32768)return null;
  let value;
  try{value=JSON.parse(row.payload_json);}catch{return null;}
  if(!value||value.execution_authorized!==false||typeof value.collected_at!=='string'
    ||!ISO_TIMESTAMP.test(value.collected_at)||!Number.isFinite(Date.parse(value.collected_at))
    ||value.readiness?.schema_version!==1||!Array.isArray(value.readiness.components)||value.readiness.components.length>8
    ||!Array.isArray(value.readiness.errors)||value.readiness.errors.length>32
    ||value.readiness.errors.some((error:unknown)=>typeof error!=='string'||!SAFE_REASON.test(error)))return null;
  const instant=now.getTime(),collectedAt=Date.parse(value.collected_at);
  const stale=!Number.isFinite(instant)||collectedAt>instant+RUNTIME_READINESS_MAX_FUTURE_SKEW_MS
    ||instant-collectedAt>RUNTIME_READINESS_MAX_AGE_MS;
  const observations=value.readiness.components.map((component:unknown)=>{
    if(!component||typeof component!=='object'||Array.isArray(component))return component;
    const item=component as Record<string,unknown>;
    if(stale)return{component:item.component,status:'unknown',required:true,reason:'observation_stale'};
    const {reason,...sample}=item;
    return normalizePortObservation(item.component as RuntimeDependency,{
      ...sample,
      ...((item.component==='db'||item.component==='schema')?{observed_at:value.collected_at}:{}),
      ...(reason===null?{}:{reason}),
    },instant);
  });
  const readiness=aggregateRuntimeReadiness(observations);
  readiness.errors=[...new Set([...readiness.errors,...value.readiness.errors])].sort();
  readiness.execution_ready=readiness.execution_ready&&readiness.errors.length===0;
  return{collected_at:value.collected_at,stale,execution_authorized:false,readiness};
}
