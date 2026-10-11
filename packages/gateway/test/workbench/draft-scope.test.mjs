import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
test('draft namespace is stable only for the authenticated owner and does not disclose the CSRF secret',async t=>{
 const service=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/draft-scope',uploadRoot:'.test-tmp/draft-scope-uploads',csrfToken:'test-draft-scope-authentication'});
 t.after(()=>{service.db.close();return service.app.close();});
 const get=owner=>service.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':owner}});
 const a=await get('alice'),again=await get('alice'),b=await get('bob');
 assert.match(a.headers['x-workbench-draft-scope']??'',/^[a-f0-9]{64}$/);
 assert.equal(a.headers['x-workbench-draft-scope'],again.headers['x-workbench-draft-scope']);
 assert.notEqual(a.headers['x-workbench-draft-scope'],b.headers['x-workbench-draft-scope']);
 assert.ok(!a.headers['x-workbench-draft-scope'].includes('authentication'));
});
