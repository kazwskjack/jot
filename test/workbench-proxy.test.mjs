import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../src/server.mjs';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

test('static application roots normalize trailing separators on Windows',async t=>{
 const base=resolve('.test-tmp/static-tests');await mkdir(base,{recursive:true});const folder=await mkdtemp(join(base,'case-'));
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',publicRoot:folder+'/'});
 t.after(async()=>{await service.close();await rm(folder,{recursive:true,force:true});});
 await writeFile(join(folder,'index.html'),'<h1>Jot workbench entry</h1>');
 const response=await service.app.inject({url:'/'});assert.equal(response.statusCode,200,response.body);assert.match(response.body,/Jot workbench entry/);
});

test('workbench forwarding fixes owner server-side and keeps gateway authentication private',async t=>{
 const requests=[];
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({agent_id:'agent-fixture'}),{status:201,headers:{'content-type':'application/json','x-csrf-token':'test-upstream-auth'}});}}});
 t.after(()=>service.close());const csrf=(await service.app.inject({url:'/api/capabilities'})).json().csrf;
 const request={method:'POST',url:'/workbench-api/v1/agents',payload:{name:'Writer'},headers:{'x-csrf-token':csrf,'x-user-id':'forged-owner','idempotency-key':'test-retry'}};
 const response=await service.app.inject(request);assert.equal(response.statusCode,201,response.body);
 assert.equal(requests[0].init.headers['x-user-id'],'local-user');assert.equal(requests[0].init.headers['x-csrf-token'],'test-upstream-auth');assert.equal(requests[0].init.headers['idempotency-key'],'test-retry');
 assert.equal(response.headers['x-csrf-token'],undefined);assert.equal(response.body.includes('test-upstream-auth'),false);
 assert.equal((await service.app.inject({...request,headers:{'x-csrf-token':'wrong'}})).statusCode,403);
 assert.equal((await service.app.inject({...request,headers:{...request.headers,origin:'https://evil.example'}})).statusCode,403);assert.equal(requests.length,1);
});
test('workbench can be disabled and configured upstream cannot escape loopback',async t=>{
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files'});t.after(()=>service.close());
 assert.equal((await service.app.inject({url:'/workbench-api/v1/capabilities'})).statusCode,503);
 await assert.rejects(()=>buildServer({demo:true,database:':memory:',workbench:{url:'https://example.com',owner:'local-user',csrf:'test-upstream-auth'}}),/invalid_workbench_config/);
});
test('workbench file download preserves binary bytes',async t=>{
 const bytes=new Uint8Array([0,255,128,80,75]);
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async()=>new Response(bytes,{headers:{'content-type':'application/octet-stream'}})}});t.after(()=>service.close());
 const result=await service.app.inject({url:'/workbench-api/v1/artifacts/file/download'});assert.equal(result.statusCode,200);assert.deepEqual(result.rawPayload,Buffer.from(bytes));
});
test('workbench forwards the exact replay cursor without numeric conversion',async t=>{
 let cursor;
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async(url,init)=>{cursor=init.headers['last-event-id'];return new Response('{}');}}});t.after(()=>service.close());
 await service.app.inject({url:'/workbench-api/v1/conversations/role/events',headers:{'last-event-id':'9007199254740994'}});assert.equal(cursor,'9007199254740994');
});
test('workbench exposes only a well-formed authenticated draft namespace on capabilities',async t=>{
 let scope='a'.repeat(64);
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async()=>new Response('{}',{headers:{'x-workbench-draft-scope':scope,'x-csrf-token':'test-upstream-auth'}})}});t.after(()=>service.close());
 assert.equal((await service.app.inject({url:'/workbench-api/v1/capabilities'})).headers['x-workbench-draft-scope'],scope);
 assert.equal((await service.app.inject({url:'/workbench-api/v1/agents'})).headers['x-workbench-draft-scope'],undefined);
 scope='invalid';assert.equal((await service.app.inject({url:'/workbench-api/v1/capabilities'})).headers['x-workbench-draft-scope'],undefined);
});

test('workbench binary upload forwards exact bytes and owner/auth without enabling arbitrary PUT routes',async t=>{
 const bytes=Buffer.from([0,255,128,80,75,10]),calls=[];
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async(url,init)=>{calls.push({url,init});return new Response(null,{status:204});}}});t.after(()=>service.close());const csrf=(await service.app.inject({url:'/api/capabilities'})).json().csrf;
 const request={method:'PUT',url:'/workbench-api/v1/uploads/test-upload/content',payload:bytes,headers:{'content-type':'application/octet-stream','x-csrf-token':csrf,'x-user-id':'forged-owner','idempotency-key':'test-upload-bytes'}};
 const response=await service.app.inject(request);assert.equal(response.statusCode,204,response.body);assert.deepEqual(calls[0].init.body,bytes);assert.equal(calls[0].init.headers['content-type'],'application/octet-stream');assert.equal(calls[0].init.headers['x-user-id'],'local-user');assert.equal(calls[0].init.headers['x-csrf-token'],'test-upstream-auth');assert.equal(calls[0].url,'http://127.0.0.1:18831/v1/uploads/test-upload/content');
 assert.equal((await service.app.inject({...request,headers:{...request.headers,'x-csrf-token':'wrong'}})).statusCode,403);
 assert.equal((await service.app.inject({...request,headers:{...request.headers,origin:'https://evil.example'}})).statusCode,403);
 assert.equal((await service.app.inject({...request,headers:{...request.headers,'content-length':'104857601'}})).statusCode,413);
 assert.equal((await service.app.inject({...request,headers:{...request.headers,'content-type':'application/json'},payload:{bad:true}})).statusCode,415);
 assert.ok((await service.app.inject({...request,url:'/workbench-api/v1/agents/role'})).statusCode>=400);assert.equal(calls.length,1);
});

test('workbench upload completion keeps its JSON body and does not admit binary JSON operations',async t=>{
 let received;
 const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:'http://127.0.0.1:18831',owner:'local-user',csrf:'test-upstream-auth',fetch:async(url,init)=>{received={url,init};return new Response('{"artifact_id":"test-file"}',{status:201});}}});t.after(()=>service.close());const csrf=(await service.app.inject({url:'/api/capabilities'})).json().csrf;
 const response=await service.app.inject({method:'POST',url:'/workbench-api/v1/uploads/test-upload/complete',headers:{'x-csrf-token':csrf},payload:{sha256:'a'.repeat(64)}});assert.equal(response.statusCode,201,response.body);assert.equal(received.init.body,JSON.stringify({sha256:'a'.repeat(64)}));
 const bad=await service.app.inject({method:'POST',url:'/workbench-api/v1/agents',headers:{'x-csrf-token':csrf,'content-type':'application/octet-stream'},payload:Buffer.from('bad')});assert.equal(bad.statusCode,415);
});

test('the actual loopback gateway accepts a BFF upload and the same owned attachment in a chat message',async t=>{
 const {buildServer:buildGateway}=await import('../packages/gateway/src/server.ts'),gateway=await buildGateway({databasePath:':memory:',workspaces:['shared'],uploadRoot:resolve('.test-tmp/proxy-upload/files'),templateRoot:resolve('packages/gateway/file-engine/templates'),csrfToken:'test-upstream-auth',allowedOrigins:['http://127.0.0.1:3057']});
 const address=await gateway.app.listen({host:'127.0.0.1',port:0});const service=await buildServer({demo:true,database:':memory:',root:'.test-tmp/proxy-files',workbench:{url:address,owner:'local-user',csrf:'test-upstream-auth'}});t.after(async()=>{await service.close();await gateway.app.close();gateway.db.close();});
 const conversation=gateway.conversations.create('local-user',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),host='127.0.0.1:3057',csrf=(await service.app.inject({url:'/api/capabilities',headers:{host}})).json().csrf,headers={host,'x-csrf-token':csrf,'idempotency-key':'test-upload-bff'};
 const bytes=Buffer.from('Synthetic attachment.\n'),sha=createHash('sha256').update(bytes).digest('hex');
 const initialized=await service.app.inject({method:'POST',url:`/workbench-api/v1/conversations/${conversation.conversation_id}/uploads`,headers,payload:{file_name:'test-note.txt',media_type:'text/plain',size_bytes:bytes.length,sha256:sha}});assert.equal(initialized.statusCode,201,initialized.body);const id=initialized.json().upload_id;
 const put=await service.app.inject({method:'PUT',url:`/workbench-api/v1/uploads/${id}/content`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(put.statusCode,204,put.body);
 const completed=await service.app.inject({method:'POST',url:`/workbench-api/v1/uploads/${id}/complete`,headers,payload:{sha256:sha}});assert.equal(completed.statusCode,201,completed.body);const artifact=completed.json();assert.equal(artifact.sha256,sha);assert.equal(artifact.origin,'upload');
 const message=await service.app.inject({method:'POST',url:`/workbench-api/v1/conversations/${conversation.conversation_id}/messages`,headers:{...headers,'idempotency-key':'test-message-upload'},payload:{client_message_id:'test-message-upload',content:[{type:'text',text:'Read this attachment'},{type:'file',artifact_id:artifact.artifact_id}]}});assert.equal(message.statusCode,202,message.body);
 const downloaded=await service.app.inject({url:`/workbench-api/v1/artifacts/${artifact.artifact_id}/download`,headers:{host}});assert.equal(downloaded.statusCode,200,downloaded.body);assert.deepEqual(downloaded.rawPayload,bytes);
 const snapshot=await service.app.inject({url:`/workbench-api/v1/conversations/${conversation.conversation_id}/snapshot`,headers:{host}});assert.equal(snapshot.statusCode,200,snapshot.body);assert.deepEqual(snapshot.json().messages[0].attachments,[artifact.artifact_id]);
 assert.equal((await gateway.app.inject({url:`/v1/artifacts/${artifact.artifact_id}`,headers:{'x-user-id':'other-user'}})).statusCode,404);assert.equal(gateway.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
