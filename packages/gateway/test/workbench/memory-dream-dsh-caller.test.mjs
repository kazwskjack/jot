import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import Module,{createRequire,registerHooks} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {MemoryDreamProductionPorts} from '../../src/harness/memory-dream-production.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {prepareDshPreSetupRuntime} from '../../../session-adapter/scripts/prepare-dsh-pre-setup.mjs';

const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
const limit={tokens:5000,nano_usd:50000,model_calls:20};
const budgetConfig=()=>({revision:1,admission_route:{provider:'dream-scripted',model:'scripted'},
 routes:[{provider:'dream-scripted',model:'scripted',revision:'dsh-test-v1',context_window:1000,max_output_tokens:64,
  rates:{input:1,output:1,cache_read:1,cache_write:1}}],
 limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limit]))});

async function prepareDshRuntime(base,runtimeRoot){
 const patchedLoop=join(base,'dsh-agent-loop-patched');await mkdir(base,{recursive:true});
 prepareDshPreSetupRuntime(join(runtimeRoot,'dsh-agent-loop'),patchedLoop,{nativeAdmission:true,pendingInputWake:true});
 process.env.JOT_DSH_PATCHED_LOOP=patchedLoop;
 process.env.NODE_PATH=[join(runtimeRoot,'..'),process.env.NODE_PATH].filter(Boolean).join(';');Module._initPaths();
 const require=createRequire(import.meta.url),resolutionRoot=resolve(runtimeRoot,'..','..');
 const hook=registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith('@deepseek-ai/')){
   if(context.parentURL?.endsWith('.cjs'))return nextResolve(specifier,context);
   return nextResolve(pathToFileURL(require.resolve(specifier,{paths:[resolutionRoot]})).href,context);
  }
  return nextResolve(specifier,context);
 }});
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'];
 const modules={};for(const name of names)modules[name]=await import(pathToFileURL(name==='dsh-agent-loop'?join(patchedLoop,'lib','index.js'):join(runtimeRoot,name,'lib','index.js')).href);
 const ctx=new modules.cordis.Context();ctx.provide('profileContext',{installAnchor:join(runtimeRoot,'dsh-session-persistence','package.json')});
 for(const name of names.filter(value=>value!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(base,'sessions'),compression:'none'}:{});
 return{ctx,modules,hook};
}

function scriptedModel(LlmAdapter,memoryId,consolidationId){
 return new class extends LlmAdapter{
  calls=0;firstCall=Promise.resolve();signalFirstCall=()=>{};
  reset(){this.calls=0;this.firstCall=new Promise(resolve=>{this.signalFirstCall=resolve;});}
  async *stream(){
   const step=this.calls++;this.signalFirstCall();
   if(step<3){
    let operation,args;
    if(step===0){operation='memory.list';args={};}
    else if(step===1){operation='memory.stage';args={scope:'project',memory_ids:[memoryId]};}
    else{const id=consolidationId();if(!id)throw Error('dream_stage_receipt_missing');operation='memory.propose';args={consolidation_id:id,expected_version:1,summary:'Current project fact for owner review.',changes:[{action:'rewrite',memory_id:memoryId,content:'Reviewed Dream finding'}]};}
    yield{type:'block-start',index:0,blockType:'tool-call'};
    yield{type:'block-end',index:0,block:{type:'tool-call',id:`dream-tool-${step+1}`,name:'jot_workspace',arguments:JSON.stringify({operation,arguments_json:JSON.stringify(args)})}};
   }else if(step===3)yield{type:'text-delta',index:0,text:'Project-only proposal prepared for owner review.'};
   else throw Error('dream_dsh_call_limit');
   yield{type:'usage',usage:{inputTokens:12,outputTokens:4,totalTokens:16}};
   yield{type:'finish',reason:{kind:step<3?'tool-calls':'stop'}};
  }
 };
}

test('real DSH Dream proposal reaches owner apply and replays its durable receipt after restart',
 {skip:!runtime,timeout:120000},async t=>{
  const base=resolve('test-tmp/memory-dream-dsh-caller');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
  let gateway,dsh,origin,sessionCalls=0,activeSourceId,revokeAfterList=true,revokedStageStatus;const oldPatch=process.env.JOT_DSH_PATCHED_LOOP,oldNodePath=process.env.NODE_PATH,token=randomBytes(32).toString('hex'),csrf=randomBytes(16).toString('hex');
  const databasePath=join(root,'product.sqlite'),workbenchRoot=join(root,'workbench'),templateRoot=join(root,'templates'),applyKey='dream-owner-apply-once';
  let applyPath='',loseResponse=false;
  await mkdir(templateRoot);
  const template=Buffer.from('controlled fixture; no document render is requested');
  await writeFile(join(templateRoot,'fixture.docx'),template);
  await writeFile(join(templateRoot,'catalog.json'),JSON.stringify({templates:[{template_id:'fixture-template',version:'1',format:'docx',file:'fixture.docx',sha256:createHash('sha256').update(template).digest('hex'),fields:{}}]}));
  const disposeDsh=async()=>{
   try{await dsh?.handle?.dispose();}catch{}try{await dsh?.ctx?.fiber.dispose();}catch{}
   try{dsh?.hook?.deregister();}catch{}dsh=null;
  };
  t.after(async()=>{
   await disposeDsh();
   try{await gateway?.app.close();}catch{}try{if(gateway?.db?.isOpen)gateway.db.close();}catch{}
   if(oldPatch===undefined)delete process.env.JOT_DSH_PATCHED_LOOP;else process.env.JOT_DSH_PATCHED_LOOP=oldPatch;
   if(oldNodePath===undefined)delete process.env.NODE_PATH;else process.env.NODE_PATH=oldNodePath;Module._initPaths();
   await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:30});
  });
  const startServer=async()=>{
   gateway=await buildServer({databasePath,workspaces:['ws'],workbenchRoot,templateRoot,csrfToken:csrf,allowedOrigins:['http://127.0.0.1'],internalChannelToken:token,modelBudgetPolicy:budgetConfig()});
   gateway.app.addHook('onSend',async(request,reply,payload)=>{
    if(loseResponse&&request.url===applyPath&&reply.statusCode===200){loseResponse=false;reply.code(503);return JSON.stringify({error:{code:'fixture_lost_apply_response'}});}
    return payload;
   });
   origin=await gateway.app.listen({host:'127.0.0.1',port:0});
  };
  await startServer();
  const agent=gateway.workbench.createAgent('alice',{name:'Dream DSH source'});
  const source=gateway.workbench.saveMemory('alice','ws',{scope:'project',project_id:agent.project_id,content:'A current synthetic project fact.',verified:true,source_revision:'fixture-source-v1'});
  const policy=gateway.workbench.memoryDreamPolicy('alice',agent.agent_id);
  gateway.workbench.setMemoryDreamPolicy('alice',agent.agent_id,{expected_version:policy.policy_version,enabled:true,interval_seconds:60});
  gateway.db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(String(Math.floor(Date.now()/1000)-1),'alice',agent.agent_id);
  let coordinator,bindings,bridge,worker,ports;
  const connectHarness=()=>{
   coordinator=new HarnessCoordinator(gateway.db,gateway.runs,gateway.events,()=>Date.now(),{maxBackgroundRuns:2,allowBackgroundRuns:true});
   bindings=new SessionBindingRepository(gateway.db,'dream-dsh');
   bridge=new WorkbenchBridge({origin,token,fetchImpl:async(url,init)=>{
    const response=await fetch(url,init);let body={};try{body=JSON.parse(String(init?.body??'{}'));}catch{}
    if(new URL(String(url)).pathname==='/internal/v1/workbench/tool'&&body.operation==='memory.stage')revokedStageStatus=response.status;
    if(revokeAfterList&&new URL(String(url)).pathname==='/internal/v1/workbench/tool'&&body.operation==='memory.list'){
     revokeAfterList=false;const current=gateway.workbench.memoryDreamPolicy('alice',agent.agent_id);
     gateway.workbench.setMemoryDreamPolicy('alice',agent.agent_id,{expected_version:current.policy_version,enabled:false});
    }
    return response;
   }});
   const runner={async run(input){
    sessionCalls++;try{dsh=await prepareDshRuntime(join(root,`dsh-runtime-${sessionCalls}`),runtime);
    const model=scriptedModel(dsh.modules['dsh-llm'].LlmAdapter,activeSourceId,
     ()=>gateway.db.prepare('SELECT consolidation_id FROM wb_memory_consolidations WHERE run_id=?').get(input.taskRequestId)?.consolidation_id);
    dsh.ctx.llm.registerAdapter(['dream-scripted'],model);
    dsh.handle=await dsh.ctx.agents.create({sessionId:input.sessionRef,meta:{agentPreset:'jot-workbench-budgeted',cwd:root},agentOptions:{provider:'dream-scripted',model:'scripted',maxTokens:32}});
    await bridge.attach(dsh.handle.agent,{runId:input.taskRequestId,sessionRef:input.sessionRef,executionLease:input.workbenchExecutionLease});
    input.onReady?.();
    const message=dsh.modules['dsh-llm'].createUserMessage({source:{kind:'user',rpcId:input.taskRequestId},content:[{type:'text',text:input.message}]});
    dsh.handle.agent.followup(message);await model.firstCall;
    try{await dsh.handle.agent.whenIdle();}catch(error){console.error('DREAM_DSH_IDLE',String(error),model.calls);throw error;}
    const calls=[];for(let i=0;i<dsh.handle.agent.session.seq;i++){const event=dsh.handle.agent.session.eventAt(i);if(event?.type==='tool/call')calls.push(event.data?.name);}
    if(sessionCalls===1){assert.deepEqual(calls,['jot_workspace','jot_workspace']);return{observed:true,completed:false,reason_code:'DREAM_POLICY_REVOKED',runtime_status:'not_required'};}
    assert.deepEqual(calls,['jot_workspace','jot_workspace','jot_workspace']);assert.equal(model.calls,4);
    return{observed:true,completed:true,reason_code:'SESSION_TURN_COMPLETED',runtime_status:'not_required',final_text:'Proposal prepared.'};
    }catch(error){console.error('DREAM_DSH_RUN_ERROR',error);throw error;}
   }};
   worker=new HarnessWorker(gateway.db,coordinator,runner,{workerId:'dream-dsh-worker',leaseMs:60000,
    sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id,
    executionGuard:{assertRunActive:runId=>gateway.workbench.assertRunActive(runId),contextForRun:runId=>gateway.workbench.contextForRun(runId)}});
   const processClaimed=worker.processClaimed.bind(worker);
   worker.processClaimed=async(...args)=>{const result=await processClaimed(...args);if(!['memory_dream_session_completed','memory_dream_reconciliation_required'].includes(result.runtime_status))console.error('DREAM_WORKER_RESULT',JSON.stringify(result),sessionCalls);return result;};
   ports=new MemoryDreamProductionPorts({db:gateway.db,workbench:gateway.workbench,coordinator,worker,
    sessionResolver:conversationId=>bindings.getOrCreateForConversation(conversationId).session_id});
  };
  connectHarness();
  activeSourceId=source.memory_id;
  const revokedCandidate=await ports.findCandidate(new Date().toISOString()),revokedClaim=await ports.claim(revokedCandidate,'dream-dsh-worker',60000);assert.ok(revokedClaim);
  try{await ports.runSession(revokedClaim,undefined,new AbortController().signal);}catch{}
  assert.equal(revokedStageStatus,409);assert.equal(sessionCalls,1);
  assert.equal(gateway.db.prepare('SELECT count(*) n FROM wb_memory_consolidations WHERE run_id=?').get(revokedClaim.run_id).n,0);
  assert.equal(gateway.workbench.memoryDreamPolicy('alice',agent.agent_id).enabled,false);
  assert.equal(await ports.findCandidate(new Date().toISOString()),null);
  await disposeDsh();

  const recoveryAgent=gateway.workbench.createAgent('alice',{name:'Dream DSH recovery source'});
  const recoverySource=gateway.workbench.saveMemory('alice','ws',{scope:'project',project_id:recoveryAgent.project_id,content:'A current synthetic project fact.',verified:true,source_revision:'fixture-recovery-v1'});
  const recoveryPolicy=gateway.workbench.memoryDreamPolicy('alice',recoveryAgent.agent_id);
  gateway.workbench.setMemoryDreamPolicy('alice',recoveryAgent.agent_id,{expected_version:recoveryPolicy.policy_version,enabled:true,interval_seconds:60});
  gateway.db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(String(Math.floor(Date.now()/1000)-1),'alice',recoveryAgent.agent_id);
  activeSourceId=recoverySource.memory_id;
  const firstCandidate=await ports.findCandidate(new Date().toISOString()),firstClaim=await ports.claim(firstCandidate,'dream-dsh-worker',60000);assert.ok(firstClaim);
  await ports.runSession(firstClaim,undefined,new AbortController().signal);
  const firstProposal=gateway.db.prepare("SELECT consolidation_id,status FROM wb_memory_consolidations WHERE run_id=?").get(firstClaim.run_id);
  assert.equal(firstProposal.status,'proposed');assert.equal(sessionCalls,2);
  gateway.modelBudgets.reserve('alice',firstClaim.run_id,{attempt_id:'dsh-unknown',provider:'dream-scripted',model:'scripted',max_tokens:32});
  gateway.modelBudgets.dispatch('alice',firstClaim.run_id,'dsh-unknown');gateway.modelBudgets.markUnknown('alice',firstClaim.run_id,'dsh-unknown','stream_incomplete');
  coordinator.interruptWithoutRuntime(firstClaim.coordinator_lease,'MEMORY_DREAM_RECONCILE_REQUIRED');
  gateway.workbench.deleteMemory('alice','ws',recoverySource.memory_id,recoverySource.version);
  await disposeDsh();await gateway.app.close();gateway.db.close();gateway=null;
  await startServer();connectHarness();
  const recovered=await new (await import('../../src/harness/memory-dream-pump.ts')).MemoryDreamPump(ports,{enabled:true,workerId:'dream-dsh-recovery',leaseMs:60000}).processNext();
  assert.deepEqual(recovered,{run_id:firstClaim.run_id,runtime_status:'memory_dream_reconciliation_required'});
  assert.equal(sessionCalls,2);assert.equal(gateway.runs.get(firstClaim.run_id,'alice').status,'interrupted');
  assert.equal(gateway.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(firstClaim.run_id,'dsh-unknown').state,'unknown');
  assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(firstClaim.run_id).n,0);
  gateway.workbench.setMemoryDreamPolicy('alice',recoveryAgent.agent_id,{expected_version:gateway.workbench.memoryDreamPolicy('alice',recoveryAgent.agent_id).policy_version,enabled:false});
  await disposeDsh();

  const reviewedAgent=gateway.workbench.createAgent('alice',{name:'Dream owner review'});
  const reviewedSource=gateway.workbench.saveMemory('alice','ws',{scope:'project',project_id:reviewedAgent.project_id,content:'A current owner-review fact.',verified:true,source_revision:'fixture-review-v1'});
  const reviewedPolicy=gateway.workbench.memoryDreamPolicy('alice',reviewedAgent.agent_id);
  gateway.workbench.setMemoryDreamPolicy('alice',reviewedAgent.agent_id,{expected_version:reviewedPolicy.policy_version,enabled:true,interval_seconds:60});
  gateway.db.prepare('UPDATE wb_memory_dream_policies SET next_due_at=? WHERE owner_id=? AND agent_id=?').run(String(Math.floor(Date.now()/1000)-1),'alice',reviewedAgent.agent_id);
  activeSourceId=reviewedSource.memory_id;
  const candidate=await ports.findCandidate(new Date().toISOString()),claim=await ports.claim(candidate,'dream-dsh-worker',60000);assert.ok(claim);
  await ports.runSession(claim,undefined,new AbortController().signal);
  const proposal=gateway.db.prepare("SELECT consolidation_id,status FROM wb_memory_consolidations WHERE run_id=?").get(claim.run_id);
  assert.equal(proposal.status,'proposed');assert.equal(sessionCalls,3);
  gateway.modelBudgets.reserve('alice',claim.run_id,{attempt_id:'dsh-reviewed',provider:'dream-scripted',model:'scripted',max_tokens:32});
  gateway.modelBudgets.dispatch('alice',claim.run_id,'dsh-reviewed');gateway.modelBudgets.settle('alice',claim.run_id,'dsh-reviewed',{inputTokens:12,outputTokens:4,totalTokens:16});
  const evidence=await ports.readEvidence(claim);assert.equal(evidence.policy_current,true);assert.equal(evidence.source_current,true);
  await ports.finalizeProposed(claim,evidence);
  assert.equal(gateway.runs.get(claim.run_id,'alice').status,'succeeded');

  applyPath=`/v1/workspaces/ws/memory-consolidations/${proposal.consolidation_id}/apply`;
  const apply=async()=>{
   const response=await fetch(new URL(applyPath,origin),{method:'POST',headers:{'content-type':'application/json','x-user-id':'alice',origin:'http://127.0.0.1','x-csrf-token':csrf,'idempotency-key':applyKey},body:JSON.stringify({expected_version:2})});
   return{status:response.status,body:await response.json()};
  };
  loseResponse=true;
  const lost=await apply();assert.equal(lost.status,503);
  assert.equal(gateway.workbench.memoryHistory('alice','ws',reviewedSource.memory_id).current_version,2);
  assert.equal(gateway.workbench.memoryConsolidations.get('alice','ws',proposal.consolidation_id).status,'applied');
  const durable=JSON.parse(gateway.db.prepare('SELECT response_json FROM ga_idempotency WHERE owner_id=? AND idempotency_key=?').get('alice',applyKey).response_json);
  await disposeDsh();
  await gateway.app.close();gateway.db.close();gateway=null;
  await startServer();
  const replay=await apply();assert.equal(replay.status,200);assert.deepEqual(replay.body,durable);
  assert.equal(gateway.workbench.memoryHistory('alice','ws',reviewedSource.memory_id).current_version,2);
  assert.equal(gateway.workbench.memoryConsolidations.get('alice','ws',proposal.consolidation_id).status,'applied');
 });
