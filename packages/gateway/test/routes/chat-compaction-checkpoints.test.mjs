import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {settledCheckpointFixture} from '../support/chat-checkpoint-fixture.mjs';
test('native checkpoint publication is bearer-only, exact-scope and does not create a message or grant execution',async t=>{
 const token=randomBytes(32).toString('hex'),f=await buildServer({templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(32).toString('hex')});t.after(async()=>{await f.app.close();f.db.close();});
 const c=settledCheckpointFixture(t,{db:f.db}),body={action:'publish',...c.scope,...c.input},call=(payload=body,auth=token)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/chat-compaction-checkpoint',headers:{authorization:'Bearer '+auth},payload});
 assert.equal((await call(body,'wrong')).statusCode,401);assert.equal((await call({...body,execution_lease:{owner:'old',generation:1}})).statusCode,422);assert.equal((await call({...body,owner_id:'foreign'})).statusCode,409);
 const before=f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,response=await call();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().checkpoint.execution_authorized,false);assert.deepEqual((await call()).json(),response.json());assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,before);
 const read={action:'read',...c.scope,...c.binding},changes=f.db.prepare('SELECT total_changes() n').get().n;assert.equal((await call(read,'wrong')).statusCode,401);const historical=await call(read);assert.equal(historical.statusCode,200,historical.body);assert.deepEqual(historical.json(),response.json());assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal((await call({...read,summary_text:c.text})).statusCode,422);
});

test('internal attempt inspection authenticates and returns only exact original records without changing state',async t=>{
 const token=randomBytes(32).toString('hex'),f=await buildServer({templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(32).toString('hex')});t.after(async()=>{await f.app.close();f.db.close();});
 const c=settledCheckpointFixture(t,{db:f.db}),body={action:'inspect',...c.scope,intent_id:c.intent.intent_id},call=(payload=body,auth=token)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/chat-compaction-attempt',headers:{authorization:'Bearer '+auth},payload});
 assert.equal((await call(body,'wrong')).statusCode,401);assert.equal((await call({...body,owner_id:'foreign'})).statusCode,409);assert.equal((await call({...body,attempt_id:'caller-selected'})).statusCode,422);
 const changes=f.db.prepare('SELECT total_changes() n').get().n,response=await call();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().attempt.execution_authorized,false);assert.equal(response.json().attempt.receipt.dispatch_allowed,false);assert.deepEqual(response.json().attempt.native_witness,JSON.parse(f.db.prepare('SELECT witness_json FROM ga_chat_compaction_attempts').get().witness_json));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});
