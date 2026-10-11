import test from 'node:test';import assert from 'node:assert/strict';
import {EmotionAdvisor} from '../../src/harness/emotion-advisor.ts';
import {ModelBudgetLedger} from '../../src/workbench/model-budget.ts';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';import {EventStore} from '../../src/events/event-store.ts';
import {buildServer} from '../../src/server.ts';
function fixture(transport){
 const db=openProductDatabase(':memory:');const c=new ConversationRepository(db).create('alice',{workspace_id:'main',model:{provider:'fixture',id:'aux'}});
 const run=new RunRepository(db,new EventStore(db)).enqueue(c.conversation_id,'alice',{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'task'}]});
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const ledger=new ModelBudgetLedger(db,{routes:['openjev','laya'].map(provider=>({provider,model:'aux',revision:'fixture-v1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:1}}))});
 const scope=ledger.createScope('alice','root',{tokens:500,nano_usd:5000,model_calls:5});ledger.bindRun('alice',run.run_id,[scope.scope_id]);
 const advisor=new EmotionAdvisor({JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'fixture',JOT_EMOTION_LAYA_TOKEN:'fixture',JOT_EMOTION_LAYA_URL:'http://127.0.0.1/fixture'},transport);
 const accounting={ledger,owner:'alice',runId:run.run_id,guard:()=>{},routes:Object.fromEntries(['openjev','laya'].map(provider=>[provider,{provider,model:'aux',readUsage:data=>data.usage}]))};
 const select=()=>advisor.select('alice|task|run','thinking','neutral','',undefined,accounting);
 return {db,ledger,scope,select,accounting};
}
const usage={inputTokens:10,outputTokens:2,totalTokens:12};
test('Jev and Laya use separate charged attempts; cached/coalesced polls add no cost',async()=>{
 let calls=0;const f=fixture(async()=>{
  calls++;assert.equal(f.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state='in_flight'").get().n,1);
  return new Response(JSON.stringify(calls===1?{answers:{emotion:{choice:'invalid',confidence:.9}},usage}:{status:'selected',provider:'laya',emotion_id:'03',ttl_ms:5500,usage}));
 });try{
  const values=await Promise.all(Array.from({length:8},()=>f.select()));assert.ok(values.every(value=>value.provider==='laya'));
  assert.equal(calls,2);await f.select();assert.equal(calls,2);
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'2');assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.nano_usd,'80');
 }finally{f.db.close();}
});
test('missing Jev usage is held unknown and Laya never executes outside the budget',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return new Response(JSON.stringify({answers:{emotion:{choice:'03',confidence:.9}}}));});try{
  assert.equal((await f.select()).status,'abstain');assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
 }finally{f.db.close();}
});
test('missing configured provider accounting never sends an unmetered request',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return new Response('{}');});try{
  f.accounting.routes={};assert.equal((await f.select()).status,'abstain');assert.equal(calls,0);
 }finally{f.db.close();}
});
test('revoked permissions prevent returning an earlier cached provider choice',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return new Response(JSON.stringify({answers:{emotion:{choice:'03',confidence:.9}},usage}));});try{
  assert.equal((await f.select()).status,'selected');
  f.accounting.guard=()=>{throw new Error('role_revoked');};
  assert.equal((await f.select()).status,'abstain');assert.equal(calls,1);
 }finally{f.db.close();}
});

test('HTTP role conversations resolve budget ownership on the server; idle interaction cannot bypass it',async()=>{
 let calls=0,replaceLease=false,activeRun='';const s=await buildServer({databasePath:':memory:',workspaces:['main'],workbenchRoot:'.test-tmp/emotion-budget-http',
  modelBudgetRoutes:[{provider:'openjev',model:'aux',revision:'fixture-v1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:1}}],
  emotion:{env:{JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'fixture'},transport:async()=>{calls++;if(replaceLease)s.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run(activeRun);return new Response(JSON.stringify({answers:{emotion:{choice:'03',confidence:.9}},usage}));},accountingRoutes:{openjev:{provider:'openjev',model:'aux',readUsage:data=>data.usage}}}
 });try{
  const a=s.workbench.createAgent('alice',{name:'Reader'});
  const response=await s.app.inject({method:'POST',url:`/v1/conversations/${a.conversation_id}/messages`,headers:{'x-user-id':'alice'},payload:{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'task'}]}});
  assert.equal(response.statusCode,202);const run=response.json().run_id;
  activeRun=run;
  s.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run);
  const scope=s.modelBudgets.createScope('alice','http-task',{tokens:500,nano_usd:5000,model_calls:5});s.modelBudgets.bindRun('alice',run,[scope.scope_id]);
  const get=extra=>s.app.inject({method:'GET',url:`/v1/conversations/${a.conversation_id}/emotion?${extra}`,headers:{'x-user-id':'alice'}});
  assert.equal((await get('run_id='+run)).json().status,'abstain');assert.equal(calls,0);
  s.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run,'worker-fixture',1,String(Date.now()+60000),new Date().toISOString());
  assert.equal((await get('run_id='+run)).json().status,'selected');assert.equal(calls,1);
  assert.equal(s.modelBudgets.balance('alice',scope.scope_id).used.model_calls,'1');
  replaceLease=true;
  assert.equal((await get('run_id='+run+'&interaction=click')).json().status,'abstain');assert.equal(calls,2);
  assert.equal(s.modelBudgets.balance('alice',scope.scope_id).used.model_calls,'2','sent call remains charged after lease takeover');
  replaceLease=false;
  s.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),run);
  assert.equal((await get('run_id='+run)).json().status,'abstain');assert.equal(calls,2);
  s.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(run);
  const unbound=s.runs.enqueue(a.conversation_id,'alice',{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'unbound run'}]});
  s.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(unbound.run_id);
  assert.equal((await get('run_id='+unbound.run_id)).json().status,'abstain');assert.equal(calls,2);
  assert.equal((await get('interaction=idle')).json().status,'abstain');assert.equal(calls,2);
 }finally{await s.app.close();s.db.close();}
});

test('explicit call-policy routes configure the HTTP emotion provider without inventing a usage adapter',async()=>{
 let calls=0;const s=await buildServer({databasePath:':memory:',workspaces:['main'],workbenchRoot:'.test-tmp/emotion-call-http',
  modelBudgetRoutes:[{provider:'openjev',model:'openjev',revision:'call-fixture-v1',context_window:100,max_output_tokens:20,rates:{input:0,output:0,cache_read:0,cache_write:0},billing:{unit:'dispatched_call',nano_usd:0}}],
  emotion:{env:{JOT_EMOTION_PROVIDER:'openjev',OPENJEV_API_KEY:'fixture'},transport:async()=>{calls++;return new Response(JSON.stringify({answers:{emotion:{choice:'03',confidence:.9}}}));}}
 });try{
  const agent=s.workbench.createAgent('alice',{name:'Call-metered role'});
  const response=await s.app.inject({method:'POST',url:`/v1/conversations/${agent.conversation_id}/messages`,headers:{'x-user-id':'alice'},payload:{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'hello'}]}});
  assert.equal(response.statusCode,202);const run=response.json().run_id;s.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run);
  const scope=s.modelBudgets.createScope('alice','call-only',{tokens:0,nano_usd:0,model_calls:1});s.modelBudgets.bindRun('alice',run,[scope.scope_id]);
  s.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run,'fixture',1,String(Date.now()+60000),new Date().toISOString());
  const result=await s.app.inject({method:'GET',url:`/v1/conversations/${agent.conversation_id}/emotion?run_id=${run}`,headers:{'x-user-id':'alice'}});
  assert.equal(result.json().status,'selected');assert.equal(calls,1);
  const row=s.db.prepare('SELECT state,actual_tokens,actual_nano_usd FROM wb_model_budget_attempts').get();
  assert.equal(row.state,'settled');assert.equal(row.actual_tokens,null);assert.equal(row.actual_nano_usd,'0');
  assert.equal(s.modelBudgets.balance('alice',scope.scope_id).used.model_calls,'1');
 }finally{await s.app.close();s.db.close();}
});
