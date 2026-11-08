import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {MemoryDreamPump} from '../../src/harness/memory-dream-pump.ts';
import {MemoryDreamProductionPorts} from '../../src/harness/memory-dream-production.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';

const limit={tokens:5000,nano_usd:50000,model_calls:20};
const budgetConfig=(budgetLimit=limit)=>({revision:1,admission_route:{provider:'fixture',model:'fixture'},routes:[{provider:'fixture',model:'fixture',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,budgetLimit]))});

async function fixture(t,{maxBackgroundRuns=1,budgetLimit=limit}={}){
 const base=resolve('test-tmp/memory-dream-production');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const db=openProductDatabase(join(root,'db.sqlite')),events=new EventStore(db),runs=new RunRepository(db,events),budget=new WorkbenchBudgetPolicy(db,budgetConfig(budgetLimit));
 let service=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files'),modelBudgetPolicy:budget});
 const agent=service.createAgent('alice',{name:'Dream project agent'});
 const coordinator=new HarnessCoordinator(db,runs,events,()=>Date.now(),{maxBackgroundRuns,allowBackgroundRuns:true});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const makeDue=()=>{const seconds=String(Math.floor(Date.now()/1000)-1);db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(seconds,'alice',agent.agent_id);return service.memoryDreamPolicy('alice',agent.agent_id);};
 return{db,events,runs,budget,agent,coordinator,get service(){return service},reopen(){service=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files'),modelBudgetPolicy:budget});},makeDue};
}

test('a separate process recovers only the original interrupted Dream run',async t=>{
 const base=resolve('test-tmp/memory-dream-process-restart');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 const repositoryRoot=resolve('../..'),url=(path)=>JSON.stringify(pathToFileURL(join(repositoryRoot,path)).href);
 const script=`
  import {openProductDatabase} from ${url('packages/gateway/src/db/database.ts')};
  import {EventStore} from ${url('packages/gateway/src/events/event-store.ts')};
  import {RunRepository} from ${url('packages/gateway/src/runs/repository.ts')};
  import {HarnessCoordinator} from ${url('packages/gateway/src/harness/coordinator.ts')};
  import {WorkbenchService} from ${url('packages/gateway/src/workbench/service.ts')};
  import {WorkbenchBudgetPolicy} from ${url('packages/gateway/src/workbench/model-budget-policy.ts')};
  const limit={tokens:5000,nano_usd:50000,model_calls:20};
  const config={revision:1,admission_route:{provider:'fixture',model:'fixture'},routes:[{provider:'fixture',model:'fixture',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limit]))};
  const db=openProductDatabase(process.env.DREAM_DB);
  try{
   const events=new EventStore(db),runs=new RunRepository(db,events),budget=new WorkbenchBudgetPolicy(db,config);
   const service=new WorkbenchService(db,{workspaceIds:['ws'],root:process.env.DREAM_ROOT,modelBudgetPolicy:budget});
   if(process.env.DREAM_PHASE==='prepare'){
    const agent=service.createAgent('alice',{name:'Restart Dream'}),initial=service.memoryDreamPolicy('alice',agent.agent_id);
    service.setMemoryDreamPolicy('alice',agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:60});
    const due=String(Math.floor(Date.now()/1000)-1);
    db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(due,'alice',agent.agent_id);
    const candidate=service.findMemoryDreamCandidate(new Date());if(!candidate)throw Error('initial_candidate_missing');
    const prepared=service.prepareMemoryConsolidation('alice',agent.agent_id,candidate.policy.policy_version,candidate.policy.cadence_slot);
    const coordinator=new HarnessCoordinator(db,runs,events,()=>Date.now(),{maxBackgroundRuns:1,allowBackgroundRuns:true});
    const lease=coordinator.claimMemoryConsolidation('restart-worker',30000,prepared.run_id);if(!lease)throw Error('initial_claim_missing');
    coordinator.start(lease);coordinator.interruptWithoutRuntime(lease,'MEMORY_DREAM_RECONCILE_REQUIRED');
    const runCount=Number(db.prepare(\"SELECT count(*) n FROM wb_run_bindings WHERE owner_id='alice' AND agent_id=? AND kind='memory_consolidation'\").get(agent.agent_id).n);
    console.log(JSON.stringify({pid:process.pid,agentId:agent.agent_id,runId:prepared.run_id,mode:candidate.mode,runCount}));
   }else{
    const agentId=process.env.DREAM_AGENT,candidate=service.findMemoryDreamCandidate(new Date());
    if(!candidate)throw Error('recovery_candidate_missing');
    const prepared=service.prepareMemoryConsolidation('alice',agentId,candidate.policy.policy_version,candidate.policy.cadence_slot);
    const runCount=Number(db.prepare(\"SELECT count(*) n FROM wb_run_bindings WHERE owner_id='alice' AND agent_id=? AND kind='memory_consolidation'\").get(agentId).n);
    const status=db.prepare('SELECT status FROM ga_runs WHERE id=?').get(prepared.run_id).status;
    console.log(JSON.stringify({pid:process.pid,agentId,runId:prepared.run_id,candidateRunId:candidate.run_id,mode:candidate.mode,runCount,status}));
   }
  }finally{db.close();}
 `;
 const run=(phase,agentId='')=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:repositoryRoot,encoding:'utf8',timeout:20000,
   env:{...process.env,DREAM_PHASE:phase,DREAM_DB:join(root,'product.sqlite'),DREAM_ROOT:join(root,'files'),DREAM_AGENT:agentId}});
  assert.equal(child.error,undefined,child.stderr||'child process failed');assert.equal(child.status,0,`${child.stderr}${child.stdout}`);
  return JSON.parse(child.stdout.trim());
 };
 const first=run('prepare'),afterRestart=run('recover',first.agentId);
 assert.notEqual(first.pid,afterRestart.pid);assert.equal(first.mode,'fresh');assert.equal(first.runCount,1);
 assert.equal(afterRestart.mode,'recovery');assert.equal(afterRestart.status,'interrupted');
 assert.equal(afterRestart.candidateRunId,first.runId);assert.equal(afterRestart.runId,first.runId);assert.equal(afterRestart.runCount,1);
});

test('Dream policy defaults off, accepts every positive integer cadence, and preserves persisted values on service restart',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 assert.deepEqual({enabled:initial.enabled,interval_seconds:initial.interval_seconds,next_due_at:initial.next_due_at},{enabled:false,interval_seconds:3600,next_due_at:null});
 const configured=f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:Number.MAX_SAFE_INTEGER});
 assert.equal(configured.enabled,true);assert.equal(configured.interval_seconds,Number.MAX_SAFE_INTEGER);assert.ok(/^\d+$/.test(configured.next_due_at));
 f.reopen();const persisted=f.service.memoryDreamPolicy('alice',f.agent.agent_id);assert.deepEqual(persisted,configured);
 const disabled=f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:persisted.policy_version,enabled:false});
 assert.equal(disabled.enabled,false);assert.equal(disabled.interval_seconds,Number.MAX_SAFE_INTEGER);assert.equal(disabled.next_due_at,null);
});

test('Dream prepares one budget-bound original run per due cadence slot and never injects or captures memory',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id),configured=f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:60});
 const due=f.makeDue(),slot=due.next_due_at,prepared=f.service.prepareMemoryConsolidation('alice',f.agent.agent_id,due.policy_version,slot),again=f.service.prepareMemoryConsolidation('alice',f.agent.agent_id,due.policy_version,slot);
 assert.equal(again.run_id,prepared.run_id);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_runs WHERE id IN (SELECT run_id FROM wb_run_bindings WHERE kind='memory_consolidation')").get().n,1);
 const context=f.service.contextForRun(prepared.run_id);assert.equal(context.kind,'memory_consolidation');assert.deepEqual(context.allowed_tools,[]);assert.deepEqual(context.memories,[]);
 assert.deepEqual(context.memory_dream,{policy_version:due.policy_version,epoch:f.agent.capability_epoch,project_id:f.agent.project_id,cadence_slot:slot,interval_seconds:60});
 assert.equal(f.budget.ledger.isBound('alice',prepared.run_id),true);assert.equal(f.runs.get(prepared.run_id,'alice').status,'queued');
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_memory_processing_runs WHERE processor_run_id=?").get(prepared.run_id).n,0);
 assert.equal(configured.interval_seconds,60);
});

test('a coordinator-claimed Dream run uses the original Workbench session and defers publication to evidence reconciliation',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:20});
 const policy=f.makeDue(),prepared=f.service.prepareMemoryConsolidation('alice',f.agent.agent_id,policy.policy_version,policy.next_due_at),lease=f.coordinator.claimMemoryConsolidation('dream-worker',30000,prepared.run_id);
 let accepted;
 new PersistentTaskService(f.db,f.service,{projectionRoot:join(resolve('test-tmp/memory-dream-production'),`tasks-${Date.now()}`),events:f.events,modelBudgetPolicy:f.budget});
 const bindings=new SessionBindingRepository(f.db,'dream');
 const worker=new HarnessWorker(f.db,f.coordinator,{run:async input=>{accepted=input;return{observed:true,completed:true,reason_code:'SESSION_TURN_COMPLETED',runtime_status:'not_required',final_text:'Synthetic Dream response'};}},{
  workerId:'dream-worker',leaseMs:30000,sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id,
  executionGuard:{assertRunActive:runId=>f.service.assertRunActive(runId),contextForRun:runId=>f.service.contextForRun(runId)},
 });
 const signal=new AbortController().signal,result=await worker.processClaimed(lease,signal);
 assert.equal(result.runtime_status,'memory_dream_session_completed');assert.equal(accepted.signal,signal);
 assert.equal(f.runs.get(prepared.run_id,'alice').status,'running');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(prepared.run_id).n,0);
 assert.equal(f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(prepared.run_id).generation,lease.generation);
});

test('shutdown cancellation reaches the production ports and a new pump holds the original run without replay',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:30});
 f.makeDue();const candidate=f.service.findMemoryDreamCandidate(new Date());assert.ok(candidate);
 new PersistentTaskService(f.db,f.service,{projectionRoot:join(resolve('test-tmp/memory-dream-production'),'cancel-tasks'),events:f.events,modelBudgetPolicy:f.budget});
 const bindings=new SessionBindingRepository(f.db,'dream-cancel');let sessionCalls=0,beginSession;
 const entered=new Promise(resolve=>beginSession=resolve),controller=new AbortController();
 const worker=new HarnessWorker(f.db,f.coordinator,{run:async input=>{
  sessionCalls++;assert.equal(input.workbenchRunId,input.taskRequestId);assert.equal(input.signal,controller.signal);input.onReady?.();beginSession();
  await new Promise((resolve,reject)=>{if(input.signal.aborted)reject(input.signal.reason??Error('aborted'));else input.signal.addEventListener('abort',()=>reject(input.signal.reason??Error('aborted')),{once:true});});
 }},{workerId:'dream-worker',leaseMs:30000,sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id,
  executionGuard:{assertRunActive:runId=>f.service.assertRunActive(runId),contextForRun:runId=>f.service.contextForRun(runId)}});
 const ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,worker,
  sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id});
 const claim=await ports.claim(candidate,'dream-worker',30000);assert.ok(claim);
 const pending=ports.runSession(claim,undefined,controller.signal);
 await Promise.race([entered,pending.then(()=>{throw Error('runner_completed_before_cancellation');},error=>Promise.reject(error)),new Promise((_,reject)=>setTimeout(()=>reject(Error('dream_runner_start_timeout')),5000))]);
 controller.abort(Error('dream_shutdown'));await assert.rejects(pending,/memory_dream_session_unconfirmed/);
 assert.equal(sessionCalls,1);assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(claim.run_id).status,'interrupted');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(claim.run_id).n,0);
 const pump=new MemoryDreamPump(ports,{enabled:true,workerId:'dream-worker',leaseMs:30000});
 const recovered=await pump.processNext();assert.deepEqual(recovered,{run_id:claim.run_id,runtime_status:'memory_dream_reconciliation_required'});
 assert.equal(sessionCalls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(claim.run_id).n,0);
});

test('only the Dream admission claims its exact slot and recovers the original interrupted run with a newer fence',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:30});
 const policy=f.makeDue(),candidate=f.service.findMemoryDreamCandidate(new Date()),prepared=f.service.prepareMemoryConsolidation('alice',f.agent.agent_id,policy.policy_version,policy.next_due_at);
 assert.equal(candidate.mode,'fresh');assert.equal(candidate.policy.cadence_slot,policy.next_due_at);assert.equal(candidate.run_id,undefined);
 assert.equal(f.coordinator.claimNext('ordinary-worker',30000),null);
 let lease=f.coordinator.claimMemoryConsolidation('dream-worker',30000,prepared.run_id);assert.equal(lease.run_id,prepared.run_id);f.coordinator.start(lease);
 for(let index=0;index<4;index++){
  f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run('0',prepared.run_id);
  const replacement=f.coordinator.claimMemoryConsolidation('dream-worker',30000,prepared.run_id);
  assert.ok(replacement.generation>lease.generation);lease=replacement;
 }
 f.coordinator.interruptWithoutRuntime(lease,'MEMORY_DREAM_RECONCILE_REQUIRED');
 const recovery=f.service.findMemoryDreamCandidate(new Date());assert.equal(recovery.mode,'recovery');assert.equal(recovery.run_id,prepared.run_id);
 const recovered=f.coordinator.claimMemoryConsolidation('dream-worker',30000,prepared.run_id,true);assert.equal(recovered.run_id,prepared.run_id);assert.ok(recovered.generation>lease.generation);
 assert.throws(()=>f.coordinator.renew(lease,30000),/worker_fence_rejected/);
});

test('candidate selection skips a live Dream lease so another due agent can use the idle worker',async t=>{
 const f=await fixture(t),second=f.service.createAgent('alice',{name:'Second Dream agent'});
 for(const agent of [f.agent,second]){const policy=f.service.memoryDreamPolicy('alice',agent.agent_id);f.service.setMemoryDreamPolicy('alice',agent.agent_id,{expected_version:policy.policy_version,enabled:true,interval_seconds:30});}
 const now=Math.floor(Date.now()/1000);
 f.db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(String(now-10),'alice',f.agent.agent_id);
 f.db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(String(now-5),'alice',second.agent_id);
 const firstPolicy=f.service.memoryDreamPolicy('alice',f.agent.agent_id),firstRun=f.service.prepareMemoryConsolidation('alice',f.agent.agent_id,firstPolicy.policy_version,firstPolicy.next_due_at);
 assert.ok(f.coordinator.claimMemoryConsolidation('active-dream-worker',30000,firstRun.run_id));
 const candidate=f.service.findMemoryDreamCandidate(new Date());
 assert.equal(candidate.policy.agent_id,second.agent_id);assert.equal(candidate.mode,'fresh');
});

test('candidate selection scans past a full deferred window to reach later due agents',async t=>{
 const f=await fixture(t,{budgetLimit:{tokens:1000000,nano_usd:1000000,model_calls:1000}}),due=String(Math.floor(Date.now()/1000)-1),entries=[];
 for(let index=0;index<65;index++){
  const agent=f.service.createAgent('alice',{name:`Deferred Dream ${index}`}),initial=f.service.memoryDreamPolicy('alice',agent.agent_id);
  f.service.setMemoryDreamPolicy('alice',agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:60});
  f.db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(due,'alice',agent.agent_id);
  const policy=f.service.memoryDreamPolicy('alice',agent.agent_id),run=f.service.prepareMemoryConsolidation('alice',agent.agent_id,policy.policy_version,due);
  entries.push({agent,run});
 }
 entries.sort((left,right)=>left.agent.agent_id<right.agent.agent_id?-1:left.agent.agent_id>right.agent.agent_id?1:0);
 const exclude=entries.slice(0,64).map(entry=>entry.run.run_id),ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,
  worker:{processClaimed:async()=>{throw Error('candidate_lookup_must_not_run_a_session');}},sessionResolver:()=> 'dream-session'});
 const candidate=await ports.findCandidate(new Date().toISOString(),exclude);
 assert.equal(candidate.policy.agent_id,entries[64].agent.agent_id);
});

test('Dream does not claim when the shared background capacity is full',async t=>{
 const f=await fixture(t,{maxBackgroundRuns:0}),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:15});
 const policy=f.makeDue(),prepared=f.service.prepareMemoryConsolidation('alice',f.agent.agent_id,policy.policy_version,policy.next_due_at);
 assert.equal(f.coordinator.claimMemoryConsolidation('dream-worker',30000,prepared.run_id),null);
 assert.equal(f.runs.get(prepared.run_id,'alice').status,'queued');
});

test('production Dream admission rolls back its prepared run and shared budget allocation when capacity closes',async t=>{
 const f=await fixture(t,{maxBackgroundRuns:0}),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:25});
 const due=f.makeDue(),candidate=f.service.findMemoryDreamCandidate(new Date());assert.equal(candidate.mode,'fresh');
 const ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,worker:{processClaimed:async()=>{throw Error('must_not_run');}},sessionResolver:()=>{throw Error('must_not_bind_session');}});
 assert.equal(await ports.claim(candidate,'dream-idle',30000),null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_run_bindings WHERE kind='memory_consolidation'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_bindings b JOIN wb_run_bindings r ON r.run_id=b.run_id WHERE r.kind=\'memory_consolidation\'').get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_runs WHERE id IN (SELECT run_id FROM wb_run_bindings WHERE kind='memory_consolidation')").get().n,0);
 assert.equal(due.enabled,true);
});

test('production Dream evidence finalizes the original due slot with settled existing budget usage',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:25});
 const due=f.makeDue(),candidate=f.service.findMemoryDreamCandidate(new Date());
 const bindings=new SessionBindingRepository(f.db,'dream');
 const ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,worker:{processClaimed:async()=>({run_id:'unused',runtime_status:'memory_dream_session_completed'})},sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id});
 const claim=await ports.claim(candidate,'dream-idle',30000);assert.ok(claim);f.coordinator.start(claim.coordinator_lease);
 f.service.retrieveMemory('alice','ws',{scope:'project',project_id:f.agent.project_id},claim.run_id,'dream-project-read');
 f.budget.ledger.reserve('alice',claim.run_id,{attempt_id:'dream-model',provider:'fixture',model:'fixture',max_tokens:20});
 f.budget.ledger.dispatch('alice',claim.run_id,'dream-model');f.budget.ledger.settle('alice',claim.run_id,'dream-model',{inputTokens:10,outputTokens:5,totalTokens:15});
 const evidence=await ports.readEvidence(claim);assert.equal(evidence.policy_current,true);assert.equal(evidence.source_current,true);
 await ports.finalizeNoProposal(claim,evidence);
 assert.equal(f.runs.get(claim.run_id,'alice').status,'succeeded');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(claim.run_id).n,0);
 assert.equal(f.service.memoryDreamPolicy('alice',f.agent.agent_id).next_due_at,(BigInt(due.next_due_at)+25n).toString());
});

test('recovery after a source is deleted holds the original proposal without replaying the session',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:25});
 const source=f.service.saveMemory('alice','ws',{scope:'project',project_id:f.agent.project_id,content:'Synthetic project fact'});
 f.makeDue();
 const bindings=new SessionBindingRepository(f.db,'dream');let sessionCalls=0;
 const ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,
  worker:{processClaimed:async()=>{sessionCalls++;return{run_id:'unused',runtime_status:'memory_dream_session_completed'};}},
  sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id});
 const candidate=f.service.findMemoryDreamCandidate(new Date());
 const claim=await ports.claim(candidate,'dream-worker',30000);assert.ok(claim);f.coordinator.start(claim.coordinator_lease);
 const retrieved=f.service.retrieveMemory('alice','ws',{scope:'project',project_id:f.agent.project_id},claim.run_id,'dream-project-read');
 assert.deepEqual(retrieved.items.map(item=>item.memory_id),[source.memory_id]);
 const staged=f.service.memoryConsolidations.stage('alice','ws',{scope:'project',project_id:f.agent.project_id,memory_ids:[source.memory_id]},claim.run_id);
 f.service.memoryConsolidations.propose('alice','ws',staged.consolidation_id,
  {expected_version:1,summary:'Synthetic proposal',changes:[]},claim.run_id);
 f.budget.ledger.reserve('alice',claim.run_id,{attempt_id:'dream-model',provider:'fixture',model:'fixture',max_tokens:20});
 f.budget.ledger.dispatch('alice',claim.run_id,'dream-model');
 f.budget.ledger.settle('alice',claim.run_id,'dream-model',{inputTokens:10,outputTokens:5,totalTokens:15});
 f.coordinator.interruptWithoutRuntime(claim.coordinator_lease,'MEMORY_DREAM_RECONCILE_REQUIRED');
 f.service.deleteMemory('alice','ws',source.memory_id,source.version);

 const pump=new MemoryDreamPump(ports,{enabled:true,workerId:'dream-worker',leaseMs:30000});
 const recovered=await pump.processNext();
 assert.deepEqual(recovered,{run_id:claim.run_id,runtime_status:'memory_dream_reconciliation_required'});
 assert.equal(sessionCalls,0);
 assert.equal(f.runs.get(claim.run_id,'alice').status,'interrupted');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(claim.run_id).n,0);
 assert.equal(f.service.memoryDreamPolicy('alice',f.agent.agent_id).next_due_at,claim.policy.cadence_slot);
});

test('recovery with unknown usage releases its lease and never replays the original session',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:25});
 const source=f.service.saveMemory('alice','ws',{scope:'project',project_id:f.agent.project_id,content:'Synthetic project fact'});
 f.makeDue();
 const bindings=new SessionBindingRepository(f.db,'dream');let sessionCalls=0;
 const ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,
  worker:{processClaimed:async()=>{sessionCalls++;return{run_id:'unused',runtime_status:'memory_dream_session_completed'};}},
  sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id});
 const candidate=f.service.findMemoryDreamCandidate(new Date()),claim=await ports.claim(candidate,'dream-worker',30000);
 assert.ok(claim);f.coordinator.start(claim.coordinator_lease);
 f.service.retrieveMemory('alice','ws',{scope:'project',project_id:f.agent.project_id},claim.run_id,'dream-project-read');
 f.budget.ledger.reserve('alice',claim.run_id,{attempt_id:'dream-model',provider:'fixture',model:'fixture',max_tokens:20});
 f.budget.ledger.dispatch('alice',claim.run_id,'dream-model');
 f.budget.ledger.markUnknown('alice',claim.run_id,'dream-model','stream_incomplete');
 f.coordinator.interruptWithoutRuntime(claim.coordinator_lease,'MEMORY_DREAM_RECONCILE_REQUIRED');

 const pump=new MemoryDreamPump(ports,{enabled:true,workerId:'dream-worker',leaseMs:30000});
 const recovered=await pump.processNext();
 assert.deepEqual(recovered,{run_id:claim.run_id,runtime_status:'memory_dream_reconciliation_required'});
 assert.equal(sessionCalls,0);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(claim.run_id,'dream-model').state,'unknown');
 assert.equal(f.runs.get(claim.run_id,'alice').status,'interrupted');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(claim.run_id).n,0);
});

test('revoking the Dream policy blocks the active run and leaves its cadence unclaimed',async t=>{
 const f=await fixture(t),initial=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:initial.policy_version,enabled:true,interval_seconds:25});
 const source=f.service.saveMemory('alice','ws',{scope:'project',project_id:f.agent.project_id,content:'Policy revocation source'});
 const due=f.makeDue(),candidate=f.service.findMemoryDreamCandidate(new Date());assert.ok(candidate);
 const bindings=new SessionBindingRepository(f.db,'dream-revoke');let sessionCalls=0;
 const ports=new MemoryDreamProductionPorts({db:f.db,workbench:f.service,coordinator:f.coordinator,
  worker:{processClaimed:async()=>{sessionCalls++;return{run_id:'unused',runtime_status:'memory_dream_session_completed'};}},
  sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id});
 const claim=await ports.claim(candidate,'dream-worker',30000);assert.ok(claim);f.coordinator.start(claim.coordinator_lease);
 const scope={owner_id:'alice',workspace_id:'ws',project_id:f.agent.project_id,scope:'project',agent_id:null};
 assert.deepEqual((await ports.memoryForClaim(claim).list(scope,{})).map(item=>item.memory_id),[source.memory_id]);
 const enabled=f.service.memoryDreamPolicy('alice',f.agent.agent_id);
 f.service.setMemoryDreamPolicy('alice',f.agent.agent_id,{expected_version:enabled.policy_version,enabled:false});
 await assert.rejects(ports.memoryForClaim(claim).list(scope,{}),/memory_dream_policy_stale/);
 assert.equal((await ports.readEvidence(claim)).policy_current,false);
 f.coordinator.interruptWithoutRuntime(claim.coordinator_lease,'MEMORY_DREAM_RECONCILE_REQUIRED');
 assert.equal(f.service.findMemoryDreamCandidate(new Date()),null);
 assert.equal(sessionCalls,0);assert.equal(f.runs.get(claim.run_id,'alice').status,'interrupted');
 assert.equal(f.service.memoryDreamPolicy('alice',f.agent.agent_id).next_due_at,null);
 assert.equal(due.enabled,true);
});
