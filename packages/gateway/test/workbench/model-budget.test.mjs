import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { openProductDatabase } from '../../src/db/database.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { EventStore } from '../../src/events/event-store.ts';

const route = {provider:'fixture',model:'bounded-model',revision:'rates-v1',context_window:100,
  max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
const moduleUrl = new URL('../../src/workbench/model-budget.ts',import.meta.url);
async function fixture(path=':memory:',routes=[route]) {
  const mod=await import(moduleUrl.href).catch(()=>({}));
  assert.equal(typeof mod.ModelBudgetLedger,'function','authoritative model budget ledger must exist');
  const db=openProductDatabase(path),conversations=new ConversationRepository(db),runs=new RunRepository(db,new EventStore(db));
  let now=new Date('2026-10-02T00:00:00Z');
  const ledger=new mod.ModelBudgetLedger(db,{routes,now:()=>now});
  const run=(owner='alice')=>{const c=conversations.create(owner,{workspace_id:'main',model:{provider:'fixture',model:'bounded-model'}});
    const r=runs.enqueue(c.conversation_id,owner,{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'Controlled task'}]});
    db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);return r.run_id;};
  const scope=(key='root',tokens=500,nano_usd=5000,model_calls=5)=>ledger.createScope('alice',key,{tokens,nano_usd,model_calls});
  const request=(attempt_id='attempt-1')=>({attempt_id,provider:route.provider,model:route.model,max_tokens:20});
  return {db,ledger,run,scope,request,now:value=>{now=new Date(value);},close:()=>db.close()};
}
const usage={inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40,reasoningTokens:2};

test('the ledger accepts budgeted memory reasoning while rejecting unregistered purposes',async()=>{
 const billed={...route,rates:{input:0,output:0,cache_read:0,cache_write:0},billing:{unit:'dispatched_call',nano_usd:25}};
 const f=await fixture(':memory:',[billed]);try{
  const scope=f.scope('memory-reasoning',500,5000,5),run=f.run();f.ledger.bindRun('alice',run,[scope.scope_id]);
  const reservation=f.ledger.reserve('alice',run,{...f.request('memory-reasoning'),purpose:'memory-reasoning'});
  assert.equal(reservation.metering,'dispatched_call');
  assert.throws(()=>f.ledger.reserve('alice',run,{...f.request('invalid-purpose'),purpose:'invalid-purpose'}),/budget_request_invalid/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
 }finally{f.close();}
});

test('step preview credits only the matching queued admission without releasing it or charging a call',async()=>{
 const f=await fixture(':memory:',[route,{...route,model:'other-model'}]);try{
  const scope=f.scope('first-call',100,1000,1),run=f.run();f.ledger.bindRun('alice',run,[scope.scope_id]);
  f.ledger.admitRun('alice',run,{provider:route.provider,model:route.model});
  const snapshot=()=>({balances:f.ledger.balancesForRun('alice',run),attempts:f.db.prepare('SELECT * FROM wb_model_budget_attempts').all(),events:f.db.prepare('SELECT * FROM wb_model_budget_events').all()});
  const before=snapshot();
  const preview=f.ledger.previewCall('alice',run,{provider:route.provider,model:route.model});
  assert.deepEqual(preview,{provider:'fixture',model:'bounded-model',pricing_revision:'rates-v1',
   reserved:{tokens:'100',nano_usd:'1000',model_calls:'1'},queue_credit:{tokens:'100',nano_usd:'1000',model_calls:'1'}});
  assert.deepEqual(snapshot(),before,'a preliminary check must not consume, free or journal a reservation');
  assert.throws(()=>f.ledger.previewCall('alice',run,{provider:'fixture',model:'other-model'}),/model_budget_exhausted/);
  assert.deepEqual(snapshot(),before);
  f.ledger.reserve('alice',run,f.request('actual-call'));f.ledger.dispatch('alice',run,'actual-call');
  assert.throws(()=>f.ledger.previewCall('alice',run,{provider:route.provider,model:route.model}),/budget_usage_pending/);
  f.ledger.settle('alice',run,'actual-call',usage);
  assert.throws(()=>f.ledger.previewCall('alice',run,{provider:route.provider,model:route.model}),/model_budget_exhausted/);
 }finally{f.close();}
});

test('step preview intersects live shared budgets and never turns an earlier positive check into a spending grant',async()=>{
 const f=await fixture();try{
  const scope=f.scope('shared',150,5000,5),a=f.run(),b=f.run();
  for(const run of [a,b])f.ledger.bindRun('alice',run,[scope.scope_id]);
  f.ledger.previewCall('alice',a,{provider:route.provider,model:route.model});
  f.ledger.reserve('alice',b,f.request('busy-member'));
  assert.throws(()=>f.ledger.previewCall('alice',a,{provider:route.provider,model:route.model}),/model_budget_exhausted/);
  assert.throws(()=>f.ledger.reserve('alice',a,f.request('late-attempt')),/model_budget_exhausted/);
  assert.equal(f.ledger.balance('alice',scope.scope_id).held.tokens,'100');
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
  assert.throws(()=>f.ledger.previewCall('bob',a,{provider:route.provider,model:route.model}),/budget_run_not_found/);
 }finally{f.close();}
});

test('step preview refuses unknown accounting, closed windows, inactive runs and forged route options',async()=>{
 const f=await fixture();try{
  const scope=f.ledger.createScope('alice','window',{tokens:500,nano_usd:5000,model_calls:5},{starts_at:'2026-10-02T00:00:00Z',ends_at:'2026-10-03T00:00:00Z'}),run=f.run();
  f.ledger.bindRun('alice',run,[scope.scope_id]);const hint={provider:route.provider,model:route.model};
  for(const invalid of [{...hint,attempt_id:'queue-admission'},{...hint,owner_id:'alice'},{...hint,max_tokens:21},{provider:'',model:route.model}])
   assert.throws(()=>f.ledger.previewCall('alice',run,invalid),/budget_request_invalid/);
  assert.throws(()=>f.ledger.previewCall('alice',run,{...hint,model:'unconfigured'}),/budget_route_unavailable/);
  f.ledger.reserve('alice',run,f.request());f.ledger.dispatch('alice',run,'attempt-1');f.ledger.markUnknown('alice',run,'attempt-1','usage_incomplete');
  assert.throws(()=>f.ledger.previewCall('alice',run,hint),/budget_usage_unknown/);
  f.ledger.settle('alice',run,'attempt-1',usage);f.now('2026-10-03T00:00:00Z');
  assert.throws(()=>f.ledger.previewCall('alice',run,hint),/budget_window_closed/);
  f.now('2026-10-02T00:00:00Z');f.db.prepare("UPDATE ga_runs SET status='waiting_user' WHERE id=?").run(run);
  assert.throws(()=>f.ledger.previewCall('alice',run,hint),/budget_run_inactive/);
 }finally{f.close();}
});

test('root, member and thread share atomic reservations and exact cache-aware settlement',async()=>{
  const f=await fixture();try{
    const root=f.scope(),member=f.scope('member',200,2000,2),thread=f.scope('thread',100,1000,1),r=f.run();
    f.ledger.bindRun('alice',r,[root.scope_id,member.scope_id,thread.scope_id]);
    const hold=f.ledger.reserve('alice',r,f.request());assert.equal(hold.state,'reserved');
    for(const s of [root,member,thread])assert.deepEqual(f.ledger.balance('alice',s.scope_id).held,{tokens:'100',nano_usd:'1000',model_calls:'1'});
    f.ledger.dispatch('alice',r,'attempt-1');
    const settled=f.ledger.settle('alice',r,'attempt-1',usage);assert.equal(settled.state,'settled');assert.equal(settled.cost_basis,'configured_rates');
    for(const s of [root,member,thread]){const b=f.ledger.balance('alice',s.scope_id);assert.deepEqual(b.used,{tokens:'40',nano_usd:'115',model_calls:'1'});assert.equal(b.held.tokens,'0');}
  }finally{f.close();}
});

test('busy members cannot each receive the full root budget and failures roll back every scope',async()=>{
  const f=await fixture();try{
    const root=f.scope('root',150),member=f.scope('member'),a=f.run(),b=f.run();
    f.ledger.bindRun('alice',a,[root.scope_id,member.scope_id]);f.ledger.bindRun('alice',b,[root.scope_id]);
    f.ledger.reserve('alice',a,f.request('a'));
    assert.throws(()=>f.ledger.reserve('alice',b,f.request('b')),/model_budget_exhausted/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
    assert.equal(f.ledger.balance('alice',root.scope_id).held.tokens,'100');
    f.db.exec("CREATE TRIGGER fixture_budget_fail BEFORE INSERT ON wb_model_budget_attempts WHEN NEW.attempt_id='rollback' BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END;");
    f.ledger.releaseUndispatched('alice',a,'a');
    assert.throws(()=>f.ledger.reserve('alice',a,f.request('rollback')),/fixture transaction failure/);
    assert.equal(f.ledger.balance('alice',member.scope_id).held.tokens,'0');
    assert.equal(f.ledger.balance('alice',root.scope_id).held.nano_usd,'0');
  }finally{f.close();}
});

test('token, configured cost and model-attempt caps independently gate dispatch',async()=>{
  const f=await fixture();try{
    for(const [key,tokens,cost,calls] of [['tokens',99,5000,5],['cost',500,999,5],['calls',500,5000,0]]){
      const s=f.scope(key,tokens,cost,calls),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);
      assert.throws(()=>f.ledger.reserve('alice',r,f.request()),/model_budget_exhausted/);
      assert.equal(f.ledger.balance('alice',s.scope_id).held.model_calls,'0');
    }
  }finally{f.close();}
});

test('attempt retries are idempotent; dispatch has one winner and changed receipts cannot replace actual spend',async()=>{
  const f=await fixture();try{
    const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);
    const a=f.ledger.reserve('alice',r,f.request());assert.deepEqual(f.ledger.reserve('alice',r,f.request()),a);
    assert.throws(()=>f.ledger.reserve('alice',r,{...f.request(),max_tokens:19}),/budget_attempt_conflict/);
    f.ledger.dispatch('alice',r,'attempt-1');assert.throws(()=>f.ledger.dispatch('alice',r,'attempt-1'),/budget_dispatch_conflict/);
    const receipt=f.ledger.settle('alice',r,'attempt-1',usage);assert.deepEqual(f.ledger.settle('alice',r,'attempt-1',{...usage}),receipt);
    assert.throws(()=>f.ledger.settle('alice',r,'attempt-1',{...usage,inputTokens:21,totalTokens:41}),/budget_settlement_conflict/);
    assert.equal(f.ledger.balance('alice',s.scope_id).used.model_calls,'1');
    const retry=f.ledger.reserve('alice',r,f.request('retry'));assert.equal(retry.state,'reserved');
    assert.equal(f.ledger.balance('alice',s.scope_id).held.model_calls,'1');
  }finally{f.close();}
});

test('unknown streaming cost retains all holds through cancellation and blocks speculative retry',async()=>{
  const f=await fixture();try{
    const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request());f.ledger.dispatch('alice',r,'attempt-1');
    f.ledger.markUnknown('alice',r,'attempt-1','stream_incomplete');
    f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(r);
    assert.throws(()=>f.ledger.releaseUndispatched('alice',r,'attempt-1'),/budget_dispatch_conflict/);
    assert.equal(f.ledger.balance('alice',s.scope_id).held.nano_usd,'1000');
    assert.throws(()=>f.ledger.reserve('alice',r,f.request('retry')),/budget_run_inactive|budget_usage_unknown/);
    f.ledger.settle('alice',r,'attempt-1',usage);
    assert.equal(f.ledger.balance('alice',s.scope_id).used.tokens,'40','spent calls must still settle after cancellation');
  }finally{f.close();}
});

test('missing cache accounting is unknown, malformed counters cannot free capacity, reasoning is not double charged',async()=>{
  const f=await fixture();try{
    const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request());f.ledger.dispatch('alice',r,'attempt-1');
    for(const malformed of [{...usage,totalTokens:39},{...usage,reasoningTokens:6},{...usage,inputTokens:-1},{...usage,outputTokens:0.5},{...usage,outputTokens:Number.MAX_SAFE_INTEGER}]){
      assert.throws(()=>f.ledger.settle('alice',r,'attempt-1',malformed),/budget_usage_invalid/);
      assert.equal(f.ledger.balance('alice',s.scope_id).held.tokens,'100');
    }
    const incomplete=f.ledger.settle('alice',r,'attempt-1',{inputTokens:20,outputTokens:5,totalTokens:40});
    assert.equal(incomplete.state,'unknown');assert.equal(f.ledger.balance('alice',s.scope_id).held.nano_usd,'1000');
    assert.throws(()=>f.ledger.reserve('alice',r,f.request('retry')),/budget_usage_unknown/);
    f.ledger.settle('alice',r,'attempt-1',usage);assert.equal(f.ledger.balance('alice',s.scope_id).used.tokens,'40');
  }finally{f.close();}
});

test('zero cache can be proven by authoritative total; nonzero unknown caches cannot be guessed',async()=>{
  const f=await fixture();try{
    const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request());f.ledger.dispatch('alice',r,'attempt-1');
    assert.equal(f.ledger.settle('alice',r,'attempt-1',{inputTokens:20,outputTokens:5,totalTokens:25}).state,'settled');
    assert.equal(f.ledger.balance('alice',s.scope_id).used.nano_usd,'90');
  }finally{f.close();}
});

test('folded unreported cache writes preserve settlement cost but stay unknown in public token buckets',async()=>{
  const equalRateRoute={...route,rates:{...route.rates,cache_write:route.rates.input}},f=await fixture(':memory:',[equalRateRoute]);try{
    const taskKey='task-total:folded-cache-write',s=f.scope(taskKey,1000,5000,2),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);
    const evidence={protocol:1,source:'reply-judge-client',cacheWrite:'folded-unreported'};
    f.ledger.reserve('alice',r,{...f.request('folded-write'),purpose:'reply-verification'});f.ledger.dispatch('alice',r,'folded-write');
    const receipt=f.ledger.settle('alice',r,'folded-write',{inputTokens:80,outputTokens:20,totalTokens:120,cacheReadTokens:20,cacheWriteTokens:0,reasoningTokens:5},evidence);
    assert.equal(receipt.state,'settled');assert.equal(f.ledger.balance('alice',s.scope_id).used.tokens,'120');assert.equal(f.ledger.balance('alice',s.scope_id).used.nano_usd,'380');
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT usage_json FROM wb_model_budget_attempts WHERE attempt_id=?').get('folded-write').usage_json),{
      inputTokens:'80',outputTokens:'20',cacheReadTokens:'20',cacheWriteTokens:'0',totalTokens:'120',reasoningTokens:'5',
      usageEvidence:{protocol:1,source:'reply-judge-client',cacheWrite:'folded-unreported'}
    });
    const page=f.ledger.listTaskAttempts('alice',taskKey);assert.equal(page.items[0].state,'settled');
    assert.deepEqual(page.items[0].settled,{tokens:'120',nano_usd:'380',model_calls:'1'});
    assert.deepEqual(page.items[0].usage,{status:'settled',input_tokens:null,output_tokens:'20',cache_read_tokens:'20',cache_write_tokens:null,reasoning_tokens:'5',total_tokens:'120'});
    assert.deepEqual(f.ledger.settle('alice',r,'folded-write',{inputTokens:80,outputTokens:20,totalTokens:120,cacheReadTokens:20,cacheWriteTokens:0,reasoningTokens:5},evidence),receipt);
  }finally{f.close();}
});

test('reported zero cache writes remain zero while ambiguous legacy same-rate folds are not rewritten',async()=>{
  const equalRateRoute={...route,rates:{...route.rates,cache_write:route.rates.input}},f=await fixture(':memory:',[equalRateRoute]);try{
    const taskKey='task-total:cache-zero',s=f.scope(taskKey,1000,5000,3),reportedRun=f.run(),legacyRun=f.run();
    f.ledger.bindRun('alice',reportedRun,[s.scope_id]);f.ledger.bindRun('alice',legacyRun,[s.scope_id]);
    const actual={inputTokens:80,outputTokens:20,totalTokens:120,cacheReadTokens:20,cacheWriteTokens:0};
    f.ledger.reserve('alice',reportedRun,{...f.request('reported-zero'),purpose:'reply-verification'});f.ledger.dispatch('alice',reportedRun,'reported-zero');
    f.ledger.settle('alice',reportedRun,'reported-zero',actual,{protocol:1,source:'reply-judge-client',cacheWrite:'reported'});
    f.ledger.reserve('alice',legacyRun,{...f.request('legacy-fold'),purpose:'reply-verification'});f.ledger.dispatch('alice',legacyRun,'legacy-fold');
    f.ledger.settle('alice',legacyRun,'legacy-fold',actual);
    const usages=f.ledger.listTaskAttempts('alice',taskKey).items.map(row=>row.usage);
    assert.deepEqual(usages.find(value=>value.cache_write_tokens==='0'),{status:'settled',input_tokens:'80',output_tokens:'20',cache_read_tokens:'20',cache_write_tokens:'0',reasoning_tokens:null,total_tokens:'120'});
    assert.deepEqual(usages.find(value=>value.cache_write_tokens===null),{status:'settled',input_tokens:null,output_tokens:'20',cache_read_tokens:'20',cache_write_tokens:null,reasoning_tokens:null,total_tokens:'120'});
    assert.equal(f.db.prepare("SELECT usage_json FROM wb_model_budget_attempts WHERE attempt_id='legacy-fold'").get().usage_json.includes('usageEvidence'),false,'legacy journal bytes stay unchanged');
    assert.equal(f.ledger.balance('alice',s.scope_id).used.nano_usd,'760');
  }finally{f.close();}
});

test('folded cache-write evidence is accepted only from reply-judge settlement and only in its exact form',async()=>{
  for(const [purpose,evidence] of [
    ['emotion',{protocol:1,source:'reply-judge-client',cacheWrite:'folded-unreported'}],
    ['reply-verification',{protocol:1,source:'provider',cacheWrite:'folded-unreported'}],
    ['reply-verification',{protocol:1,source:'reply-judge-client',cacheWrite:'reported-zero'}],
    ['reply-verification',{protocol:1,source:'reply-judge-client',cacheWrite:'folded-unreported',extra:true}]
  ]){
    const f=await fixture();try{
      const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,{...f.request('invalid-evidence'),purpose});f.ledger.dispatch('alice',r,'invalid-evidence');
      assert.throws(()=>f.ledger.settle('alice',r,'invalid-evidence',{inputTokens:20,outputTokens:5,totalTokens:25,cacheReadTokens:0,cacheWriteTokens:0},evidence),/budget_usage_invalid/);
      assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE attempt_id=?').get('invalid-evidence').state,'in_flight');
    }finally{f.close();}
  }
});

test('routes, request limits, identities and binding boundaries cannot come from model-controlled fields',async()=>{
  const f=await fixture();try{
    const s=f.scope(),r=f.run(),foreign=f.run('bob');
    assert.throws(()=>f.ledger.bindRun('bob',r,[s.scope_id]),/budget_run_not_found/);
    assert.throws(()=>f.ledger.bindRun('alice',foreign,[s.scope_id]),/budget_run_not_found/);
    assert.throws(()=>f.ledger.bindRun('bob',foreign,[s.scope_id]),/budget_scope_not_found/);
    f.ledger.bindRun('alice',r,[s.scope_id]);
    assert.throws(()=>f.ledger.bindRun('alice',r,[f.scope('other').scope_id]),/budget_binding_conflict/);
    for(const request of [{...f.request(),model:'unpriced'},{...f.request(),max_tokens:21},{...f.request(),rates:{output:0}},{...f.request(),scope_id:'fake'}])
      assert.throws(()=>f.ledger.reserve('alice',r,request),/budget_route_unavailable|budget_request_invalid/);
    assert.throws(()=>f.ledger.reserve('bob',r,f.request()),/budget_run_not_found/);
    assert.throws(()=>f.ledger.balance('bob',s.scope_id),/budget_scope_not_found/);
    assert.throws(()=>f.scope('root',501),/budget_scope_conflict/);
    assert.throws(()=>f.ledger.bindRun('alice',f.run(),[]),/budget_binding_invalid/);
  }finally{f.close();}
});

test('expired windows deny new reservations but never forgive earlier dispatched cost',async()=>{
  const f=await fixture();try{
    const s=f.ledger.createScope('alice','day',{tokens:500,nano_usd:5000,model_calls:5},{starts_at:'2026-10-02T00:00:00Z',ends_at:'2026-10-03T00:00:00Z'}),r=f.run();
    f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request());f.ledger.dispatch('alice',r,'attempt-1');
    f.now('2026-10-03T00:00:00Z');assert.throws(()=>f.ledger.reserve('alice',r,f.request('new-day')),/budget_window_closed/);
    f.ledger.settle('alice',r,'attempt-1',usage);assert.equal(f.ledger.balance('alice',s.scope_id).used.tokens,'40');
  }finally{f.close();}
});

test('a reservation cannot dispatch after its window closes or after an earlier attempt becomes unknown',async()=>{
  const f=await fixture();try{
    const s=f.ledger.createScope('alice','window',{tokens:500,nano_usd:5000,model_calls:5},{ends_at:'2026-10-03T00:00:00Z'}),r=f.run();
    f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request('first'));f.ledger.reserve('alice',r,f.request('second'));
    f.ledger.dispatch('alice',r,'first');f.ledger.markUnknown('alice',r,'first','stream_incomplete');
    assert.throws(()=>f.ledger.dispatch('alice',r,'second'),/budget_usage_unknown/);
    f.ledger.settle('alice',r,'first',usage);f.now('2026-10-03T00:00:00Z');
    assert.throws(()=>f.ledger.dispatch('alice',r,'second'),/budget_window_closed/);
    f.ledger.releaseUndispatched('alice',r,'second');assert.equal(f.ledger.balance('alice',s.scope_id).held.tokens,'0');
  }finally{f.close();}
});

test('final receipts, scope policies, bindings and audit history cannot be rewritten',async()=>{
  const f=await fixture();try{
    const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request());f.ledger.dispatch('alice',r,'attempt-1');f.ledger.settle('alice',r,'attempt-1',usage);
    assert.throws(()=>f.db.prepare('UPDATE wb_model_budget_attempts SET actual_tokens=?').run('0'),/budget_receipt_immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_attempts').run(),/budget_receipt_immutable/);
    assert.throws(()=>f.db.prepare('UPDATE wb_model_budget_scopes SET limits_json=?').run('{}'),/budget_scope_immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_scopes').run(),/budget_scope_immutable/);
    assert.throws(()=>f.db.prepare('UPDATE wb_model_budget_bindings SET scopes_json=?').run('[]'),/budget_binding_immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_bindings').run(),/budget_binding_immutable/);
    assert.throws(()=>f.db.prepare('UPDATE wb_model_budget_events SET state=?').run('released'),/budget_event_immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_events').run(),/budget_event_immutable/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n,3);
  }finally{f.close();}
});

test('slash-qualified model identifiers and counters beyond floating point totals remain exact',async()=>{
  const configured={...route,model:'Qwen/fixture-model'},f=await fixture(':memory:',[configured]);try{
    const s=f.scope(),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);
    f.ledger.reserve('alice',r,{...f.request(),model:configured.model});f.ledger.dispatch('alice',r,'attempt-1');
    const input=Number.MAX_SAFE_INTEGER-5;
    const result=f.ledger.settle('alice',r,'attempt-1',{inputTokens:input,outputTokens:10,cacheReadTokens:0,cacheWriteTokens:0});
    assert.equal(result.actual.tokens,String(BigInt(input)+10n));assert.equal(result.actual.nano_usd,String(BigInt(input)*2n+100n));
    assert.equal(f.ledger.balance('alice',s.scope_id).used.tokens,result.actual.tokens);assert.equal(result.bound_exceeded,true);
  }finally{f.close();}
});

test('provider exceeds declared bound: record actual debt and stop new calls, never clamp reported usage',async()=>{
  const f=await fixture();try{
    const s=f.scope('root',100,1000,5),r=f.run();f.ledger.bindRun('alice',r,[s.scope_id]);f.ledger.reserve('alice',r,f.request());f.ledger.dispatch('alice',r,'attempt-1');
    const receipt=f.ledger.settle('alice',r,'attempt-1',{inputTokens:100,outputTokens:25,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:125});
    assert.equal(receipt.bound_exceeded,true);assert.equal(f.ledger.balance('alice',s.scope_id).used.tokens,'125');
    assert.throws(()=>f.ledger.reserve('alice',r,f.request('overdrawn')),/model_budget_exhausted/);
  }finally{f.close();}
});

test('restart and a second SQLite connection preserve holds, dispatch CAS and the original price revision',async()=>{
  const base=resolve('../../.test-tmp/model-budget');assert.match(base.replaceAll('\\','/'),/^E:\/codex\//i);mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'case-')),path=join(dir,'ledger.sqlite');let first,second;
  try{
    first=await fixture(path);const s=first.scope('shared',150),r=first.run();first.ledger.bindRun('alice',r,[s.scope_id]);first.ledger.reserve('alice',r,first.request());
    second=await fixture(path,[{...route,revision:'rates-v2',rates:{input:99,output:100,cache_read:99,cache_write:99}}]);
    second.ledger.dispatch('alice',r,'attempt-1');assert.throws(()=>first.ledger.dispatch('alice',r,'attempt-1'),/budget_dispatch_conflict/);
    first.close();first=null;
    assert.equal(second.ledger.balance('alice',s.scope_id).held.tokens,'100');
    const settled=second.ledger.settle('alice',r,'attempt-1',usage);assert.equal(settled.pricing_revision,'rates-v1');
    assert.equal(second.ledger.balance('alice',s.scope_id).used.nano_usd,'115');
    const r2=second.run();second.ledger.bindRun('alice',r2,[s.scope_id]);
    assert.throws(()=>second.ledger.reserve('alice',r2,second.request('other')),/model_budget_exhausted/);
  }finally{
    first?.close();second?.close();const child=relative(base,resolve(dir));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(dir,{recursive:true,force:true});
  }
});

test('unknown member usage fences the shared task root at preview, reservation and dispatch until trusted settlement',async()=>{
 const f=await fixture();try{
  const root=f.scope('task-total:fixture',2000,50000,20),daily=f.scope('owner-day:fixture',5000,100000,30),a=f.run(),b=f.run();
  for(const run of [a,b])f.ledger.bindRun('alice',run,[root.scope_id,daily.scope_id]);
  f.ledger.reserve('alice',b,f.request('waiting'));f.ledger.reserve('alice',a,f.request('unknown-member'));f.ledger.dispatch('alice',a,'unknown-member');f.ledger.markUnknown('alice',a,'unknown-member','usage_incomplete');
  const before=f.ledger.balancesForRun('alice',b);
  assert.throws(()=>f.ledger.previewCall('alice',b,{provider:route.provider,model:route.model}),/budget_usage_unknown/);
  assert.throws(()=>f.ledger.reserve('alice',b,f.request('new-call')),/budget_usage_unknown/);
  assert.throws(()=>f.ledger.dispatch('alice',b,'waiting'),/budget_usage_unknown/);
  assert.deepEqual(f.ledger.balancesForRun('alice',b),before);
  assert.equal(f.db.prepare("SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='waiting'").get(b).state,'reserved');
  f.ledger.settle('alice',a,'unknown-member',usage);f.ledger.dispatch('alice',b,'waiting');
  assert.equal(f.db.prepare("SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='waiting'").get(b).state,'in_flight');
 }finally{f.close();}
});

test('durable thread and chat roots share unknown fences but daily-only siblings and other owners remain independent',async()=>{
 for(const key of ['mailbox-thread:fixture','chat-root:fixture']){
  const f=await fixture();try{
   const root=f.scope(key,2000,50000,20),daily=f.scope('owner-day:fixture',5000,100000,30),a=f.run(),b=f.run(),unrelated=f.run(),foreign=f.run('bob');
   for(const run of [a,b])f.ledger.bindRun('alice',run,[root.scope_id,daily.scope_id]);
   f.ledger.bindRun('alice',unrelated,[daily.scope_id]);
   const bob=f.ledger.createScope('bob',key,{tokens:2000,nano_usd:50000,model_calls:20});f.ledger.bindRun('bob',foreign,[bob.scope_id]);
   f.ledger.reserve('alice',a,f.request('unknown'));f.ledger.dispatch('alice',a,'unknown');f.ledger.markUnknown('alice',a,'unknown','usage_incomplete');
   assert.throws(()=>f.ledger.reserve('alice',b,f.request('blocked')),/budget_usage_unknown/);
   assert.equal(f.ledger.reserve('alice',unrelated,f.request('independent')).state,'reserved');
   assert.equal(f.ledger.reserve('bob',foreign,f.request('independent')).state,'reserved');
  }finally{f.close();}
 }
});

test('explicit unlimited money keeps actual accounting and finite token/call limits',async()=>{
 const f=await fixture();try{
  const root=f.scope('unlimited-money',200,null,2),run=f.run();f.ledger.bindRun('alice',run,[root.scope_id]);
  for(const id of ['first','second']){f.ledger.previewCall('alice',run,{provider:route.provider,model:route.model});f.ledger.reserve('alice',run,f.request(id));f.ledger.dispatch('alice',run,id);f.ledger.settle('alice',run,id,usage);}
  const balance=f.ledger.balance('alice',root.scope_id);assert.equal(balance.limits.nano_usd,null);assert.equal(balance.used.nano_usd,'230');assert.equal(balance.used.model_calls,'2');assert.equal(balance.held.nano_usd,'0');
  assert.throws(()=>f.ledger.reserve('alice',run,f.request('third')),/model_budget_exhausted/);
 }finally{f.close();}
});

test('unlimited owner adjustment requires an unlimited host ceiling and retains commitments',async()=>{
 const f=await fixture();try{
  const root=f.scope('adjust-unlimited',500,null,5),run=f.run();f.ledger.bindRun('alice',run,[root.scope_id]);f.ledger.reserve('alice',run,f.request());
  const ceiling={tokens:500,nano_usd:null,model_calls:5};
  assert.throws(()=>f.ledger.setLimits('alice','adjust-unlimited',0,{...ceiling,nano_usd:999},ceiling),/budget_limit_below_commitment/);
  assert.equal(f.ledger.setLimits('alice','adjust-unlimited',0,{...ceiling,nano_usd:1000},ceiling).version,1);
  assert.equal(f.ledger.setLimits('alice','adjust-unlimited',1,ceiling,ceiling).limits.nano_usd,null);
  assert.equal(f.ledger.balance('alice',root.scope_id).held.nano_usd,'1000');
  assert.throws(()=>f.ledger.setLimits('alice','adjust-unlimited',2,ceiling,{...ceiling,nano_usd:2000}),/budget_ceiling_exceeded/);
 }finally{f.close();}
});

test('task attempt pages expose normalized usage only for the exact owner scope without internal routes or run IDs',async()=>{
 const f=await fixture();try{
  const taskKey='task-total:task-one',taskScope=f.scope(taskKey),otherScope=f.scope('task-total:task-two');
  const ownerRun=f.run(),otherTaskRun=f.run(),foreignRun=f.run('bob');
  const foreignScope=f.ledger.createScope('bob',taskKey,{tokens:500,nano_usd:5000,model_calls:5});
  f.ledger.bindRun('alice',ownerRun,[taskScope.scope_id]);
  f.ledger.bindRun('alice',otherTaskRun,[otherScope.scope_id]);
  f.ledger.bindRun('bob',foreignRun,[foreignScope.scope_id]);
  const addSettled=(runId,attemptId,purpose)=>{
   f.ledger.reserve('alice',runId,{...f.request(attemptId),purpose});f.ledger.dispatch('alice',runId,attemptId);
   f.ledger.settle('alice',runId,attemptId,usage);
  };
  addSettled(ownerRun,'alpha','compaction');addSettled(ownerRun,'beta','compaction');
  f.ledger.reserve('alice',ownerRun,{...f.request('unknown-missing-cache'),purpose:'session-title'});
  f.ledger.dispatch('alice',ownerRun,'unknown-missing-cache');
  f.ledger.settle('alice',ownerRun,'unknown-missing-cache',{inputTokens:4,outputTokens:2});
  f.ledger.reserve('alice',otherTaskRun,f.request('other-task-attempt'));f.ledger.dispatch('alice',otherTaskRun,'other-task-attempt');f.ledger.settle('alice',otherTaskRun,'other-task-attempt',usage);
  f.ledger.reserve('bob',foreignRun,f.request('other-owner-attempt'));f.ledger.dispatch('bob',foreignRun,'other-owner-attempt');f.ledger.settle('bob',foreignRun,'other-owner-attempt',usage);

  const first=f.ledger.listTaskAttempts('alice',taskKey,undefined,2);
  assert.equal(first.items.length,2);assert.equal(first.next_cursor,'2');
  assert.deepEqual(first.items.map(item=>item.purpose),['compaction','compaction']);
  assert.deepEqual(first.items[0].reserved,{tokens:'100',nano_usd:'1000',model_calls:'1'});
  assert.deepEqual(first.items[0].settled,{tokens:'40',nano_usd:'115',model_calls:'1'});
  assert.deepEqual(first.items[0].usage,{status:'settled',input_tokens:'20',output_tokens:'5',cache_read_tokens:'10',cache_write_tokens:'5',reasoning_tokens:'2',total_tokens:'40'});
  assert.equal(first.items[0].cost_basis,'configured_rates');
  const second=f.ledger.listTaskAttempts('alice',taskKey,first.next_cursor,2);
  assert.equal(second.next_cursor,null);assert.equal(second.items.length,1);
  assert.equal(second.items[0].state,'unknown');
  assert.deepEqual(second.items[0].settled,{tokens:null,nano_usd:null,model_calls:null});
  assert.deepEqual(second.items[0].usage,{status:'unknown',input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,reasoning_tokens:null,total_tokens:null});
  const encoded=JSON.stringify([...first.items,...second.items]);
  for(const forbidden of [ownerRun,'alpha','beta','unknown-missing-cache','fixture','bounded-model','route_json','request_json','owner_id','run_id','session_id'])assert.equal(encoded.includes(forbidden),false,forbidden);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.attempt_ref)).size,3);
  assert.equal(first.items[0].attempt_ref, f.ledger.listTaskAttempts('alice',taskKey,undefined,2).items[0].attempt_ref);
  assert.throws(()=>f.ledger.listTaskAttempts('alice',taskKey,'not-a-cursor',2),/budget_attempt_query_invalid/);
  assert.throws(()=>f.ledger.listTaskAttempts('alice',taskKey,undefined,51),/budget_attempt_query_invalid/);
 }finally{f.close();}
});
test('task attempt pages report truncation at the six-digit cursor boundary',async()=>{
 const f=await fixture();try{
  const taskKey='task-total:cursor-boundary',scope=f.scope(taskKey),run=f.run();
  f.ledger.bindRun('alice',run,[scope.scope_id]);
  f.ledger.reserve('alice',run,{...f.request('boundary-attempt'),purpose:'compaction'});
  const prepare=f.db.prepare.bind(f.db);
  const row=prepare('SELECT run_id,attempt_id,request_json,route_json,state,held_tokens,held_nano_usd,usage_json,actual_tokens,actual_nano_usd,created_at,updated_at FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(run,'boundary-attempt');
  f.db.prepare=sql=>sql.includes('FROM wb_model_budget_attempts a JOIN wb_model_budget_bindings b')?{all:()=>[row,row]}:prepare(sql);
  const page=f.ledger.listTaskAttempts('alice',taskKey,'999999',1);
  assert.equal(page.items.length,1);assert.equal(page.next_cursor,null);assert.equal(page.truncated,true);
 }finally{f.close();}
});
