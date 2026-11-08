import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
import {ModelBudgetLedger} from '../../src/workbench/model-budget.ts';
import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';

const reasoningToken='local-reasoning-test-token';
const reasoningRoute={provider:'fixture',model:'memory-reasoner',revision:'fixture-rates-v1',context_window:16000,max_output_tokens:2000,
 rates:{input:1,output:2,cache_read:1,cache_write:1}};
const reasoningUsage={inputTokens:10,outputTokens:2,totalTokens:12,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0};

function fixture(t,client,limits={tokens:100000,nano_usd:100000000,model_calls:3}){
 const base=resolve('test-tmp/memory-product-injection');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite'));
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files')}),tasks=new PersistentTaskService(db,workbench);
 const ledger=new ModelBudgetLedger(db,{routes:[reasoningRoute]}),agent=workbench.createAgent('alice',{name:'Reasoning reader',workspace_id:'ws'});
 const task=tasks.create('alice',{agent_id:agent.agent_id,title:'Memory reasoning',objective:'Retrieve scoped memories',trigger:{kind:'once'}}),run=tasks.runNow('alice',task.task_id,randomUUID());
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run.run_id,'fixture-worker',1,String(Date.now()+60000),new Date().toISOString());
 const sessionRef=new SessionBindingRepository(db).getOrCreate('alice',run.conversation_id).session_id;
 const scope=ledger.createScope('alice','memory-reasoning',limits);ledger.bindRun('alice',run.run_id,[scope.scope_id]);
 const app={routes:new Map(),post(path,handler){this.routes.set(path,handler);}};
 registerWorkbenchExecution(app,db,workbench,tasks,reasoningToken,ledger,undefined,undefined,undefined,new Set(),client);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{db,workbench,ledger,agent,run,scope,invoke:(query,callId='reasoning-call-01')=>app.routes.get('/internal/v1/workbench/tool')({
  headers:{authorization:`Bearer ${reasoningToken}`},body:{run_id:run.run_id,session_ref:sessionRef,operation:'memory.list',arguments:{q:query},call_id:callId},
 })};
}

test('M04.04 memory.list reasoning selection uses only its authorized candidates and settles the configured budget',async t=>{
 const seen=[];let calls=0;
 const client={route:reasoningRoute,preflight(input){seen.push({stage:'preflight',input});},async invoke(input){
  calls++;seen.push({stage:'invoke',input});return{value:{selected_ids:[String(input.candidates.find(x=>x.content.includes('Ferry service'))?.memory_id)]},usage:reasoningUsage};
 }};
 const f=fixture(t,client),sameProjectAgent=f.workbench.createAgent('alice',{name:'Another role',workspace_id:'ws'});
 const own=f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'Ferry service ends at 18:00.'});
 const otherOwn=f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'The clinic closes at 17:00.'});
 f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:sameProjectAgent.agent_id,content:'Ferry note belonging to another role.'});
 const otherProject=new ProjectRepository(f.db).create('alice',{title:'Separate project'});
 f.workbench.saveMemory('alice','ws',{scope:'project',project_id:otherProject.project_id,content:'Ferry note from another project.'});
 const query='Which hour should callers leave island?',result=await f.invoke(query);
 assert.deepEqual(result.items.map(x=>x.memory_id),[own.memory_id]);
 assert.deepEqual(seen.map(x=>x.stage),['preflight','invoke']);
 assert.equal(seen[1].input.query,query);assert.deepEqual(seen[1].input.candidates.map(x=>x.memory_id),[own.memory_id,otherOwn.memory_id]);
 assert.equal(JSON.parse(f.db.prepare('SELECT request_json FROM wb_model_budget_attempts WHERE run_id=?').get(f.run.run_id).request_json).purpose,'memory-reasoning');
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=?').get(f.run.run_id).state,'settled');
 assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'1');
 const trace=f.workbench.memoryRetrievals.get('alice','ws',result.retrieval_id);
 assert.equal(trace.method,'reasoning_provider');assert.deepEqual(trace.references.map(x=>[x.memory_id,x.version,x.scope]),[[own.memory_id,1,'private']]);
 assert.equal(trace.excluded.provider_unselected,1);assert.equal(trace.excluded.selected_source_stale,0);
 const replay=await f.invoke(query);assert.deepEqual(replay,result);assert.equal(calls,1);
 await assert.rejects(f.invoke('Different question with the same call ID'),/idempotency_conflict/);assert.equal(calls,1);
 f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,memory_id:own.memory_id,expected_version:1,content:'Ferry service now ends at 19:00.'});
 const invalidated=await f.invoke(query);assert.deepEqual(invalidated.items,[]);assert.equal(invalidated.invalidated_result,true);assert.equal(invalidated.retrieval_id,result.retrieval_id);
 });

test('M04.04 discards a provider selection when its source version changes during the call',async t=>{
 let release;const client={route:reasoningRoute,preflight(){},invoke(input){return new Promise(resolve=>{release=()=>resolve({value:{selected_ids:[input.candidates[0].memory_id]},usage:reasoningUsage});});}};
 const f=fixture(t,client),note=f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'The ferry stops at 18:00.'});
 const pending=f.invoke('When does the ferry stop?','stale-source-call-01');
 f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,memory_id:note.memory_id,expected_version:1,content:'The ferry now stops at 19:00.'});
 release();const result=await pending;assert.deepEqual(result.items,[]);
 const trace=f.workbench.memoryRetrievals.get('alice','ws',result.retrieval_id);assert.equal(trace.method,'reasoning_provider');assert.equal(trace.result_count,0);assert.equal(trace.excluded.provider_unselected,0);assert.equal(trace.excluded.selected_source_stale,1);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=?').get(f.run.run_id).state,'settled');
});

test('M04.04 provider failures create no retrieval trace and keep dispatched usage unknown',async t=>{
 const client={route:reasoningRoute,preflight(){},async invoke(){throw new Error('private provider response detail');}};
 const f=fixture(t,client);f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'A scoped note.'});
 await assert.rejects(f.invoke('Find the note.','provider-failure-call-01'),/auxiliary_usage_unknown/);
 const attempt=f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=?').get(f.run.run_id);assert.equal(attempt.state,'unknown');
 assert.equal(f.workbench.memoryRetrievals.list('alice','ws',f.agent.agent_id).items.filter(item=>item.kind==='tool_query').length,0);
 assert.equal(f.ledger.balance('alice',f.scope.scope_id).held.model_calls,'1');
});

test('M04.04 preserves the actual ledger exhaustion code across the reasoning adapter',async t=>{
 let calls=0;const client={route:reasoningRoute,preflight(){},async invoke(){calls++;return{value:{selected_ids:[]},usage:reasoningUsage};}};
 const f=fixture(t,client,{tokens:1,nano_usd:1,model_calls:0});f.workbench.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'A scoped note.'});
 await assert.rejects(f.invoke('Find the note.','budget-exhausted-call-01'),/model_budget_exhausted/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=?').get(f.run.run_id).n,0);
});
