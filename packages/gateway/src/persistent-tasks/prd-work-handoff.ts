import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {RunCommandService} from '../runs/commands.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {WorkCycles} from '../always-on/work-cycles.ts';

type Row=Record<string,any>;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const commandKey=(owner:string,taskId:string,planId:string,cycleId:string)=>'prd-work-handoff-'+digest({owner,task_id:taskId,plan_id:planId,cycle_id:cycleId});
function nativeBinding(db:DatabaseSync,owner:string,runId:string,conversationId:string){
 return db.prepare(`SELECT n.session_id FROM ga_run_native_sessions n JOIN ga_harness_session_bindings b
  ON b.conversation_id=n.conversation_id AND b.owner_id=? AND b.session_id=n.session_id
  WHERE n.run_id=? AND n.conversation_id=?`).get(owner,runId,conversationId) as Row|undefined;
}
function planning(db:DatabaseSync,owner:string,taskId:string,cycleId:string){
 const row=db.prepare(`SELECT r.id AS run_id,r.status,r.version,r.conversation_id FROM wb_discovery_work_cycles c
  JOIN wb_task_current_occurrences o ON o.occurrence_id=c.occurrence_id AND o.task_id=c.task_id AND o.run_id=c.current_run_id
  JOIN ga_runs r ON r.id=o.run_id AND r.conversation_id=o.conversation_id
  JOIN ga_conversations conversation ON conversation.id=r.conversation_id AND conversation.owner_id=c.owner_id
   AND conversation.workspace_id=c.workspace_id AND conversation.project_id=c.project_id
  WHERE c.cycle_id=? AND c.owner_id=? AND c.task_id=?`).get(cycleId,owner,taskId) as Row|undefined;
 if(!row)throw Error('prd_work_handoff_scope_changed');
 return row;
}
function receipt(taskId:string,planId:string,cycleId:string,runId:string,commandId:string){
 return {protocol:1,task_id:taskId,plan_id:planId,cycle_id:cycleId,run_id:runId,command_id:commandId,accepted:true,execution_authorized:false};
}

/** Read original cancellation and task-drain facts only. Native idle, capacity
 * and original budget admission remain separate mandatory execution checks. */
export function readPrdWorkHandoff(db:DatabaseSync,owner:string,taskId:string,planId:string,available:boolean,drain:()=>string[]){
 const cycle=new WorkCycles(db).prdCycle(owner,taskId,planId);
 if(!cycle)return {task_id:taskId,plan_id:planId,cycle_id:null,available,planning:null,command_id:null,requested:false,settled:false,reasons:[],execution_authorized:false};
 const run=planning(db,owner,taskId,cycle.cycle_id),key=commandKey(owner,taskId,planId,cycle.cycle_id);
 const command=db.prepare("SELECT * FROM ga_run_commands WHERE run_id=? AND kind='cancel' AND idempotency_key=?").get(run.run_id,'cancel:'+key) as Row|undefined;
 const reasons=drain();
 if(command){
  const payload=JSON.parse(command.payload_json),binding=nativeBinding(db,owner,run.run_id,run.conversation_id);
  if(payload.reason!=='prd_work_handoff'||payload.handoff?.cycle_id!==cycle.cycle_id||payload.handoff?.plan_id!==planId
   ||payload.handoff?.acceptance_sha256!==cycle.origin.acceptance_sha256)throw Error('prd_work_handoff_integrity_failed');
  if(!binding||binding.session_id!==payload.handoff.session_id)reasons.push('PRD_WORK_HANDOFF_BINDING_UNCONFIRMED');
  if(command.status==='superseded')reasons.push('PRD_WORK_HANDOFF_SUPERSEDED');
  else if(command.status!=='applied'||run.status!=='cancelled')reasons.push('PRD_WORK_HANDOFF_PENDING');
 }
 return {task_id:taskId,plan_id:planId,cycle_id:cycle.cycle_id,available,
  planning:{run_id:String(run.run_id),status:String(run.status),version:Number(run.version)},command_id:command?String(command.id):null,
  requested:!!command,settled:!!command&&reasons.length===0,reasons:[...new Set(reasons)],execution_authorized:false};
}

/** Explicit owner request through the existing run command/Session dispatcher.
 * Keep original occurrence generation, task ledger and cumulative budgets. */
export function requestPrdWorkHandoff(db:DatabaseSync,commands:Pick<RunCommandService,'cancel'>|undefined,owner:string,taskId:string,input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).sort().join(',')!=='cycle_id,expected_run_version,plan_id,preview_sha256,run_id')throw Error('invalid_prd_work_handoff');
 const request=input as Row;
 if(typeof request.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(request.plan_id)||typeof request.preview_sha256!=='string'||!/^[a-f0-9]{64}$/.test(request.preview_sha256)
  ||typeof request.run_id!=='string'||!request.run_id||request.run_id.length>200||typeof request.cycle_id!=='string'||!request.cycle_id||request.cycle_id.length>256
  ||!Number.isSafeInteger(request.expected_run_version)||request.expected_run_version<1)throw Error('invalid_prd_work_handoff');
 return withImmediateTransaction(db,()=>{
  const cycles=new WorkCycles(db),cycle=cycles.prdCycle(owner,taskId,request.plan_id);
  if(!cycle||cycle.cycle_id!==request.cycle_id||cycle.origin.acceptance_sha256!==request.preview_sha256)throw Error('prd_work_handoff_scope_changed');
  const owned=db.prepare('SELECT agent_id,project_id,workspace_id,current_run_id FROM wb_discovery_work_cycles WHERE cycle_id=? AND owner_id=?').get(cycle.cycle_id,owner) as Row;
  if(owned.current_run_id!==request.run_id)throw Error('prd_work_handoff_scope_changed');
  const key=commandKey(owner,taskId,request.plan_id,cycle.cycle_id);
  const prior=db.prepare("SELECT * FROM ga_run_commands WHERE run_id=? AND kind='cancel' AND idempotency_key=?").get(request.run_id,'cancel:'+key) as Row|undefined;
  if(prior){
   const payload=JSON.parse(prior.payload_json);
   if(payload.expected_run_version!==request.expected_run_version||payload.reason!=='prd_work_handoff'||payload.handoff?.cycle_id!==cycle.cycle_id
    ||payload.handoff?.plan_id!==request.plan_id||payload.handoff?.acceptance_sha256!==request.preview_sha256)throw Error('idempotency_conflict');
   return receipt(taskId,request.plan_id,cycle.cycle_id,request.run_id,String(prior.id));
  }
  if(!commands)throw Error('prd_work_handoff_unavailable');
  cycles.guard(owner,{agent_id:owned.agent_id,project_id:owned.project_id,workspace_id:owned.workspace_id},cycle.cycle_id);
  const run=planning(db,owner,taskId,cycle.cycle_id);
  if(run.run_id!==request.run_id||run.version!==request.expected_run_version||!['starting','running','waiting_user','waiting_approval'].includes(run.status))throw Error('prd_work_handoff_scope_changed');
  const binding=nativeBinding(db,owner,run.run_id,run.conversation_id);
  if(!binding)throw Error('prd_work_handoff_binding_unconfirmed');
  const result=commands.cancel(run.run_id,owner,{expected_run_version:request.expected_run_version,reason:'prd_work_handoff',
   handoff:{cycle_id:cycle.cycle_id,plan_id:request.plan_id,acceptance_sha256:request.preview_sha256,session_id:String(binding.session_id)}},key);
  return receipt(taskId,request.plan_id,cycle.cycle_id,run.run_id,result.command_id);
 });
}
