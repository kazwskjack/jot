import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {WebDecisionBudgetService} from '../../src/workbench/web-decision-budget.ts';import {createAuxiliaryRunGuard} from '../../src/workbench/auxiliary-run-guard.ts';
const secret='test-web-budget-internal-secret';
test('web budget internal routes retain bearer authorization when browser CSRF is enabled',async t=>{
 const f=await fixture(t,[route],':memory:',{csrfToken:'test-browser-csrf-secret',allowedOrigins:['https://fixture.invalid']});
 const minted=await f.mint();assert.equal(minted.statusCode,200,minted.body);
 const grant=minted.json().grant;
 const reserved=await f.command(grant,{action:'reserve',request_id:'csrf-internal',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)});
 assert.equal(reserved.statusCode,200,reserved.body);
 const closed=await f.app.inject({method:'POST',url:'/internal/v1/workbench/web-budget-grant/close',headers:{authorization:'Bearer '+secret},
  payload:{run_id:f.run.run_id,session_ref:f.identity.session_ref,call_id:f.identity.call_id}});
 assert.equal(closed.statusCode,200,closed.body);
 for(const url of ['/internal/v1/workbench/web-budget-grant','/internal/v1/workbench/web-budget-grant/close','/internal/v1/workbench/web-model-budget']){
  const rejected=await f.app.inject({method:'POST',url,payload:{}});
  assert.equal(rejected.statusCode,401,rejected.body);
 }
 const browser=await f.app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers:{'x-user-id':'alice'},payload:{trigger:{kind:'once'}}});
 assert.equal(browser.statusCode,403,browser.body);assert.equal(browser.json().error.code,'ORIGIN_FORBIDDEN');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
});
test('expired grant resolves its unknown token attempt and settles original usage without new admission',async t=>{
 const tokenRoute={provider:'laya',model:'multilingual',revision:'test-expired-token',context_window:100,max_output_tokens:10,rates:{input:1,output:2,cache_read:1,cache_write:1}};
 const f=await fixture(t,[tokenRoute]);let clock=Date.now();
 const service=new WebDecisionBudgetService(f.db,{ledger:f.modelBudgets,secret,
  guard:(owner,run)=>createAuxiliaryRunGuard(f.db,f.workbench,f.persistentTasks,owner,run),now:()=>clock});
 const grant=service.mint('alice',f.run.run_id,'test-web-session','test-expired-recovery','universe_search','a'.repeat(64)).grant;
 const body={action:'reserve',request_id:'expired-original',provider:'laya',model:'multilingual',request_hash:'b'.repeat(64)};
 const original=service.command(grant,body).receipt;
 service.command(grant,{action:'dispatch',attempt_id:original.attempt_id});
 service.command(grant,{action:'unknown',attempt_id:original.attempt_id,reason:'transport_unknown'});
 clock+=300001;f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1').run();
 const recovered=service.command(grant,body);
 assert.equal(recovered.fresh,false);assert.equal(recovered.receipt.state,'unknown');
 assert.equal(recovered.receipt.attempt_id,original.attempt_id);
 assert.throws(()=>service.command(grant,{...body,request_id:'expired-new'}),/web_budget_grant_revoked/);
 assert.throws(()=>service.command(grant,{action:'dispatch',attempt_id:original.attempt_id}),/web_budget_grant_revoked/);
 assert.equal(service.command(grant,{action:'settle',attempt_id:original.attempt_id,usage:{inputTokens:20,outputTokens:5,totalTokens:25}}).receipt.state,'settled');
 assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.tokens,'25');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
});
test('closed original grant resolves an exact dispatched attempt without admission or new spend',async t=>{
 const f=await fixture(t),grant=(await f.mint()).json().grant;
 const request={action:'reserve',request_id:'closed-recovery',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)};
 const original=(await f.command(grant,request)).json().receipt;
 await f.command(grant,{action:'dispatch',attempt_id:original.attempt_id});
 const response_json=JSON.stringify({protocol:1,encoding:'json',value:{result:'original'}});
 await f.command(grant,{action:'response_record',attempt_id:original.attempt_id,response_json,response_hash:createHash('sha256').update(response_json).digest('hex')});
 await f.app.inject({method:'POST',url:'/internal/v1/workbench/web-budget-grant/close',headers:{authorization:'Bearer '+secret},
  payload:{run_id:f.run.run_id,session_ref:f.identity.session_ref,call_id:f.identity.call_id}});
 f.workbench.updateAgent('alice',f.agent.agent_id,{expected_version:f.agent.version,status:'disabled'});
 const recovered=await f.command(grant,request);
 assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().fresh,false);
 assert.equal(recovered.json().receipt.attempt_id,original.attempt_id);assert.equal(recovered.json().receipt.state,'settled');
 assert.equal((await f.command(grant,{action:'response_read',attempt_id:original.attempt_id})).json().response.response_json,response_json);
 assert.notEqual((await f.command(grant,{...request,request_id:'new-after-close'})).statusCode,200);
 assert.notEqual((await f.command(grant,{...request,request_hash:'c'.repeat(64)})).statusCode,200);
 assert.notEqual((await f.command(grant,{action:'dispatch',attempt_id:original.attempt_id})).statusCode,200);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
 assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');
});
test('unknown reason requires a literal allowed string before changing accounting',async t=>{
 const f=await fixture(t),grant=(await f.mint()).json().grant;
 const reserved=(await f.command(grant,{action:'reserve',request_id:'reason-type',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)})).json();
 const attempt=reserved.receipt.attempt_id;
 for(const reason of [['provider_failed'],['transport_unknown'],null,1,{}]){
  const reply=await f.command(grant,{action:'unknown',attempt_id:attempt,reason});
  assert.equal(reply.statusCode,422,reply.body);
  assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'0');
  assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).held.model_calls,'1');
 }
});
test('original recorded response survives closing every database connection and reopening the gateway',async t=>{
 const databasePath='.test-tmp/web-response-'+randomUUID()+'.sqlite',f=await fixture(t,[route],databasePath),grant=(await f.mint()).json().grant;
 const attempt=(await f.command(grant,{action:'reserve',request_id:'test-durable-response',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)})).json().receipt.attempt_id;
 await f.command(grant,{action:'dispatch',attempt_id:attempt});
 const response_json=JSON.stringify({protocol:1,encoding:'json',value:{status:'selected',evidence:'synthetic-only'}}),response_hash=createHash('sha256').update(response_json).digest('hex');
 assert.equal((await f.command(grant,{action:'response_record',attempt_id:attempt,response_json,response_hash})).statusCode,200);
 await f.app.close();f.db.close();
 const restored=await buildServer({databasePath,workspaces:['shared'],workbenchRoot:'.test-tmp/reopened-budget',internalChannelToken:secret,modelBudgetRoutes:[route]});
 t.after(async()=>{await restored.app.close();restored.db.close();});
 const recovered=await restored.app.inject({method:'POST',url:'/internal/v1/workbench/web-model-budget',headers:{authorization:'Bearer '+grant},payload:{action:'response_read',attempt_id:attempt}});
 assert.equal(recovered.statusCode,200,recovered.body);assert.deepEqual(recovered.json().response,{response_json,response_hash});
 assert.equal(restored.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');
 assert.equal(restored.db.prepare('SELECT count(*) n FROM wb_web_model_responses').get().n,1);
});
test('original provider response is append-only, byte-hashed and cannot be recorded before dispatch',async t=>{
 const f=await fixture(t),grant=(await f.mint()).json().grant;
 const reservation=(await f.command(grant,{action:'reserve',request_id:'test-response',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)})).json();
 const attempt=reservation.receipt.attempt_id,response_json=JSON.stringify({protocol:1,encoding:'json',value:{status:'selected',target:'test-one'}});
 const payload={action:'response_record',attempt_id:attempt,response_json,response_hash:createHash('sha256').update(response_json).digest('hex')};
 assert.equal((await f.command(grant,payload)).statusCode,409);
 assert.equal((await f.command(grant,{action:'dispatch',attempt_id:attempt})).statusCode,200);
 assert.equal((await f.command(grant,payload)).statusCode,200);
 assert.equal((await f.command(grant,payload)).statusCode,200);
 const changed=JSON.stringify({protocol:1,encoding:'json',value:{status:'selected',target:'changed'}});
 assert.equal((await f.command(grant,{...payload,response_json:changed,response_hash:createHash('sha256').update(changed).digest('hex')})).statusCode,409);
 assert.equal((await f.command(grant,{...payload,response_hash:'f'.repeat(64)})).statusCode,422);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_web_model_responses').get().n,1);
 assert.throws(()=>f.db.prepare("UPDATE wb_web_model_responses SET response_json='{}'").run(),/web_budget_response_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_web_model_responses').run(),/web_budget_response_immutable/);
 assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');
});
test('lost response acknowledgement can be recovered from the original closed grant without a new invocation',async t=>{
 const f=await fixture(t),grant=(await f.mint()).json().grant;
 const attempt=(await f.command(grant,{action:'reserve',request_id:'test-response',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)})).json().receipt.attempt_id;
 await f.command(grant,{action:'dispatch',attempt_id:attempt});
 const response_json=JSON.stringify({protocol:1,encoding:'http',status_code:200,body_base64:Buffer.from('{"status":"selected"}').toString('base64'),retry_after:null});
 const response_hash=createHash('sha256').update(response_json).digest('hex');
 await f.command(grant,{action:'response_record',attempt_id:attempt,response_json,response_hash});
 await f.app.inject({method:'POST',url:'/internal/v1/workbench/web-budget-grant/close',headers:{authorization:'Bearer '+secret},payload:{run_id:f.run.run_id,session_ref:'test-web-session',call_id:f.identity.call_id}});
 const recovered=await f.command(grant,{action:'response_read',attempt_id:attempt});
 assert.equal(recovered.statusCode,200,recovered.body);assert.deepEqual(recovered.json().response,{response_json,response_hash});
 const other=(await f.mint({...f.identity,call_id:'test-other-call'})).json().grant;
 assert.equal((await f.command(other,{action:'response_read',attempt_id:attempt})).statusCode,403);
 assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');
 assert.notEqual((await f.command(grant,{action:'dispatch',attempt_id:attempt})).statusCode,200);
});
const route={provider:'openjev',model:'openjev',revision:'test-web-call',context_window:100,max_output_tokens:1,rates:{input:0,output:0,cache_read:0,cache_write:0},billing:{unit:'dispatched_call',nano_usd:7}};
async function fixture(t,routes=[route],databasePath=':memory:',security={}){const server=await buildServer({...security,databasePath,workspaces:['shared'],workbenchRoot:'.test-tmp/web-budget-'+randomUUID(),internalChannelToken:secret,modelBudgetRoutes:routes});t.after(async()=>{await server.app.close();if(server.db.isOpen)server.db.close();});const agent=server.workbench.createAgent('alice',{name:'Reader'}),task=server.persistentTasks.create('alice',{title:'Controlled search',agent_id:agent.agent_id,objective:'Read public sources',trigger:{kind:'once'}}),run=server.persistentTasks.runNow('alice',task.task_id,randomUUID());server.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);const now=new Date().toISOString();server.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run.run_id,'test-web-worker',1,String(Date.now()+60000),now);server.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(run.conversation_id,'alice','test-web-session',now,now);const scope=server.modelBudgets.createScope('alice','test-web-scope',{tokens:1000,nano_usd:1000,model_calls:3});server.modelBudgets.bindRun('alice',run.run_id,[scope.scope_id]);const identity={run_id:run.run_id,session_ref:'test-web-session',execution_lease:Object.freeze({owner:'test-web-worker',generation:1}),call_id:'test-search-call',tool_name:'universe_search',request_hash:'a'.repeat(64)};const mint=(body=identity)=>server.app.inject({method:'POST',url:'/internal/v1/workbench/web-budget-grant',headers:{authorization:'Bearer '+secret},payload:body});const command=(grant,body)=>server.app.inject({method:'POST',url:'/internal/v1/workbench/web-model-budget',headers:{authorization:'Bearer '+grant},payload:body});return {...server,agent,task,run,scope,identity,mint,command};}
test('trusted host mints an opaque replay-stable grant; model owner/session claims cannot create it',async t=>{const f=await fixture(t),first=await f.mint();assert.equal(first.statusCode,200,first.body);const value=first.json();assert.match(value.grant,/^[a-f0-9]{64}$/);assert.equal((await f.mint()).body,first.body);assert.equal(first.body.includes('test-web-session'),false);assert.equal(first.body.includes(f.run.run_id),false);assert.notEqual((await f.mint({...f.identity,owner_id:'alice'})).statusCode,200);assert.notEqual((await f.mint({...f.identity,request_hash:'b'.repeat(64)})).statusCode,200);assert.equal((await f.command(secret,{action:'reserve'})).statusCode,401);});
test('each provider attempt uses the original root quota and dispatch cannot be replayed',async t=>{const f=await fixture(t),grant=(await f.mint()).json().grant,request={action:'reserve',request_id:'test-prediction',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)},reserved=await f.command(grant,request);assert.equal(reserved.statusCode,200,reserved.body);const first=reserved.json();assert.equal(first.fresh,true);const replay=await f.command(grant,request);assert.equal(replay.json().fresh,false);assert.equal(replay.json().receipt.attempt_id,first.receipt.attempt_id);const dispatched=await f.command(grant,{action:'dispatch',attempt_id:first.receipt.attempt_id});assert.equal(dispatched.statusCode,200,dispatched.body);assert.equal(dispatched.json().receipt.state,'settled');assert.equal(dispatched.json().receipt.actual.tokens,null);assert.notEqual((await f.command(grant,{action:'dispatch',attempt_id:first.receipt.attempt_id})).statusCode,200);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.nano_usd,'7');assert.notEqual((await f.command(grant,{...request,request_hash:'c'.repeat(64)})).statusCode,200);assert.notEqual((await f.command(grant,{...request,request_id:'bad-provider',provider:'fixture'})).statusCode,200);});
test('replacement lease rejects new spends without refunding dispatched costs',async t=>{const f=await fixture(t),grant=(await f.mint()).json().grant,body={action:'reserve',request_id:'first',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)},first=(await f.command(grant,body)).json();assert.equal((await f.command(grant,{action:'dispatch',attempt_id:first.receipt.attempt_id})).statusCode,200);f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1').run();assert.notEqual((await f.command(grant,{...body,request_id:'second'})).statusCode,200);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');});
test('close releases only unsent holds, revokes future calls and preserves immutable authority',async t=>{const f=await fixture(t),grant=(await f.mint()).json().grant,body={action:'reserve',request_id:'pending',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)},reserved=await f.command(grant,body);assert.equal(reserved.statusCode,200);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).held.model_calls,'1');const close=()=>f.app.inject({method:'POST',url:'/internal/v1/workbench/web-budget-grant/close',headers:{authorization:'Bearer '+secret},payload:{run_id:f.run.run_id,session_ref:'test-web-session',call_id:f.identity.call_id}});assert.equal((await close()).statusCode,200);assert.equal((await close()).statusCode,200);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).held.model_calls,'0');assert.notEqual((await f.command(grant,{...body,request_id:'late'})).statusCode,200);assert.throws(()=>f.db.prepare("UPDATE wb_web_model_grants SET state='active'").run(),/web_budget_grant_immutable/);assert.throws(()=>f.db.prepare('DELETE FROM wb_web_model_attempts').run(),/web_budget_attempt_immutable/);});
test('token-metered sent attempts settle after role revocation; new invocation and foreign identity remain forbidden',async t=>{const tokenRoute={provider:'laya',model:'multilingual',revision:'test-token-web',context_window:100,max_output_tokens:10,rates:{input:1,output:2,cache_read:1,cache_write:1}},f=await fixture(t,[tokenRoute]),grant=(await f.mint()).json().grant,body={action:'reserve',request_id:'tokens',provider:'laya',model:'multilingual',request_hash:'b'.repeat(64)},first=await f.command(grant,body);assert.equal(first.statusCode,200,first.body);const attempt=first.json().receipt.attempt_id;assert.equal((await f.command(grant,{action:'dispatch',attempt_id:attempt})).json().receipt.state,'in_flight');f.workbench.updateAgent('alice',f.agent.agent_id,{expected_version:f.agent.version,status:'disabled'});assert.notEqual((await f.command(grant,{...body,request_id:'new'})).statusCode,200);const settled=await f.command(grant,{action:'settle',attempt_id:attempt,usage:{inputTokens:20,outputTokens:5,totalTokens:25}});assert.equal(settled.statusCode,200,settled.body);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.tokens,'25');assert.notEqual((await f.command(grant,{action:'settle',attempt_id:attempt,usage:{inputTokens:20,outputTokens:5,totalTokens:25},owner_id:'alice'})).statusCode,200);});
test('root quota exhaustion cannot be bypassed with new provider request ids or forged attempt ids',async t=>{const f=await fixture(t),grant=(await f.mint()).json().grant;for(let n=0;n<3;n++){const response=await f.command(grant,{action:'reserve',request_id:'test-predict-'+n,provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)});assert.equal(response.statusCode,200,response.body);assert.equal((await f.command(grant,{action:'dispatch',attempt_id:response.json().receipt.attempt_id})).statusCode,200);}assert.equal((await f.command(grant,{action:'reserve',request_id:'fourth',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)})).statusCode,429);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'3');assert.equal((await f.command(grant,{action:'settle',attempt_id:'another-attempt'})).statusCode,403);});
test('fixed grant expiry and changed native Session bindings reject spending without extending the ticket',async t=>{const f=await fixture(t);let clock=Date.now();const service=new WebDecisionBudgetService(f.db,{ledger:f.modelBudgets,secret,guard:(owner,run)=>createAuxiliaryRunGuard(f.db,f.workbench,f.persistentTasks,owner,run),now:()=>clock}),grant=service.mint('alice',f.run.run_id,'test-web-session','test-clock-call','universe_search','a'.repeat(64));clock+=300001;assert.throws(()=>service.command(grant.grant,{action:'reserve',request_id:'expired',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)}),/web_budget_grant_revoked/);assert.throws(()=>service.mint('alice',f.run.run_id,'test-web-session','test-clock-call','universe_search','a'.repeat(64)),/web_budget_grant_revoked/);const fresh=(await f.mint()).json().grant;f.db.prepare("UPDATE ga_harness_session_bindings SET session_id='test-replacement-session'").run();assert.notEqual((await f.command(fresh,{action:'reserve',request_id:'changed-session',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)})).statusCode,200);});
test('missing native call ids and coercible command fields cannot allocate authorization or quota',async t=>{const f=await fixture(t),{call_id,...missing}=f.identity;assert.equal((await f.mint(missing)).statusCode,422);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_web_model_grants').get().n,0);const grant=(await f.mint()).json().grant,body={action:'reserve',request_id:'test-types',provider:'openjev',model:'openjev',request_hash:'b'.repeat(64)};for(const request of [{...body,action:['reserve']},{...body,provider:['openjev']},{...body,run_id:f.run.run_id},{...body,session_ref:'test-web-session'}])assert.notEqual((await f.command(grant,request)).statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,0);});
