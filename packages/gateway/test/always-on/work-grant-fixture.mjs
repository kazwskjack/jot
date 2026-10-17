import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {acceptedWorkCycleFixture} from './work-cycle-fixture.mjs';
import {WorkCycles} from '../../src/always-on/work-cycles.ts';
import {LogicalWorkCycleWorkspaceManager} from '../../src/always-on/logical-work-cycle-workspace.ts';
export async function workGrantFixture(t,{prepare=true}={}){
 const f=await acceptedWorkCycleFixture(t),cycles=new WorkCycles(f.db),cycle=cycles.create('owner',f.scope,{admission_id:f.admission.admission_id,report_sha256:f.report.sha256,plan_ids:f.history.detail('owner',f.scope,f.admission.admission_id).report.plan_ids,expected_policy_version:2,expected_role_version:1,expected_role_epoch:1},'grant-cycle');
 const storageRoot=join(f.root,'grant-snapshots');mkdirSync(storageRoot);const manager=new LogicalWorkCycleWorkspaceManager({db:f.db,workbench:f.workbench,storageRoot});
 const prepared=prepare?await manager.prepare('owner',f.scope,cycle.cycle_id,{signal:new AbortController().signal}):undefined;
 const input={expected_cycle_version:1,expected_policy_version:2,expected_role_version:1,expected_role_epoch:1,snapshot_id:prepared?.snapshot.receipt.snapshot_id??'missing-snapshot',source_sha256:prepared?.source_sha256??'a'.repeat(64)};
 const counts=()=>['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations','wb_model_budget_scopes'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
 return {...f,cycle,cycles,manager,prepared,input,counts};
}
