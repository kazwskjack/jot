import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';
import {readSkillCatalogView} from '../../packages/skills/catalog-view.js';
let compiled;
const outputRoot=await mkdtemp(join(process.cwd(),'.test-tmp','m1601-ui-'));test.after(()=>rm(outputRoot,{recursive:true,force:true}));
async function api(){
 if(!compiled){const root=fileURLToPath(new URL('../../',import.meta.url)),outfile=join(outputRoot,'harness.cjs');await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {SkillCatalogView} from './web/jot/SkillCatalogPanel.tsx';export {readSkillCatalog,readSelectedSkillResource,catalogForScope} from './web/jot/skill-catalog-client.ts';export {request as seed} from './web/jot/client.ts';export const render=value=>renderToStaticMarkup(<SkillCatalogView value={value} paths={{notes:'resources/help.md'}} resources={{}} onPathChange={()=>{}} onReadResource={()=>{}} onUseSkill={()=>{}}/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:true,outfile,platform:'node',format:'cjs',jsx:'automatic'});compiled=createRequire(import.meta.url)(outfile);}return compiled;
}
const scope='a'.repeat(64),viewScope={run_id:'run',conversation_id:'chat',workspace_id:'workspace',project_id:'project',agent_id:'role',capability_epoch:1};
async function view(userInvocable=true){const summary={name:'notes',description:'<script>untrusted</script>',source:'user-dsh',provider:'filesystem',invocation:{userInvocable,modelInvocable:true}};return {...await readSkillCatalogView({skills:{snapshot:async()=>({complete:true,skills:[summary]}),get:async()=>({...summary,metadata:{version:'2.0'},content:'Notes'})}}),viewScope};}
test('catalog UI client consumes only the selected run GET and verifies its observation hash',async t=>{
 const m=await api(),value=await view(),prior=globalThis.fetch;const calls=[];t.after(()=>globalThis.fetch=prior);
 globalThis.fetch=async(url,init)=>{calls.push({url,method:init.method});return url.endsWith('/capabilities')?Response.json({},{headers:{'x-workbench-draft-scope':scope}}):Response.json(value);};
 await m.seed('/capabilities');const got=await m.readSkillCatalog('run',scope,new AbortController().signal);assert.equal(got.items[0].name,'notes');assert.equal('bodySha256' in got.items[0],false);
 assert.deepEqual(calls.at(-1),{url:'/workbench-api/v1/runs/run/skills',method:'GET'});
 value.catalogSha256='f'.repeat(64);await assert.rejects(()=>m.readSkillCatalog('run',scope,new AbortController().signal),/skill_catalog_invalid/);
});
test('catalog UI refuses an owner change while the read is in flight',async t=>{
 const m=await api(),value=await view(),prior=globalThis.fetch;let current=scope,release;const blocked=new Promise(resolve=>release=resolve);t.after(()=>globalThis.fetch=prior);
 globalThis.fetch=async url=>url.endsWith('/capabilities')?Response.json({},{headers:{'x-workbench-draft-scope':current}}):(await blocked,Response.json(value));
 await m.seed('/capabilities');const pending=m.readSkillCatalog('run',scope,new AbortController().signal);current='b'.repeat(64);await m.seed('/capabilities');release();
 await assert.rejects(()=>pending,/SKILL_CATALOG_SCOPE_CHANGED/);
});
test('catalog presenter exposes metadata and a selected read-only resource control',async()=>{
 const m=await api(),html=m.render(await view());assert.match(html,/user-dsh/);assert.match(html,/workspace/);assert.match(html,/读取所选资源/);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|安装|卸载/);
});
test('catalog rendering discards a previous owner or run before an effect can refresh',async()=>{
 const m=await api(),record={runId:'run',ownerScope:scope,value:await view()};
 assert.equal(m.catalogForScope(record,'run',scope),record);
 assert.equal(m.catalogForScope(record,'different-run',scope),null);
 assert.equal(m.catalogForScope(record,'run','b'.repeat(64)),null);
});
test('selected-resource UI client verifies one explicit resource and its digest',async t=>{
 const m=await api(),prior=globalThis.fetch,calls=[];t.after(()=>globalThis.fetch=prior);
 const text='help text',textSha256=createHash('sha256').update(text).digest('hex'),value={protocol:1,name:'notes',relativePath:'resources/help.md',text,textSha256,execution_authorized:false,viewScope};
 globalThis.fetch=async(url,init)=>{calls.push({url,method:init.method});return url.endsWith('/capabilities')?Response.json({},{headers:{'x-workbench-draft-scope':scope}}):Response.json(value);};
 await m.seed('/capabilities');const result=await m.readSelectedSkillResource('run',scope,'notes','resources/help.md',new AbortController().signal);
 assert.equal(result.text,text);assert.equal(result.execution_authorized,false);
 assert.deepEqual(calls.at(-1),{url:'/workbench-api/v1/runs/run/skills?name=notes&path=resources%2Fhelp.md',method:'GET'});
 value.relativePath='other.md';await assert.rejects(()=>m.readSelectedSkillResource('run',scope,'notes','resources/help.md',new AbortController().signal),/skill_catalog_invalid/);
 value.relativePath='resources/help.md';
 value.textSha256='f'.repeat(64);await assert.rejects(()=>m.readSelectedSkillResource('run',scope,'notes','resources/help.md',new AbortController().signal),/skill_catalog_invalid/);
});
test('catalog UI disables resource reads for skills DSH marks non-user-invocable',async()=>{
 const m=await api(),html=m.render(await view(false));assert.match(html,/<button type="button" disabled="">读取所选资源<\/button>/);
});
