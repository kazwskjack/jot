import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import { ContractValidator } from '../../src/contracts/validator.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';
import { registerPersistentTaskRoutes } from '../../src/persistent-tasks/routes.ts';
import { buildServer } from '../../src/server.ts';

const daily = {kind:'daily',time:'09:30',timezone:'Asia/Hong_Kong'};
const weekly = {kind:'weekly',time:'10:00',timezone:'Asia/Hong_Kong',weekdays:[1,3,5]};
const invalidTriggers = [
  {...daily,time:'9:30'}, {...daily,time:'24:00'}, {...daily,time:'09:60'},
  {...daily,timezone:''}, {kind:'daily',time:'09:30'}, {...daily,weekdays:[1]},
  {...daily,interval_seconds:300}, {...weekly,weekdays:[]}, {...weekly,weekdays:[1,1]},
  {...weekly,weekdays:[7]}, {...weekly,weekdays:['1']}, {...weekly,weekdays:[1.5]},
  {kind:'weekly',time:'10:00',timezone:'UTC'}, {...weekly,run_at:'2026-10-02T00:00:00Z'},
  {kind:'once',time:'09:30',timezone:'UTC'}, {kind:'interval',url:'https://example.com'},
  {kind:'page_change',url:'https://example.com',run_at:'2026-10-02T00:00:00Z'},
];
const createBody = trigger => ({title:'Calendar',agent_id:'agent-fixture',objective:'Read the source',trigger});

test('calendar request contracts accept complete daily/weekly schedules and reject mixed branch fields', () => {
  const validator = new ContractValidator();
  assert.deepEqual(validator.compilationErrors, []);
  const create = validator.operationFor('POST','/v1/persistent-tasks');
  const update = validator.operationFor('PATCH','/v1/persistent-tasks/{task_id}');
  for (const trigger of [daily,weekly,{kind:'weekly',time:'00:00',timezone:'UTC',weekdays:[0,6]},
    {kind:'once'},{kind:'interval'},{kind:'page_change',url:'https://example.com'}]) {
    assert.equal(validator.validateRequest(create,createBody(trigger)).valid,true,JSON.stringify(trigger));
    assert.equal(validator.validateRequest(update,{expected_version:1,trigger}).valid,true,JSON.stringify(trigger));
  }
  for (const trigger of invalidTriggers) {
    assert.equal(validator.validateRequest(create,createBody(trigger)).valid,false,JSON.stringify(trigger));
    assert.equal(validator.validateRequest(update,{expected_version:1,trigger}).valid,false,JSON.stringify(trigger));
  }
});

test('preview operation exposes a strict request and nullable UTC due time response', () => {
  const validator = new ContractValidator();
  const operation = validator.operationFor('POST','/v1/persistent-tasks/preview');
  assert.ok(operation);
  assert.equal(validator.validateRequest(operation,{trigger:daily}).valid,true);
  for (const input of [{},{trigger:daily,owner_id:'bob'},{trigger:daily,title:'forged'},
    ...invalidTriggers.map(trigger=>({trigger}))]) assert.equal(validator.validateRequest(operation,input).valid,false,JSON.stringify(input));
  for (const value of [{next_due_at:'2026-10-02T01:30:00.000Z',timezone:'Asia/Hong_Kong'},
    {next_due_at:null,timezone:null}]) assert.equal(validator.validateResponse(operation,200,value).valid,true);
  for (const value of [{next_due_at:'not-a-date',timezone:'UTC'},{next_due_at:null},
    {next_due_at:null,timezone:null,task_id:'forged'}]) assert.equal(validator.validateResponse(operation,200,value).valid,false);
  const manifest = JSON.parse(readFileSync(new URL('../../contracts/operations.json',import.meta.url),'utf8'));
  assert.equal(manifest.filter(([method,path])=>method==='POST'&&path==='/v1/persistent-tasks/preview').length,1);
});

test('registered preview calculates calendar schedules without persisting tasks, runs, or occurrences', async () => {
  const base='.test-tmp';mkdirSync(base,{recursive:true});
  const directory=mkdtempSync(join(base,'calendar-routes-'));
  const db=openProductDatabase(join(directory,'fixture.sqlite'));
  const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(directory,'workspace')});
  const tasks=new PersistentTaskService(db,workbench,{now:()=>new Date('2026-10-02T00:00:00Z')});
  const app=Fastify();
  app.setErrorHandler((error,_request,reply)=>reply.code(error.message==='unauthorized'?401:400).send({error:{code:error.message}}));
  registerPersistentTaskRoutes(app,tasks,request=>{
    const owner=request.headers['x-user-id'];if(owner!=='alice')throw new Error('unauthorized');return owner;
  });
  try {
    const before=db.prepare('SELECT total_changes() AS count').get().count;
    for (const [trigger,expected] of [[daily,'2026-10-02T01:30:00.000Z'],[weekly,'2026-10-02T02:00:00.000Z']]) {
      const response=await app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers:{'x-user-id':'alice'},payload:{trigger}});
      assert.equal(response.statusCode,200,response.body);
      assert.deepEqual(response.json(),{next_due_at:expected,timezone:'Asia/Hong_Kong'});
    }
    assert.equal(db.prepare('SELECT total_changes() AS count').get().count,before);
    const anonymous=await app.inject({method:'POST',url:'/v1/persistent-tasks/preview',payload:{trigger:daily}});
    assert.equal(anonymous.statusCode,401);
    for (const trigger of [...invalidTriggers,{...daily,timezone:'Mars/Olympus'}]) {
      const response=await app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers:{'x-user-id':'alice'},payload:{trigger}});
      assert.equal(response.statusCode,400,JSON.stringify(trigger));
    }
    const forged=await app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers:{'x-user-id':'alice'},payload:{trigger:daily,owner_id:'bob'}});
    assert.equal(forged.statusCode,400);
    const agent=workbench.createAgent('alice',{name:'Calendar reader'});
    for (const trigger of [daily,weekly]) {
      const response=await app.inject({method:'POST',url:'/v1/persistent-tasks',headers:{'x-user-id':'alice'},payload:{...createBody(trigger),agent_id:agent.agent_id}});
      assert.equal(response.statusCode,201,response.body);
      const created=response.json();
      const update=await app.inject({method:'PATCH',url:`/v1/persistent-tasks/${created.task_id}`,headers:{'x-user-id':'alice'},payload:{expected_version:created.version,trigger:trigger.kind==='daily'?weekly:daily}});
      assert.equal(update.statusCode,200,update.body);
    }
  } finally {await app.close();db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});

test('preview retains owner, origin and CSRF checks and does not write the POST idempotency ledger', async () => {
  const base='.test-tmp';mkdirSync(base,{recursive:true});
  const directory=mkdtempSync(join(base,'calendar-auth-'));
  const server=await buildServer({databasePath:join(directory,'fixture.sqlite'),workspaces:['ws'],workbenchRoot:join(directory,'workspace'),templateRoot:fileURLToPath(new URL('../../file-engine/templates',import.meta.url)),csrfToken:'c'.repeat(32),allowedOrigins:['https://jot.invalid']});
  const headers={'x-user-id':'alice',origin:'https://jot.invalid','x-csrf-token':'c'.repeat(32)};
  try {
    const before=server.db.prepare('SELECT total_changes() AS count').get().count;
    for (let i=0;i<2;i++) {
      const response=await server.app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers,payload:{trigger:daily}});
      assert.equal(response.statusCode,200,response.body);
      assert.equal(response.json().timezone,'Asia/Hong_Kong');
    }
    assert.equal(server.db.prepare('SELECT total_changes() AS count').get().count,before);
    for (const [changed,status] of [[{'x-user-id':undefined},401],[{origin:'https://evil.invalid'},403],[{'x-csrf-token':'wrong'},403]]) {
      const requestHeaders=Object.fromEntries(Object.entries({...headers,...changed}).filter(([,value])=>value!==undefined));
      const response=await server.app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers:requestHeaders,payload:{trigger:daily}});
      assert.equal(response.statusCode,status,response.body);
    }
  } finally {await server.app.close();server.db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
