import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {DiscoveryHistory,type DiscoveryHistoryScope} from './discovery-history.ts';
import {taskBudgetKey} from '../workbench/model-budget-policy.ts';

type Row=Record<string,any>;
export type WorkCycleScope=DiscoveryHistoryScope;
export type CreateWorkCycle={admission_id:string;report_sha256:string;plan_ids:string[];expected_policy_version:number;expected_role_version:number;expected_role_epoch:number};
export type WorkCyclePlan=Readonly<{plan_id:string;sha256:string;paths:readonly string[]}>;
export type WorkCycleView=Readonly<{cycle_id:string;version:number;state:'open'|'closed';admission_id:string;occurrence_id:string;task_id:string;root_run_id:string;report_sha256:string;policy_version:number;role_version:number;role_epoch:number;plans:readonly WorkCyclePlan[];created_at:string;closed_at:string|null;execution_authorized:false}>;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function id(value:unknown,code='work_cycle_invalid'):string{if(typeof value!=='string'||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value))throw Error(code);return value;}
function exact(value:unknown,keys:string[]):Row{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('work_cycle_invalid');return value as Row;}
function positive(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<1)throw Error('work_cycle_invalid');return Number(value);}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Explicit owned artifact resource commands only; no execution, new task/run,
 * model grant, counter reset, filesystem deletion or budget allocation. */
export class WorkCycles{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;}
 private read<T>(operation:()=>T){if(this.db.isTransaction)return operation();this.db.exec('BEGIN DEFERRED');try{return operation();}finally{this.db.exec('ROLLBACK');}}
 private scope(owner:string,scope:WorkCycleScope){
  id(owner,'work_cycle_not_found');exact(scope,['agent_id','project_id','workspace_id']);for(const key of ['agent_id','project_id','workspace_id'])id((scope as Row)[key],'work_cycle_not_found');
  const row=this.db.prepare(`SELECT a.* FROM wb_agents a JOIN ga_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
   JOIN ga_conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id AND c.project_id=a.project_id AND c.workspace_id=a.workspace_id
   WHERE a.owner_id=? AND a.agent_id=? AND a.project_id=? AND a.workspace_id=?`).get(owner,scope.agent_id,scope.project_id,scope.workspace_id) as Row|undefined;
  if(!row)throw Error('work_cycle_not_found');return row;
 }
 private row(owner:string,scope:WorkCycleScope,cycleId:string){this.scope(owner,scope);id(cycleId,'work_cycle_not_found');const row=this.db.prepare('SELECT * FROM wb_discovery_work_cycles WHERE cycle_id=? AND owner_id=? AND agent_id=? AND project_id=? AND workspace_id=?').get(cycleId,owner,scope.agent_id,scope.project_id,scope.workspace_id) as Row|undefined;if(!row)throw Error('work_cycle_not_found');return row;}
 private view(row:Row):WorkCycleView{
  let plans;try{plans=JSON.parse(row.plans_json);}catch{throw Error('work_cycle_corrupt');}
  if(hash(row.plans_json)!==row.plans_sha256||!Array.isArray(plans))throw Error('work_cycle_corrupt');
  return frozen({cycle_id:row.cycle_id,version:row.version,state:row.state,admission_id:row.admission_id,occurrence_id:row.occurrence_id,task_id:row.task_id,root_run_id:row.root_run_id,report_sha256:row.report_sha256,policy_version:row.policy_version,role_version:row.role_version,role_epoch:row.role_epoch,plans,created_at:row.created_at,closed_at:row.closed_at,execution_authorized:false});
 }
 private prior(owner:string,key:string,fingerprint:string){const row=this.db.prepare('SELECT * FROM wb_discovery_work_cycle_commands WHERE owner_id=? AND command_key=?').get(owner,key) as Row|undefined;if(!row)return null;if(row.command_sha256!==fingerprint)throw Error('idempotency_conflict');try{return frozen(JSON.parse(row.receipt_json)) as WorkCycleView;}catch{throw Error('work_cycle_corrupt');}}
 private receipt(owner:string,key:string,fingerprint:string,cycle:WorkCycleView){this.db.prepare('INSERT INTO wb_discovery_work_cycle_commands VALUES(?,?,?,?,?,?)').run(owner,key,fingerprint,cycle.cycle_id,canonicalJson(cycle),new Date().toISOString());return cycle;}
 private facts(owner:string,scope:WorkCycleScope,admissionId:string){
  const role=this.scope(owner,scope),row=this.db.prepare(`SELECT a.*,o.root_run_id,o.run_id AS current_run_id,t.version AS current_task_version,t.generation AS current_task_generation,t.status AS task_status,
   p.version AS current_policy_version,p.state AS policy_state,p.role_version AS current_policy_role_version,p.role_epoch AS current_policy_role_epoch
   FROM wb_discovery_admissions a JOIN wb_discovery_policies p ON p.policy_id=a.policy_id AND p.owner_id=a.owner_id
   JOIN wb_discovery_task_bindings b ON b.policy_id=p.policy_id AND b.task_id=a.task_id AND b.owner_id=a.owner_id AND b.agent_id=p.agent_id AND b.project_id=p.project_id AND b.workspace_id=p.workspace_id
   JOIN wb_persistent_tasks t ON t.task_id=a.task_id AND t.owner_id=a.owner_id
   JOIN wb_task_current_occurrences o ON o.occurrence_id=a.occurrence_id AND o.task_id=a.task_id
   WHERE a.admission_id=? AND a.owner_id=? AND b.agent_id=? AND b.project_id=? AND b.workspace_id=?`).get(admissionId,owner,scope.agent_id,scope.project_id,scope.workspace_id) as Row|undefined;
  if(!row)throw Error('work_cycle_not_found');
  const head=(this.db.prepare('SELECT coalesce(max(revision),0) revision FROM wb_discovery_signals WHERE policy_id=?').get(row.policy_id) as Row).revision;
  if(role.status!=='active'||role.version!==row.role_version||role.capability_epoch!==row.role_epoch||row.policy_state!=='active'
   ||row.current_policy_version!==row.policy_version||row.current_policy_role_version!==row.role_version||row.current_policy_role_epoch!==row.role_epoch
   ||row.current_task_version!==row.task_version||row.current_task_generation!==row.task_generation||!['active','budget_exhausted'].includes(row.task_status)||head!==row.signal_revision)throw Error('work_cycle_authority_revoked');
  return row;
 }
 private budget(owner:string,row:Row){
  const allocation=this.db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE owner_id=? AND run_id=?').get(owner,row.root_run_id) as Row|undefined,binding=this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,row.root_run_id) as Row|undefined;
  try{const a=JSON.parse(allocation!.allocation_json),bound=JSON.parse(binding!.scopes_json),key=taskBudgetKey(row.task_id),selected=a.scopes.filter((scope:Row)=>scope.key===key);
   if(a.run_id!==row.root_run_id||selected.length!==1||!Array.isArray(bound)||!bound.includes(selected[0].scope_id)||!this.db.prepare('SELECT 1 FROM wb_model_budget_scopes WHERE owner_id=? AND scope_id=? AND scope_key=?').get(owner,selected[0].scope_id,key))throw Error();return id(selected[0].scope_id);
  }catch{throw Error('work_cycle_budget_binding_unconfirmed');}
 }
 private plans(owner:string,scope:WorkCycleScope,admissionId:string,reportHash:string,ids:string[]){
  const history=new DiscoveryHistory(this.db);let page=history.detail(owner,scope,admissionId);
  if(!page.cycle.accepted||!page.report||page.report.outcome!=='proposals'||page.report.sha256!==reportHash||ids.some(id=>!page.report!.plan_ids.includes(id)))throw Error('work_cycle_report_unaccepted');
  const selected=new Map<string,WorkCyclePlan>();
  for(;;){for(const plan of page.plans)if(ids.includes(plan.plan_id))selected.set(plan.plan_id,{plan_id:plan.plan_id,sha256:plan.sha256,paths:[...new Set(plan.changes.map(change=>change.path))].sort()});if(selected.size===ids.length||!page.next_after_plan_id)break;page=history.detail(owner,scope,admissionId,page.next_after_plan_id);}
  if(selected.size!==ids.length)throw Error('work_cycle_report_unaccepted');return ids.map(id=>selected.get(id)!).sort((a,b)=>a.plan_id<b.plan_id?-1:1);
 }
 create(owner:string,scope:WorkCycleScope,input:CreateWorkCycle,key:string):WorkCycleView{
  id(key);exact(input,['admission_id','report_sha256','plan_ids','expected_policy_version','expected_role_version','expected_role_epoch']);id(input.admission_id);if(!/^[a-f0-9]{64}$/.test(input.report_sha256)||!Array.isArray(input.plan_ids)||!input.plan_ids.length||new Set(input.plan_ids).size!==input.plan_ids.length)throw Error('work_cycle_invalid');input.plan_ids.forEach(plan=>id(plan));positive(input.expected_policy_version);positive(input.expected_role_version);positive(input.expected_role_epoch);
  return withImmediateTransaction(this.db,()=>{this.scope(owner,scope);const fingerprint=hash(canonicalJson({scope,action:'create',input})),prior=this.prior(owner,key,fingerprint);if(prior)return prior;
   const row=this.facts(owner,scope,input.admission_id);if(row.policy_version!==input.expected_policy_version||row.role_version!==input.expected_role_version||row.role_epoch!==input.expected_role_epoch)throw Error('work_cycle_version_conflict');
   const plans=this.plans(owner,scope,row.admission_id,input.report_sha256,input.plan_ids),scopeId=this.budget(owner,row),json=canonicalJson(plans);
   if(this.db.prepare("SELECT 1 FROM wb_discovery_work_cycles WHERE owner_id=? AND project_id=? AND workspace_id=? AND state='open'").get(owner,scope.project_id,scope.workspace_id))throw Error('work_cycle_slot_occupied');
   const values=[`work-cycle-${randomUUID()}`,owner,scope.project_id,scope.workspace_id,scope.agent_id,row.admission_id,row.occurrence_id,row.task_id,row.root_run_id,row.current_run_id,input.report_sha256,row.policy_version,row.role_version,row.role_epoch,row.task_version,row.task_generation,row.signal_revision,row.signal_sha256,scopeId,json,hash(json),1,'open',new Date().toISOString(),null];
   this.db.prepare('INSERT INTO wb_discovery_work_cycles VALUES('+values.map(()=>'?').join(',')+')').run(...values);
   return this.receipt(owner,key,fingerprint,this.view(this.row(owner,scope,String(values[0]))));
  });
 }
 get(owner:string,scope:WorkCycleScope,cycleId:string){return this.read(()=>this.view(this.row(owner,scope,cycleId)));}
 list(owner:string,scope:WorkCycleScope,options:{before_id?:string}={}){return this.read(()=>{this.scope(owner,scope);exact(options,options.before_id===undefined?[]:['before_id']);let boundary=Number.MAX_SAFE_INTEGER;if(options.before_id!==undefined){const row=this.db.prepare('SELECT rowid AS sequence FROM wb_discovery_work_cycles WHERE owner_id=? AND agent_id=? AND project_id=? AND workspace_id=? AND cycle_id=?').get(owner,scope.agent_id,scope.project_id,scope.workspace_id,id(options.before_id)) as Row|undefined;if(!row)throw Error('invalid_work_cycle_cursor');boundary=row.sequence;}
  const rows=this.db.prepare('SELECT * FROM wb_discovery_work_cycles WHERE owner_id=? AND agent_id=? AND project_id=? AND workspace_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21').all(owner,scope.agent_id,scope.project_id,scope.workspace_id,boundary) as Row[],page=rows.slice(0,20);return {items:page.map(row=>this.view(row)),next_before_id:rows.length>20?page.at(-1)!.cycle_id:null,execution_authorized:false as const};});}
 guard(owner:string,scope:WorkCycleScope,cycleId:string){return this.read(()=>{const row=this.row(owner,scope,cycleId);if(row.state!=='open')throw Error('work_cycle_closed');const current=this.facts(owner,scope,row.admission_id);
  for(const key of ['occurrence_id','task_id','root_run_id','current_run_id','policy_version','role_version','role_epoch','task_version','task_generation','signal_revision','signal_sha256'])if(row[key]!==current[key])throw Error('work_cycle_authority_revoked');
  if(this.budget(owner,current)!==row.task_budget_scope_id)throw Error('work_cycle_budget_binding_unconfirmed');
  const view=this.view(row),plans=this.plans(owner,scope,row.admission_id,row.report_sha256,view.plans.map(plan=>plan.plan_id));if(canonicalJson(plans)!==row.plans_json)throw Error('work_cycle_corrupt');return view;
 });}
 close(owner:string,scope:WorkCycleScope,cycleId:string,input:{expected_version:number},key:string){id(key);exact(input,['expected_version']);positive(input.expected_version);return withImmediateTransaction(this.db,()=>{const row=this.row(owner,scope,cycleId),fingerprint=hash(canonicalJson({scope,action:'close',cycle_id:cycleId,input})),prior=this.prior(owner,key,fingerprint);if(prior)return prior;if(row.version!==input.expected_version)throw Error('work_cycle_version_conflict');if(row.state!=='open')throw Error('work_cycle_closed');
  const changed=this.db.prepare("UPDATE wb_discovery_work_cycles SET state='closed',version=version+1,closed_at=? WHERE cycle_id=? AND owner_id=? AND version=? AND state='open'").run(new Date().toISOString(),cycleId,owner,input.expected_version);if(changed.changes!==1)throw Error('work_cycle_version_conflict');return this.receipt(owner,key,fingerprint,this.view(this.row(owner,scope,cycleId)));});}
}
