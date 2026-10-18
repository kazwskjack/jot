import test from 'node:test';
import assert from 'node:assert/strict';
const runtime=await import('../chat-compaction-runtime.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const engine=await import('../chat-compaction-engine.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const agent=()=>({id:'s',session:{id:'s',header:{agentPreset:'jot-chat'}}});
const entry=()=>({attempt:{scope:{session_ref:'s',run_id:'r',owner_id:'u'}},model:{provider:'fixture',model:'fast',reasoning_effort:'off'},signal:new AbortController().signal,check:async()=>{},request:async()=>{}});
test('Chat compaction slots isolate original Agents and clear ownership after completion or failure',async()=>{
 assert.equal(typeof runtime.createChatCompactionRuntime,'function');const r=runtime.createChatCompactionRuntime(),a=agent(),e=entry();assert.equal(r.get(a),undefined);
 await r.withOperation(a,e,async()=>{assert.equal(r.get(a),e);assert.equal(r.get(agent()),undefined);await assert.rejects(()=>r.withOperation(a,entry(),async()=>{}));});assert.equal(r.get(a),undefined);
 await assert.rejects(()=>r.withOperation(a,e,async()=>{throw Error('failed');}));assert.equal(r.get(a),undefined);
});
test('the supported engine subclass always disables automatic foreground compaction and refuses unowned summaries',async()=>{
 assert.equal(typeof engine.createAccountedChatCompactionEngine,'function');let inference=0;
 class Original{constructor(ctx,config){this.ctx=ctx;this.config=config;}compactNow(){}};
 const Class=engine.createAccountedChatCompactionEngine({BasicCompactionEngine:Original,BlockAssembler:class{},getOperation:()=>undefined}),e=new Class({llm:{stream:()=>inference++}},{auto:true,maxTokens:100});assert.equal(e.config.auto,false);assert.equal(e.jotChatCompactionProtocol,1);
 await assert.rejects(()=>e.summarize({messages:[]},agent(),new AbortController().signal));assert.equal(inference,0);assert.equal(Class.prototype.compactNow,Original.prototype.compactNow);
});
