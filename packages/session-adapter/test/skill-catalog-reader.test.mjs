import test from 'node:test';import assert from 'node:assert/strict';
const module=await import('../skill-catalog-reader.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const scope={owner_id:'alice',project_id:'project',workspace_id:'workspace',agent_id:'role',run_id:'run',session_ref:'session',capability_epoch:1};
function fixture(){
 const session={id:'session',header:{cwd:'E:/synthetic-project'}},binding={runId:'run',sessionRef:'session'};
 const agent={id:'session',session,ctx:{get:key=>key==='skills'?skills:fs}},state={agent,reads:0,guards:0,loaded:[]};
 const summary={name:'notes',description:'Notes',source:'project-dsh',provider:'filesystem',invocation:{userInvocable:true,modelInvocable:true},resourceBase:{kind:'directory',path:'E:/synthetic-project/notes'}};
 const skills={snapshot:async()=>{state.reads++;return {complete:true,skills:[summary]};},get:async name=>{state.loaded.push(name);return {...summary,name,content:'Notes',resourceBase:{kind:'directory',path:'E:/synthetic-project/notes'}};}};
 const fs={resolve:async(path,options)=>({path:path.startsWith('E:/')?path:`${options?.cwd}/${path}`}),contains:(parent,child)=>child.path.startsWith(parent.path+'/'),
  stat:async target=>target.path.endsWith('/notes')?{type:'directory',size:0,version:'v1'}:{type:'file',size:14,version:'v1'},
  readBytes:async()=>Buffer.from('Notes resource','utf8')};
 const options={agents:{get:()=>state.agent},sessions:{get:()=>session},
  bridge:{bindingFor:()=>binding,guard:async()=>{state.guards++;},request:async()=>({context:{...scope}})}};
 return {options,state,scope};
}
test('Host catalog resolves only the current original Agent and rechecks original guard',async()=>{
 assert.equal(typeof module.createSkillCatalogReader,'function');const f=fixture();
 const view=await module.createSkillCatalogReader(f.options)({scope,signal:new AbortController().signal});
 assert.equal(view.catalog.items[0].name,'notes');assert.deepEqual(view.scope,scope);assert.ok(f.state.guards>=2);assert.deepEqual(f.state.loaded,[]);
});
test('Host catalog rejects owner substitution and replaced Agent without leaking a partial view',async()=>{
 assert.equal(typeof module.createSkillCatalogReader,'function');const f=fixture(),read=module.createSkillCatalogReader(f.options);
 await assert.rejects(()=>read({scope:{...scope,owner_id:'mallory'}}),/skill_catalog_scope_forbidden/);assert.equal(f.state.reads,0);
 f.options.bridge.guard=async()=>{if(++f.state.guards===2)f.state.agent={...f.state.agent};};
 await assert.rejects(()=>read({scope}),/skill_catalog_scope_changed/);
});
test('Host catalog requires the original Agent and guard but no custom read gate',async()=>{
 assert.equal(typeof module.createSkillCatalogReader,'function');const f=fixture();
 assert.throws(()=>module.createSkillCatalogReader({...f.options,bridge:undefined}),/skill_catalog_host_unavailable/);
 assert.doesNotThrow(()=>module.createSkillCatalogReader({...f.options,readGate:undefined}));
 f.state.agent=undefined;await assert.rejects(()=>module.createSkillCatalogReader(f.options)({scope}),/skill_catalog_scope_changed/);
});

test('Host command accepts only a read scope envelope and delegates once without replay',async()=>{
 assert.equal(typeof module.createSkillCatalogCommand,'function');
 const f=fixture(),reader=module.createSkillCatalogReader(f.options),command=module.createSkillCatalogCommand(reader),body={protocol:1,scope};
 assert.throws(()=>module.createSkillCatalogCommand(async()=>({scope,catalog:{}})),/skill_catalog_host_unavailable/);
 const result=await command(body);assert.deepEqual(result.scope,scope);assert.equal(result.catalog.items[0].name,'notes');
 const before={reads:f.state.reads,guards:f.state.guards};
 for(const invalid of [{...body,action:'install'},{...body,operation:'execute'},{...body,protocol:2},{...body,scope:{...scope,owner_id:undefined}}])
  await assert.rejects(()=>command(invalid));
 assert.deepEqual({reads:f.state.reads,guards:f.state.guards},before);
});

test('Host selected-resource reader is bound to the original Agent and exactly one requested resource',async()=>{
 assert.equal(typeof module.createSkillResourceReader,'function');assert.equal(typeof module.createSkillResourceCommand,'function');
 const f=fixture(),reader=module.createSkillResourceReader(f.options),command=module.createSkillResourceCommand(reader);
 const result=await command({protocol:1,scope,skill_name:'notes',relative_path:'references/help.md'});
 assert.deepEqual(result.scope,scope);assert.equal(result.resource.text,'Notes resource');
 assert.equal(result.resource.name,'notes');assert.equal(result.resource.relativePath,'references/help.md');
 assert.equal(result.resource.execution_authorized,false);
 assert.deepEqual(f.state.loaded,[]);
 await assert.rejects(()=>command({protocol:1,scope,skill_name:'notes',relative_path:'../outside'}));
 assert.throws(()=>module.createSkillResourceCommand(async()=>({})),/skill_catalog_host_unavailable/);
});

