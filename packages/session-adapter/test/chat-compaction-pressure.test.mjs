import test from 'node:test';
import assert from 'node:assert/strict';
import * as pressure from '../chat-compaction-pressure.js';
function fixture(){
 const header={config:{provider:'fixture',model:'fast',maxTokens:2000}},session={id:'s',seq:20,requestHeader:()=>structuredClone(header)};
 const f={header,session,reads:0,measurements:0,tokens:1000,info:{context:{contextWindow:10000},defaultMaxTokens:1000}};
 f.args={session,expectedModel:{provider:'fixture',model:'fast'},policy:{thresholdRatio:.8,headroomTokens:1000},signal:new AbortController().signal,
  tokenMeter:{measure:()=>{f.measurements++;return{logRevision:session.seq,totalTokens:f.tokens};}},llm:{resolveModelInfo:async()=>{f.reads++;return f.info;}}};return f;
}
const inspect=f=>pressure.inspectChatCompactionPressure(f.args);
test('low effective pressure quietly skips, without inference or mutation',async()=>{
 assert.equal(typeof pressure.inspectChatCompactionPressure,'function');const f=fixture(),before=JSON.stringify(f.header);
 const r=await inspect(f);assert.equal(r.decision,'skip');assert.equal(r.reason,'LOW_PRESSURE');assert.equal(r.threshold_tokens,7000);assert.equal(r.execution_authorized,false);assert.equal(f.reads,1);assert.equal(f.measurements,2);assert.equal(JSON.stringify(f.header),before);
});
test('threshold includes output reservation and headroom, equality needs maintenance advice only',async()=>{
 const f=fixture();f.tokens=7000;const r=await inspect(f);assert.equal(r.decision,'needed');assert.equal(r.execution_authorized,false);assert.equal(r.total_tokens,7000);
 delete f.header.config.maxTokens;assert.equal((await inspect(f)).threshold_tokens,8000);
});
test('uses effective meter pressure rather than raw persisted content',async()=>{
 const f=fixture();f.session.snapshotEvents=()=>assert.fail('must not scan raw history');f.session.transcript='x'.repeat(200000);assert.equal((await inspect(f)).decision,'skip');
});
for(const mutate of [f=>f.info={},f=>f.info.context.contextWindow=0,f=>f.header.config.maxTokens=10000,f=>f.args.policy.thresholdRatio=NaN,f=>f.tokens=NaN,f=>f.info.defaultMaxTokens=-1])test('invalid or unavailable metadata never requests maintenance',async()=>{
 const f=fixture();mutate(f);assert.equal((await inspect(f)).decision,'skip');
});
test('exact routed model identity is required before metadata lookup',async()=>{
 const f=fixture();f.header.config.model='other';assert.equal((await inspect(f)).reason,'ROUTE_UNCONFIRMED');assert.equal(f.reads,0);
});
test('changes across asynchronous resolution revoke the observation',async()=>{
 for(const change of [f=>f.session.seq++,f=>f.header.config.maxTokens++,f=>f.tokens++]){const f=fixture();f.args.llm.resolveModelInfo=async()=>{change(f);return f.info;};assert.equal((await inspect(f)).reason,'STATE_CHANGED');}
});
test('cancellation propagates, provider errors remain private quiet skips',async()=>{
 const f=fixture();f.args.llm.resolveModelInfo=async()=>{throw Error('private endpoint');};const r=await inspect(f);assert.equal(r.reason,'METADATA_UNAVAILABLE');assert.ok(!JSON.stringify(r).includes('private'));
 const abort=new AbortController();abort.abort(Error('cancelled'));f.args.signal=abort.signal;await assert.rejects(()=>inspect(f),/cancelled/);
});
test('new input cancellation does not wait for an unresponsive metadata resolver',async()=>{
 const f=fixture(),abort=new AbortController();let started;const ready=new Promise(resolve=>started=resolve);
 f.args.signal=abort.signal;f.args.llm.resolveModelInfo=()=>{started();return new Promise(()=>{});};
 const pending=inspect(f);await ready;abort.abort(Error('new input'));await assert.rejects(()=>pending,/new input/);
});
