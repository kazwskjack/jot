import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../gateway/src/server.ts';
import {completedChatFixture} from '../../gateway/test/support/chat-maintenance-fixture.mjs';
const impl=await import('../chat-compaction-stream.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const usage={inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40};
const chunks=[{type:'text-delta',index:0,text:'Synthetic summary'},{type:'usage',usage},{type:'finish',reason:{kind:'stop'}}];
const collect=async stream=>{const result=[];for await(const chunk of stream)result.push(chunk);return result;};
async function fixture(t){
 assert.equal(typeof impl.accountedChatCompactionStream,'function');const token=randomBytes(32).toString('hex'),service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url))});t.after(async()=>{await service.app.close();service.db.close();});const f=completedChatFixture(t,{db:service.db}),controller=new AbortController();let calls=0;
 const attempt={scope:f.scope,intent_id:f.intent.intent_id,attempt_id:'stream-attempt',observer_id:'host-instance',witness:f.witness},options=Object.freeze({provider:'fixture',model:'fast',reasoningEffort:'off',sessionId:f.scope.session_ref,purpose:'compaction',messages:Object.freeze([{role:'user',content:[{type:'text',text:'Synthetic summary input.'}]}]),signal:controller.signal});
 const state={...f,service,controller,attempt,options,calls:()=>calls,failAction:null,failAfterCommit:false};
 const request=async(path,binding,payload,signal)=>{assert.equal(path,'chat-compaction-attempt');assert.equal(signal,undefined,'accounting must survive the inference abort');if(state.failAction===payload.action&&!state.failAfterCommit)throw Error('synthetic lost response');const r=await service.app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer '+token},payload:{...payload,run_id:binding.runId,session_ref:binding.sessionRef}});if(r.statusCode!==200)throw Error('synthetic ledger rejected request');if(state.failAction===payload.action&&state.failAfterCommit)throw Error('synthetic lost response');return r.json();};
 state.stream=(values=chunks,change={})=>impl.accountedChatCompactionStream({attempt,options:change.options??options,request,check:change.check??(async signal=>signal.throwIfAborted()),next:async function*(){calls++;for(const chunk of values){if(change.beforeChunk)await change.beforeChunk(chunk);yield chunk;}}});state.receipt=()=>service.db.prepare('SELECT * FROM ga_chat_compaction_attempts').get();return state;
}
test('independent compaction stream settles exact usage before exposing the terminal finish',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.options),out=await collect(f.stream());assert.equal(out.at(-1).type,'finish');assert.equal(f.calls(),1);assert.equal(f.receipt().state,'settled');assert.equal(f.receipt().actual_tokens,'40');assert.equal(JSON.stringify(f.options),before);assert.equal(f.service.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
});
test('lost dispatch acknowledgement and replay never issue another provider request',async t=>{
 const f=await fixture(t);f.failAction='dispatch';f.failAfterCommit=true;await assert.rejects(()=>collect(f.stream()));assert.equal(f.calls(),0);assert.equal(f.receipt().state,'usage_unknown');f.failAction=null;await assert.rejects(()=>collect(f.stream()));assert.equal(f.calls(),0);
});
test('partial usage is preserved after cancellation and new input, independently of current run authority',async t=>{
 const f=await fixture(t),partial=[chunks[0],{type:'usage',usage:{inputTokens:20,outputTokens:2}},{type:'text-delta',index:0,text:'Still streaming'}];await assert.rejects(()=>collect(f.stream(partial,{beforeChunk:chunk=>{if(chunk.text==='Still streaming'){f.newInput();f.controller.abort(Error('new input'));}}})));assert.equal(f.calls(),1);assert.equal(f.receipt().state,'usage_unknown');assert.equal(f.receipt().usage_status,'partial');assert.ok(f.receipt().usage_json.includes('inputTokens'));
});
test('cancellation after receiving the terminal provider usage charges once but exposes no successful finish',async t=>{
 const f=await fixture(t),seen=[];await assert.rejects(async()=>{for await(const chunk of f.stream(chunks,{beforeChunk:chunk=>{if(chunk.type==='finish')f.controller.abort(Error('new input'));}}))seen.push(chunk);});assert.equal(f.receipt().state,'settled');assert.equal(f.receipt().actual_tokens,'40');assert.equal(seen.some(c=>c.type==='finish'),false);assert.equal(f.calls(),1);
});
test('missing finish or usage remains unknown instead of falsely completing a checkpoint',async t=>{
 const f=await fixture(t);await assert.rejects(()=>collect(f.stream(chunks.filter(c=>c.type!=='usage'))));assert.equal(f.receipt().state,'usage_unknown');assert.equal(f.receipt().actual_tokens,null);
});
test('lost settlement acknowledgement retains committed accounting and cannot call the provider again',async t=>{
 const f=await fixture(t);f.failAction='settle';f.failAfterCommit=true;await assert.rejects(()=>collect(f.stream()));assert.equal(f.receipt().state,'settled');assert.equal(f.receipt().actual_tokens,'40');f.failAction=null;await assert.rejects(()=>collect(f.stream()));assert.equal(f.calls(),1);
});
test('wrong purpose, thinking or Session refuses all journal and provider effects',async t=>{
 const f=await fixture(t);for(const patch of [{purpose:'session-title'},{reasoningEffort:'high'},{sessionId:'foreign'}])await assert.rejects(()=>collect(f.stream(chunks,{options:Object.freeze({...f.options,...patch})})));assert.equal(f.calls(),0);assert.equal(f.receipt(),undefined);
});
test('mutable caller bookkeeping cannot redirect or invalidate the frozen original accounting identity',async t=>{
 const f=await fixture(t);let checks=0;const out=await collect(f.stream(chunks,{check:async()=>{if(++checks===2){f.attempt.observer_id='changed-host';f.attempt.intent_id='changed-intent';f.attempt.witness.proof_sha256='e'.repeat(64);}}}));assert.equal(out.at(-1).type,'finish');assert.equal(f.receipt().observer_id,'host-instance');assert.equal(f.receipt().state,'settled');
});
test('malformed provider usage still records a durable unknown outcome without storing invalid fields',async t=>{
 const f=await fixture(t);await assert.rejects(()=>collect(f.stream([chunks[0],{type:'usage',usage:{inputTokens:-1,outputTokens:2}},chunks[2]])));assert.equal(f.calls(),1);assert.equal(f.receipt().state,'usage_unknown');assert.equal(f.receipt().usage_status,'none');assert.equal(f.receipt().actual_tokens,null);
});
