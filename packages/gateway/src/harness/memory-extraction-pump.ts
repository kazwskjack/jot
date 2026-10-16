import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
import type {HarnessCoordinator} from './coordinator.ts';
import {withImmediateTransaction} from '../db/database.ts';
interface Client{
 memoryExtractionReadiness(signal:AbortSignal):Promise<Record<string,unknown>>;
 create(session:string,cwd:string,preset:string,signal:AbortSignal,runId:string,lease:{owner:string;generation:number}):Promise<unknown>;
 extractMemory(session:string,runId:string,signal:AbortSignal):Promise<unknown>;
}
type Options={enabled:boolean;workerId:string;leaseMs:number;cwd:string;sessionResolver:(conversationId:string)=>string};
type Candidate={owner_id:string;agent_id:string;capture_id:string;processor_run_id:string|null};
/** Invoked only as the original pool slot's idle fallback. Original runs,
 * leases, background capacity and model ledger remain authoritative.
 */
export class MemoryExtractionPump{
 private readonly db:DatabaseSync;private readonly workbench:WorkbenchService;private readonly coordinator:HarnessCoordinator;private readonly client:Client;private readonly options:Options;
 constructor(db:DatabaseSync,workbench:WorkbenchService,coordinator:HarnessCoordinator,client:Client,options:Options){this.db=db;this.workbench=workbench;this.coordinator=coordinator;this.client=client;this.options=options;}

 private candidates(){return this.db.prepare(`SELECT c.owner_id,c.agent_id,c.capture_id,p.processor_run_id
  FROM wb_memory_captures c JOIN wb_memory_capture_policies policy ON policy.agent_id=c.agent_id
  JOIN wb_agents a ON a.agent_id=c.agent_id LEFT JOIN wb_memory_processing_runs p ON p.capture_id=c.capture_id
  LEFT JOIN ga_runs r ON r.id=p.processor_run_id
  WHERE policy.owner_id=c.owner_id AND policy.mode='suggest' AND policy.version=c.policy_version AND policy.epoch=c.epoch
   AND a.owner_id=c.owner_id AND a.status='active' AND a.capability_epoch=c.epoch
   AND ((p.processor_run_id IS NULL AND c.status='ready') OR (r.status IN ('queued','starting','running') AND c.status IN ('ready','proposed','no_notes','applied')))
   AND NOT EXISTS(SELECT 1 FROM ga_runs foreground JOIN wb_run_bindings binding ON binding.run_id=foreground.id
    WHERE binding.owner_id=c.owner_id AND binding.agent_id=c.agent_id AND binding.kind!='memory_capture'
     AND foreground.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling'))
  ORDER BY c.sequence LIMIT 16`).all() as unknown as Candidate[];}
 private completed(runId:string,captureId:string){
  const capture=this.db.prepare('SELECT status,processor_run_id FROM wb_memory_captures WHERE capture_id=?').get(captureId) as {status:string;processor_run_id:string|null}|undefined;
  if(!capture||capture.processor_run_id!==runId||!['proposed','no_notes','applied'].includes(capture.status))return null;
  const attempts=this.db.prepare('SELECT state,bound_exceeded FROM wb_model_budget_attempts WHERE run_id=?').all(runId) as Array<{state:string;bound_exceeded:number}>;
  if(!attempts.some(item=>item.state==='settled')||attempts.some(item=>!['settled','released'].includes(item.state)||item.bound_exceeded))throw Error('memory_extraction_accounting_unresolved');
  return capture.status;
 }
 async processNext(signal?:AbortSignal):Promise<{run_id:string;runtime_status:string}|null>{
  if(!this.options.enabled)return null;
  const control=new AbortController(),combined=signal?AbortSignal.any([signal,control.signal]):control.signal;
  combined.throwIfAborted();
  if((await this.client.memoryExtractionReadiness(AbortSignal.any([combined,AbortSignal.timeout(15000)]))).ready!==true)return null;
  for(const candidate of this.candidates()){
   let runId=candidate.processor_run_id;
   try{if(!runId)runId=this.workbench.prepareMemoryProcessing(candidate.owner_id,candidate.agent_id,candidate.capture_id).processor_run_id;}
   catch(error){if(error instanceof Error&&/^(memory_processing_|model_budget_exhausted|budget_|agent_not_active)/.test(error.message))continue;throw error;}
   const lease=this.coordinator.claimMemoryExtraction(this.options.workerId,this.options.leaseMs,runId);
   if(!lease)continue;
   let timer:ReturnType<typeof setInterval>|undefined;
   try{
    this.workbench.assertRunActive(runId);
    const session=this.options.sessionResolver(lease.conversation_id);
    this.coordinator.bindSession(lease,session);this.coordinator.start(lease);
    timer=setInterval(()=>{try{this.workbench.assertRunActive(runId);this.coordinator.renew(lease,this.options.leaseMs);}catch(error){control.abort(error);}},Math.max(100,Math.min(250,Math.floor(this.options.leaseMs/3))));timer.unref();
    // A committed proposal and settled original usage can finish after a lost
    // Host response without invoking the provider or proposing a second time.
    if(!this.completed(runId,candidate.capture_id)){
     await this.client.create(session,this.options.cwd,'jot-workbench-budgeted',combined,runId,{owner:lease.owner,generation:lease.generation});
     combined.throwIfAborted();this.workbench.assertRunActive(runId);
     await this.client.extractMemory(session,runId,combined);
    }
    combined.throwIfAborted();
    withImmediateTransaction(this.db,()=>{this.workbench.assertRunActive(runId);if(!this.completed(runId,candidate.capture_id))throw Error('memory_extraction_receipt_missing');this.coordinator.finalizePublication(lease,'succeeded',null);});
    return {run_id:runId,runtime_status:'memory_proposed'};
   }catch{
    try{
     combined.throwIfAborted();
     withImmediateTransaction(this.db,()=>{this.workbench.assertRunActive(runId);if(!this.completed(runId,candidate.capture_id))throw Error('memory_extraction_receipt_missing');this.coordinator.finalizePublication(lease,'succeeded',null);});
     return {run_id:runId,runtime_status:'memory_proposed'};
    }catch{/* Only committed, still-authorized facts can recover a lost reply. */}
    // No new run and no speculative provider retry. Any unknown/in-flight
    // usage remains held by the existing ledger for explicit reconciliation.
    try{this.coordinator.interruptWithoutRuntime(lease,'MEMORY_EXTRACTION_RECONCILE_REQUIRED');}catch{/* A replacement lease owns the run. */}
    return {run_id:runId,runtime_status:'memory_reconciliation_required'};
   }finally{if(timer)clearInterval(timer);control.abort();}
  }
  return null;
 }
}
