import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contracts = new URL('../../contracts/', import.meta.url);
test('Run contract accepts every documented lifecycle state without accepting unknown states',async()=>{
 const {ContractValidator}=await import('../../src/contracts/validator.ts');
 const validator=new ContractValidator();
 const op=validator.operationFor('GET','/v1/runs/{runId}');
 const base={run_id:'test-run',conversation_id:'test-conversation',input_message_id:'test-message',version:1,created_at:'2026-09-13T00:00:00Z',updated_at:'2026-09-13T00:00:00Z'};
 for(const status of ['queued','starting','running','waiting_user','waiting_approval','cancelling','succeeded','partial','failed','interrupted','cancelled'])assert.equal(validator.validateResponse(op,200,{...base,status}).valid,true,status);
 assert.equal(validator.validateResponse(op,200,{...base,status:'invented'}).valid,false);
});

async function json(name) {
  return JSON.parse(await readFile(new URL(name, contracts), 'utf8'));
}

test('contract bundle exposes exactly 33 operations over 28 paths including voice capture and status', async () => {
  const operations = await json('operations.json');
  const openapi = await json('openapi.json');
  assert.equal(operations.length, 33);
  assert.equal(Object.keys(openapi.paths).length, 28);
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
