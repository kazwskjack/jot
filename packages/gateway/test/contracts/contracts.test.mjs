import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contracts = new URL('../../contracts/', import.meta.url);
test('Git workbench schemas expose bounded read-only state and no host paths, commands or credentials',async()=>{
 const spec=await json('openapi.json'),event=await json('agent-event.schema.json'),schemas=spec.components.schemas;
 assert.ok(schemas.GitSnapshot);assert.equal(schemas.GitSnapshot.properties.read_only.const,true);assert.equal(schemas.GitSnapshot.properties.execution_authorized.const,false);
 assert.equal(schemas.GitSnapshot.properties.entries.maxItems,5000);
 assert.deepEqual(schemas.GitWorkbenchCapability,event.$defs.GitWorkbenchCapability);
 for(const name of ['GitSnapshot','GitDiff','GitEntry','GitRemote'])for(const forbidden of ['root','git_directory','executable','command','url','credentials'])assert.equal(forbidden in schemas[name].properties,false);
 const yaml=await readFile(new URL('openapi.yaml',contracts),'utf8');for(const name of ['Capabilities','GitSnapshot','GitDiff','GitEntry','GitRemote','GitWorkbenchCapability']){const line=yaml.split('\n').find(s=>s.startsWith('    '+name+': '));assert.ok(line);assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),schemas[name]);}
});
test('Git review contracts reject execution claims and keep commit messages operation-specific',async()=>{
 const spec=await json('openapi.json'),event=await json('agent-event.schema.json'),yaml=await readFile(new URL('openapi.yaml',contracts),'utf8'),{ContractValidator}=await import('../../src/contracts/validator.ts'),validator=new ContractValidator();
 const operation=validator.operationFor('POST','/v1/projects/{projectId}/git/intents'),base={request_id:'review-1',action:'stage',paths:['note.txt'],snapshot_id:'a'.repeat(64)};
 assert.equal(validator.validateRequest(operation,base).valid,true);assert.equal(validator.validateRequest(operation,{...base,action:'commit',message:'Reviewed change'}).valid,true);
 for(const patch of [{action:'commit'},{message:'Unexpected stage message'},{paths:[]},{paths:['note.txt','note.txt']},{root:'untrusted'},{owner_id:'other'},{action:'push'},{execution_authorized:true}])assert.equal(validator.validateRequest(operation,{...base,...patch}).valid,false);
 const receipt={intent_id:'intent',project_id:'project',action:'stage',paths:['note.txt'],snapshot_id:base.snapshot_id,review_sha256:'b'.repeat(64),version:1,state:'prepared',created_at:'2026-10-19T00:00:00Z',updated_at:'2026-10-19T00:00:00Z',execution_authorized:false};
 assert.equal(validator.validateResponse(operation,201,receipt).valid,true);
 for(const patch of [{execution_authorized:true},{state:'applied'},{root:'untrusted'},{version:0}])assert.equal(validator.validateResponse(operation,201,{...receipt,...patch}).valid,false);
 for(const name of ['GitReviewPrepare','GitReviewControl','GitReviewIntent']){assert.deepEqual(event.$defs[name],spec.components.schemas[name]);const line=yaml.split('\n').find(value=>value.startsWith('    '+name+': '));assert.ok(line);assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),spec.components.schemas[name]);}
});
test('Git execution history contracts distinguish original acceptance, pending, applied and explicitly closed results',async()=>{
 const spec=await json('openapi.json'),event=await json('agent-event.schema.json'),yaml=await readFile(new URL('openapi.yaml',contracts),'utf8'),{ContractValidator}=await import('../../src/contracts/validator.ts'),validator=new ContractValidator();
 const receiptOperation=validator.operationFor('GET','/v1/projects/:projectId/git/admissions/:requestId'),resultOperation=validator.operationFor('GET','/v1/projects/:projectId/git/executions/:executionId');assert.ok(receiptOperation);assert.ok(resultOperation);
 const base={execution_id:'execution',project_id:'project',intent_id:'intent',request_id:'request',action:'stage',execution_authorized:false},accepted={...base,accepted:true};
 assert.equal(validator.validateResponse(receiptOperation,200,accepted).valid,true);
 for(const patch of [{accepted:false},{execution_authorized:true},{paths:['note.txt']},{root:'untrusted'}])assert.equal(validator.validateResponse(receiptOperation,200,{...accepted,...patch}).valid,false);
 const pending={...base,paths:['note.txt'],state:'pending'},applied={...pending,state:'applied',before_index_sha256:'a'.repeat(64),index_sha256:'b'.repeat(64)},closed={...pending,state:'abandoned_unknown',disposition_id:'control'};
 for(const result of [pending,{...pending,state:'unknown'},applied,{...applied,before_index_sha256:null},closed,{...closed,state:'not_dispatched'}])assert.equal(validator.validateResponse(resultOperation,200,result).valid,true);
 for(const result of [{...pending,state:'applied'},{...applied,state:'pending'},{...closed,disposition_id:undefined},{...closed,state:'failed'},{...pending,execution_authorized:true},{...pending,paths:['../escape']},{...pending,paths:[]},{...pending,paths:['note.txt','note.txt']},{...pending,root:'untrusted'}])assert.equal(validator.validateResponse(resultOperation,200,result).valid,false);
 for(const name of ['GitIndexAcceptance','GitIndexExecutionResult']){assert.deepEqual(event.$defs[name],spec.components.schemas[name]);const line=yaml.split('\n').find(value=>value.startsWith('    '+name+': '));assert.ok(line);assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),spec.components.schemas[name]);}
});

test('pinned message references are bounded public metadata in REST, SSE and YAML',async()=>{
 const spec=await json('openapi.json'),event=await json('agent-event.schema.json'),ref=spec.components.schemas.MessageAttachmentRef;
 assert.ok(ref);const {default:Ajv}=await import('ajv/dist/2020.js'),validate=new Ajv({strict:false}).compile(ref);
 const pin={artifact_id:'file',version:1,sha256:'a'.repeat(64),size_bytes:12,media_type:'text/plain',file_name:'sent.txt'};
 assert.equal(validate(pin),true);
 for(const invalid of [{...pin,version:0},{...pin,sha256:'unknown'},{...pin,server_path:'private'},{...pin,receipt_id:'private'},{...pin,size_bytes:-1}])assert.equal(validate(invalid),false);
 assert.deepEqual(event.$defs.MessageAttachmentRef,ref);
 assert.equal(spec.components.schemas.Message.properties.attachment_refs.maxItems,10);
 assert.equal(event.$defs.Message.properties.attachment_refs.maxItems,10);
 const yaml=await readFile(new URL('openapi.yaml',contracts),'utf8');
 for(const name of ['Message','MessageAttachmentRef']){const line=yaml.split('\n').find(s=>s.startsWith('    '+name+': '));assert.ok(line);assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),spec.components.schemas[name]);}
});
test('task run-limit schemas preserve finite limits and explicit unlimited null in JSON and YAML',async()=>{
 const spec=await json('openapi.json'),{default:Ajv}=await import('ajv/dist/2020.js'),schema=spec.components.schemas.PersistentTaskBudget;
 const validate=new Ajv({strict:false}).compile(schema);
 for(const value of [{max_runs:null},{max_runs:1},{max_runs:10000}])assert.equal(validate(value),true);
 for(const value of [{},{max_runs:0},{max_runs:-1},{max_runs:10001},{max_runs:'unlimited'},{max_runs:null,run_limit_mode:'unlimited'}])assert.equal(validate(value),false);
 const yaml=await readFile(new URL('openapi.yaml',contracts),'utf8'),line=yaml.split('\n').find(s=>s.trimStart().startsWith('PersistentTaskBudget: '));
 assert.deepEqual(JSON.parse(line.slice(line.indexOf(':')+1)),schema);
});
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

test('Run contract allows a message-free Goal control only with explicit control and source lineage',async()=>{
 const {ContractValidator}=await import('../../src/contracts/validator.ts'),validator=new ContractValidator(),operation=validator.operationFor('GET','/v1/runs/{runId}');
 const run={run_id:'run-a',conversation_id:'conv-a',input_message_id:null,goal_control_id:'goal-control-fixture',continuation_of:'run-source',status:'queued',version:1,created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z'};
 assert.equal(validator.validateResponse(operation,200,run).valid,true);
 for(const patch of [{goal_control_id:undefined},{continuation_of:undefined},{input_message_id:'old-prompt'}]){const value={...run,...patch};for(const key of Object.keys(value))if(value[key]===undefined)delete value[key];assert.equal(validator.validateResponse(operation,200,value).valid,false);}
});
