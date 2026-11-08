import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildServer} from '../../src/server.ts';

test('Memory Dream policy routes are owner scoped, versioned and explicitly enabled',async t=>{
 const csrf='memory-dream-route-csrf-token-1234567890',workbenchRoot=`.test-tmp/memory-dream-policy-${randomUUID()}`;
 const server=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot,csrfToken:csrf,allowedOrigins:['https://fixture.invalid']});
 t.after(async()=>{await server.app.close();if(server.db.isOpen)server.db.close();});
 const agent=server.workbench.createAgent('alice',{name:'Dream policy'}),url=`/v1/agents/${agent.agent_id}/memory-dream-policy`;
 const read=await server.app.inject({method:'GET',url,headers:{'x-user-id':'alice'}});
 assert.equal(read.statusCode,200,read.body);assert.equal(read.json().enabled,false);assert.equal(read.json().interval_seconds,3600);
 const headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':csrf,'idempotency-key':'memory-dream-enable-01','content-type':'application/json'};
 const input={expected_version:read.json().policy_version,enabled:true,interval_seconds:60};
 const update=await server.app.inject({method:'PATCH',url,headers,payload:input});
 assert.equal(update.statusCode,200,update.body);assert.equal(update.json().enabled,true);assert.equal(update.json().interval_seconds,60);assert.ok(update.json().next_due_at);
 const replay=await server.app.inject({method:'PATCH',url,headers,payload:input});assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),update.json());
 const stale=await server.app.inject({method:'PATCH',url,headers:{...headers,'idempotency-key':'memory-dream-stale-01'},payload:{expected_version:read.json().policy_version,enabled:false}});
 assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error.code,'MEMORY_DREAM_POLICY_VERSION_CONFLICT');
 const rejected=await server.app.inject({method:'PATCH',url,headers:{...headers,'idempotency-key':'memory-dream-extra-01'},payload:{expected_version:update.json().policy_version,enabled:true,private_scope:true}});
 assert.equal(rejected.statusCode,400,rejected.body);
});
