import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {mkdtempSync,rmSync} from 'node:fs';import {resolve} from 'node:path';
import Fastify from 'fastify';
import {readSkillCatalogView} from '../../../skills/catalog-view.js';
import {registerSkillCatalogRoutes} from '../../src/skills/catalog-routes.ts';
const module=await import('../../src/skills/catalog.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
function fixture(t){
 const root=mkdtempSync(resolve('.test-tmp/m1601-gateway-')),db=openProductDatabase(':memory:');
 const workbench=new WorkbenchService(db,{workspaceIds:['workspace'],root});
 const role=workbench.createAgent('alice',{name:'Reader',instructions:'Read',workspace_id:'workspace',allowed_tools:[]});
 const run=workbench.enqueueAgentMessage('alice',role.agent_id,{client_message_id:'catalog-fixture',text:'Synthetic request'});
 const session=new SessionBindingRepository(db).getOrCreate('alice',run.conversation_id);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {db,workbench,run,session,role};
}
test('Gateway catalog derives original owner/run/session context without creating a binding',async t=>{
 assert.equal(typeof module.SkillCatalogService,'function');const f=fixture(t);let input;
 const host={read:async value=>{input=value;return {scope:value.scope,catalog:{protocol:1,complete:true,items:[],catalogSha256:'0'.repeat(64),execution_authorized:false}};}};
 const service=new module.SkillCatalogService(f.db,f.workbench,host);
 await assert.rejects(()=>service.read('mallory',f.run.run_id),/skill_catalog_scope_forbidden/);assert.equal(input,undefined);
 await assert.rejects(()=>service.read('alice',f.run.run_id),/skill_catalog_invalid/);
 assert.equal(input.scope.session_ref,f.session.session_id);assert.equal(input.scope.owner_id,'alice');assert.equal(input.scope.agent_id,f.role.agent_id);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM ga_harness_session_bindings').get().n,1);
});
async function catalog(){return readSkillCatalogView({skills:{snapshot:async()=>({complete:true,skills:[]}),get:async()=>undefined}});}
test('Gateway candidate GET route reads the live catalog with original Workbench/SQLite scope',async t=>{
 const f=fixture(t),view=await catalog();let calls=0;
 const service=new module.SkillCatalogService(f.db,f.workbench,{read:async({scope})=>{calls++;return {scope,catalog:view};}});
 const app=Fastify();registerSkillCatalogRoutes(app,service,request=>String(request.headers['x-test-owner']));t.after(()=>app.close());
 const path=`/v1/runs/${f.run.run_id}/skills`;
 const refused=await app.inject({method:'GET',url:path,headers:{'x-test-owner':'mallory'}});assert.equal(refused.statusCode,404);assert.equal(calls,0);
 const result=await app.inject({method:'GET',url:path,headers:{'x-test-owner':'alice'}});assert.equal(result.statusCode,200);
 const body=result.json();assert.equal(body.viewScope.agent_id,f.role.agent_id);assert.equal(body.viewScope.run_id,f.run.run_id);
 assert.equal(body.viewScope.owner_id,undefined);assert.equal(body.viewScope.session_ref,undefined);assert.equal(body.execution_authorized,false);
 assert.equal((await app.inject({method:'POST',url:path,headers:{'x-test-owner':'alice'}})).statusCode,404);
});
test('Gateway rechecks original session binding after a delayed catalog observation',async t=>{
 const f=fixture(t),view=await catalog();
 const service=new module.SkillCatalogService(f.db,f.workbench,{read:async({scope})=>{
  f.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('substituted',f.run.conversation_id);
  return {scope,catalog:view};
 }});
 await assert.rejects(()=>service.read('alice',f.run.run_id),/skill_catalog_scope_changed/);
});

test('Gateway reads only the selected relative resource under the existing run and owner binding',async t=>{
 assert.equal(typeof module.SkillCatalogService,'function');const f=fixture(t),calls=[];
 const resource={protocol:1,name:'notes',relativePath:'references/help.md',text:'Read-only text',
  textSha256:createHash('sha256').update('Read-only text').digest('hex'),execution_authorized:false};
 const host={read:async({scope})=>({scope,catalog:await catalog()}),readResource:async input=>{calls.push(input);return {scope:input.scope,resource};}};
 const service=new module.SkillCatalogService(f.db,f.workbench,host);
 await assert.rejects(()=>service.readResource('mallory',f.run.run_id,'notes','references/help.md'),/skill_catalog_scope_forbidden/);
 assert.equal(calls.length,0);
 const app=Fastify();registerSkillCatalogRoutes(app,service,request=>String(request.headers['x-test-owner']));t.after(()=>app.close());
 const response=await app.inject({method:'GET',url:`/v1/runs/${f.run.run_id}/skills?name=notes&path=references%2Fhelp.md`,headers:{'x-test-owner':'alice'}});
 assert.equal(response.statusCode,200);assert.equal(response.json().text,'Read-only text');assert.equal(response.json().execution_authorized,false);
 assert.equal(response.json().viewScope.session_ref,undefined);assert.equal(calls.length,1);
 assert.equal(calls[0].skill_name,'notes');assert.equal(calls[0].relative_path,'references/help.md');
 const substitutedResource=new module.SkillCatalogService(f.db,f.workbench,{read:host.read,readResource:async input=>({scope:input.scope,resource:{...resource,relativePath:'references/other.md'}})});
 await assert.rejects(()=>substitutedResource.readResource('alice',f.run.run_id,'notes','references/help.md'),/skill_catalog_scope_changed/);
 const changedBinding=new module.SkillCatalogService(f.db,f.workbench,{read:host.read,readResource:async input=>{
  f.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('substituted',f.run.conversation_id);
  return {scope:input.scope,resource};
 }});
 await assert.rejects(()=>changedBinding.readResource('alice',f.run.run_id,'notes','references/help.md'),/skill_catalog_scope_changed/);
});
