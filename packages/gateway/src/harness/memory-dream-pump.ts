import {createMemoryDreamTools,type DreamConsolidationRecord,type MemoryDreamIdentity,type MemoryDreamToolPorts} from '../workbench/memory-dream-tools.ts';

export interface MemoryDreamPolicy extends MemoryDreamIdentity {
 scope:'project'|'private';
 enabled:boolean;
 due_at:string;
}

export interface MemoryDreamCandidate {
 policy:MemoryDreamPolicy;
 mode:'fresh'|'recovery';
 run_id?:string;
}

export interface MemoryDreamClaim {
 run_id:string;
 mode:'fresh'|'recovery';
 policy:MemoryDreamPolicy;
 session_id:string;
 lease:{owner:string;generation:number};
 coordinator_lease?:import('./coordinator.ts').RunLease;
}

export interface MemoryDreamBudgetAttempt {
 state:'settled'|'released'|'held'|'unknown'|'reserved'|'dispatched'|string;
 bound_exceeded:boolean;
}

export interface MemoryDreamEvidence {
 run_id:string;
 owner_id:string;
 workspace_id:string;
 project_id:string;
 agent_id:string;
 policy_version:number;
 epoch:number;
 cadence_slot:string;
 policy_current:boolean;
 source_current:boolean;
 consolidation:DreamConsolidationRecord|null;
 budget_attempts:MemoryDreamBudgetAttempt[];
}

export interface MemoryDreamPumpPorts {
 findCandidate(now:string,excludeRunIds?:readonly string[]):Promise<MemoryDreamCandidate|null>;
 /** Must reuse the cadence-slot operation/run identity and existing coordinator capacity/lease. */
 claim(candidate:MemoryDreamCandidate,workerId:string,leaseMs:number):Promise<MemoryDreamClaim|null>;
 /** Rechecks owner, project, policy/source epoch, original run, cancellation and lease. */
 assertCurrent(claim:MemoryDreamClaim):void|Promise<void>;
 memory?:MemoryDreamToolPorts;
 memoryForClaim?(claim:MemoryDreamClaim):MemoryDreamToolPorts;
 runSession(claim:MemoryDreamClaim,tools:ReturnType<typeof createMemoryDreamTools>,signal:AbortSignal):Promise<void>;
 readEvidence(claim:MemoryDreamClaim):Promise<MemoryDreamEvidence>;
 finalizeProposed(claim:MemoryDreamClaim,evidence:MemoryDreamEvidence):void|Promise<void>;
 finalizeNoProposal(claim:MemoryDreamClaim,evidence:MemoryDreamEvidence):void|Promise<void>;
 requireReconciliation(claim:MemoryDreamClaim,reason:string):void|Promise<void>;
}

export interface MemoryDreamPumpOptions {
 enabled?:boolean;
 workerId:string;
 leaseMs:number;
 now?:()=>Date;
}

export interface MemoryDreamResult {
 run_id:string;
 runtime_status:'memory_dream_proposed'|'memory_dream_no_proposal'|'memory_dream_reconciliation_required';
}

const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
const fields=['owner_id','workspace_id','project_id','agent_id','policy_version','epoch','cadence_slot','scope','enabled','due_at'] as const;
const RECONCILIATION_RETRY_MS=60_000;

function validPolicy(policy:MemoryDreamPolicy,now:Date,mode:'fresh'|'recovery'){
 if(!policy||policy.enabled!==true||policy.scope!=='project'||!nonempty(policy.owner_id)||!nonempty(policy.workspace_id)
  ||!nonempty(policy.project_id)||!nonempty(policy.agent_id)||!Number.isSafeInteger(policy.policy_version)||policy.policy_version<1
  ||!Number.isSafeInteger(policy.epoch)||policy.epoch<0||!nonempty(policy.cadence_slot))return false;
 const dueAt=/^\d+$/.test(policy.due_at)?Number(policy.due_at)*1000:Date.parse(policy.due_at);
 return Number.isFinite(dueAt)&&(mode==='recovery'||dueAt<=now.getTime());
}

function samePolicy(left:MemoryDreamPolicy,right:MemoryDreamPolicy){
 return fields.every(key=>left[key]===right[key]);
}

function validCandidate(candidate:MemoryDreamCandidate|null,now:Date):candidate is MemoryDreamCandidate{
 if(!candidate||!['fresh','recovery'].includes(candidate.mode)||!validPolicy(candidate.policy,now,candidate.mode))return false;
 if(candidate.mode==='recovery')return nonempty(candidate.run_id);
 return candidate.run_id===undefined;
}

function evidenceMatches(claim:MemoryDreamClaim,evidence:MemoryDreamEvidence){
 const policy=claim.policy,consolidation=evidence.consolidation;
 if(evidence.run_id!==claim.run_id||evidence.owner_id!==policy.owner_id||evidence.workspace_id!==policy.workspace_id
  ||evidence.project_id!==policy.project_id||evidence.agent_id!==policy.agent_id||evidence.policy_version!==policy.policy_version
  ||evidence.epoch!==policy.epoch||evidence.cadence_slot!==policy.cadence_slot||evidence.policy_current!==true||evidence.source_current!==true)return false;
 if(!consolidation)return true;
 return consolidation.run_id===claim.run_id&&consolidation.owner_id===policy.owner_id&&consolidation.workspace_id===policy.workspace_id
  &&consolidation.project_id===policy.project_id&&consolidation.scope==='project'&&consolidation.agent_id===null;
}

function usageSettled(evidence:MemoryDreamEvidence){
 const attempts=evidence.budget_attempts;
 return Array.isArray(attempts)&&attempts.some(attempt=>attempt.state==='settled')
  &&attempts.every(attempt=>(attempt.state==='settled'||attempt.state==='released')&&attempt.bound_exceeded===false);
}

/** One idle fallback attempt. This candidate has no timer, model client, DB schema, or production registration. */
export class MemoryDreamPump{
 private readonly ports:MemoryDreamPumpPorts;
 private readonly options:MemoryDreamPumpOptions;
 private readonly deferredRuns=new Map<string,number>();
 constructor(ports:MemoryDreamPumpPorts,options:MemoryDreamPumpOptions){this.ports=ports;this.options=options;}

 private async hold(claim:MemoryDreamClaim,reason:string):Promise<MemoryDreamResult>{
  this.deferredRuns.set(claim.run_id,(this.options.now?.()??new Date()).getTime()+RECONCILIATION_RETRY_MS);
  try{await this.ports.requireReconciliation(claim,reason);}catch{/* A replacement lease or durable hold may already own this run. */}
  return {run_id:claim.run_id,runtime_status:'memory_dream_reconciliation_required'};
 }

 private matchesCandidate(candidate:MemoryDreamCandidate,claim:MemoryDreamClaim){
  return claim.mode===candidate.mode&&samePolicy(candidate.policy,claim.policy)&&nonempty(claim.run_id)&&nonempty(claim.session_id)
   &&nonempty(claim.lease?.owner)&&Number.isSafeInteger(claim.lease?.generation)&&claim.lease.generation>0
   &&(candidate.mode!=='recovery'||claim.run_id===candidate.run_id);
 }

 private async reconcile(claim:MemoryDreamClaim,sessionCompleted:boolean):Promise<MemoryDreamResult>{
  try{await this.ports.assertCurrent(claim);}catch{return this.hold(claim,'identity_stale');}
  let evidence:MemoryDreamEvidence;
  try{evidence=await this.ports.readEvidence(claim);}catch{return this.hold(claim,'evidence_unavailable');}
  if(!evidenceMatches(claim,evidence))return this.hold(claim,'source_or_policy_stale');
  if(evidence.consolidation?.status==='applied')return this.hold(claim,'apply_observed');
  if(!usageSettled(evidence))return this.hold(claim,'usage_unsettled');
  if(evidence.consolidation?.status==='proposed'){
   try{await this.ports.finalizeProposed(claim,evidence);return {run_id:claim.run_id,runtime_status:'memory_dream_proposed'};}
   catch{return this.hold(claim,'finalize_unresolved');}
  }
  if(!evidence.consolidation&&sessionCompleted&&claim.mode==='fresh'){
   try{await this.ports.finalizeNoProposal(claim,evidence);return {run_id:claim.run_id,runtime_status:'memory_dream_no_proposal'};}
   catch{return this.hold(claim,'finalize_unresolved');}
  }
  return this.hold(claim,'proposal_uncommitted');
 }

 async processNext(signal?:AbortSignal):Promise<MemoryDreamResult|null>{
  if(this.options.enabled!==true||signal?.aborted)return null;
  const now=this.options.now?.()??new Date();
  const excludeRunIds:string[]=[];
  for(const [runId,retryAt] of this.deferredRuns){if(retryAt>now.getTime())excludeRunIds.push(runId);else this.deferredRuns.delete(runId);}
  const candidate=await this.ports.findCandidate(now.toISOString(),excludeRunIds);
  if(signal?.aborted)return null;
  if(!validCandidate(candidate,now))return null;
  const workerId=nonempty(this.options.workerId)?this.options.workerId:'';
  const leaseMs=this.options.leaseMs;
  if(!workerId||!Number.isSafeInteger(leaseMs)||leaseMs<1)return null;
  const claim=await this.ports.claim(candidate,workerId,leaseMs);
  if(!claim)return null;
  if(!this.matchesCandidate(candidate,claim))return this.hold(claim,'claim_identity_mismatch');
  if(signal?.aborted&&claim.mode==='fresh')return this.hold(claim,'interrupted_before_start');
  let sessionCompleted=false;
  if(candidate.mode==='fresh'){
   try{
    await this.ports.assertCurrent(claim);
    if(signal?.aborted)return this.hold(claim,'interrupted_before_start');
    const toolSignal=signal??new AbortController().signal;
    const memory=this.ports.memoryForClaim?.(claim)??this.ports.memory;
    if(!memory)return this.hold(claim,'memory_adapter_unavailable');
    const tools=createMemoryDreamTools(claim.policy,claim.run_id,memory,async()=>{
     toolSignal.throwIfAborted();
     await this.ports.assertCurrent(claim);
    });
    await this.ports.runSession(claim,tools,toolSignal);
    sessionCompleted=true;
   }catch{/* Evidence below decides whether this original run can be recovered. */}
  }
  return this.reconcile(claim,sessionCompleted);
 }
}
