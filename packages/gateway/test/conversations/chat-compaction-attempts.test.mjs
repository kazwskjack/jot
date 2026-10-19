import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {completedChatFixture} from '../support/chat-maintenance-fixture.mjs';
const impl=await import('../../src/conversations/chat-compaction-attempts.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const usage={inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40,reasoningTokens:2};
function fixture(t){assert.equal(typeof impl.ChatCompactionAttempts,'function');const f=completedChatFixture(t);let now=100000;const ledger=new impl.ChatCompactionAttempts(f.db,{now:()=>now}),reservation={intent_id:f.intent.intent_id,attempt_id:'compact-attempt',observer_id:'host-instance',request:f.request,witness:f.witness};const reserve=()=>ledger.reserve(f.scope,reservation);return{...f,ledger,reservation,reserve,setTime:value=>now=value,binding:receipt=>({intent_id:f.intent.intent_id,attempt_id:receipt.attempt_id,observer_id:'host-instance',fence_id:receipt.fence_id})};}
test('one independent attempt freezes source, call and native witness without a foreground lease or public effects',t=>{
 const f=fixture(t),counts=()=>['ga_runs','ga_messages','ga_events','ga_outbox','ga_worker_leases'].map(table=>f.db.prepare('SELECT count(*) n FROM '+table).get().n),before=counts(),r=f.reserve();assert.equal(r.state,'reserved');assert.equal(r.execution_authorized,false);assert.equal(r.dispatch_allowed,false);assert.equal(r.actual_tokens,null);assert.deepEqual(f.reserve(),r);assert.deepEqual(counts(),before);
 assert.throws(()=>f.ledger.reserve(f.scope,{...f.reservation,attempt_id:'other'}));assert.throws(()=>f.ledger.reserve(f.scope,{...f.reservation,request:{...f.request,call_sha256:'e'.repeat(64)}}));assert.throws(()=>f.db.prepare("UPDATE ga_chat_compaction_attempts SET observer_id='foreign'").run());
});
test('dispatch permission is returned only by the first durable transition, never by receipt replay',t=>{
 const f=fixture(t),r=f.reserve(),b=f.binding(r);assert.equal(f.ledger.dispatch(f.scope,b).dispatch_allowed,true);assert.equal(f.ledger.dispatch(f.scope,b).dispatch_allowed,false);assert.equal(f.ledger.read(f.scope,b).state,'dispatched');assert.equal(f.ledger.read(f.scope,b).execution_authorized,false);assert.throws(()=>f.ledger.release(f.scope,b));
});
test('new input and ticket expiry revoke dispatch but do not invent another attempt or renew a ticket',t=>{
 for(const change of [f=>f.newInput(),f=>f.setTime(200000)]){const f=fixture(t),r=f.reserve(),b=f.binding(r);change(f);assert.throws(()=>f.ledger.dispatch(f.scope,b));assert.equal(f.ledger.read(f.scope,b).state,'reserved');assert.equal(f.ledger.release(f.scope,b).state,'released');assert.throws(()=>f.ledger.dispatch(f.scope,b));assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);}
});
test('incurred usage settles after source revocation; reasoning is not double counted and replay cannot charge twice',t=>{
 const f=fixture(t),b=f.binding(f.reserve());f.ledger.dispatch(f.scope,b);f.newInput();f.setTime(200000);const r=f.ledger.settle(f.scope,b,usage);assert.equal(r.state,'settled');assert.equal(r.actual_tokens,'40');assert.equal(r.estimated_cost_nano_usd,null);assert.deepEqual(f.ledger.settle(f.scope,b,usage),r);assert.equal(f.ledger.unknown(f.scope,b,'cancelled').state,'settled');assert.throws(()=>f.ledger.settle(f.scope,b,{...usage,outputTokens:6,totalTokens:41}));
});
test('partial or absent usage stays unknown, with late actual usage able to finish accounting',t=>{
 const f=fixture(t),b=f.binding(f.reserve());f.ledger.dispatch(f.scope,b);const r=f.ledger.unknown(f.scope,b,'cancelled',{inputTokens:20,outputTokens:2});assert.equal(r.state,'usage_unknown');assert.equal(r.usage_status,'partial');assert.equal(r.actual_tokens,null);assert.equal(r.usage.inputTokens,20);assert.equal(f.ledger.settle(f.scope,b,{inputTokens:20,outputTokens:5,totalTokens:40}).state,'usage_unknown');assert.equal(f.ledger.settle(f.scope,b,usage).actual_tokens,'40');
});
test('foreign owner, Host fence, intent or model cannot dispatch or settle an original attempt',t=>{
 const f=fixture(t),r=f.reserve(),b=f.binding(r);for(const key of ['observer_id','intent_id','fence_id'])assert.throws(()=>f.ledger.dispatch(f.scope,{...b,[key]:'foreign'}));assert.throws(()=>f.ledger.read({...f.scope,owner_id:'foreign'},b));assert.throws(()=>f.ledger.reserve(f.scope,{...f.reservation,request:{...f.request,reasoning_effort:'high'}}));assert.throws(()=>f.ledger.reserve(f.scope,{...f.reservation,request:{...f.request,purpose:'session-title'}}));
});
test('independent connections and disk reopen retain the same fence and cannot replay dispatch',t=>{
 const base=resolve('.test-tmp');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'chat-attempt-')),path=join(root,'gateway.db');let second,third;
 const f=completedChatFixture(t,{path});t.after(()=>{for(const db of [f.db,second,third])if(db?.isOpen)db.close();const rel=relative(base,root);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));rmSync(root,{recursive:true,force:true});});
 const first=new impl.ChatCompactionAttempts(f.db),input={intent_id:f.intent.intent_id,attempt_id:'disk-attempt',observer_id:'host-one',request:f.request,witness:f.witness},r=first.reserve(f.scope,input),binding={intent_id:f.intent.intent_id,attempt_id:r.attempt_id,observer_id:'host-one',fence_id:r.fence_id};
 second=openProductDatabase(path);const other=new impl.ChatCompactionAttempts(second);assert.deepEqual(other.reserve(f.scope,input),r);assert.equal(first.dispatch(f.scope,binding).dispatch_allowed,true);assert.equal(other.dispatch(f.scope,binding).dispatch_allowed,false);f.db.close();second.close();
 third=openProductDatabase(path);const reopened=new impl.ChatCompactionAttempts(third);assert.equal(reopened.read(f.scope,binding).state,'dispatched');assert.equal(reopened.dispatch(f.scope,binding).dispatch_allowed,false);assert.equal(reopened.settle(f.scope,binding,usage).actual_tokens,'40');assert.equal(third.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);
 const changes=third.prepare('SELECT total_changes() n').get().n,inspection=reopened.inspect(f.scope,f.intent.intent_id);assert.equal(inspection.receipt.fence_id,r.fence_id);assert.equal(inspection.receipt.actual_tokens,'40');assert.equal(inspection.receipt.dispatch_allowed,false);assert.equal(third.prepare('SELECT total_changes() n').get().n,changes);
});
test('invalid usage never replaces an incurred attempt with a successful zero-cost receipt',t=>{
 const f=fixture(t),b=f.binding(f.reserve());f.ledger.dispatch(f.scope,b);for(const bad of [{},{inputTokens:-1,outputTokens:0},{inputTokens:1,outputTokens:2,totalTokens:1},{inputTokens:1,outputTokens:2,reasoningTokens:3},{inputTokens:1,outputTokens:2,totalTokens:3,secret:'not a usage field'}])assert.throws(()=>f.ledger.settle(f.scope,b,bad));assert.equal(f.ledger.read(f.scope,b).actual_tokens,null);
});

test('owned attempt inspection recovers only original metadata without allocation, dispatch or fence renewal',t=>{
 const f=fixture(t);assert.equal(typeof f.ledger.inspect,'function');
 const empty=f.ledger.inspect(f.scope,f.intent.intent_id);assert.equal(empty.receipt,null);assert.equal(empty.native_witness,null);assert.equal(empty.execution_authorized,false);
 const r=f.reserve(),b=f.binding(r);f.ledger.dispatch(f.scope,b);f.newInput();f.setTime(200000);
 const changes=f.db.prepare('SELECT total_changes() n').get().n,seen=f.ledger.inspect(f.scope,f.intent.intent_id);
 assert.equal(seen.kind,'chat_compaction_attempt_inspection');assert.deepEqual(seen.receipt,f.ledger.read(f.scope,b));assert.equal(seen.receipt.dispatch_allowed,false);assert.equal(seen.receipt.expires_at,r.expires_at);assert.deepEqual(seen.native_witness,f.witness);assert.deepEqual(seen.source,f.intent.source);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 seen.native_witness.raw_sha256='0'.repeat(64);seen.source.policy.mode='work';assert.deepEqual(f.ledger.inspect(f.scope,f.intent.intent_id).native_witness,f.witness);assert.deepEqual(f.ledger.inspect(f.scope,f.intent.intent_id).source,f.intent.source);
 for(const field of ['owner_id','conversation_id','run_id','session_ref','expected_run_version'])assert.throws(()=>f.ledger.inspect({...f.scope,[field]:field==='expected_run_version'?99:'foreign'},f.intent.intent_id),undefined,field);
 assert.throws(()=>f.ledger.inspect(f.scope,'missing-intent'));assert.throws(()=>f.ledger.inspect({...f.scope,execution_authorized:true},f.intent.intent_id));assert.equal(f.db.prepare('SELECT count(*) n FROM ga_chat_compaction_attempts').get().n,1);
});
