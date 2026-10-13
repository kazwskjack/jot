import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,randomUUID} from 'node:crypto';
import {buildServer} from '../../src/server.ts';import {fileURLToPath} from 'node:url';
async function fixture(){const token=randomBytes(32).toString('hex');const s=await buildServer({databasePath:':memory:',workspaces:['main'],workbenchRoot:fileURLToPath(new URL('../../.test-tmp/native-lease/',import.meta.url)),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),internalChannelToken:token,emotion:{env:{}},modelBudgetRoutes:[{provider:'fixture',model:'model',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:2}}]});const owner='owner';const agent=s.workbench.createAgent(owner,{name:'Lease fixture'});const task=s.persistentTasks.create(owner,{title:'Lease fixture',agent_id:agent.agent_id,objective:'No external calls',trigger:{kind:'once'}});const run=s.persistentTasks.runNow(owner,task.task_id,randomUUID());s.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);s.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run.run_id,'worker-1',1,String(Date.now()+60000),'now');s.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(run.conversation_id,owner,'session-1','now','now');const scope=s.modelBudgets.createScope(owner,'original-root',{tokens:1000,nano_usd:10000,model_calls:10});s.modelBudgets.bindRun(owner,run.run_id,[scope.scope_id]);const fence=Object.freeze({owner:'worker-1',generation:1});const request=(endpoint,body)=>s.app.inject({method:'POST',url:'/internal/v1/workbench/'+endpoint,headers:{authorization:'Bearer '+token},payload:{run_id:run.run_id,session_ref:'session-1',...body}});return {...s,owner,run,scope,fence,request};}
test('fresh model spends require their original Worker fence; replacement cannot reserve or dispatch',async()=>{
 const s=await fixture();try{
  const reserve={action:'reserve',request:{attempt_id:'model-1',provider:'fixture',model:'model',max_tokens:20}};
  assert.equal((await s.request('model-budget',reserve)).statusCode,409);assert.equal(s.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,0);
  assert.equal((await s.request('model-budget',{...reserve,execution_lease:s.fence})).statusCode,200);
  s.db.prepare('UPDATE ga_worker_leases SET generation=2').run();
  assert.equal((await s.request('model-budget',{...reserve,request:{...reserve.request,attempt_id:'model-2'},execution_lease:s.fence})).statusCode,409);
  assert.equal((await s.request('model-budget',{action:'dispatch',attempt_id:'model-1',execution_lease:s.fence})).statusCode,409);
  assert.equal((await s.request('model-budget',{action:'release',attempt_id:'model-1',execution_lease:s.fence})).statusCode,200);
  assert.equal(s.modelBudgets.balance(s.owner,s.scope.scope_id).held.tokens,'0');assert.equal(s.modelBudgets.balance(s.owner,s.scope.scope_id).used.model_calls,'0');
 }finally{await s.app.close();s.db.close()}
});
test('dispatched usage settles after Worker replacement while old guard and new grants are revoked',async()=>{
 const s=await fixture();try{
  assert.equal((await s.request('model-budget',{action:'reserve',request:{attempt_id:'model-1',provider:'fixture',model:'model'},execution_lease:s.fence})).statusCode,200);
  assert.equal((await s.request('model-budget',{action:'dispatch',attempt_id:'model-1',execution_lease:s.fence})).statusCode,200);
  s.db.prepare('UPDATE ga_worker_leases SET generation=2').run();
  assert.equal((await s.request('guard',{execution_lease:s.fence})).statusCode,409);
  const grant={call_id:'call-1',tool_name:'universe_search',request_hash:'a'.repeat(64)};
  assert.equal((await s.request('web-budget-grant',grant)).statusCode,409);assert.equal((await s.request('web-budget-grant',{...grant,execution_lease:s.fence})).statusCode,409);
  const settle={action:'settle',attempt_id:'model-1',usage:{inputTokens:5,outputTokens:2,totalTokens:7},execution_lease:s.fence};assert.equal((await s.request('model-budget',settle)).statusCode,200);
  const balance=s.modelBudgets.balance(s.owner,s.scope.scope_id);assert.deepEqual(balance.used,{tokens:'7',nano_usd:'30',model_calls:'1'});assert.equal((await s.request('model-budget',settle)).statusCode,200);assert.deepEqual(s.modelBudgets.balance(s.owner,s.scope.scope_id),balance);
 }finally{await s.app.close();s.db.close()}
});
