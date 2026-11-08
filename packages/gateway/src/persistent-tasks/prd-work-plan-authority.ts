import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {getPrdWorkPlan} from './prd-work-plans.ts';
import {readTaskSubtasks} from './subtask-state.ts';
import type {PrdWorkPlanAcceptanceFacts} from './prd-work-plan-acceptances.ts';

type Row=Record<string,any>;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
/** Current database facts only. Historical reviews remain immutable and grant no live authority. */
export function prdWorkPlanAuthority(db:DatabaseSync,owner:string,taskId:string,planId:string,workCycleId?:string):{
 plan:ReturnType<typeof getPrdWorkPlan>;facts:PrdWorkPlanAcceptanceFacts;
}{
 if(!db.isTransaction)throw Error('prd_work_plan_transaction_required');
 const plan=getPrdWorkPlan(db,owner,taskId,planId);
 const task=db.prepare('SELECT * FROM wb_persistent_tasks WHERE owner_id=? AND task_id=?').get(owner,taskId) as Row|undefined;
 if(!task)throw Error('task_not_found');
 const agent=db.prepare('SELECT * FROM wb_agents WHERE owner_id=? AND agent_id=?').get(owner,task.agent_id) as Row|undefined;
 if(!agent)throw Error('agent_not_found');
 const role={agent_id:String(agent.agent_id),version:Number(agent.version),capability_epoch:Number(agent.capability_epoch),
  workspace_id:String(agent.workspace_id),project_id:String(agent.project_id)};
 if(Number(task.version)!==plan.task_version||canonicalJson(plan.role)!==canonicalJson(role)||agent.status!=='active'
  ||!['active','budget_exhausted'].includes(String(task.status))||hash(String(task.objective))!==plan.objective_sha256)throw Error('prd_work_plan_scope_changed');
 const occurrence=db.prepare(`SELECT o.root_run_id,o.run_id,o.generation FROM wb_task_current_occurrences o
  WHERE o.occurrence_id=? AND o.task_id=?`).get(plan.occurrence_id,taskId) as Row|undefined;
 if(!occurrence||occurrence.root_run_id!==plan.root_run_id||occurrence.generation!==task.generation)throw Error('prd_work_plan_scope_changed');
 const source=db.prepare(`SELECT p.*,s.occurrence_id,s.root_run_id FROM wb_task_run_occurrences o
  JOIN wb_task_prd_occurrence_sources s ON s.occurrence_id=o.occurrence_id AND s.root_run_id=o.root_run_id AND s.task_id=o.task_id
  JOIN wb_task_prd_bindings p ON p.binding_id=s.binding_id AND p.owner_id=s.owner_id AND p.task_id=s.task_id
  JOIN wb_persistent_tasks t ON t.task_id=s.task_id AND t.owner_id=s.owner_id
  WHERE o.run_id=? AND s.owner_id=?`).get(plan.run_id,owner) as Row|undefined;
 const latest=db.prepare('SELECT binding_id FROM wb_task_prd_bindings WHERE owner_id=? AND task_id=? ORDER BY revision DESC LIMIT 1').get(owner,taskId) as Row|undefined;
 if(!source||latest?.binding_id!==plan.source.binding_id||source.binding_id!==plan.source.binding_id||source.root_run_id!==plan.root_run_id
  ||source.occurrence_id!==plan.occurrence_id||source.content_sha256!==plan.source.content_sha256||source.objective!==task.objective
  ||hash(source.content)!==plan.source.content_sha256||Buffer.byteLength(source.content,'utf8')!==plan.source.size)throw Error('prd_work_plan_scope_changed');
 const ledger=readTaskSubtasks(db,taskId,plan.occurrence_id);
 if(hash(canonicalJson(ledger))!==plan.ledger_sha256)throw Error('prd_work_plan_ledger_changed');
 const scope=db.prepare('SELECT occurrence_id FROM wb_task_subtask_scope WHERE task_id=?').get(taskId) as Row|undefined;
 if(scope?.occurrence_id===plan.occurrence_id){
  const current=readTaskSubtasks(db,taskId),byId=(a:{subtask_id:string},b:{subtask_id:string})=>Buffer.compare(Buffer.from(a.subtask_id),Buffer.from(b.subtask_id));
  if(canonicalJson([...current].sort(byId))!==canonicalJson([...ledger].sort(byId)))throw Error('prd_work_plan_ledger_changed');
 }else{
  if(!workCycleId||!scope)throw Error('prd_work_plan_scope_changed');
  const work=db.prepare(`SELECT a.*,g.grant_json,g.grant_sha256 FROM wb_discovery_work_admissions a
   JOIN wb_discovery_work_grants g ON g.grant_id=a.grant_id AND g.owner_id=a.owner_id
   JOIN wb_discovery_work_cycles c ON c.cycle_id=g.cycle_id AND c.owner_id=g.owner_id AND c.task_id=a.task_id
   JOIN wb_task_prd_work_cycle_origins origin ON origin.cycle_id=c.cycle_id AND origin.owner_id=c.owner_id AND origin.task_id=c.task_id
   JOIN wb_task_occurrences o ON o.occurrence_id=a.occurrence_id AND o.task_id=a.task_id AND o.run_id=a.run_id AND o.conversation_id=a.conversation_id
   JOIN wb_task_current_occurrences current ON current.occurrence_id=o.occurrence_id AND current.task_id=o.task_id
   WHERE a.owner_id=? AND a.task_id=? AND a.occurrence_id=? AND c.cycle_id=? AND c.occurrence_id=? AND origin.plan_id=?
    AND c.admission_id IS NULL AND c.state='open' AND c.version=g.cycle_version
    AND a.task_version=? AND a.task_generation=? AND o.generation=a.task_generation AND current.generation=a.task_generation
    AND json_extract(g.grant_json,'$.origin.acceptance_id')=origin.acceptance_id
    AND json_extract(g.grant_json,'$.origin.acceptance_sha256')=origin.acceptance_sha256
    AND o.trigger_key='prd-work:'||a.grant_id`).get(owner,taskId,scope.occurrence_id,workCycleId,plan.occurrence_id,planId,task.version,task.generation) as Row|undefined;
  if(!work)throw Error('prd_work_plan_scope_changed');
  const record=JSON.parse(work.record_json),grant=JSON.parse(work.grant_json);
  if(canonicalJson(record)!==work.record_json||hash(work.record_json)!==work.record_sha256||canonicalJson(grant)!==work.grant_json
   ||hash(work.grant_json)!==work.grant_sha256||record.grant_sha256!==work.grant_sha256||record.grant_id!==work.grant_id
   ||record.owner_id!==owner||record.task_id!==taskId||record.cycle_id!==workCycleId||record.occurrence_id!==work.occurrence_id
   ||record.run_id!==work.run_id||record.conversation_id!==work.conversation_id||record.task_version!==task.version||record.task_generation!==task.generation
   ||record.protocol!==1||grant.protocol!==1||record.task_budget_scope_id!==grant.task_budget_scope_id
   ||grant.task_version!==task.version||grant.task_generation!==task.generation
   ||canonicalJson(grant.scope)!==canonicalJson({agent_id:role.agent_id,project_id:role.project_id,workspace_id:role.workspace_id})
   ||grant.role_version!==role.version||grant.role_epoch!==role.capability_epoch
   ||grant.owner_id!==owner||grant.task_id!==taskId||grant.cycle_id!==workCycleId||grant.grant_id!==work.grant_id
   ||grant.origin?.kind!=='task_prd'||grant.origin.plan_id!==planId||grant.origin.plan_sha256!==plan.sha256
   ||grant.planning_occurrence_id!==plan.occurrence_id||grant.planning_root_run_id!==plan.root_run_id
   ||grant.planning_current_run_id!==occurrence.run_id||record.execution_authorized!==false||grant.execution_authorized!==false)throw Error('prd_work_plan_scope_changed');
 }

 return {plan,facts:{task_version:Number(task.version),task_generation:Number(task.generation),role,source:plan.source,ledger_sha256:plan.ledger_sha256,
  occurrence_id:plan.occurrence_id,root_run_id:plan.root_run_id,planning_current_run_id:String(occurrence.run_id)}};
}
