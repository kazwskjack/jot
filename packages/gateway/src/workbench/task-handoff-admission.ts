import type {DatabaseSync} from 'node:sqlite';
import type {AgentRunContext} from './service.ts';
import {assertExecutionLease} from './execution-lease.ts';
import {assertNativeCollaborationPolicy} from './task-collaboration.ts';
/** Additional operation fence only. Original owner/task/role/budget checks
 * remain mandatory. Planning/accounting reads do not invoke this boundary. */
export function assertTaskHandoffOperation(db:DatabaseSync,context:AgentRunContext,session:string){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_handoff_control'").get())return;
 const lineage=db.prepare(`SELECT root_run_id FROM wb_native_execution_runs WHERE run_id=? AND owner_id=?
  UNION ALL SELECT root_run_id FROM wb_task_auxiliary_runs WHERE run_id=? AND owner_id=?
  UNION ALL SELECT root_run_id FROM wb_task_run_occurrences WHERE run_id=? LIMIT 1`).get(context.run_id,context.owner_id,context.run_id,context.owner_id,context.run_id) as {root_run_id:string}|undefined;
 const root=lineage?.root_run_id??context.run_id;
 const row=db.prepare('SELECT authority_json,state_json FROM wb_task_handoff_control WHERE owner_id=? AND root_run_id=?').get(context.owner_id,root) as {authority_json:string;state_json:string}|undefined;
 if(!row)return;const authority=JSON.parse(row.authority_json),state=JSON.parse(row.state_json);
 if(authority.owner!==context.owner_id||authority.root_run!==root||typeof authority.lease_owner!=='string'||!Number.isSafeInteger(authority.policy_version))throw new Error('handoff_authority_invalid');
 assertExecutionLease(db,root,{owner:authority.lease_owner,generation:authority.lease_generation});
 const task=db.prepare('SELECT task_id FROM wb_task_current_occurrences WHERE run_id=?').get(root) as {task_id:string}|undefined;
 if(!task)throw new Error('handoff_identity_forbidden');for(const member of authority.members)assertNativeCollaborationPolicy(db,context.owner_id,task.task_id,authority.policy_version,member);
 if(state.phase==='stopped')throw new Error('handoff_closed');
 if(state.phase==='returned'){
  if(context.run_id!==root||context.agent_id!==authority.lead)throw new Error('handoff_closed');return;
 }
 if(state.phase!=='active'||context.agent_id!==state.controller)throw new Error('handoff_controller_changed');
 const bound=db.prepare('SELECT run_id,session_ref FROM wb_task_handoff_executions WHERE owner_id=? AND root_run_id=? AND revision=?').get(context.owner_id,root,state.revision) as {run_id:string;session_ref:string}|undefined;
 if(!bound)throw new Error('handoff_execution_unbound');
 if(bound.run_id!==context.run_id||bound.session_ref!==session)throw new Error('handoff_execution_conflict');
}
