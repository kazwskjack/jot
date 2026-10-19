import test from 'node:test';
import assert from 'node:assert/strict';
const impl=await import('./conversation-mode.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const caps={conversation_modes:{default:'chat',work:{supported:true},chat:{ready:true}},workspaces:[{workspace_id:'ws',can_write:true}],models:[{provider:'fixture',model:'work',supported_reasoning_efforts:['high']}]};
test('new conversations use confirmed Chat readiness and real workspace/model values; legacy omits mode',()=>{
 assert.equal(typeof impl.conversationCreation,'function');assert.deepEqual(impl.conversationCreation(caps,'ws'),{title:'新对话',workspace_id:'ws',model:{provider:'fixture',model:'work'},mode:'chat'});
 const work={...caps,conversation_modes:{default:'work',work:{supported:true},chat:{ready:false}}};assert.equal(impl.conversationCreation(work,'ws').mode,'work');assert.equal(impl.conversationCreation(work,'ws').model.reasoning_effort,'high');
 const legacy={...caps};delete legacy.conversation_modes;assert.equal(Object.hasOwn(impl.conversationCreation(legacy,'ws'),'mode'),false);
 assert.throws(()=>impl.conversationCreation(caps,'foreign'));assert.throws(()=>impl.conversationCreation({...caps,models:[]},'ws'));assert.throws(()=>impl.conversationCreation({...caps,conversation_modes:{...caps.conversation_modes,chat:{ready:false}}},'ws'));
});
test('lost mode response retains the exact path, version, target and key on explicit retry',async()=>{
 assert.equal(typeof impl.ConversationModeWriter,'function');const calls=[];let lost=true;const writer=new impl.ConversationModeWriter(async(path,method,body,key)=>{calls.push({path,method,body,key});if(lost)throw Error('synthetic response loss');return{conversation_id:'conv',version:8,mode:'chat'};},()=>{},()=> 'test-mode-key');
 await assert.rejects(()=>writer.change({conversation_id:'conv',version:7},'chat'));assert.equal(writer.pending,true);lost=false;const saved=await writer.retry();assert.equal(saved.mode,'chat');assert.equal(writer.pending,false);assert.deepEqual(calls[1],calls[0]);assert.deepEqual(calls[0],{path:'/conversations/conv',method:'PATCH',body:{expected_version:7,mode:'chat'},key:'test-mode-key'});
});
test('malformed success stays unconfirmed; definite conflict clears the command without automatic replay',async()=>{
 assert.equal(typeof impl.ConversationModeWriter,'function');let behavior='wrong';const writer=new impl.ConversationModeWriter(async()=>{if(behavior==='wrong')return{conversation_id:'other',version:2,mode:'chat'};throw Object.assign(Error('VERSION_CONFLICT'),{status:409});});
 await assert.rejects(()=>writer.change({conversation_id:'conv',version:1},'chat'));assert.equal(writer.pending,true);behavior='conflict';await assert.rejects(()=>writer.retry());assert.equal(writer.pending,false);
});

test('unconfirmed creation retries the original payload and key instead of making another conversation',async()=>{
 assert.equal(typeof impl.ConversationCreateWriter,'function');let lost=true;const calls=[];const writer=new impl.ConversationCreateWriter(async(path,method,body,key)=>{calls.push({path,method,body,key});if(lost)throw Error('response lost');return{conversation_id:'created',version:1,mode:'chat'};},()=>{},()=> 'synthetic-create-request');
 await assert.rejects(()=>writer.create(impl.conversationCreation(caps,'ws')));assert.equal(writer.pending,true);lost=false;assert.equal((await writer.retry()).conversation_id,'created');assert.deepEqual(calls[1],calls[0]);assert.equal(writer.pending,false);
});

test('a malformed creation identity cannot clear an unconfirmed request',async()=>{
 const writer=new impl.ConversationCreateWriter(async()=>({conversation_id:123,version:1,mode:'chat'}));await assert.rejects(()=>writer.create(impl.conversationCreation(caps,'ws')));assert.equal(writer.pending,true);
});
