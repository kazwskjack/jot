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
});
