import test from 'node:test';import assert from 'node:assert/strict';
import {createAdapterHandler} from '../index.js';

const token='catalog-adapter-test-token-0123456789abcdef';
const scope={owner_id:'alice',project_id:'project',workspace_id:'workspace',agent_id:'role',run_id:'run',session_ref:'session',capability_epoch:1};
const request=(handler,{method='POST',body={protocol:1,scope},authorization=`Bearer ${token}`,signal=new AbortController().signal}={})=>
 handler({method,url:new URL('http://127.0.0.1/v1/skills/catalog'),headers:{authorization},body,signal});
const resourceRequest=(handler,{method='POST',body={protocol:1,scope,skill_name:'notes',relative_path:'references/help.md'},authorization=`Bearer ${token}`,signal=new AbortController().signal}={})=>
 handler({method,url:new URL('http://127.0.0.1/v1/skills/resource'),headers:{authorization},body,signal});

test('Host catalog route is bearer-authenticated, read-only and delegates the exact protocol body once',async()=>{
 const calls=[];
 const handler=createAdapterHandler({token,controller:{},skillCatalogCommand:async(body,{signal})=>{
  calls.push({body,signal});return {scope:body.scope,catalog:{protocol:1,execution_authorized:false}};
 }});
 assert.equal((await request(handler,{authorization:'Bearer wrong'})).status,401);
 assert.equal((await request(handler,{method:'GET'})).status,405);
 for(const body of [{protocol:1,scope,action:'install'},{protocol:2,scope},{protocol:1,scope,owner_id:'mallory'}])
  assert.equal((await request(handler,{body})).status,422);
 assert.equal(calls.length,0);
 const signal=new AbortController().signal,result=await request(handler,{signal});
 assert.equal(result.status,200);assert.deepEqual(result.value,{scope,catalog:{protocol:1,execution_authorized:false}});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{protocol:1,scope});assert.equal(calls[0].signal,signal);
});

test('Host catalog route remains unavailable without the original reader composition',async()=>{
 const handler=createAdapterHandler({token,controller:{}});
 const response=await request(handler);
 assert.equal(response.status,503);assert.deepEqual(response.value,{error:'skill_catalog_unavailable'});
});

test('Host selected-resource route accepts one read-only selection under the existing bearer',async()=>{
 const calls=[],resource={protocol:1,name:'notes',relativePath:'references/help.md',text:'Read only',textSha256:'0'.repeat(64),execution_authorized:false};
 const handler=createAdapterHandler({token,controller:{},skillResourceCommand:async(body,{signal})=>{
  calls.push({body,signal});return {scope:body.scope,resource};
 }});
 assert.equal((await resourceRequest(handler,{authorization:'Bearer wrong'})).status,401);
 assert.equal((await resourceRequest(handler,{method:'GET'})).status,405);
 for(const body of [{protocol:1,scope,skill_name:'notes',relative_path:'x',action:'install'},
  {protocol:1,scope,skill_name:'notes'},{protocol:2,scope,skill_name:'notes',relative_path:'x'}])
  assert.equal((await resourceRequest(handler,{body})).status,422);
 assert.equal(calls.length,0);
 const signal=new AbortController().signal,result=await resourceRequest(handler,{signal});
 assert.equal(result.status,200);assert.deepEqual(result.value,{scope,resource});
 assert.deepEqual(calls[0].body,{protocol:1,scope,skill_name:'notes',relative_path:'references/help.md'});assert.equal(calls[0].signal,signal);
});
