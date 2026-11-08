import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {WorkGrants} from '../always-on/work-grants.ts';
import {WorkAdmissionRecords} from '../always-on/work-admission-records.ts';
import type {WorkAdmissionController} from '../always-on/work-admission.ts';

type Row=Record<string,any>;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function installPrdWorkAdmissionRequests(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_work_requests(
  grant_id TEXT PRIMARY KEY REFERENCES wb_discovery_work_grants(grant_id),owner_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),plan_id TEXT NOT NULL REFERENCES wb_task_prd_work_plans(plan_id),
  cycle_id TEXT NOT NULL REFERENCES wb_discovery_work_cycles(cycle_id),grant_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS wb_prd_work_request_plan ON wb_task_prd_work_requests(owner_id,task_id,plan_id);
 CREATE TABLE IF NOT EXISTS wb_task_prd_work_request_commands(owner_id TEXT NOT NULL,command_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES wb_task_prd_work_requests(grant_id),PRIMARY KEY(owner_id,command_key));
 CREATE TABLE IF NOT EXISTS wb_task_prd_work_request_deferrals(grant_id TEXT PRIMARY KEY REFERENCES wb_task_prd_work_requests(grant_id),
  not_before INTEGER NOT NULL,reason TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_prd_work_request_scope BEFORE INSERT ON wb_task_prd_work_requests
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_grants g JOIN wb_task_prd_work_cycle_origins o ON o.cycle_id=g.cycle_id
  WHERE g.grant_id=NEW.grant_id AND g.owner_id=NEW.owner_id AND g.grant_sha256=NEW.grant_sha256
   AND o.owner_id=NEW.owner_id AND o.task_id=NEW.task_id AND o.plan_id=NEW.plan_id AND o.cycle_id=NEW.cycle_id
   AND json_extract(g.grant_json,'$.task_id')=NEW.task_id AND json_extract(g.grant_json,'$.admission_id') IS NULL)
 BEGIN SELECT RAISE(ABORT,'prd_work_admission_scope_changed'); END;`);
 for(const table of ['wb_task_prd_work_requests','wb_task_prd_work_request_commands']){
  for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'prd_work_admission_immutable'); END;`);
  const conflict=table.endsWith('_commands')?'owner_id=NEW.owner_id AND command_key=NEW.command_key':'grant_id=NEW.grant_id';
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'prd_work_admission_immutable'); END;`);
 }
}
function receipt(row:Row){return {protocol:1,task_id:String(row.task_id),plan_id:String(row.plan_id),cycle_id:String(row.cycle_id),grant_id:String(row.grant_id),grant_sha256:String(row.grant_sha256),created_at:String(row.created_at),accepted:true,execution_authorized:false};}
function originalGrant(db:DatabaseSync,row:Row){
 const scope=db.prepare('SELECT agent_id,project_id,workspace_id FROM wb_discovery_work_grants WHERE grant_id=? AND owner_id=?').get(row.grant_id,row.owner_id) as {agent_id:string;project_id:string;workspace_id:string}|undefined;
 if(!scope)throw Error('prd_work_admission_integrity_failed');
 const grant=new WorkGrants(db).get(row.owner_id,scope,row.grant_id);
 if(grant.admission_id!==null||grant.task_id!==row.task_id||grant.cycle_id!==row.cycle_id||grant.origin.plan_id!==row.plan_id||digest(grant)!==row.grant_sha256)throw Error('prd_work_admission_integrity_failed');
 return grant;
}
export function requestPrdWorkAdmission(db:DatabaseSync,available:boolean,owner:string,taskId:string,value:unknown,key:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='cycle_id,grant_id,plan_id,preview_sha256')throw Error('invalid_prd_work_admission');
 const input=value as Row;
 if(typeof input.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(input.plan_id)||typeof input.preview_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.preview_sha256)
  ||[input.cycle_id,input.grant_id].some(id=>typeof id!=='string'||!id||id.length>256))throw Error('invalid_prd_work_admission');
 if(typeof key!=='string'||! /^[\x21-\x7e]{8,128}$/.test(key))throw Error('idempotency_key_invalid');
 const hash=digest({task_id:taskId,input});
 return withImmediateTransaction(db,()=>{
  const prior=db.prepare('SELECT * FROM wb_task_prd_work_request_commands WHERE owner_id=? AND command_key=?').get(owner,key) as Row|undefined;
  if(prior&&prior.request_sha256!==hash)throw Error('idempotency_conflict');
  const existing=db.prepare('SELECT * FROM wb_task_prd_work_requests WHERE owner_id=? AND grant_id=?').get(owner,input.grant_id) as Row|undefined;
  if(prior&&(!existing||prior.grant_id!==input.grant_id))throw Error('prd_work_admission_integrity_failed');
  if(existing){
   if(existing.task_id!==taskId||existing.plan_id!==input.plan_id||existing.cycle_id!==input.cycle_id||existing.grant_sha256!==input.preview_sha256)throw Error('prd_work_admission_scope_changed');
   originalGrant(db,existing);
   if(!prior)db.prepare('INSERT INTO wb_task_prd_work_request_commands VALUES(?,?,?,?)').run(owner,key,hash,input.grant_id);
   return receipt(existing);
  }
  if(!available)throw Error('prd_work_admission_unavailable');
  const row={owner_id:owner,task_id:taskId,plan_id:input.plan_id,cycle_id:input.cycle_id,grant_id:input.grant_id,grant_sha256:input.preview_sha256,created_at:new Date().toISOString()};
  const grant=originalGrant(db,row);new WorkGrants(db).guard(owner,grant.scope,grant.grant_id);
  const prepared=db.prepare('SELECT review_sha256 FROM wb_task_prd_work_preparations WHERE owner_id=? AND task_id=? AND plan_id=? AND cycle_id=?').get(owner,taskId,input.plan_id,input.cycle_id);
  if(!prepared)throw Error('prd_work_admission_scope_changed');
  db.prepare('INSERT INTO wb_task_prd_work_requests VALUES(?,?,?,?,?,?,?)').run(input.grant_id,owner,taskId,input.plan_id,input.cycle_id,input.preview_sha256,row.created_at);
  db.prepare('INSERT INTO wb_task_prd_work_request_commands VALUES(?,?,?,?)').run(owner,key,hash,input.grant_id);
  return receipt(row);
 });
}
export function readPrdWorkAdmission(db:DatabaseSync,owner:string,taskId:string,planId:string,available:boolean){
 return withReadTransaction(db,()=>{
  const row=db.prepare('SELECT * FROM wb_task_prd_work_requests WHERE owner_id=? AND task_id=? AND plan_id=?').get(owner,taskId,planId) as Row|undefined;
  if(!row)return {task_id:taskId,plan_id:planId,available,request:null,admission:null,reason:null,execution_authorized:false};
  const grant=originalGrant(db,row);
  let admission:{grant_id:string;occurrence_id:string;run_id:string;conversation_id:string;created_at:string}|null=null;
  if(db.prepare('SELECT 1 FROM wb_discovery_work_admissions WHERE owner_id=? AND grant_id=?').get(owner,row.grant_id)){
   const saved=new WorkAdmissionRecords(db).get(owner,grant.scope,row.grant_id);
   admission={grant_id:saved.grant_id,occurrence_id:saved.occurrence_id,run_id:saved.run_id,conversation_id:saved.conversation_id,created_at:saved.created_at};
  }
  const wait=db.prepare('SELECT reason FROM wb_task_prd_work_request_deferrals WHERE grant_id=?').get(row.grant_id) as Row|undefined;
  return {task_id:taskId,plan_id:planId,available,request:receipt(row),admission,reason:admission?null:String(wait?.reason??'ADMISSION_PENDING'),execution_authorized:false};
 });
}
/** Admission intent only. The existing controller owns original occurrence
 * creation and grant-level replay, including overlapping worker recovery. */
export class PrdWorkAdmissionRequests{
 private readonly db:DatabaseSync;private readonly controller:Pick<WorkAdmissionController,'admit'>;
 constructor(db:DatabaseSync,controller:Pick<WorkAdmissionController,'admit'>){this.db=db;this.controller=controller;installPrdWorkAdmissionRequests(db);}
 async processNext(signal:AbortSignal){
  signal.throwIfAborted();
  const row=withImmediateTransaction(this.db,()=>{
   const now=Date.now(),next=this.db.prepare(`SELECT q.* FROM wb_task_prd_work_requests q
    LEFT JOIN wb_discovery_work_admissions a ON a.grant_id=q.grant_id AND a.owner_id=q.owner_id
    LEFT JOIN wb_task_prd_work_request_deferrals d ON d.grant_id=q.grant_id
    WHERE a.grant_id IS NULL AND (d.not_before IS NULL OR d.not_before<=?) ORDER BY COALESCE(d.not_before,0),q.created_at,q.grant_id LIMIT 1`).get(now) as Row|undefined;
   if(next)this.defer(next.grant_id,now+120_000,'ADMISSION_CHECKING');return next;
  });
  if(!row)return false;
  let reason='ADMISSION_RETRY';
  try{
   const grant=originalGrant(this.db,row),result=await this.controller.admit(row.owner_id,grant.scope,grant.grant_id,AbortSignal.any([signal,AbortSignal.timeout(120_000)]));
   if(result.admitted)return true;
   reason=/^[A-Z][A-Z0-9_]{0,95}$/.test(result.reason)?result.reason:'ADMISSION_RETRY';
  }catch(error){
   if(signal.aborted)throw signal.reason;
   if(error instanceof Error&&['work_cycle_authority_revoked','work_cycle_closed','work_cycle_version_conflict',
    'work_grant_authority_revoked','work_grant_source_changed','work_admission_source_changed','work_admission_snapshot_changed',
    'prd_work_plan_scope_changed','prd_work_plan_ledger_changed','task_state_conflict','task_budget_exhausted','task_active_occurrence'].includes(error.message))reason=error.message.toUpperCase();
  }
  withImmediateTransaction(this.db,()=>this.defer(row.grant_id,Date.now()+5000,reason));return true;
 }
 private defer(grantId:string,notBefore:number,reason:string){this.db.prepare('INSERT INTO wb_task_prd_work_request_deferrals VALUES(?,?,?) ON CONFLICT(grant_id) DO UPDATE SET not_before=excluded.not_before,reason=excluded.reason').run(grantId,notBefore,reason);}
}
