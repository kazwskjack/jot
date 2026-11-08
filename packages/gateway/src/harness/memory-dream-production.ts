import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {WorkbenchService} from '../workbench/service.ts';
import {MemoryDreamWorkbenchAdapter} from '../workbench/memory-dream-workbench.ts';
import type {MemoryDreamIdentity,DreamConsolidationRecord} from '../workbench/memory-dream-tools.ts';
import type {HarnessCoordinator,RunLease} from './coordinator.ts';
import type {HarnessWorker} from './worker.ts';
import {assertExecutionLease} from '../workbench/execution-lease.ts';
import type {MemoryDreamClaim,MemoryDreamCandidate,MemoryDreamEvidence,MemoryDreamPumpPorts} from './memory-dream-pump.ts';

type Row=Record<string,any>;
type Options={db:DatabaseSync;workbench:WorkbenchService;coordinator:HarnessCoordinator;worker:Pick<HarnessWorker,'processClaimed'>;
 sessionResolver:(conversationId:string)=>string;readiness?:{memoryExtractionReadiness(signal:AbortSignal):Promise<Record<string,unknown>>}};
const unavailable=(error:unknown)=>error instanceof Error&&/^(memory_dream_(?:policy_stale|slot_finalized)|model_metadata_(?:changed|invalid|unavailable)|agent_capability_revoked|model_budget_exhausted|budget_(?:window_closed|route_unavailable|binding_invalid))$/.test(error.message);
const samePolicy=(left:MemoryDreamCandidate['policy'],right:MemoryDreamCandidate['policy'])=>left.owner_id===right.owner_id&&left.workspace_id===right.workspace_id
 &&left.project_id===right.project_id&&left.agent_id===right.agent_id&&left.scope==='project'&&right.scope==='project'
 &&left.enabled===true&&right.enabled===true&&left.policy_version===right.policy_version&&left.epoch===right.epoch&&left.cadence_slot===right.cadence_slot;
function usageSettled(evidence:MemoryDreamEvidence){
 return evidence.budget_attempts.some(item=>item.state==='settled')&&evidence.budget_attempts.every(item=>(item.state==='settled'||item.state==='released')&&item.bound_exceeded===false);
}
function sameEvidence(left:MemoryDreamEvidence,right:MemoryDreamEvidence){
 return left.run_id===right.run_id&&left.owner_id===right.owner_id&&left.workspace_id===right.workspace_id&&left.project_id===right.project_id
  &&left.agent_id===right.agent_id&&left.policy_version===right.policy_version&&left.epoch===right.epoch&&left.cadence_slot===right.cadence_slot
  &&left.policy_current===right.policy_current&&left.source_current===right.source_current
  &&JSON.stringify(left.consolidation)===JSON.stringify(right.consolidation)
  &&JSON.stringify(left.budget_attempts)===JSON.stringify(right.budget_attempts);
}
/** Production ports over the original Workbench, run, budget and DSH worker services. */
export class MemoryDreamProductionPorts implements MemoryDreamPumpPorts{
 private readonly db:DatabaseSync;private readonly workbench:WorkbenchService;private readonly coordinator:HarnessCoordinator;
 private readonly worker:Options['worker'];private readonly sessionResolver:Options['sessionResolver'];private readonly readiness?:Options['readiness'];
 constructor(options:Options){this.db=options.db;this.workbench=options.workbench;this.coordinator=options.coordinator;this.worker=options.worker;this.sessionResolver=options.sessionResolver;this.readiness=options.readiness;}

 async findCandidate(now:string,excludeRunIds:readonly string[]=[]):Promise<MemoryDreamCandidate|null>{
  if(this.readiness&&(await this.readiness.memoryExtractionReadiness(AbortSignal.timeout(15000))).ready!==true)return null;
  const found=this.workbench.findMemoryDreamCandidate(now,new Set(excludeRunIds));if(!found)return null;
  const dueSeconds=Number(found.policy.cadence_slot);if(!Number.isSafeInteger(dueSeconds)||dueSeconds<0)return null;
  let dueAt:string;try{dueAt=new Date(dueSeconds*1000).toISOString();}catch{return null;}
  return{...found,policy:{...found.policy,due_at:dueAt}};
 }

 async claim(candidate:MemoryDreamCandidate,workerId:string,leaseMs:number):Promise<MemoryDreamClaim|null>{
  try{
   const commit=await this.workbench.prepareMemoryConsolidationAdmission(candidate.policy.owner_id,candidate.policy.agent_id,candidate.policy.policy_version,candidate.policy.cadence_slot);
   return withImmediateTransaction(this.db,()=>{
    const prepared=commit();
    if(!samePolicy(candidate.policy,{...prepared.policy,scope:'project',cadence_slot:prepared.cadence_slot,due_at:candidate.policy.due_at})
      ||candidate.mode==='recovery'&&prepared.run_id!==candidate.run_id||candidate.mode==='fresh'&&candidate.run_id!==undefined)throw Error('memory_dream_policy_stale');
    const lease=this.coordinator.claimMemoryConsolidation(workerId,leaseMs,prepared.run_id,candidate.mode==='recovery');
    if(!lease)throw Error('memory_dream_admission_unavailable');
    const sessionId=this.sessionResolver(lease.conversation_id);
    if(typeof sessionId!=='string'||!sessionId.trim())throw Error('memory_dream_session_unavailable');
    return{run_id:prepared.run_id,mode:candidate.mode,policy:candidate.policy,session_id:sessionId,
     lease:{owner:lease.owner,generation:lease.generation},coordinator_lease:lease};
   });
  }catch(error){if(unavailable(error)||error instanceof Error&&error.message==='memory_dream_admission_unavailable')return null;throw error;}
 }

 private identity(claim:MemoryDreamClaim):MemoryDreamIdentity{return{owner_id:claim.policy.owner_id,workspace_id:claim.policy.workspace_id,project_id:claim.policy.project_id,
  agent_id:claim.policy.agent_id,policy_version:claim.policy.policy_version,epoch:claim.policy.epoch,cadence_slot:claim.policy.cadence_slot};}
 private coordinatorLease(claim:MemoryDreamClaim):RunLease{
  const lease=claim.coordinator_lease;if(!lease||lease.run_id!==claim.run_id||lease.owner!==claim.lease.owner||lease.generation!==claim.lease.generation)throw Error('memory_dream_claim_invalid');return lease;
 }
 private policyCurrent(claim:MemoryDreamClaim,context:Row|undefined,agent:Row|undefined){
  if(!context||!agent||agent.status!=='active'||Number(agent.capability_epoch)!==claim.policy.epoch||agent.project_id!==claim.policy.project_id||agent.workspace_id!==claim.policy.workspace_id)return false;
  const saved=context.memory_dream as Record<string,unknown>|undefined;
  if(!saved||context.owner_id!==claim.policy.owner_id||context.agent_id!==claim.policy.agent_id||context.kind!=='memory_consolidation'
    ||saved.policy_version!==claim.policy.policy_version||saved.epoch!==claim.policy.epoch||saved.project_id!==claim.policy.project_id||saved.cadence_slot!==claim.policy.cadence_slot)return false;
  const policy=this.workbench.memoryDreamPolicy(claim.policy.owner_id,claim.policy.agent_id);
  return policy.enabled&&policy.policy_version===claim.policy.policy_version&&policy.epoch===claim.policy.epoch&&policy.project_id===claim.policy.project_id
   &&policy.workspace_id===claim.policy.workspace_id&&policy.next_due_at===claim.policy.cadence_slot&&policy.interval_seconds===saved.interval_seconds;
 }
 assertCurrent(claim:MemoryDreamClaim):void{
  const lease=this.coordinatorLease(claim);assertExecutionLease(this.db,claim.run_id,{owner:lease.owner,generation:lease.generation});
  const row=this.db.prepare(`SELECT r.status,c.owner_id,c.workspace_id,c.project_id,b.context_json,a.status AS agent_status,a.capability_epoch,a.workspace_id AS agent_workspace,a.project_id AS agent_project
   FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id JOIN wb_run_bindings b ON b.run_id=r.id JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id
   WHERE r.id=? AND b.kind='memory_consolidation'`).get(claim.run_id) as Row|undefined;
  if(!row||row.owner_id!==claim.policy.owner_id||row.workspace_id!==claim.policy.workspace_id||row.project_id!==claim.policy.project_id
    ||!['starting','running','interrupted'].includes(String(row.status)))throw Error('memory_dream_run_cancelled');
  const context=this.workbench.contextForRun(claim.run_id);
  if(!this.policyCurrent(claim,context as Row|undefined,{status:row.agent_status,capability_epoch:row.capability_epoch,workspace_id:row.agent_workspace,project_id:row.agent_project} as Row))throw Error('memory_dream_policy_stale');
 }

 memoryForClaim(claim:MemoryDreamClaim){
  const lease=this.coordinatorLease(claim);
  return new MemoryDreamWorkbenchAdapter(this.db,this.workbench,this.identity(claim),claim.run_id,()=>this.assertCurrent({...claim,lease:{owner:lease.owner,generation:lease.generation}}));
 }
 async runSession(claim:MemoryDreamClaim,_tools:Parameters<MemoryDreamPumpPorts['runSession']>[1],signal:AbortSignal):Promise<void>{
  const lease=this.coordinatorLease(claim),result=await this.worker.processClaimed(lease,signal);
  if(result?.run_id!==claim.run_id||result.runtime_status!=='memory_dream_session_completed')throw Error('memory_dream_session_unconfirmed');
 }

 private evidenceSync(claim:MemoryDreamClaim):MemoryDreamEvidence{
  const identity=this.identity(claim),context=this.workbench.contextForRun(claim.run_id) as Row|undefined;
  const row=this.db.prepare(`SELECT c.owner_id,c.workspace_id,c.project_id,r.status,b.context_json,a.status AS agent_status,a.capability_epoch,a.workspace_id AS agent_workspace,a.project_id AS agent_project
   FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id JOIN wb_run_bindings b ON b.run_id=r.id JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id
   WHERE r.id=? AND b.kind='memory_consolidation'`).get(claim.run_id) as Row|undefined;
  const policyCurrent=!!row&&row.owner_id===identity.owner_id&&row.workspace_id===identity.workspace_id&&row.project_id===identity.project_id
   &&this.policyCurrent(claim,context,row?{status:row.agent_status,capability_epoch:row.capability_epoch,workspace_id:row.agent_workspace,project_id:row.agent_project} as Row:undefined);
  let consolidation:DreamConsolidationRecord|null=null,sourceCurrent=false;
  try{const evidence=this.memoryForClaim(claim).readEvidence();consolidation=evidence.consolidation;sourceCurrent=evidence.source_current===true;}catch{sourceCurrent=false;}
  const budget_attempts=this.db.prepare('SELECT state,bound_exceeded FROM wb_model_budget_attempts WHERE run_id=? ORDER BY created_at,attempt_id').all(claim.run_id)
   .map((attempt:Row)=>({state:String(attempt.state),bound_exceeded:Number(attempt.bound_exceeded)!==0}));
  return{run_id:claim.run_id,...identity,policy_current:policyCurrent,source_current:sourceCurrent,consolidation,budget_attempts};
 }
 async readEvidence(claim:MemoryDreamClaim):Promise<MemoryDreamEvidence>{return this.evidenceSync(claim);}

 private finalize(claim:MemoryDreamClaim,observed:MemoryDreamEvidence,expected:'proposed'|'no_proposal'){
  return withImmediateTransaction(this.db,()=>{
   this.assertCurrent(claim);
   const current=this.evidenceSync(claim),run=this.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(claim.run_id) as {status:string}|undefined;
   if(!run||!['starting','running','interrupted'].includes(run.status)||!sameEvidence(current,observed)||!current.policy_current||!current.source_current||!usageSettled(current))throw Error('memory_dream_finalize_unresolved');
   if(expected==='proposed'&&current.consolidation?.status!=='proposed'||expected==='no_proposal'&&current.consolidation!==null)throw Error('memory_dream_finalize_unresolved');
   const interval=Number((this.workbench.contextForRun(claim.run_id) as Row).memory_dream.interval_seconds);
   const nextDue=(BigInt(claim.policy.cadence_slot)+BigInt(interval)).toString();
   const updated=this.db.prepare(`UPDATE wb_memory_dream_policies SET next_due_at=?,updated_at=? WHERE owner_id=? AND workspace_id=? AND project_id=? AND agent_id=?
    AND enabled=1 AND policy_version=? AND epoch=? AND interval_seconds=? AND next_due_at=?`)
    .run(nextDue,new Date().toISOString(),claim.policy.owner_id,claim.policy.workspace_id,claim.policy.project_id,claim.policy.agent_id,claim.policy.policy_version,claim.policy.epoch,interval,claim.policy.cadence_slot);
   if(updated.changes!==1)throw Error('memory_dream_finalize_unresolved');
   this.coordinator.finalizePublication(this.coordinatorLease(claim),'succeeded',null);
  });
 }
 async finalizeProposed(claim:MemoryDreamClaim,evidence:MemoryDreamEvidence){this.finalize(claim,evidence,'proposed');}
 async finalizeNoProposal(claim:MemoryDreamClaim,evidence:MemoryDreamEvidence){if(claim.mode!=='fresh')throw Error('memory_dream_finalize_unresolved');this.finalize(claim,evidence,'no_proposal');}

 async requireReconciliation(claim:MemoryDreamClaim,_reason:string):Promise<void>{
  const lease=this.coordinatorLease(claim);assertExecutionLease(this.db,claim.run_id,{owner:lease.owner,generation:lease.generation});
  const row=this.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(claim.run_id) as {status:string}|undefined;
  if(row&&['starting','running','interrupted'].includes(row.status))this.coordinator.interruptWithoutRuntime(lease,'MEMORY_DREAM_RECONCILE_REQUIRED');
 }
}
