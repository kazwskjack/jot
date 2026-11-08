import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {WorkCycles} from '../always-on/work-cycles.ts';
import {WorkCycleSources} from '../always-on/work-cycle-sources.ts';
import {WorkspaceJournal} from '../always-on/workspace-journal.ts';
import {WorkGrants,type WorkGrant} from '../always-on/work-grants.ts';
import type {LogicalWorkCycleWorkspaceManager} from '../always-on/logical-work-cycle-workspace.ts';

type Row=Record<string,any>;
export type PrdWorkResourcePorts={workspace:Pick<LogicalWorkCycleWorkspaceManager,'prepare'>;grants:WorkGrants};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function request(value:unknown,keys:string[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('invalid_prd_work_resource');
 const input=value as Row;
 if(typeof input.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(input.plan_id)||typeof input.cycle_id!=='string'||!input.cycle_id||input.cycle_id.length>256
  ||typeof input.preview_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.preview_sha256))throw Error('invalid_prd_work_resource');
 return input;
}
function key(value:unknown):string{if(typeof value!=='string'||! /^[\x21-\x7e]{8,128}$/.test(value))throw Error('idempotency_key_invalid');return value;}
function ownedCycle(db:DatabaseSync,owner:string,taskId:string,planId:string,cycleId:string){
 const cycle=new WorkCycles(db).prdCycle(owner,taskId,planId);
 if(!cycle||cycle.cycle_id!==cycleId)throw Error('work_cycle_not_found');
 const scope=db.prepare('SELECT agent_id,workspace_id,project_id FROM wb_discovery_work_cycles WHERE cycle_id=? AND owner_id=? AND task_id=?').get(cycleId,owner,taskId) as {agent_id:string;workspace_id:string;project_id:string};
 return {cycle,scope};
}
export function installPrdWorkResources(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_work_preparations(
  cycle_id TEXT PRIMARY KEY REFERENCES wb_discovery_work_cycles(cycle_id),owner_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),plan_id TEXT NOT NULL REFERENCES wb_task_prd_work_plans(plan_id),
  snapshot_id TEXT NOT NULL,review_sha256 TEXT NOT NULL,review_json TEXT NOT NULL,created_at TEXT NOT NULL,
  FOREIGN KEY(cycle_id,snapshot_id) REFERENCES wb_discovery_workspace_intents(cycle_id,snapshot_id));
 CREATE INDEX IF NOT EXISTS wb_prd_work_preparation_plan ON wb_task_prd_work_preparations(owner_id,task_id,plan_id);
 CREATE TABLE IF NOT EXISTS wb_task_prd_work_preparation_commands(owner_id TEXT NOT NULL,command_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,
  cycle_id TEXT NOT NULL REFERENCES wb_task_prd_work_preparations(cycle_id),PRIMARY KEY(owner_id,command_key));
 CREATE TRIGGER IF NOT EXISTS wb_prd_work_preparation_scope BEFORE INSERT ON wb_task_prd_work_preparations
 WHEN NOT EXISTS(SELECT 1 FROM wb_discovery_work_cycles c JOIN wb_task_prd_work_cycle_origins o ON o.cycle_id=c.cycle_id
  JOIN wb_discovery_workspace_records r ON r.cycle_id=c.cycle_id AND r.snapshot_id=NEW.snapshot_id
  JOIN wb_discovery_work_cycle_sources source ON source.cycle_id=c.cycle_id
  WHERE c.cycle_id=NEW.cycle_id AND c.owner_id=NEW.owner_id AND c.task_id=NEW.task_id AND o.plan_id=NEW.plan_id
   AND c.state='open' AND c.version=json_extract(NEW.review_json,'$.cycle_version')
   AND r.record_sha256=json_extract(NEW.review_json,'$.snapshot_record_sha256')
   AND source.record_sha256=json_extract(NEW.review_json,'$.source_record_sha256'))
 BEGIN SELECT RAISE(ABORT,'prd_work_preparation_scope_invalid'); END;`);
 for(const table of ['wb_task_prd_work_preparations','wb_task_prd_work_preparation_commands']){
  for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'prd_work_preparation_immutable'); END;`);
  const conflict=table.endsWith('_commands')?'owner_id=NEW.owner_id AND command_key=NEW.command_key':'cycle_id=NEW.cycle_id';
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${conflict}) BEGIN SELECT RAISE(ABORT,'prd_work_preparation_immutable'); END;`);
 }
}
function preparation(db:DatabaseSync,owner:string,taskId:string,planId:string){
 const row=db.prepare('SELECT * FROM wb_task_prd_work_preparations WHERE owner_id=? AND task_id=? AND plan_id=?').get(owner,taskId,planId) as Row|undefined;
 if(!row)return null;
 try{
  const body=JSON.parse(row.review_json);
  if(canonicalJson(body)!==row.review_json||digest(body)!==row.review_sha256||body.protocol!==1||body.task_id!==row.task_id||body.plan_id!==row.plan_id
   ||body.cycle_id!==row.cycle_id||body.snapshot_id!==row.snapshot_id||body.created_at!==row.created_at||body.execution_authorized!==false||body.source_bytes_verified!==false)throw Error();
  return {...body,review_sha256:String(row.review_sha256)};
 }catch{throw Error('prd_work_preparation_integrity_failed');}
}
function prior(db:DatabaseSync,owner:string,taskId:string,input:Row,commandKey:string,hash:string){
 const row=db.prepare('SELECT * FROM wb_task_prd_work_preparation_commands WHERE owner_id=? AND command_key=?').get(owner,commandKey) as Row|undefined;
 if(!row)return null;
 if(row.request_sha256!==hash)throw Error('idempotency_conflict');
 const view=preparation(db,owner,taskId,input.plan_id);
 if(!view||view.cycle_id!==row.cycle_id)throw Error('prd_work_preparation_integrity_failed');
 return view;
}
/** Physical IO stays outside the original atomic HTTP business transaction. */
export async function preparePrdWorkSnapshot(db:DatabaseSync,ports:PrdWorkResourcePorts|undefined,owner:string,taskId:string,value:unknown,rawKey:unknown,drain:()=>string[],signal:AbortSignal){
 const input=request(value,['plan_id','cycle_id','preview_sha256','expected_cycle_version']),commandKey=key(rawKey),hash=digest({task_id:taskId,input});
 if(!Number.isSafeInteger(input.expected_cycle_version)||input.expected_cycle_version<1)throw Error('invalid_prd_work_resource');
 const saved=withReadTransaction(db,()=>prior(db,owner,taskId,input,commandKey,hash));
 if(saved)return()=>saved;
 const existing=withReadTransaction(db,()=>preparation(db,owner,taskId,input.plan_id));
 if(existing){
  if(existing.cycle_id!==input.cycle_id||existing.acceptance_sha256!==input.preview_sha256||existing.cycle_version!==input.expected_cycle_version)throw Error('prd_work_preparation_changed');
  return()=>withImmediateTransaction(db,()=>{
   const recovered=prior(db,owner,taskId,input,commandKey,hash);if(recovered)return recovered;
   db.prepare('INSERT INTO wb_task_prd_work_preparation_commands VALUES(?,?,?,?)').run(owner,commandKey,hash,existing.cycle_id);return existing;
  });
 }
 if(!ports)throw Error('prd_work_preparation_unavailable');
 if(db.isTransaction)throw Error('prd_work_preparation_transaction_active');
 const {cycle,scope}=ownedCycle(db,owner,taskId,input.plan_id,input.cycle_id);
 if(cycle.version!==input.expected_cycle_version||cycle.origin.acceptance_sha256!==input.preview_sha256)throw Error('prd_work_preparation_changed');
 if(drain().length)throw Error('prd_work_preparation_unresolved');
 const prepared=await ports.workspace.prepare(owner,scope,cycle.cycle_id,{signal});
 return()=>withImmediateTransaction(db,()=>{
  const recovered=prior(db,owner,taskId,input,commandKey,hash);if(recovered)return recovered;
  const current=new WorkCycles(db).guard(owner,scope,cycle.cycle_id);
  if(current.admission_id!==null||current.version!==input.expected_cycle_version||current.origin.acceptance_sha256!==input.preview_sha256)throw Error('prd_work_preparation_changed');
  const source=new WorkCycleSources(db).get(owner,scope,cycle.cycle_id),record=new WorkspaceJournal(db).record(owner,scope,cycle.cycle_id,prepared.snapshot.receipt.snapshot_id);
  if(!source||!record||source.sha256!==prepared.source_sha256||record.receipt.manifest_sha256!==prepared.snapshot.receipt.manifest_sha256)throw Error('prd_work_preparation_changed');
  const body={protocol:1,task_id:taskId,plan_id:input.plan_id,cycle_id:cycle.cycle_id,cycle_version:cycle.version,
   acceptance_sha256:input.preview_sha256,snapshot_id:record.snapshot_id,source_sha256:source.sha256,
   manifest_sha256:record.receipt.manifest_sha256,source_record_sha256:digest(source),snapshot_record_sha256:digest(record),
   role_version:cycle.role_version,role_epoch:cycle.role_epoch,file_count:record.receipt.file_count,total_bytes:record.receipt.total_bytes,
   paths:[...new Set(current.plans.flatMap(plan=>plan.paths))].sort(),created_at:record.receipt.created_at,execution_authorized:false,source_bytes_verified:false};
  const other=preparation(db,owner,taskId,input.plan_id);
  if(other){if(other.review_sha256!==digest(body))throw Error('prd_work_preparation_changed');}
  else db.prepare('INSERT INTO wb_task_prd_work_preparations VALUES(?,?,?,?,?,?,?,?)').run(cycle.cycle_id,owner,taskId,input.plan_id,body.snapshot_id,digest(body),canonicalJson(body),body.created_at);
  db.prepare('INSERT INTO wb_task_prd_work_preparation_commands VALUES(?,?,?,?)').run(owner,commandKey,hash,cycle.cycle_id);
  return {...body,review_sha256:digest(body)};
 });
}
function grantView(grant:WorkGrant,review:Row){
 if(grant.admission_id!==null||grant.task_id!==review.task_id||grant.cycle_id!==review.cycle_id||grant.snapshot_id!==review.snapshot_id
  ||grant.source_sha256!==review.source_sha256||grant.source_record_sha256!==review.source_record_sha256||grant.snapshot_record_sha256!==review.snapshot_record_sha256
  ||grant.origin.plan_id!==review.plan_id||grant.origin.acceptance_sha256!==review.acceptance_sha256)throw Error('prd_work_preparation_integrity_failed');
 return {protocol:1,task_id:grant.task_id,plan_id:grant.origin.plan_id,cycle_id:grant.cycle_id,grant_id:grant.grant_id,grant_sha256:digest(grant),
  review_sha256:review.review_sha256,snapshot_id:grant.snapshot_id,source_sha256:grant.source_sha256,paths:[...grant.plan_paths],
  role_version:grant.role_version,role_epoch:grant.role_epoch,created_at:grant.created_at,execution_authorized:false,source_bytes_verified:false};
}
export function readPrdWorkResources(db:DatabaseSync,owner:string,taskId:string,planId:string,available:boolean,drain:()=>string[]){
 return withReadTransaction(db,()=>{
  const cycle=new WorkCycles(db).prdCycle(owner,taskId,planId),review=preparation(db,owner,taskId,planId);
  let grant:ReturnType<typeof grantView>|null=null;
  if(cycle&&review){
   const row=db.prepare('SELECT grant_id FROM wb_discovery_work_grants WHERE cycle_id=? AND owner_id=?').get(cycle.cycle_id,owner) as Row|undefined;
   if(row){const {scope}=ownedCycle(db,owner,taskId,planId,cycle.cycle_id);grant=grantView(new WorkGrants(db).get(owner,scope,row.grant_id),review);}
  }
  const uncertain=!!cycle&&!review&&!!db.prepare('SELECT 1 FROM wb_discovery_workspace_intents WHERE cycle_id=?').get(cycle.cycle_id);
  return {task_id:taskId,plan_id:planId,cycle_id:cycle?.cycle_id??null,available,preparation:review,grant,preparation_uncertain:uncertain,reasons:drain(),execution_authorized:false};
 });
}
export function authorizePrdWork(db:DatabaseSync,ports:PrdWorkResourcePorts|undefined,owner:string,taskId:string,value:unknown,rawKey:unknown){
 const input=request(value,['plan_id','cycle_id','preview_sha256']),commandKey='prd-work-grant-'+digest({task_id:taskId,key:key(rawKey)});
 return withImmediateTransaction(db,()=>{
  const review=preparation(db,owner,taskId,input.plan_id);
  if(!review||review.cycle_id!==input.cycle_id||review.review_sha256!==input.preview_sha256)throw Error('prd_work_preparation_changed');
  const {scope}=ownedCycle(db,owner,taskId,input.plan_id,input.cycle_id);
  const stored=db.prepare('SELECT grant_id FROM wb_discovery_work_grant_commands WHERE owner_id=? AND command_key=?').get(owner,commandKey) as Row|undefined;
  if(!ports&&!stored)throw Error('prd_work_preparation_unavailable');
  const grants=ports?.grants??new WorkGrants(db);
  return grantView(grants.authorize(owner,scope,input.cycle_id,{expected_cycle_version:review.cycle_version,expected_policy_version:null,
   expected_role_version:review.role_version,expected_role_epoch:review.role_epoch,snapshot_id:review.snapshot_id,source_sha256:review.source_sha256},commandKey),review);
 });
}
