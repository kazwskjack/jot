import type {DatabaseSync} from 'node:sqlite';
import {assertExecutionLease} from '../workbench/execution-lease.ts';

export type BrowserDriverScope=Readonly<{run_id:string;owner_id:string;workspace_id:string;session_id:string;lease_owner:string;lease_generation:number}>;
export type BrowserDriverObservation=Readonly<{protocol:1;scope:BrowserDriverScope;status:'ready'|'unknown'|'failed';required:true;observed_at:string;reason?:string;execution_authorized:false}>;
export type BrowserActionReadinessItem=Readonly<{protocol:1;run_id:string;workspace_id:string;status:'ready'|'unknown'|'failed';required:true;observed_at:string;reason?:string;execution_authorized:false}>;
type RunScope=Readonly<Pick<BrowserDriverScope,'run_id'|'owner_id'|'workspace_id'>>;
type BrowserDriverReadinessHost={observeBrowserDriver(sessionId:string,scope:BrowserDriverScope,signal:AbortSignal):Promise<BrowserDriverObservation>};
const keys='lease_generation,lease_owner,owner_id,run_id,session_id,workspace_id';
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
export function normalizeBrowserDriverScope(value:unknown):BrowserDriverScope{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('driver_scope_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!==keys||['run_id','owner_id','workspace_id','session_id','lease_owner'].some(k=>!id(row[k]))||!Number.isSafeInteger(row.lease_generation)||Number(row.lease_generation)<1)throw Error('driver_scope_invalid');
 return Object.freeze({...row}) as BrowserDriverScope;
}
export function validateBrowserDriverObservation(value:unknown,scope:BrowserDriverScope,now=Date.now()):BrowserDriverObservation{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('driver_observation_invalid');const row=value as Record<string,unknown>;
 if(!['execution_authorized,observed_at,protocol,required,scope,status','execution_authorized,observed_at,protocol,reason,required,scope,status'].includes(Object.keys(row).sort().join(','))||row.protocol!==1||row.execution_authorized!==false||row.required!==true||!['ready','unknown','failed'].includes(String(row.status)))throw Error('driver_observation_invalid');
 const bound=normalizeBrowserDriverScope(row.scope);if(Object.keys(bound).some(k=>bound[k as keyof BrowserDriverScope]!==scope[k as keyof BrowserDriverScope]))throw Error('driver_scope_changed');
 const time=typeof row.observed_at==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(row.observed_at)?Date.parse(row.observed_at):NaN;
 if(!Number.isFinite(time)||time>now+5000||now-time>60000||row.reason!==undefined&&(typeof row.reason!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(row.reason)))throw Error('driver_observation_invalid');
 return Object.freeze({...row,scope:bound}) as BrowserDriverObservation;
}

/** Passive adapter for the existing internal M26 bound source contract. */
export function createBrowserDriverReadinessSource(db:DatabaseSync,host:{observeBrowserDriver(sessionId:string,scope:BrowserDriverScope,signal:AbortSignal):Promise<BrowserDriverObservation>},now:()=>Date=()=>new Date()){
 return async(scope:RunScope,signal:AbortSignal)=>{
  const output=(status:'ready'|'unknown'|'failed',reason?:string,observed_at?:string)=>({protocol:1 as const,scope:Object.freeze({...scope}),status,required:true,observed_at:observed_at??now().toISOString(),...(reason?{reason}:{})});
  const read=()=>{
   if(!db.isOpen||db.isTransaction)throw Error('driver_binding_unavailable');
   const row=db.prepare(`SELECT r.id AS run_id,r.conversation_id,r.status,c.owner_id,c.workspace_id,n.session_id,l.owner AS lease_owner,l.generation AS lease_generation
    FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
    JOIN ga_worker_leases l ON l.resource_id=r.id
    WHERE r.id=? AND c.owner_id=? AND c.workspace_id=? AND c.archived_at IS NULL`).get(scope.run_id,scope.owner_id,scope.workspace_id) as Record<string,unknown>|undefined;
   if(!row||!['starting','running','waiting_user','waiting_approval','cancelling'].includes(String(row.status)))throw Error('driver_binding_unavailable');
   const bound=normalizeBrowserDriverScope({run_id:row.run_id,owner_id:row.owner_id,workspace_id:row.workspace_id,session_id:row.session_id,lease_owner:row.lease_owner,lease_generation:row.lease_generation});
   assertExecutionLease(db,bound.run_id,{owner:bound.lease_owner,generation:bound.lease_generation},()=>now().getTime());return{bound,fingerprint:JSON.stringify(row)};
  };
  try{
   signal.throwIfAborted();const before=read();
   const observation=await host.observeBrowserDriver(before.bound.session_id,before.bound,signal);
   signal.throwIfAborted();const after=read();if(before.fingerprint!==after.fingerprint)return output('unknown','driver_scope_changed');
   const fact=validateBrowserDriverObservation(observation,before.bound,now().getTime());return output(fact.status,fact.reason,fact.observed_at);
  }catch{return output('unknown','driver_observation_unconfirmed');}
 };
}

export async function observeBrowserActionReadiness(db:DatabaseSync,ownerId:string,workspaceIds:string[],host:BrowserDriverReadinessHost|undefined,signal:AbortSignal,now:()=>Date=()=>new Date()):Promise<BrowserActionReadinessItem[]>{
 if(!db.isOpen||db.isTransaction||!workspaceIds.length)return[];
 const rows=db.prepare(`SELECT r.id AS run_id,c.workspace_id,b.context_json,b.agent_id,b.epoch,a.capability_epoch,a.status AS agent_status FROM ga_runs r
  JOIN ga_conversations c ON c.id=r.conversation_id
  JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id
  JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id
  WHERE c.owner_id=? AND c.workspace_id IN (${workspaceIds.map(()=>'?').join(',')}) AND c.archived_at IS NULL
   AND a.status='active' AND a.capability_epoch=b.epoch
   AND r.status IN ('starting','running','waiting_user','waiting_approval') ORDER BY r.updated_at,r.id`).all(ownerId,...workspaceIds) as Array<{run_id:string;workspace_id:string;context_json:string;agent_id:string;epoch:number;capability_epoch:number;agent_status:string}>;
 const candidates=rows.flatMap(row=>{
  try{
   const context=JSON.parse(row.context_json);
   return context&&typeof context==='object'&&!Array.isArray(context)&&Array.isArray(context.allowed_tools)&&context.allowed_tools.includes('browser_action')
    ?[{...row,scopeMatches:context.run_id===row.run_id&&context.owner_id===ownerId&&context.workspace_id===row.workspace_id}]:[];
  }catch{return[];}
 });
 if(!candidates.length)return[];
 const stamp=()=>{try{const value=now();return Number.isFinite(value.getTime())?value.toISOString():new Date().toISOString();}catch{return new Date().toISOString();}};
 const unknown=(row:typeof candidates[number],reason:string):BrowserActionReadinessItem=>({protocol:1,run_id:row.run_id,workspace_id:row.workspace_id,status:'unknown',required:true,observed_at:stamp(),reason,execution_authorized:false});
 if(!host||typeof host.observeBrowserDriver!=='function')return candidates.map(row=>unknown(row,'host_status_port_missing'));
 const source=createBrowserDriverReadinessSource(db,host,now);
  return Promise.all(candidates.map(async row=>{
  signal.throwIfAborted();if(!row.scopeMatches)return unknown(row,'browser_scope_mismatch');
  const sample=await source({run_id:row.run_id,owner_id:ownerId,workspace_id:row.workspace_id},signal);signal.throwIfAborted();
  const current=db.prepare(`SELECT b.context_json,b.agent_id,b.epoch,a.capability_epoch,a.status AS agent_status FROM wb_run_bindings b
   JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id WHERE b.run_id=? AND b.owner_id=?`).get(row.run_id,ownerId) as typeof row|undefined;
  if(!current||current.context_json!==row.context_json||current.agent_id!==row.agent_id||current.epoch!==row.epoch
    ||current.capability_epoch!==row.capability_epoch||current.agent_status!=='active'||current.capability_epoch!==current.epoch)return unknown(row,'browser_scope_changed');
  if(!sample||!['ready','unknown','failed'].includes(sample.status)||sample.required!==true||typeof sample.observed_at!=='string')return unknown(row,'browser_observation_invalid');
  return{protocol:1 as const,run_id:row.run_id,workspace_id:row.workspace_id,status:sample.status,required:true as const,observed_at:sample.observed_at,
   ...(sample.reason?{reason:sample.reason}:{}),execution_authorized:false as const};
 }));
}
