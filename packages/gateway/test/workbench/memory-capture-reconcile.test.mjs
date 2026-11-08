import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';
import {registerWorkbenchRoutes} from '../../src/workbench/routes.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {MemoryExtractionPump} from '../../src/harness/memory-extraction-pump.ts';

function fixture(t,{usage={inputTokens:5,outputTokens:5,totalTokens:10,cacheReadTokens:0,cacheWriteTokens:0},markUnknown=true}={}){
 const base=resolve('.test-tmp/memory-capture-reconcile');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite'));
 const limits={tokens:5000,nano_usd:50000,model_calls:20},policy=new WorkbenchBudgetPolicy(db,{revision:1,admission_route:{provider:'fixture',model:'fixture'},routes:[{provider:'fixture',model:'fixture',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))});
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files'),modelBudgetPolicy:policy}),events=new EventStore(db),runs=new RunRepository(db,events),coordinator=new HarnessCoordinator(db,runs,events),sessions=new SessionBindingRepository(db),agent=workbench.createAgent('alice',{name:'Reader'});
 workbench.memoryCapture.setPolicy('alice',agent.agent_id,{expected_version:0,mode:'suggest'});
 const source=workbench.enqueueAgentMessage('alice',agent.agent_id,{text:'Private source text',client_message_id:'source'});
 db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);workbench.collectMemoryCaptures();
 const capture=workbench.memoryCapture.list('alice',agent.agent_id).items[0];let extractionCalls=0;
 const client={memoryExtractionReadiness:async()=>({ready:true}),create:async()=>{},extractMemory:async(_session,runId)=>{
  extractionCalls++;policy.ledger.reserve('alice',runId,{attempt_id:'original-call',provider:'fixture',model:'fixture',max_tokens:20});policy.ledger.dispatch('alice',runId,'original-call');
  const packet=workbench.memoryCapture.get('alice',agent.agent_id,capture.capture_id);
  const proposal=workbench.memoryCapture.propose('alice',agent.agent_id,capture.capture_id,{expected_version:packet.version,summary:'Private proposal summary',notes:[{content:'Private proposal body',source_ids:[packet.sources[0].source_id]}]},runId);
  assert.equal(proposal.status,'proposed');
  policy.ledger.recordMemoryProviderReceipt('alice',runId,'original-call','original-call',usage);
  if(markUnknown)policy.ledger.markUnknown('alice',runId,'original-call','settlement_unavailable');
  throw new Error('private raw failure detail');
 }};
 const pump=new MemoryExtractionPump(db,workbench,coordinator,client,{enabled:true,workerId:'route-test',leaseMs:30000,cwd:root,sessionResolver:id=>sessions.getOrCreateForConversation(id).session_id});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return {db,workbench,policy,agent,source,capture,pump,extractionCalls:()=>extractionCalls};
}

test('owner reconciles the exact unknown call for an already committed proposal without rerunning extraction',async t=>{
 const f=fixture(t),processed=await f.pump.processNext();
 assert.equal(processed.runtime_status,'memory_reconciliation_required');
 assert.equal(f.extractionCalls(),1);
 const read=f.workbench.memoryCapture.recovery('alice',f.agent.agent_id,f.capture.capture_id);
 const evidence=read.reconciliation_evidence;
 assert.equal(evidence.length,1);
 assert.equal(evidence[0].attempt_id,'original-call');
 const capture=f.workbench.memoryCapture.get('alice',f.agent.agent_id,f.capture.capture_id);
 const input={expected_capture_version:capture.version,expected_policy_version:1,expected_epoch:f.agent.capability_epoch,attempt_id:'original-call',evidence_ref:evidence[0].evidence_ref};
 assert.throws(()=>f.workbench.memoryCapture.apply('alice',f.agent.agent_id,f.capture.capture_id,capture.version),/memory_capture_unresolved_usage_held/);
 const handlers=new Map(),app=new Proxy({}, {get(_target,method){return (path,handler)=>{if(typeof path==='string'&&typeof handler==='function')handlers.set(String(method).toUpperCase()+' '+path,handler);};}});
 registerWorkbenchRoutes(app,f.workbench,request=>String(request.headers['x-user-id']??''));
 const recoveryHeaders={},recoveryHandler=handlers.get('GET /v1/agents/:agentId/memory-captures/:captureId/recovery');
 const recoveryResponse=await recoveryHandler({params:{agentId:f.agent.agent_id,captureId:f.capture.capture_id},query:{},headers:{'x-user-id':'alice'}},{header:(name,value)=>{recoveryHeaders[name]=value;}});
 assert.equal(recoveryHeaders['cache-control'],'private, no-store');assert.equal(recoveryResponse.recovery_state,'unresolved_usage_held');
 const reconcile=handlers.get('POST /v1/agents/:agentId/memory-captures/:captureId/reconcile');assert.equal(typeof reconcile,'function');
 const result=await reconcile({params:{agentId:f.agent.agent_id,captureId:f.capture.capture_id},query:{},body:input,headers:{'x-user-id':'alice'}});
 assert.equal(result.state,'committed_proposal_settled');
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(processed.run_id,'original-call').state,'settled');
 assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(processed.run_id).status,'succeeded');
 assert.equal(f.workbench.memoryCapture.recovery('alice',f.agent.agent_id,f.capture.capture_id).recovery_state,'committed_proposal_settled');
 assert.deepEqual(await reconcile({params:{agentId:f.agent.agent_id,captureId:f.capture.capture_id},query:{},body:input,headers:{'x-user-id':'alice'}}),result);
 const applied=f.workbench.memoryCapture.apply('alice',f.agent.agent_id,f.capture.capture_id,capture.version);
 assert.equal(applied.status,'applied');
 assert.equal(f.extractionCalls(),1);
});

test('provider overrun settles the original attempt as failed and never makes the candidate applicable',async t=>{
 const f=fixture(t,{usage:{inputTokens:50,outputTokens:50,totalTokens:100,cacheReadTokens:0,cacheWriteTokens:0}}),processed=await f.pump.processNext();
 const read=f.workbench.memoryCapture.recovery('alice',f.agent.agent_id,f.capture.capture_id),evidence=read.reconciliation_evidence[0],capture=f.workbench.memoryCapture.get('alice',f.agent.agent_id,f.capture.capture_id);
 const input={expected_capture_version:capture.version,expected_policy_version:1,expected_epoch:f.agent.capability_epoch,attempt_id:'original-call',evidence_ref:evidence.evidence_ref};
 assert.throws(()=>f.workbench.memoryCapture.apply('alice',f.agent.agent_id,f.capture.capture_id,capture.version),/memory_capture_unresolved_usage_held/);
 const result=f.workbench.memoryCapture.reconcile('alice',f.agent.agent_id,f.capture.capture_id,input);
 assert.equal(result.state,'budget_bound_exceeded');assert.equal(f.db.prepare('SELECT status,reason_code FROM ga_runs WHERE id=?').get(processed.run_id).status,'failed');
 assert.equal(f.workbench.memoryCapture.recovery('alice',f.agent.agent_id,f.capture.capture_id).recovery_state,'budget_bound_exceeded');
 assert.throws(()=>f.workbench.memoryCapture.apply('alice',f.agent.agent_id,f.capture.capture_id,capture.version),/memory_capture_unresolved_usage_held/);
 assert.equal(f.extractionCalls(),1);
});

test('a durable receipt also reconciles an in-flight attempt after its original lease ends',async t=>{
 const f=fixture(t,{markUnknown:false}),processed=await f.pump.processNext();
 const read=f.workbench.memoryCapture.recovery('alice',f.agent.agent_id,f.capture.capture_id),evidence=read.reconciliation_evidence[0],capture=f.workbench.memoryCapture.get('alice',f.agent.agent_id,f.capture.capture_id);
 assert.equal(read.usage_state,'held_in_flight');assert.ok(evidence);
 const result=f.workbench.memoryCapture.reconcile('alice',f.agent.agent_id,f.capture.capture_id,{expected_capture_version:capture.version,expected_policy_version:1,expected_epoch:f.agent.capability_epoch,attempt_id:'original-call',evidence_ref:evidence.evidence_ref});
 assert.equal(result.state,'committed_proposal_settled');assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(processed.run_id).status,'succeeded');assert.equal(f.extractionCalls(),1);
});

test('reconciliation rejects another owner and a stale policy without settling original usage',async t=>{
 const f=fixture(t);await f.pump.processNext();
 const read=f.workbench.memoryCapture.recovery('alice',f.agent.agent_id,f.capture.capture_id),evidence=read.reconciliation_evidence[0];
 const capture=f.workbench.memoryCapture.get('alice',f.agent.agent_id,f.capture.capture_id);
 const input={expected_capture_version:capture.version,expected_policy_version:1,expected_epoch:f.agent.capability_epoch,attempt_id:'original-call',evidence_ref:evidence.evidence_ref};
 assert.throws(()=>f.workbench.memoryCapture.reconcile('bob',f.agent.agent_id,f.capture.capture_id,input),/agent_not_found|memory_capture_not_found/);
 f.workbench.memoryCapture.setPolicy('alice',f.agent.agent_id,{expected_version:1,mode:'off'});
 assert.throws(()=>f.workbench.memoryCapture.reconcile('alice',f.agent.agent_id,f.capture.capture_id,input),/memory_capture_source_or_policy_stale|memory_capture_reconcile_conflict/);
 const runId=f.db.prepare('SELECT processor_run_id FROM wb_memory_captures WHERE capture_id=?').get(f.capture.capture_id).processor_run_id;
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runId,'original-call').state,'unknown');
 assert.equal(f.extractionCalls(),1);
});
