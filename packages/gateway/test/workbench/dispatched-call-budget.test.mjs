import test from 'node:test';import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';import {EventStore} from '../../src/events/event-store.ts';
import {ModelBudgetLedger,normalizeModelBudgetRoutes} from '../../src/workbench/model-budget.ts';
import {runBudgetedAuxiliaryCall} from '../../src/workbench/auxiliary-model-call.ts';
const route={provider:'fixture',model:'decision',revision:'call-v1',context_window:100,max_output_tokens:20,
 rates:{input:0,output:0,cache_read:0,cache_write:0},billing:{unit:'dispatched_call',nano_usd:7}};
function fixture(routes=[route]){
 const db=openProductDatabase(':memory:');const c=new ConversationRepository(db).create('alice',{workspace_id:'main',model:{provider:'fixture',id:'decision'}});
 const r=new RunRepository(db,new EventStore(db)).enqueue(c.conversation_id,'alice',{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'fixture'}]});
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);
 const ledger=new ModelBudgetLedger(db,{routes});const scope=ledger.createScope('alice','root',{tokens:0,nano_usd:14,model_calls:2});ledger.bindRun('alice',r.run_id,[scope.scope_id]);
 return {db,ledger,run:r.run_id,scope,request:id=>({attempt_id:id,provider:'fixture',model:'decision',purpose:'emotion'}),call:invoke=>runBudgetedAuxiliaryCall({ledger,owner:'alice',runId:r.run_id,route:{provider:'fixture',model:'decision'},purpose:'emotion',guard:()=>{},invoke})};
}
test('explicit dispatched-call policy charges calls and configured cost without fabricating token use',async()=>{
 const f=fixture();try{
  const result=await f.call(async()=>({value:'selected',usage:undefined}));
  assert.equal(result.receipt.state,'settled');assert.equal(result.receipt.metering,'dispatched_call');assert.equal(result.receipt.actual.tokens,null);assert.equal(result.receipt.actual.nano_usd,'7');
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'1');
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).held.model_calls,'0');
 }finally{f.db.close();}
});
test('failed attempted dispatch is charged once and a later attempt still obeys the root call cap',async()=>{
 const f=fixture();try{
  await assert.rejects(f.call(async()=>{throw new Error('private error');}),/auxiliary_provider_failed/);
  assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');
  await f.call(async()=>({value:'fallback',usage:undefined}));
  let called=false;await assert.rejects(f.call(async()=>{called=true;return {value:'extra',usage:undefined};}),/model_budget_exhausted/);assert.equal(called,false);
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.nano_usd,'14');
 }finally{f.db.close();}
});
test('frozen configured call price survives restart/config changes and settlement is idempotent',()=>{
 const f=fixture();try{
  f.ledger.reserve('alice',f.run,f.request('a'));f.ledger.dispatch('alice',f.run,'a');
  const changed=new ModelBudgetLedger(f.db,{routes:[{...route,revision:'call-v2',billing:{...route.billing,nano_usd:99}}]});
  const receipt=changed.settleDispatchedCall('alice',f.run,'a');assert.equal(receipt.actual.nano_usd,'7');assert.equal(receipt.pricing_revision,'call-v1');
  assert.deepEqual(changed.settleDispatchedCall('alice',f.run,'a'),receipt);
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'1');
 }finally{f.db.close();}
});
test('call metering is explicit, auxiliary-only, and cannot be used as a token-usage assertion',()=>{
 for(const billing of [{unit:'token',nano_usd:1},{unit:'dispatched_call',nano_usd:-1},{unit:'dispatched_call',nano_usd:1,extra:true}])assert.throws(()=>normalizeModelBudgetRoutes([{...route,billing}]),/budget_route_invalid/);
 const f=fixture();try{
  assert.throws(()=>f.ledger.reserve('alice',f.run,{attempt_id:'main',provider:'fixture',model:'decision'}),/budget_request_invalid/);
  f.ledger.reserve('alice',f.run,f.request('a'));f.ledger.dispatch('alice',f.run,'a');
  assert.throws(()=>f.ledger.settle('alice',f.run,'a',{inputTokens:0,outputTokens:0,totalTokens:0}),/budget_usage_invalid/);
 }finally{f.db.close();}
});
test('maintenance reconciles a committed dispatch after a crash without calling a provider or double charging',()=>{
 const f=fixture();try{
  f.ledger.reserve('alice',f.run,f.request('crashed'));f.ledger.dispatch('alice',f.run,'crashed');
  f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(f.run);
  assert.deepEqual(f.ledger.reconcileDispatchedCalls(),{settled:1});
  assert.deepEqual(f.ledger.reconcileDispatchedCalls(),{settled:0});
  assert.equal(f.ledger.balance('alice',f.scope.scope_id).used.model_calls,'1');
  assert.equal(f.db.prepare('SELECT actual_tokens,state FROM wb_model_budget_attempts').get().actual_tokens,null);
 }finally{f.db.close();}
});
