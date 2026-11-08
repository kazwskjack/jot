import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';

type Row=Record<string,any>;
export type PrdWorkPlanAcceptanceRequest={
 plan_id:string;preview_sha256:string;expected_task_version:number;expected_role_version:number;expected_role_epoch:number;
};
export type PrdWorkPlanAcceptanceFacts={
 task_version:number;task_generation:number;role:{agent_id:string;version:number;capability_epoch:number;workspace_id:string;project_id:string};
 source:{binding_id:string;content_sha256:string;size:number};ledger_sha256:string;occurrence_id:string;root_run_id:string;planning_current_run_id:string;
};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Owner review material only. Execution still requires the original work grant and native admission. */
export function installPrdWorkPlanAcceptances(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_work_plan_acceptances(
  acceptance_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE REFERENCES wb_task_prd_work_plans(plan_id),
  owner_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),request_sha256 TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wb_task_prd_work_plan_acceptance_commands(
   owner_id TEXT NOT NULL,command_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,
   acceptance_id TEXT NOT NULL REFERENCES wb_task_prd_work_plan_acceptances(acceptance_id),PRIMARY KEY(owner_id,command_key));`);
 for(const table of ['wb_task_prd_work_plan_acceptances','wb_task_prd_work_plan_acceptance_commands']){
  for(const operation of ['UPDATE','DELETE']){
   db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT,'prd_work_plan_acceptance_immutable'); END;`);
  }
  const conflict=table.endsWith('_commands')?'owner_id=NEW.owner_id AND command_key=NEW.command_key':'acceptance_id=NEW.acceptance_id OR plan_id=NEW.plan_id';
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
   WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'prd_work_plan_acceptance_immutable'); END;`);
 }
}

function view(row:Row){
 try{
  const record=JSON.parse(row.record_json);
  if(canonicalJson(record)!==row.record_json||digest(record)!==row.record_sha256||record.protocol!==1
   ||record.acceptance_id!==row.acceptance_id||record.plan_id!==row.plan_id||record.task_id!==row.task_id
   ||record.request_sha256!==row.request_sha256||record.plan_sha256!==row.plan_sha256||record.created_at!==row.created_at
   ||record.accepted!==true||record.execution_authorized!==false)throw Error();
  return {...record,sha256:String(row.record_sha256)};
 }catch{throw Error('prd_work_plan_acceptance_integrity_failed');}
}

export function readPrdWorkPlanAcceptance(db:DatabaseSync,owner:string,taskId:string,planId:string){
 const row=db.prepare(`SELECT a.*,p.snapshot_sha256 AS plan_sha256 FROM wb_task_prd_work_plan_acceptances a
  LEFT JOIN wb_task_prd_work_plans p ON p.plan_id=a.plan_id AND p.owner_id=a.owner_id AND p.task_id=a.task_id
  WHERE a.owner_id=? AND a.task_id=? AND a.plan_id=?`).get(owner,taskId,planId) as Row|undefined;
 return row?view(row):null;
}

export function acceptPrdWorkPlan(db:DatabaseSync,owner:string,taskId:string,input:unknown,key:unknown,validate:(request:PrdWorkPlanAcceptanceRequest)=>PrdWorkPlanAcceptanceFacts){
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).sort().join(',')!=='expected_role_epoch,expected_role_version,expected_task_version,plan_id,preview_sha256')throw Error('invalid_prd_work_plan_acceptance');
 const request=input as PrdWorkPlanAcceptanceRequest;
 if(typeof request.plan_id!=='string'||typeof request.preview_sha256!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(request.plan_id)||!/^[a-f0-9]{64}$/.test(request.preview_sha256)
  ||[request.expected_task_version,request.expected_role_version,request.expected_role_epoch].some(value=>!Number.isSafeInteger(value)||value<1))throw Error('invalid_prd_work_plan_acceptance');
 if(typeof key!=='string'||! /^[\x21-\x7e]{8,128}$/.test(key))throw Error('idempotency_key_invalid');
 const requestHash=digest({owner,task_id:taskId,request});
 return withImmediateTransaction(db,()=>{
  const prior=db.prepare('SELECT * FROM wb_task_prd_work_plan_acceptance_commands WHERE owner_id=? AND command_key=?').get(owner,key) as Row|undefined;
  if(prior){
   if(prior.request_sha256!==requestHash)throw Error('idempotency_conflict');
   const record=readPrdWorkPlanAcceptance(db,owner,taskId,request.plan_id);
   if(!record||record.acceptance_id!==prior.acceptance_id||record.request_sha256!==requestHash)throw Error('prd_work_plan_acceptance_integrity_failed');
   return record;
  }
  const existing=readPrdWorkPlanAcceptance(db,owner,taskId,request.plan_id);
  if(existing&&existing.request_sha256!==requestHash)throw Error('prd_work_plan_acceptance_conflict');
  let record=existing;
  if(!record){
   const facts=validate(request),at=new Date().toISOString();
   const body={protocol:1,acceptance_id:'prd-acceptance-'+digest({owner,task_id:taskId,plan_id:request.plan_id}),
    task_id:taskId,plan_id:request.plan_id,plan_sha256:request.preview_sha256,request_sha256:requestHash,
    ...facts,created_at:at,accepted:true,execution_authorized:false};
   db.prepare('INSERT INTO wb_task_prd_work_plan_acceptances VALUES(?,?,?,?,?,?,?,?)')
    .run(body.acceptance_id,request.plan_id,owner,taskId,requestHash,digest(body),canonicalJson(body),at);
   record={...body,sha256:digest(body)};
  }
  db.prepare('INSERT INTO wb_task_prd_work_plan_acceptance_commands VALUES(?,?,?,?)').run(owner,key,requestHash,record.acceptance_id);
  return record;
 });
}
