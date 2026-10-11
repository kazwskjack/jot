import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildServer } from '../../src/server.ts';
import {EventStore} from '../../src/events/event-store.ts';

test('Runtime outcomes are projected but completion eligibility does not publish the product run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-vertical-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'] });
  try {
    const created = await service.app.inject({
      method: 'POST', url: '/v1/conversations', headers: { 'x-user-id': 'user-1' },
      payload: { title: 'Agent research', workspace_id: 'ws-1', model: { provider: 'zhipu', model: 'glm-5.3-flash' } },
    });
    assert.equal(created.statusCode, 201);
    const conversation = created.json();

    const accepted = await service.app.inject({
      method: 'POST', url: `/v1/conversations/${conversation.conversation_id}/messages`,
      headers: { 'x-user-id': 'user-1', 'idempotency-key': 'client-msg-1' },
      payload: { client_message_id: 'client-msg-1', content: [{ type: 'text', text: '搜索 AI' }] },
    });
    assert.equal(accepted.statusCode, 202);
    const receipt = accepted.json();

    let run = (await service.app.inject({ method: 'GET', url: `/v1/runs/${receipt.run_id}`, headers: { 'x-user-id': 'user-1' } })).json();
    assert.equal(run.status, 'queued');

    service.runs.applyRuntimeOutcome(receipt.run_id, { status: 'running', runtime_revision: 1, reason_code: null });
    service.runs.applyRuntimeOutcome(receipt.run_id, { status: 'completion_ineligible', runtime_revision: 2, reason_code: 'REQUIREMENT_NOT_SATISFIED' });
    run = (await service.app.inject({ method: 'GET', url: `/v1/runs/${receipt.run_id}`, headers: { 'x-user-id': 'user-1' } })).json();
    assert.equal(run.status, 'running');

    service.runs.applyRuntimeOutcome(receipt.run_id, { status: 'completion_eligible', runtime_revision: 3, reason_code: null });
    run = (await service.app.inject({ method: 'GET', url: `/v1/runs/${receipt.run_id}`, headers: { 'x-user-id': 'user-1' } })).json();
    assert.equal(run.status, 'running');

    const snapshot = await service.app.inject({
      method: 'GET', url: `/v1/conversations/${conversation.conversation_id}/snapshot`, headers: { 'x-user-id': 'user-1' },
    });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().runs[0].status, 'running');
    const store=new EventStore(service.db);
    service.db.exec('BEGIN');
    store.append(conversation.conversation_id,receipt.run_id,'assistant.delta',{message_id:'stream-test',attempt_id:'attempt-test',block_id:'block-test',kind:'text',delta_index:0,text:'实时正文'});
    service.db.exec('COMMIT');
    const streaming=(await service.app.inject({method:'GET',url:`/v1/conversations/${conversation.conversation_id}/snapshot`,headers:{'x-user-id':'user-1'}})).json();
    assert.equal(streaming.messages.find(m=>m.message_id==='stream-test')?.blocks[0].text,'实时正文');
    assert.ok(Number(snapshot.json().as_of_seq) >= 5);

    const events = await service.app.inject({
      method: 'GET', url: `/v1/conversations/${conversation.conversation_id}/events?after=0&follow=0`,
      headers: { 'x-user-id': 'user-1', accept: 'text/event-stream' },
    });
    assert.equal(events.statusCode, 200);
    assert.match(events.body, /event: runtime\.outcome/);
    assert.match(events.body, /event: run\.state/);
  } finally {
    await service.app.close();
    service.db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('BFF SSE replays a committed event written through an independent Worker SQLite connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-cross-process-sse-'));
  const databasePath = join(directory, 'db.sqlite');
  const service = await buildServer({ databasePath, workspaces: ['ws-1'] });
  let workerDb;
  let address;
  let clientRequest;
  let clientResponse;
  try {
    const created = await service.app.inject({
      method: 'POST', url: '/v1/conversations', headers: { 'x-user-id': 'user-1' },
      payload: { title: 'Cross-process event', workspace_id: 'ws-1', model: { provider: 'zhipu', model: 'glm-5.3-flash' } },
    });
    assert.equal(created.statusCode, 201);
    const conversation = created.json();
    const after = service.events.head(conversation.conversation_id);
    address = await service.app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL(`/v1/conversations/${conversation.conversation_id}/events?after=${after}`, address);
    let resolveConnected;
    let rejectConnected;
    const connected = new Promise((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
    let resolveEvent;
    const eventReceived = new Promise(resolve => { resolveEvent = resolve; });
    let text = '';
    clientRequest = httpGet(url, { headers: { 'x-user-id': 'user-1', accept: 'text/event-stream' } }, response => {
      clientResponse = response;
      assert.equal(response.statusCode, 200);
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.includes('event: activity.upsert')) resolveEvent();
      });
      resolveConnected();
    });
    clientRequest.once('error', rejectConnected);
    await connected;
    workerDb = new DatabaseSync(databasePath);
    const workerEvents = new EventStore(workerDb);
    workerDb.exec('BEGIN IMMEDIATE');
    workerEvents.append(conversation.conversation_id, 'run-worker-process', 'activity.upsert', {
      activity_id: 'batch-call-1', tool_call_id: 'batch-call-1', status: 'running',
      detail: { operation_id: 'web-operation-1', event_cursor: 1, items: [
        { item_id: 'item-1', attempt: 1, status: 'succeeded', url: 'https://example.com/a', result_ref: 'result-1' },
      ] },
    });
    workerDb.exec('COMMIT');

    await Promise.race([eventReceived, new Promise((_, reject) => setTimeout(() => reject(new Error('cross_process_sse_timeout')), 4000))]);
    assert.match(text, /event: activity\.upsert/);
    assert.match(text, /"item_id":"item-1"/);
    assert.match(text, /"result_ref":"result-1"/);
  } finally {
    const responseClosed = clientResponse
      ? new Promise(resolve => clientResponse.once('close', resolve))
      : Promise.resolve();
    clientResponse?.destroy();
    clientRequest?.socket?.destroy();
    clientRequest?.destroy();
    await Promise.race([responseClosed, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (workerDb?.isTransaction) workerDb.exec('ROLLBACK');
    workerDb?.close();
    service.app.server.closeAllConnections?.();
    await service.app.close();
    service.db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
