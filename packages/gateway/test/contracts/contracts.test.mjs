import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contracts = new URL('../../contracts/', import.meta.url);
test('owner mailbox request can bind a public task run without accepting internal session identities',async()=>{
 const spec=await json('openapi.json'),{default:Ajv}=await import('ajv/dist/2020.js');
 const validate=new Ajv({strict:false}).compile(spec.components.schemas.SendAgentMailboxMessage);
 const base={sender_agent_id:'lead',recipient_agent_id:'member',text:'Review',client_message_id:'request',auto_reply:true,task_run_id:'run-owned'};
 assert.equal(validate(base),true);
 for(const value of [{...base,session_id:'private'},{...base,task_run_id:''},{...base,task_run_id:7}])assert.equal(validate(value),false);
 assert.ok(spec.components.schemas.AgentMailboxMessage.properties.status.enum.includes('task_revoked'));
});
test('Run contract accepts every documented lifecycle state without accepting unknown states',async()=>{
 const {ContractValidator}=await import('../../src/contracts/validator.ts');
 const validator=new ContractValidator();
 const op=validator.operationFor('GET','/v1/runs/{runId}');
 const base={run_id:'test-run',conversation_id:'test-conversation',input_message_id:'test-message',version:1,created_at:'2026-09-13T00:00:00Z',updated_at:'2026-09-13T00:00:00Z'};
 for(const status of ['queued','starting','running','waiting_user','waiting_approval','cancelling','succeeded','partial','failed','interrupted','cancelled'])assert.equal(validator.validateResponse(op,200,{...base,status}).valid,true,status);
 assert.equal(validator.validateResponse(op,200,{...base,status:'invented'}).valid,false);
});

test('task history query accepts only an optional public occurrence and no internal session or mutable scope',async()=>{
 const spec=await json('openapi.json'),{default:Ajv}=await import('ajv/dist/2020.js');
 assert.ok(spec.components.schemas.TaskSubtaskQuery,'history query contract must exist');
 const validate=new Ajv({strict:false}).compile(spec.components.schemas.TaskSubtaskQuery);
 for(const value of [{},{occurrence_id:'occurrence-prior'}])assert.equal(validate(value),true,JSON.stringify(value));
 for(const value of [{occurrence_id:''},{occurrence_id:3},{occurrence_id:'a'.repeat(201)},{session_id:'internal'},{owner_id:'another'},{occurrence_id:'occurrence-prior',status:'completed'}])assert.equal(validate(value),false,JSON.stringify(value));
 const path=spec.paths['/v1/persistent-tasks/{task_id}/subtasks'];
 assert.equal(path.get.parameters.find(parameter=>parameter.in==='query'&&parameter.name==='occurrence_id').required,false);
 assert.equal(path.post.parameters.some(parameter=>parameter.in==='query'),false);
});

async function json(name) {
  return JSON.parse(await readFile(new URL(name, contracts), 'utf8'));
}

test('contract bundle keeps operation manifest and paths synchronized including voice and workbench', async () => {
  const operations = await json('operations.json');
  const openapi = await json('openapi.json');
  const actual=Object.entries(openapi.paths).flatMap(([path,item])=>Object.keys(item).filter(method=>['get','post','put','patch','delete','head','options'].includes(method)).map(method=>`${method.toUpperCase()} ${path}`));
  assert.deepEqual(operations.map(([method,path])=>`${method} ${path}`).sort(),actual.sort());
  assert.equal(new Set(operations.map(([method,path])=>`${method} ${path}`)).size,operations.length);
  assert.ok(operations.some(([method,path])=>method==='POST'&&path==='/v1/persistent-tasks'));
  assert.ok(operations.some(([method, path]) => method === 'POST' && path.endsWith('/voice/transcriptions')));
  assert.ok(operations.some(([method, path]) => method === 'GET' && path.endsWith('/voice/transcriptions/{transcription_id}')));
  assert.ok(operations.some(([method, path]) => method === 'DELETE' && path.endsWith('/voice/transcriptions/{transcription_id}')));
});

test('every declared operation and event type is backed by a schema', async () => {
  const operations = await json('operations.json');
  const openapi = await json('openapi.json');
  for (const [method, path] of operations) {
    assert.ok(openapi.paths[path]?.[method.toLowerCase()], `${method} ${path}`);
  }

  const eventTypes = await json('event-types.json');
  const eventSchema = await json('agent-event.schema.json');
  const encoded = JSON.stringify(eventSchema);
  for (const type of Object.keys(eventTypes)) assert.match(encoded, new RegExp(type.replace('.', '\\.')));
});

test('Universe projection events are part of the public event union', async () => {
  const eventTypes = await json('event-types.json');
  for (const type of [
    'goal.updated',
    'progress.updated',
    'runtime.outcome',
    'checkpoint.upsert',
    'delivery.upsert',
    'response.upsert',
  ]) assert.ok(Object.hasOwn(eventTypes, type), type);
});
