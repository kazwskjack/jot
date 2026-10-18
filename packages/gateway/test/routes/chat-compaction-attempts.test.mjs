import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {completedChatFixture} from '../support/chat-maintenance-fixture.mjs';
test('independent compaction accounting is bearer-only and accepts late usage without reviving old execution',async t=>{
 const token=randomBytes(32).toString('hex'),f=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(32).toString('hex')});t.after(async()=>{await f.app.close();f.db.close();});const c=completedChatFixture(t,{db:f.db});
 const base={...c.scope,intent_id:c.intent.intent_id,attempt_id:'compact-attempt',observer_id:'host-instance'},call=(body,auth=token)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/chat-compaction-attempt',headers:{authorization:'Bearer '+auth},payload:body}),reserve={...base,action:'reserve',request:c.request,witness:c.witness};
 assert.equal((await call(reserve,'wrong')).statusCode,401);assert.equal((await call({...reserve,execution_lease:{owner:'old',generation:1}})).statusCode,422);
 const r=await call(reserve);assert.equal(r.statusCode,200,r.body);const binding={...base,fence_id:r.json().receipt.fence_id};assert.equal(r.json().receipt.execution_authorized,false);
 const first=await call({...binding,action:'dispatch'});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().receipt.dispatch_allowed,true);assert.equal((await call({...binding,action:'dispatch'})).json().receipt.dispatch_allowed,false);
 c.newInput();const settled=await call({...binding,action:'settle',usage:{inputTokens:20,outputTokens:5,totalTokens:25}});assert.equal(settled.statusCode,200,settled.body);assert.equal(settled.json().receipt.actual_tokens,'25');assert.equal(settled.json().receipt.execution_authorized,false);assert.equal((await call({...binding,action:'read',owner_id:'foreign'})).statusCode,409);
});
