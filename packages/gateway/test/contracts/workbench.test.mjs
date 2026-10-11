import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ContractValidator } from '../../src/contracts/validator.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';
import { buildServer } from '../../src/server.ts';
const spec=()=>JSON.parse(readFileSync(new URL('../../contracts/openapi.json',import.meta.url),'utf8'));

test('task mailbox history declares its optional owned occurrence filter',()=>{
 const parameters=spec().paths['/v1/workspaces/{workspace_id}/agent-messages'].get.parameters;
 assert.deepEqual(parameters.find(p=>p.name==='occurrence_id').schema,{type:'string',minLength:1,maxLength:128});
 assert.equal(parameters.find(p=>p.name==='occurrence_id').in,'query');
 assert.equal(parameters.find(p=>p.name==='occurrence_id').required,false);
});
test('workbench and persistent route families expose request and response schemas',()=>{
  const v=new ContractValidator();
  for(const [method,path] of [['POST','/v1/agents'],['DELETE','/v1/agents/{agent_id}'],['GET','/v1/teams'],['GET','/v1/workspaces/{workspace_id}/files/content'],['POST','/v1/persistent-tasks'],['POST','/v1/persistent-tasks/{task_id}/occurrences/{occurrence_id}/cancel'],['POST','/v1/persistent-tasks/{task_id}/subtasks'],['GET','/v1/persistent-tasks/{task_id}/readiness']])assert.ok(v.operationFor(method,path),`${method} ${path}`);
});
test('public workbench capabilities expose only two reviewed tool IDs',()=>{
  const schemas=spec().components.schemas;assert.ok(schemas.WorkbenchCapabilities);
  const w=schemas.WorkbenchCapabilities.properties;
  assert.deepEqual(w.task_triggers.items.enum,['once','interval','page_change','daily','weekly','conversation_message','conversation_result']);
  assert.deepEqual(w.notification_channels.items.enum,['in_app']);
  assert.deepEqual(w.allowed_tools.items.enum,['universe_capabilities','universe_search']);
  assert.equal(w.execution_ready.type,'boolean');
});
test('new JSON-flow YAML path and schema blocks match JSON and have TypeScript declarations',()=>{
  const json=spec();const yaml=readFileSync(new URL('../../contracts/openapi.yaml',import.meta.url),'utf8');const types=readFileSync(new URL('../../contracts/types.ts',import.meta.url),'utf8');
  const seenSchemas=new Set();
  for(const line of yaml.split(/\r?\n/)){
    const path=line.match(/^  (\/v1\/(?:agents|teams|workspaces|persistent-tasks)[^:]*): (\{.*\})$/);
    if(path)assert.deepEqual(JSON.parse(path[2]),json.paths[path[1]],path[1]);
    const schema=line.match(/^    ([A-Za-z][A-Za-z0-9_]*): (\{.*\})$/);
    if(schema&&Object.hasOwn(json.components.schemas,schema[1])){assert.equal(seenSchemas.has(schema[1]),false,`duplicate schema: ${schema[1]}`);seenSchemas.add(schema[1]);assert.deepEqual(JSON.parse(schema[2]),json.components.schemas[schema[1]],schema[1]);assert.match(types,new RegExp(`export type ${schema[1]} =`));}
  }
  assert.match(yaml,/  \/v1\/persistent-tasks: \{/);assert.match(types,/workbench\?: WorkbenchCapabilities/);
});
test('live capabilities response validates safe tool IDs, readiness and disabled collaboration modes',async()=>{
  const base='.test-tmp';mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'contract-capability-'));
  const service=await buildServer({databasePath:join(directory,'fixture.sqlite'),workspaces:['ws'],workbenchRoot:join(directory,'workspace')});
  try{
    const response=await service.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':'alice'}});assert.equal(response.statusCode,200);
    const value=response.json();assert.equal(value.workbench.execution_ready,false);assert.equal(value.workbench.allowed_tools.length,2);
    assert.equal(value.workbench.task_readiness,true);
    const v=new ContractValidator();const op=v.operationFor('GET','/v1/capabilities');assert.equal(v.validateResponse(op,200,value).valid,true);
    const forged=structuredClone(value);forged.workbench.collaboration_modes.find(mode=>mode.id==='team').enabled=true;assert.equal(v.validateResponse(op,200,forged).valid,false);
    const unsafe=structuredClone(value);unsafe.workbench.allowed_tools.push('arbitrary_shell');assert.equal(v.validateResponse(op,200,unsafe).valid,false);
    for(const tool of ['universe_metric_query','universe_get_state','universe_cancel','universe_read_page','universe_research']){const legacy=structuredClone(value);legacy.workbench.allowed_tools.push(tool);assert.equal(v.validateResponse(op,200,legacy).valid,false,tool);}
  }finally{await service.app.close();service.db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
test('real workbench and task DTOs satisfy success schemas and reject owner spoofing and unsupported task triggers',async()=>{
  const base='.test-tmp';mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'contract-workbench-'));const db=openProductDatabase(join(dir,'fixture.sqlite'));
  try{
    const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(dir,'workspace')});const tasks=new PersistentTaskService(db,workbench);const v=new ContractValidator();
    const check=(method,path,status,value)=>{const op=v.operationFor(method,path);assert.ok(op,path);const result=v.validateResponse(op,status,value);assert.equal(result.valid,true,`${path}: ${JSON.stringify(result.errors)}`);};
    const a=workbench.createAgent('alice',{name:'Reader',instructions:'Read'});check('POST','/v1/agents',201,a);check('GET','/v1/agents',200,workbench.listAgents('alice'));
    check('GET','/v1/agents/{agent_id}/deletion-preview',200,workbench.deletionPreview('alice',a.agent_id));
    const team=workbench.createTeam('alice',{name:'Readers',member_ids:[a.agent_id]});check('POST','/v1/teams',201,team);check('GET','/v1/workspaces/{workspace_id}',200,workbench.getWorkspace('alice','ws'));
    const memory=workbench.saveMemory('alice','ws',{scope:'private',agent_id:a.agent_id,content:'Note'});check('POST','/v1/workspaces/{workspace_id}/memory',201,memory);
    const b=workbench.createAgent('alice',{name:'Writer'});const message=workbench.sendMessage('alice','ws',{sender_agent_id:a.agent_id,recipient_agent_id:b.agent_id,text:'Read this source',client_message_id:'message-1'});check('POST','/v1/workspaces/{workspace_id}/agent-messages',201,message);check('GET','/v1/workspaces/{workspace_id}/agent-messages',200,workbench.listMessages('alice','ws'));
    const file=workbench.writeFile('alice','ws',{project_id:a.project_id,path:'notes/read.txt',content:'Notes',expected_version:0});check('PUT','/v1/workspaces/{workspace_id}/files',200,file);check('GET','/v1/workspaces/{workspace_id}/files/content',200,workbench.readFile('alice','ws',a.project_id,'notes/read.txt'));
    const t=tasks.create('alice',{title:'Check',agent_id:a.agent_id,objective:'Check the source',trigger:{kind:'once'}});check('POST','/v1/persistent-tasks',201,t);
    const o=tasks.runNow('alice',t.task_id,'manual');check('POST','/v1/persistent-tasks/{task_id}/run-now',202,o);check('GET','/v1/persistent-tasks/{task_id}/occurrences',200,tasks.occurrences('alice',t.task_id));
    const sub=tasks.upsertSubtask('alice',t.task_id,{title:'Read'});check('POST','/v1/persistent-tasks/{task_id}/subtasks',200,sub);
    const readiness=tasks.readiness('alice',t.task_id);check('GET','/v1/persistent-tasks/{task_id}/readiness',200,readiness);
    const forgedReadiness={...readiness,owner_id:'alice'};assert.equal(v.validateResponse(v.operationFor('GET','/v1/persistent-tasks/{task_id}/readiness'),200,forgedReadiness).valid,false);
    const create=v.operationFor('POST','/v1/persistent-tasks');assert.equal(v.validateRequest(create,{title:'T',agent_id:a.agent_id,objective:'O',trigger:{kind:'daily'}}).valid,false);
    const role=v.operationFor('POST','/v1/agents');assert.equal(v.validateRequest(role,{name:'Reader',owner_id:'bob'}).valid,false);
    assert.equal(v.validateRequest(role,{name:'Reader',allowed_tools:['arbitrary_shell']}).valid,false);
    for(const tool of ['universe_metric_query','universe_get_state','universe_cancel','universe_read_page','universe_research'])assert.equal(v.validateRequest(role,{name:'Reader',allowed_tools:[tool]}).valid,false,tool);
  }finally{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
