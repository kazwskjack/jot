import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../src/server.mjs';
test('shared file writes use the owned JSON route and cannot broaden binary or arbitrary PUT access',async t=>{
 const calls=[],service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({path:'notes/test.md',version:1,size:5,sha256:'0'.repeat(64)}));}}});t.after(()=>service.close());
 const csrf=(await service.app.inject({url:'/api/capabilities'})).json().csrf,request={method:'PUT',url:'/workbench-api/v1/workspaces/shared/files',headers:{'content-type':'application/json','x-csrf-token':csrf,'x-user-id':'forged-owner','idempotency-key':'test-file-write'},payload:{project_id:'test-project',path:'notes/test.md',content:'hello',expected_version:0}};
 const response=await service.app.inject(request);assert.equal(response.statusCode,200,response.body);assert.equal(calls[0].url,'http://127.0.0.1:18831/v1/workspaces/shared/files');assert.deepEqual(JSON.parse(calls[0].init.body),request.payload);assert.equal(calls[0].init.headers['x-user-id'],'local-user');assert.equal(calls[0].init.headers['idempotency-key'],'test-file-write');assert.equal(calls[0].init.headers['x-csrf-token'],'test-upstream-auth');
 assert.equal((await service.app.inject({...request,headers:{...request.headers,'x-csrf-token':'wrong'}})).statusCode,403);
 assert.equal((await service.app.inject({...request,headers:{...request.headers,origin:'https://evil.example'}})).statusCode,403);
 assert.equal((await service.app.inject({...request,headers:{...request.headers,'content-type':'application/octet-stream'},payload:Buffer.from('bad')})).statusCode,415);
 for(const url of ['/workbench-api/v1/agents/test-role','/workbench-api/v1/workspaces/%2e%2e/files','/workbench-api/v1/workspaces/shared/files/content'])assert.ok((await service.app.inject({...request,url})).statusCode>=400);
 assert.equal(calls.length,1);
});
