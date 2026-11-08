import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';

test('the authenticated ordinary fork-context route is mounted when fork storage is enabled',async t=>{
 const token='conversation-fork-context-test-token-0123456789';
 const service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,
  conversationForkSourceClient:{inspectConversationForkSource:async()=>{throw Error('not used by the context route');}}});
 t.after(async()=>{await service.app.close();if(service.db.isOpen)service.db.close();});
 const call=(headers,payload={})=>service.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-fork-context',headers,payload});
 assert.equal((await call({},{})).statusCode,401);
 const malformed=await call({authorization:'Bearer '+token},{});
 assert.equal(malformed.statusCode,422,malformed.body);
 assert.deepEqual(malformed.json(),{error:{code:'FORK_CONTEXT_INPUT_INVALID'}});
});
