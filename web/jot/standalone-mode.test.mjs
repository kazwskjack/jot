import test from 'node:test';import assert from 'node:assert/strict';
const impl=await import('../standalone-mode.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
test('standalone creation follows confirmed readiness and preserves legacy Work requests',()=>{
 assert.equal(typeof impl.standaloneCreation,'function');assert.deepEqual(impl.standaloneCreation({conversation_modes:{default:'chat',work:{supported:true},chat:{ready:true}}}),{title:'New chat',mode:'chat'});assert.deepEqual(impl.standaloneCreation({}),{title:'New chat'});assert.throws(()=>impl.standaloneCreation({conversation_modes:{default:'chat',work:{supported:true},chat:{ready:false}}}));
});
test('standalone command retries keep the exact own-API body/request ID until a matching outcome arrives',async()=>{
 assert.equal(typeof impl.StandaloneCommand,'function');let behavior='lost';const calls=[],writer=new impl.StandaloneCommand(async(path,method,body)=>{calls.push({path,method,body});if(behavior==='lost')throw Error('unconfirmed');if(behavior==='wrong')return{id:'different',mode:'chat',version:2};return{id:'original',mode:'chat',version:2};},()=>{},()=> 'test-command');
 await assert.rejects(()=>writer.send('/conversations/original','PATCH',{mode:'chat',expected_version:1}));assert.equal(writer.pending,true);behavior='wrong';await assert.rejects(()=>writer.retry());assert.equal(writer.pending,true);behavior='ok';await writer.retry();assert.equal(writer.pending,false);assert.deepEqual(calls[0],calls[2]);assert.equal(calls[0].body.request_id,'test-command');assert.equal(calls[0].body.expected_version,1);
});
test('standalone snapshot merge retains newer setting versions independently of event cursor',()=>{
 assert.equal(typeof impl.mergeStandaloneSnapshot,'function');const previous={seq:9,conversation:{id:'same',mode:'chat',version:3},messages:['new']},incoming={seq:10,conversation:{id:'same',mode:'work',version:2},messages:['later']};const result=impl.mergeStandaloneSnapshot(previous,incoming);assert.equal(result.conversation.mode,'chat');assert.equal(result.messages[0],'later');assert.equal(impl.mergeStandaloneSnapshot(previous,{...incoming,seq:8}).seq,9);
});
