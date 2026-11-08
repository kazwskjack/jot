import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const module=await import('../../src/skills/catalog-adapter.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const scope={owner_id:'alice',project_id:'project',workspace_id:'workspace',agent_id:'role',run_id:'run',session_ref:'session',capability_epoch:1};
test('catalog transport uses the configured existing bearer and fixed read endpoint only',async()=>{
 assert.equal(typeof module.SkillCatalogAdapterClient,'function');let call;
 const client=new module.SkillCatalogAdapterClient('http://127.0.0.1:18841','synthetic-token-'.padEnd(32,'x'),async(url,init)=>{call={url,init};return Response.json({scope,catalog:{}});});
 assert.deepEqual(await client.read({scope}),{scope,catalog:{}});assert.equal(call.url,'http://127.0.0.1:18841/v1/skills/catalog');
 assert.equal(call.init.method,'POST');assert.equal(call.init.redirect,'error');assert.deepEqual(JSON.parse(call.init.body),{protocol:1,scope});
 assert.equal(JSON.stringify(client).includes('synthetic-token'),false);
});
test('catalog transport refuses external endpoints, oversized replies and pre-cancelled dispatch',async()=>{
 assert.equal(typeof module.SkillCatalogAdapterClient,'function');
 assert.throws(()=>new module.SkillCatalogAdapterClient('https://example.com','x'.repeat(32)),/skill_catalog_adapter_configuration_invalid/);
 let calls=0;const client=new module.SkillCatalogAdapterClient('http://127.0.0.1:18841','x'.repeat(32),async()=>{calls++;return new Response('x'.repeat(8*1024*1024+1));});
 await assert.rejects(()=>client.read({scope}),/skill_catalog_adapter_invalid/);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>client.read({scope,signal:abort.signal}),e=>e.name==='AbortError');assert.equal(calls,1);
});
test('catalog transport preserves only safe Host authorization and scope conflict classes',async()=>{
 assert.equal(typeof module.SkillCatalogAdapterClient,'function');
 for(const [status,code] of [[404,'skill_catalog_scope_forbidden'],[409,'skill_catalog_scope_changed']]){
  const client=new module.SkillCatalogAdapterClient('http://127.0.0.1:18841','x'.repeat(32),async()=>Response.json({error:'private host detail'},{status}));
  await assert.rejects(()=>client.read({scope}),new RegExp(code));
 }
});
test('selected-resource transport uses only the authenticated local Host read endpoint',async()=>{
 assert.equal(typeof module.SkillCatalogAdapterClient,'function');let call;
 const client=new module.SkillCatalogAdapterClient('http://127.0.0.1:18841','synthetic-token-'.padEnd(32,'x'),async(url,init)=>{
  call={url,init};return Response.json({scope,resource:{protocol:1,name:'notes',relativePath:'guide.md',text:'help',textSha256:'a'.repeat(64),execution_authorized:false}});
 });
 const signal=new AbortController().signal;
 const value=await client.readResource({scope,skill_name:'notes',relative_path:'guide.md',signal});
 assert.equal(call.url,'http://127.0.0.1:18841/v1/skills/resource');assert.equal(call.init.method,'POST');
 assert.equal(call.init.cache,'no-store');assert.ok(call.init.signal instanceof AbortSignal);assert.equal(JSON.parse(call.init.body).skill_name,'notes');
 assert.equal(JSON.parse(call.init.body).relative_path,'guide.md');assert.deepEqual(value.scope,scope);
});
test('selected-resource transport accepts the maximum UTF-8 resource after JSON escaping',async()=>{
 const text='\u0000'.repeat(64*1024),resource={protocol:1,name:'notes',relativePath:'guide.md',text,
  textSha256:createHash('sha256').update(text,'utf8').digest('hex'),execution_authorized:false};
 const response=Response.json({scope,resource});assert.ok((await response.clone().arrayBuffer()).byteLength>256*1024);
 const client=new module.SkillCatalogAdapterClient('http://127.0.0.1:18841','x'.repeat(32),async()=>response);
 const result=await client.readResource({scope,skill_name:'notes',relative_path:'guide.md'});
 assert.equal(result.resource.text,text);
});
