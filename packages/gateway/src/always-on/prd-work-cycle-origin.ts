import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {readPrdWorkPlanAcceptance} from '../persistent-tasks/prd-work-plan-acceptances.ts';
import {prdWorkPlanAuthority} from '../persistent-tasks/prd-work-plan-authority.ts';

type Row=Record<string,any>;
export type PrdWorkCycleOrigin=Readonly<{kind:'task_prd';acceptance_id:string;acceptance_sha256:string;plan_id:string;plan_sha256:string}>;
export function installPrdWorkCycleOrigins(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_prd_work_cycle_origins(
  cycle_id TEXT PRIMARY KEY REFERENCES wb_discovery_work_cycles(cycle_id) DEFERRABLE INITIALLY DEFERRED,
  owner_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),
  acceptance_id TEXT NOT NULL UNIQUE REFERENCES wb_task_prd_work_plan_acceptances(acceptance_id),
  acceptance_sha256 TEXT NOT NULL,plan_id TEXT NOT NULL REFERENCES wb_task_prd_work_plans(plan_id),plan_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS wb_prd_cycle_plan_scope ON wb_task_prd_work_cycle_origins(owner_id,task_id,plan_id);
 CREATE TRIGGER IF NOT EXISTS wb_prd_cycle_origin_scope BEFORE INSERT ON wb_task_prd_work_cycle_origins
 WHEN EXISTS(SELECT 1 FROM wb_discovery_work_cycles WHERE cycle_id=NEW.cycle_id AND admission_id IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM wb_task_prd_work_plan_acceptances a JOIN wb_task_prd_work_plans p ON p.plan_id=a.plan_id
  WHERE a.acceptance_id=NEW.acceptance_id AND a.owner_id=NEW.owner_id AND a.task_id=NEW.task_id
  AND a.record_sha256=NEW.acceptance_sha256 AND a.plan_id=NEW.plan_id AND p.owner_id=a.owner_id AND p.task_id=a.task_id
  AND p.snapshot_sha256=NEW.plan_sha256 AND json_extract(a.record_json,'$.plan_sha256')=NEW.plan_sha256
  AND json_extract(a.record_json,'$.accepted')=1 AND json_extract(a.record_json,'$.execution_authorized')=0)
 BEGIN SELECT RAISE(ABORT,'work_cycle_prd_origin_invalid'); END;
 CREATE TRIGGER IF NOT EXISTS wb_prd_cycle_origin_no_replace BEFORE INSERT ON wb_task_prd_work_cycle_origins
 WHEN EXISTS(SELECT 1 FROM wb_task_prd_work_cycle_origins WHERE cycle_id=NEW.cycle_id OR acceptance_id=NEW.acceptance_id)
 BEGIN SELECT RAISE(ABORT,'work_cycle_prd_origin_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_work_cycle_prd_origin_required BEFORE INSERT ON wb_discovery_work_cycles
 WHEN NEW.admission_id IS NULL AND NOT EXISTS(SELECT 1 FROM wb_task_prd_work_cycle_origins o
  WHERE o.cycle_id=NEW.cycle_id AND o.owner_id=NEW.owner_id AND o.task_id=NEW.task_id)
 BEGIN SELECT RAISE(ABORT,'work_cycle_prd_origin_required'); END;`);
 for(const operation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS wb_prd_cycle_origin_no_${operation.toLowerCase()}
  BEFORE ${operation} ON wb_task_prd_work_cycle_origins BEGIN SELECT RAISE(ABORT,'work_cycle_prd_origin_immutable'); END;`);
}

export function prdCycleAcceptance(db:DatabaseSync,owner:string,taskId:string,planId:string,expectedHash:string,workCycleId?:string){
 const acceptance=readPrdWorkPlanAcceptance(db,owner,taskId,planId);
 if(!acceptance||acceptance.sha256!==expectedHash)throw Error('work_cycle_prd_review_changed');
 const {plan,facts}=prdWorkPlanAuthority(db,owner,taskId,planId,workCycleId);
 if(plan.sha256!==acceptance.plan_sha256)throw Error('work_cycle_corrupt');
 for(const key of ['task_version','task_generation','role','source','ledger_sha256','occurrence_id','root_run_id','planning_current_run_id'] as const){
  if(canonicalJson(facts[key])!==canonicalJson(acceptance[key]))throw Error('work_cycle_authority_revoked');
 }
 return {acceptance,plan,facts};
}

export function readPrdCycleOrigin(db:DatabaseSync,cycle:Row):PrdWorkCycleOrigin{
 const row=db.prepare('SELECT * FROM wb_task_prd_work_cycle_origins WHERE cycle_id=? AND owner_id=? AND task_id=?')
  .get(cycle.cycle_id,cycle.owner_id,cycle.task_id) as Row|undefined;
 if(!row)throw Error('work_cycle_corrupt');
 const acceptance=readPrdWorkPlanAcceptance(db,cycle.owner_id,cycle.task_id,row.plan_id);
 if(!acceptance||acceptance.acceptance_id!==row.acceptance_id||acceptance.sha256!==row.acceptance_sha256
  ||acceptance.plan_sha256!==row.plan_sha256||acceptance.task_version!==cycle.task_version||acceptance.task_generation!==cycle.task_generation
  ||acceptance.occurrence_id!==cycle.occurrence_id||acceptance.root_run_id!==cycle.root_run_id||acceptance.planning_current_run_id!==cycle.current_run_id
  ||acceptance.role.agent_id!==cycle.agent_id||acceptance.role.workspace_id!==cycle.workspace_id||acceptance.role.project_id!==cycle.project_id
  ||acceptance.role.version!==cycle.role_version||acceptance.role.capability_epoch!==cycle.role_epoch)throw Error('work_cycle_corrupt');
 return {kind:'task_prd',acceptance_id:row.acceptance_id,acceptance_sha256:row.acceptance_sha256,plan_id:row.plan_id,plan_sha256:row.plan_sha256};
}
