import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {getPrdWorkPlan} from './prd-work-plans.ts';
import {readTaskSubtasks} from './subtask-state.ts';
import type {PrdWorkPlanAcceptanceFacts} from './prd-work-plan-acceptances.ts';

type Row=Record<string,any>;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
/** Current database facts only. Historical reviews remain immutable and grant no live authority. */
export function prdWorkPlanAuthority(db:DatabaseSync,owner:string,taskId:string,planId:string):{
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
  JOIN wb_task_subtask_scope s ON s.occurrence_id=o.occurrence_id AND s.task_id=o.task_id
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
 const ledger=readTaskSubtasks(db,taskId,plan.occurrence_id),current=readTaskSubtasks(db,taskId);
 const byId=(a:{subtask_id:string},b:{subtask_id:string})=>Buffer.compare(Buffer.from(a.subtask_id),Buffer.from(b.subtask_id));
 if(hash(canonicalJson(ledger))!==plan.ledger_sha256||canonicalJson([...current].sort(byId))!==canonicalJson([...ledger].sort(byId)))throw Error('prd_work_plan_ledger_changed');
 return {plan,facts:{task_version:Number(task.version),task_generation:Number(task.generation),role,source:plan.source,ledger_sha256:plan.ledger_sha256,
  occurrence_id:plan.occurrence_id,root_run_id:plan.root_run_id,planning_current_run_id:String(occurrence.run_id)}};
}
