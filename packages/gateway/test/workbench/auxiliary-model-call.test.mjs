import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {ModelBudgetLedger} from '../../src/workbench/model-budget.ts';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {resolve,join} from 'node:path';import {spawnSync} from 'node:child_process';

const route={provider:'fixture',model:'aux-model',revision:'v1',context_window:100,max_output_tokens:20,
 rates:{input:2,output:10,cache_read:1,cache_write:3}};
const usage={inputTokens:20,outputTokens:5,totalTokens:25};
async function fixture(database=':memory:'){
 const mod=await import('../../src/workbench/auxiliary-model-call.ts').catch(()=>({}));
 assert.equal(typeof mod.runBudgetedAuxiliaryCall,'function');
 const db=openProductDatabase(database);const conversations=new ConversationRepository(db);
 const runs=new RunRepository(db,new EventStore(db));
 const c=conversations.create('alice',{workspace_id:'main',model:{provider:'fixture',id:'aux-model'}});
 const run=runs.enqueue(c.conversation_id,'alice',{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'fixture'}]});
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const ledger=new ModelBudgetLedger(db,{routes:[route]});const scope=ledger.createScope('alice','task',{tokens:300,nano_usd:3000,model_calls:3});
 ledger.bindRun('alice',run.run_id,[scope.scope_id]);
 const call=(invoke,extra={})=>mod.runBudgetedAuxiliaryCall({ledger,owner:'alice',runId:run.run_id,route:{provider:'fixture',model:'aux-model'},purpose:'emotion',guard:()=>{},invoke,...extra});
 return {db,ledger,scope,run:run.run_id,call};
}

test('auxiliary invocation is dispatched before provider access and settles in the original root budget',async()=>{
 const f=await fixture();try{
  const result=await f.call(async()=>{
   assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'in_flight');
   return {value:{emotion_id:'03'},usage};
  });
  assert.deepEqual(result.value,{emotion_id:'03'});assert.equal(result.receipt.state,'settled');
  assert.equal(result.receipt.actual.nano_usd,'90');assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'1');
  assert.equal(JSON.parse(f.db.prepare('SELECT request_json FROM wb_model_budget_attempts').get().request_json).purpose,'emotion');
 }finally{f.db.close();}
});

test('missing usage or failed provider retains an unknown hold and blocks an uncharged fallback',async()=>{
 for(const mode of ['missing','invalid','throw']){
  const f=await fixture();try{
   await assert.rejects(f.call(async()=>{if(mode==='throw')throw new Error('private provider detail');return {value:'selected',usage:mode==='invalid'?{inputTokens:-1}:undefined};}),/auxiliary_usage_unknown/);
   const row=f.db.prepare('SELECT state,held_tokens,actual_tokens FROM wb_model_budget_attempts').get();
   assert.equal(row.state,'unknown');assert.equal(row.held_tokens,'100');assert.equal(row.actual_tokens,null);
   let called=false;await assert.rejects(f.call(async()=>{called=true;return {value:'fallback',usage};}),/budget_usage_unknown/);assert.equal(called,false);
  }finally{f.db.close();}
 }
});

test('permission revoked before dispatch releases only the unsent reservation',async()=>{
 const f=await fixture();try{
  let checks=0,called=false;
  await assert.rejects(f.call(async()=>{called=true;return {value:'x',usage};},{guard:()=>{if(++checks===2)throw new Error('role_revoked');}}),/role_revoked/);
  assert.equal(called,false);assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'released');
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).held.model_calls,'0');
 }finally{f.db.close();}
});

test('already sent use settles after cancellation and preserves the cost of separate fallback attempts',async()=>{
 const f=await fixture();try{
  const first=await f.call(async()=>({value:null,usage}));
  const second=await f.call(async()=>{f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(f.run);return {value:'fallback',usage};},{purpose:'web-decision'});
  assert.notEqual(first.receipt.attempt_id,second.receipt.attempt_id);assert.equal(second.receipt.state,'settled');
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.nano_usd,'180');assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'2');
 }finally{f.db.close();}
});

test('a settled provider overrun stays charged and cannot be returned as an accepted result',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.call(async()=>({value:'selected',usage:{inputTokens:80,outputTokens:30,totalTokens:110}})),/model_budget_exhausted/);
  const row=f.db.prepare('SELECT state,bound_exceeded,actual_tokens FROM wb_model_budget_attempts').get();
  assert.equal(row.state,'settled');assert.equal(row.bound_exceeded,1);assert.equal(row.actual_tokens,'110');
 }finally{f.db.close();}
});

test('revocation during a sent call settles costs but prevents delivering its decision',async()=>{
 const f=await fixture();try{
  let revoked=false;
  await assert.rejects(f.call(async()=>{revoked=true;return {value:'decision',usage};},{guard:()=>{if(revoked)throw new Error('role_revoked');}}),/role_revoked/);
  assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.nano_usd,'90');
 }finally{f.db.close();}
});

test('actual auxiliary calls retain root-bound process observations without inventing GPU or provider usage',async()=>{
 const f=await fixture();try{await f.call(async()=>{const end=performance.now()+30;while(performance.now()<end){}return {value:'observed',usage};},{purpose:'web-decision'});const report=f.ledger.resourceReport('alice',f.run);assert.equal(report.items.length,1);const row=report.items[0];assert.equal(row.state,'complete');assert.equal(row.outcome,'succeeded');assert.equal(row.measurement.source,'gateway_process_interval');assert.equal(row.measurement.attribution,'shared_process_interval');assert.ok(row.measurement.wall_ms>=20);assert.ok(row.measurement.cpu_user_us+row.measurement.cpu_system_us>0);assert.ok(row.measurement.rss_end_bytes>0);assert.equal(row.measurement.gpu,null);assert.equal(row.measurement.remote_inference,null);assert.throws(()=>f.ledger.resourceReport('bob',f.run));assert.throws(()=>f.db.prepare('UPDATE wb_host_resource_observations SET measurement_json=?').run('{}'),/host_resource_immutable/);assert.throws(()=>f.db.prepare('DELETE FROM wb_host_resource_observations').run(),/host_resource_immutable/);}finally{f.db.close();}
});
test('failed provider still records an observed interval while model usage remains unknown and held',async()=>{
 const f=await fixture();try{await assert.rejects(f.call(async()=>{throw new Error('private provider detail');}),/auxiliary_usage_unknown/);const report=f.ledger.resourceReport('alice',f.run);assert.equal(report.items[0].outcome,'failed');assert.equal(JSON.stringify(report).includes('private provider detail'),false);assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');assert.equal(f.ledger.balance('alice',f.scope.scope_id).held.model_calls,'1');}finally{f.db.close();}
});
test('observation storage failure retains valid provider accounting without repetition or fabricated resource facts',async()=>{
 const f=await fixture();try{f.db.exec("CREATE TRIGGER fail_resource_store BEFORE UPDATE ON wb_host_resource_observations BEGIN SELECT RAISE(ABORT,'test_resource_store_failed'); END;");let calls=0;const response=await f.call(async()=>{calls++;return {value:'selected',usage};});assert.equal(response.value,'selected');assert.equal(calls,1);const row=f.ledger.resourceReport('alice',f.run).items[0];assert.equal(row.state,'pending');assert.equal(row.measurement,null);assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.nano_usd,'90');}finally{f.db.close();}
});
test('administrator resource report is read-only, owner scoped and never repeats a provider request',async()=>{
 const base=resolve('../../.test-tmp/host-resources');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),file=join(root,'product.sqlite'),f=await fixture(file);try{let calls=0;await f.call(async()=>{calls++;return {value:'private fixture output',usage};});const before=f.db.prepare('SELECT count(*) n FROM wb_host_resource_observations').get().n;const run=owner=>spawnSync(process.execPath,['src/workbench/resource-report-main.ts',file,owner,f.run],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});const reply=run('alice');assert.equal(reply.status,0,reply.stderr);assert.equal(JSON.parse(reply.stdout).items.length,1);assert.equal(reply.stdout.includes('private fixture output'),false);assert.equal(reply.stdout.includes(file),false);const denied=run('bob');assert.equal(denied.status,1);assert.equal(denied.stdout,'');assert.equal(denied.stderr.trim(),'host_resource_report_unavailable');assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_host_resource_observations').get().n,before);}finally{f.db.close();rmSync(root,{recursive:true,force:true});}
});
test('dispatch runs the authority fence inside its transaction and a rejected fence leaves the reservation unsent',async()=>{
 const f=await fixture();try{
  f.ledger.reserve('alice',f.run,{attempt_id:'guarded-dispatch',provider:'fixture',model:'aux-model',purpose:'emotion'});
  assert.throws(()=>f.ledger.dispatch('alice',f.run,'guarded-dispatch',()=>{assert.equal(f.db.isTransaction,true);throw new Error('lease_revoked');}),/lease_revoked/);
  assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'reserved');
 }finally{f.db.close();}
});
