import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import Fastify from 'fastify';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';
import {registerWorkbenchRoutes} from '../../src/workbench/routes.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {MemoryExtractionPump} from '../../src/harness/memory-extraction-pump.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';

function fixture(t,mode='settled'){
 const base=resolve('.test-tmp/memory-recovery-routes');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite'));
 const limits={tokens:5000,nano_usd:50000,model_calls:20},policy=new WorkbenchBudgetPolicy(db,{revision:1,admission_route:{provider:'fixture',model:'fixture'},routes:[{provider:'fixture',model:'fixture',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))});
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files'),modelBudgetPolicy:policy}),events=new EventStore(db),runs=new RunRepository(db,events),coordinator=new HarnessCoordinator(db,runs,events),sessions=new SessionBindingRepository(db),agent=workbench.createAgent('alice',{name:'Reader'}),app=Fastify();
 app.setErrorHandler((error,_request,reply)=>reply.code(error.message.endsWith('_not_found')?404:error.message.startsWith('invalid_')?422:400).send({error:error.message}));
 registerWorkbenchRoutes(app,workbench,request=>String(request.headers['x-user-id']??''));
 workbench.memoryCapture.setPolicy('alice',agent.agent_id,{expected_version:0,mode:'suggest'});const source=workbench.enqueueAgentMessage('alice',agent.agent_id,{text:'Private source text',client_message_id:'source'});db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);workbench.collectMemoryCaptures();const capture=workbench.memoryCapture.list('alice',agent.agent_id).items[0];
 const client={memoryExtractionReadiness:async()=>({ready:true}),create:async()=>{},extractMemory:async(_session,runId)=>{
  policy.ledger.reserve('alice',runId,{attempt_id:'one-call',provider:'fixture',model:'fixture',max_tokens:20});policy.ledger.dispatch('alice',runId,'one-call');
  if(mode==='settled')policy.ledger.settle('alice',runId,'one-call',{inputTokens:5,outputTokens:5,totalTokens:10});
  else if(mode==='unknown')policy.ledger.markUnknown('alice',runId,'one-call','stream_incomplete');
  else throw Error('private raw failure detail');
  if(mode!=='settled')throw Error('private raw failure detail');
  const packet=workbench.memoryCapture.get('alice',agent.agent_id,capture.capture_id);
  return workbench.memoryCapture.propose('alice',agent.agent_id,capture.capture_id,{expected_version:packet.version,summary:'Private proposal summary',notes:[{content:'Private proposal body',source_ids:[packet.sources[0].source_id]}]},runId);
 }};
 const pump=new MemoryExtractionPump(db,workbench,coordinator,client,{enabled:true,workerId:'route-test',leaseMs:30000,cwd:root,sessionResolver:id=>sessions.getOrCreateForConversation(id).session_id});
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const get=(user='alice',agentId=agent.agent_id)=>app.inject({method:'GET',url:`/v1/agents/${agentId}/memory-captures/${capture.capture_id}/recovery`,headers:{'x-user-id':user}});
 const snapshot=()=>({tables:db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,runs:db.prepare('SELECT count(*) n FROM ga_runs').get().n,attempts:db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,capture:db.prepare('SELECT status,version FROM wb_memory_captures WHERE capture_id=?').get(capture.capture_id)});
 return {db,workbench,policy,agent,source,capture,app,pump,get,snapshot};
}

test('owner recovery read exposes only finite committed proposal and settled usage state without mutation',async t=>{
 const f=fixture(t);assert.equal((await f.pump.processNext()).runtime_status,'memory_proposed');const before=f.snapshot();
 const response=await f.get();assert.equal(response.statusCode,200,response.body);
 const contract=new ContractValidator();assert.equal(contract.validateResponse('getMemoryCaptureRecovery',200,response.json()).valid,true);
 assert.deepEqual(response.json(),{capture_status:'proposed',processor_run_status:'succeeded',proposal_available:true,usage_state:'settled',recovery_state:'committed_proposal_settled'});
 assert.equal(response.body.includes('Private'),false);assert.equal(response.body.includes(f.capture.capture_id),false);assert.equal(response.body.includes('run_id'),false);assert.deepEqual(f.snapshot(),before);
});

test('recovery read hides captures from another owner and another authorized agent scope',async t=>{
 const f=fixture(t);assert.equal((await f.pump.processNext()).runtime_status,'memory_proposed');const other=f.workbench.createAgent('alice',{name:'Other'});
 assert.equal((await f.get('bob')).statusCode,404);assert.equal((await f.get('alice',other.agent_id)).statusCode,404);
 assert.equal((await f.app.inject({method:'GET',url:`/v1/agents/${f.agent.agent_id}/memory-captures/${f.capture.capture_id}/recovery?details=all`,headers:{'x-user-id':'alice'}})).statusCode,422);
});

test('policy revocation makes a committed proposal unavailable in the recovery read',async t=>{
 const f=fixture(t);assert.equal((await f.pump.processNext()).runtime_status,'memory_proposed');f.workbench.memoryCapture.setPolicy('alice',f.agent.agent_id,{expected_version:1,mode:'off'});
 const response=await f.get();assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{capture_status:'proposed',processor_run_status:'succeeded',proposal_available:false,usage_state:'settled',recovery_state:'source_or_policy_stale'});
});

test('a source edit makes a committed proposal unavailable in the recovery read',async t=>{
 const f=fixture(t);assert.equal((await f.pump.processNext()).runtime_status,'memory_proposed');f.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run('[]',f.db.prepare('SELECT input_message_id FROM ga_runs WHERE id=?').get(f.source.run_id).input_message_id);
 const response=await f.get();assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{capture_status:'proposed',processor_run_status:'succeeded',proposal_available:false,usage_state:'settled',recovery_state:'source_or_policy_stale'});
});

test('unknown and in-flight provider usage remain held in recovery state',async t=>{
 for(const [mode,usage] of [['unknown','held_unknown'],['in_flight','held_in_flight']]){
  const f=fixture(t,mode),result=await f.pump.processNext();assert.equal(result.runtime_status,'memory_reconciliation_required');
  const response=await f.get();assert.equal(response.statusCode,200,response.body);const value=response.json();
  assert.equal(value.capture_status,'ready');assert.equal(value.processor_run_status,'interrupted');assert.equal(value.proposal_available,false);assert.equal(value.usage_state,usage);assert.equal(value.recovery_state,'unresolved_usage_held');
  assert.equal(response.body.includes('private raw failure detail'),false);assert.equal(response.body.includes(f.capture.capture_id),false);
 }
});
