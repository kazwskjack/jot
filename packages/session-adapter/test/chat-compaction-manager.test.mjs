import test from 'node:test';
import assert from 'node:assert/strict';
import {completedChatFixture,digest} from '../../gateway/test/support/chat-maintenance-fixture.mjs';
import {readChatCompactionIntent} from '../../gateway/src/conversations/chat-compaction-source.ts';
import {createChatCompactionRuntime} from '../chat-compaction-runtime.js';
const impl=await import('../chat-compaction-manager.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
function fixture(t){
 assert.equal(typeof impl.createChatCompactionManager,'function');const f=completedChatFixture(t),runtime=createChatCompactionRuntime(),s=f.scope.session_ref,proof={raw_event_count:8,run_id:f.scope.run_id,run_version:f.scope.expected_run_version,session_id:s,source_sha256:f.intent.source.history_sha256,command_ids:[],native_message_ids:['original-native'],raw_sha256:'b'.repeat(64),answer_sha256:f.witness.answer_sha256,answer_seq:5,turn_end_seq:7,profile_fingerprint:'c'.repeat(64)};
 const state={...f,runtime,proof,tokens:9000,calls:0};let started;state.started=new Promise(resolve=>started=resolve);
 const engine={jotChatCompactionIdentity:Object.freeze({}),jotChatCompactionProtocol:1,config:{auto:false,thresholdRatio:.8,headroomTokens:1000},compactNow:async(agent,signal)=>{state.calls++;started();assert.ok(runtime.get(agent));await runtime.get(agent).check(signal);signal.throwIfAborted();return{compactionId:'synthetic-compaction'};}};
 const agent={id:s,session:{id:s,header:{agentPreset:'jot-chat'},seq:8,requestHeader:()=>({config:{...f.request,reasoningEffort:'off'}})},status:'idle',inbox:{nextStep:[],nextTurn:[]},ctx:{get:()=>undefined},cancel:()=>assert.fail('never cancel another native activity')};state.agent=agent;state.engine=engine;
 const ctx={on:()=>()=>{}},bridge={request:async(path,binding,body)=>{assert.equal(path,'chat-compaction-source');assert.equal(body.action,'read');return{intent:readChatCompactionIntent(f.db,f.scope,body.intent_id)};}};
 state.manager=impl.createChatCompactionManager({ctx,bridge,presets:{serviceFor:(owner,name)=>{assert.equal(owner,agent);assert.equal(name,'compaction');return new Proxy(engine,{});},composedPreset:()=>agent.session.header.agentPreset},agents:{get:id=>id===s?agent:undefined},runtime,observe:async()=>({native:{proof_sha256:digest(proof)},execution_authorized:false}),completionReader:async()=>structuredClone(proof),tokenMeter:{measure:()=>({logRevision:8,totalTokens:state.tokens})},llm:{resolveModelInfo:async()=>({context:{contextWindow:10000},defaultMaxTokens:1000})}});
 state.run=()=>state.manager.run({scope:f.scope,intent_id:f.intent.intent_id,source_sha256:f.intent.source_sha256});return state;
}
test('low pressure skips official maintenance while high pressure delegates only to the owned Chat engine',async t=>{
 const f=fixture(t);f.tokens=10;assert.equal((await f.run()).status,'skipped');assert.equal(f.calls,0);f.tokens=9000;assert.equal((await f.run()).status,'compacted');assert.equal(f.calls,1);assert.equal(f.runtime.get(f.agent),undefined);
});
test('new input cancels and drains only its own live compaction before allowing admission',async t=>{
 const f=fixture(t);let release,ready;const gate=new Promise(resolve=>release=resolve),armed=new Promise(resolve=>ready=resolve),original=f.engine.compactNow;f.engine.compactNow=async(agent,signal)=>{await original(agent,signal);signal.throwIfAborted();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{gate.then(()=>reject(signal.reason));},{once:true});ready();});};
 const running=f.run();running.catch(()=>{});await armed;let drained=false;const wait=f.manager.beforeInput({agent:f.agent,binding:{sessionRef:f.scope.session_ref},signal:new AbortController().signal}).then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);release();await wait;await assert.rejects(()=>running);assert.equal(drained,true);assert.equal(f.runtime.get(f.agent),undefined);
});
test('stale source, changed native proof, Work engine or foreign Agent cannot invoke compaction',async t=>{
 for(const mode of ['source','proof','work','engine','foreign']){const f=fixture(t);if(mode==='source')f.newInput();if(mode==='proof')f.proof.raw_event_count++;if(mode==='work')f.agent.session.header.agentPreset='jot-general';if(mode==='foreign')f.agent.id='foreign-agent';if(mode==='engine')f.engine.jotChatCompactionProtocol=0;await assert.rejects(f.run,undefined,mode);assert.equal(f.calls,0);}
});
