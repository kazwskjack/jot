import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { HarnessWorker } from '../../src/harness/worker.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../src/channels/worker.ts';
import { createSlackDeliveryProvider, resolveSlackReplyContext } from '../../src/channels/slack.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';

const signingSecret = 'slack-signing-secret-fixture-000000000000';

function signedHeaders(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(body).digest('hex');
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${digest}` };
}

function eventBody(eventId, text) {
  return Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111', api_app_id: 'A111',
    event_id: eventId, event: { type: 'message', channel: 'C111', user: 'U111',
      ts: '1761000000.000005', thread_ts: '1761000000.000001', text } }));
}

async function signedSlackServer() {
  return buildServer({ databasePath: ':memory:', workspaces: ['jot'],
    internalChannelToken: 'test-intake-token-123456',
    slackWebhook: { teamId: 'T111', signingSecret, appId: 'A111', botUserId: 'B111' } });
}

function signAndPost(service, body) {
  return service.app.inject({ method: 'POST', url: '/hooks/v1/channels/slack',
    headers: signedHeaders(body), payload: body });
}

test('signed Slack intake publishes the assistant final answer to the verified original thread and stores its receipt', async t => {
  const service = await signedSlackServer();
  t.after(async () => { await service.app.close(); service.db.close(); });
  const ownerBindings = new OwnerChannelBindings(service.db, { enabled: ['slack'] });
  const challenge = ownerBindings.create('alice', 'slack', 'slack-bind-request-1');

  const unbound = await signAndPost(service, eventBody('Ev-unbound', 'must not be admitted'));
  assert.equal(unbound.statusCode, 409, unbound.body);
  assert.equal(service.db.prepare("SELECT count(*) n FROM ga_channel_message_events WHERE channel='slack'").get().n, 0);

  const proof = await signAndPost(service, eventBody('Ev-bind', `/jot-bind ${challenge.code}`));
  assert.equal(proof.statusCode, 200, proof.body);
  assert.equal(service.db.prepare("SELECT owner_id FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=? AND status='verified'")
    .get('slack:T111:U111').owner_id, 'alice');

  const body = eventBody('Ev111', 'hello from Slack');
  const first = await signAndPost(service, body);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { ok: true });
  const replay = await signAndPost(service, body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(service.db.prepare("SELECT count(*) n FROM ga_channel_message_events WHERE channel='slack'").get().n, 1);
  const source = service.db.prepare(`SELECT e.run_id,e.principal,e.provider_thread_id,e.conversation_id,e.message_id,
      r.input_message_id,c.owner_id FROM ga_channel_message_events e
      JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=e.conversation_id
      WHERE e.channel='slack'`).get();
  assert.deepEqual({ principal: source.principal, provider_thread_id: source.provider_thread_id,
    owner_id: source.owner_id, message_id: source.message_id }, {
    principal: 'slack:T111:U111', provider_thread_id: 'C111:1761000000.000001',
    owner_id: 'alice', message_id: source.input_message_id,
  });

  const deliveries = new ChannelDeliveryService(service.db);
  const harness = new HarnessWorker(service.db, new HarnessCoordinator(service.db, service.runs, service.events), {
    run: async () => ({ observed: true, completed: false, reason_code: 'LOGIN_REQUIRED',
      runtime_status: 'not_required', final_text: 'Slack answer' }),
  }, { workerId: 'worker-slack-fixture', leaseMs: 30_000, channelDelivery: deliveries });
  await harness.processNext();
  const queued = service.db.prepare("SELECT * FROM ga_channel_deliveries WHERE destination='slack'").get();
  assert.ok(queued);
  assert.equal(queued.run_id, source.run_id);
  const assistant = service.db.prepare("SELECT role,content_json FROM ga_messages WHERE id=?").get(queued.message_id);
  assert.equal(assistant.role, 'assistant');
  assert.match(assistant.content_json, /Slack answer/);
  assert.throws(() => deliveries.enqueueExternal({ runId: source.run_id, messageId: 'assistant-file',
    destination: 'slack', recipient: 'slack:T111:U111', artifactRef: 'artifact-file', text: null }),
  /external_delivery_invalid/);

  const calls = [];
  const provider = createSlackDeliveryProvider({ botToken: 'xoxb-12345678901234567890', teamId: 'T111' }, service.db,
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, channel: 'C111', ts: '1761000001.000007' }), { status: 200 });
    });
  const worker = new ChannelDeliveryWorker(deliveries, { providers: { slack: provider } },
    { registerDeliveryReceipt: async () => { throw new Error('text_reply_does_not_register_file_receipts'); } }, {
      resolveArtifact: () => { throw new Error('text_reply_does_not_resolve_artifacts'); },
      resolveRuntime: () => { throw new Error('text_reply_does_not_resolve_runtime'); },
    });
  assert.equal(await worker.processNext(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.deepEqual(JSON.parse(calls[0].init.body), { channel: 'C111', thread_ts: '1761000000.000001',
    text: 'Slack answer', reply_broadcast: false });
  const delivered = deliveries.get(queued.effect_id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(JSON.parse(delivered.provider_receipt_json).provider_message_id, 'C111:1761000001.000007');
});

test('Slack unknown send outcome is recorded and is not retried', async t => {
  const service = await buildServer({ databasePath: ':memory:', workspaces: ['jot'],
    internalChannelToken: 'test-intake-token-123456',
    slackWebhook: { teamId: 'T111', signingSecret, appId: 'A111', botUserId: 'B111' } });
  t.after(async () => { await service.app.close(); service.db.close(); });
  const ownerBindings = new OwnerChannelBindings(service.db, { enabled: ['slack'] });
  const challenge = ownerBindings.create('alice', 'slack', 'slack-unknown-bind');
  ownerBindings.acceptProof('slack', 'slack:T111:U111', challenge.code);
  const response = await signAndPost(service, eventBody('Ev-unknown', 'hello'));
  assert.equal(response.statusCode, 200, response.body);
  const deliveries = new ChannelDeliveryService(service.db);
  const harness = new HarnessWorker(service.db, new HarnessCoordinator(service.db, service.runs, service.events), {
    run: async () => ({ observed: true, completed: false, reason_code: 'LOGIN_REQUIRED',
      runtime_status: 'not_required', final_text: 'Uncertain answer' }),
  }, { workerId: 'worker-slack-unknown', leaseMs: 30_000, channelDelivery: deliveries });
  await harness.processNext();
  const queued = service.db.prepare("SELECT * FROM ga_channel_deliveries WHERE destination='slack'").get();
  let calls = 0;
  const provider = createSlackDeliveryProvider({ botToken: 'xoxb-12345678901234567890', teamId: 'T111' }, service.db,
    async () => { calls++; throw new Error('network timeout after acceptance'); });
  const worker = new ChannelDeliveryWorker(deliveries, { providers: { slack: provider } },
    { registerDeliveryReceipt: async () => ({ ok: true }) }, {
      resolveArtifact: () => ({ path: 'unused', displayName: 'unused' }),
      resolveRuntime: () => ({ runtimeRunId: 'unused', clientRunId: 'unused' }),
    });
  assert.equal(await worker.processNext(), true);
  assert.equal(deliveries.get(queued.effect_id).status, 'outcome_unknown');
  assert.equal(await worker.processNext(), false);
  assert.equal(calls, 1);
});

test('Slack delivery and reply context are fenced when a revoked owner is rebound to the same principal', async t => {
  const service = await signedSlackServer();
  t.after(async () => { await service.app.close(); service.db.close(); });
  const ownerBindings = new OwnerChannelBindings(service.db, { enabled: ['slack'] });
  const challenge = ownerBindings.create('alice', 'slack', 'slack-revocation-bind');
  ownerBindings.acceptProof('slack', 'slack:T111:U111', challenge.code);
  const response = await signAndPost(service, eventBody('Ev-revoked', 'hello'));
  assert.equal(response.statusCode, 200, response.body);
  const deliveries = new ChannelDeliveryService(service.db);
  const harness = new HarnessWorker(service.db, new HarnessCoordinator(service.db, service.runs, service.events), {
    run: async () => ({ observed: true, completed: false, reason_code: 'LOGIN_REQUIRED',
      runtime_status: 'not_required', final_text: 'Do not send after revocation' }),
  }, { workerId: 'worker-slack-revoked', leaseMs: 30_000, channelDelivery: deliveries });
  await harness.processNext();
  const queued = service.db.prepare("SELECT * FROM ga_channel_deliveries WHERE destination='slack'").get();
  const binding = service.db.prepare("SELECT channel_binding_id,version FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=?")
    .get('slack:T111:U111');
  ownerBindings.revoke('alice', binding.channel_binding_id, binding.version);
  const rebound = ownerBindings.create('alice', 'slack', 'slack-revocation-rebind');
  ownerBindings.acceptProof('slack', 'slack:T111:U111', rebound.code);
  assert.equal(resolveSlackReplyContext(service.db, queued.effect_id), undefined);
  let calls = 0;
  const provider = createSlackDeliveryProvider({ botToken: 'xoxb-12345678901234567890', teamId: 'T111' }, service.db,
    async () => { calls++; return new Response('{}', { status: 200 }); });
  const worker = new ChannelDeliveryWorker(deliveries, { providers: { slack: provider } },
    { registerDeliveryReceipt: async () => ({ ok: true }) }, {
      resolveArtifact: () => ({ path: 'unused', displayName: 'unused' }),
      resolveRuntime: () => ({ runtimeRunId: 'unused', clientRunId: 'unused' }),
    });
  assert.equal(await worker.processNext(), true);
  assert.equal(deliveries.get(queued.effect_id).status, 'cancelled');
  assert.equal(deliveries.get(queued.effect_id).last_reason_code, 'SLACK_REPLY_AUTHORIZATION_REVOKED');
  assert.equal(calls, 0);
});

test('Slack interaction cannot approve an old thread after the same principal is rebound', async t => {
  const service = await signedSlackServer();
  t.after(async () => { await service.app.close(); service.db.close(); });
  const ownerBindings = new OwnerChannelBindings(service.db, { enabled: ['slack'] });
  const firstBinding = ownerBindings.create('alice', 'slack', 'slack-interaction-first-bind');
  ownerBindings.acceptProof('slack', 'slack:T111:U111', firstBinding.code);
  const sourceResponse = await signAndPost(service, eventBody('Ev-interaction-source', 'please approve'));
  assert.equal(sourceResponse.statusCode, 200, sourceResponse.body);
  const source = service.db.prepare(`SELECT e.run_id,e.conversation_id FROM ga_channel_message_events e
    JOIN ga_runs r ON r.id=e.run_id WHERE e.provider_message_id='Ev-interaction-source'`).get();
  assert.ok(source);

  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();
  const digest = `sha256:${'a'.repeat(64)}`;
  service.db.prepare(`INSERT INTO ga_interactions
    (id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('int-slack-old-thread', source.conversation_id, source.run_id,
    'approval', 'pending', 1, digest,
    JSON.stringify({ interaction_id: 'int-slack-old-thread', run_id: source.run_id, version: 1,
      status: 'pending', kind: 'approval', action_digest: digest, action_summary: 'approve fixture' }), expires, now);

  const binding = service.db.prepare("SELECT channel_binding_id,version FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=?")
    .get('slack:T111:U111');
  ownerBindings.revoke('alice', binding.channel_binding_id, binding.version);
  const secondBinding = ownerBindings.create('alice', 'slack', 'slack-interaction-second-bind');
  ownerBindings.acceptProof('slack', 'slack:T111:U111', secondBinding.code);

  const reply = await signAndPost(service, eventBody('Ev-rebound-approval', '<@B111> /approve int-slack-old-thread'));
  assert.equal(reply.statusCode, 404, reply.body);
  assert.equal(service.db.prepare("SELECT status FROM ga_interactions WHERE id='int-slack-old-thread'").get().status, 'pending');
  assert.equal(service.db.prepare("SELECT count(*) n FROM ga_slack_interaction_replies WHERE provider_event_id='Ev-rebound-approval'").get().n, 0);

  const newSourceResponse = await signAndPost(service, eventBody('Ev-rebound-source', 'new binding thread'));
  assert.equal(newSourceResponse.statusCode, 200, newSourceResponse.body);
  const newSource = service.db.prepare(`SELECT e.run_id,e.conversation_id FROM ga_channel_message_events e
    JOIN ga_runs r ON r.id=e.run_id WHERE e.provider_message_id='Ev-rebound-source'`).get();
  assert.ok(newSource);
  const newDigest = `sha256:${'b'.repeat(64)}`;
  service.db.prepare(`INSERT INTO ga_interactions
    (id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('int-slack-current-thread', newSource.conversation_id, newSource.run_id,
    'approval', 'pending', 1, newDigest,
    JSON.stringify({ interaction_id: 'int-slack-current-thread', run_id: newSource.run_id, version: 1,
      status: 'pending', kind: 'approval', action_digest: newDigest, action_summary: 'approve current fixture' }), expires, now);
  const currentReply = await signAndPost(service, eventBody('Ev-rebound-current-approval',
    '<@B111> /approve int-slack-current-thread'));
  assert.equal(currentReply.statusCode, 200, currentReply.body);
  const currentReceipt = service.db.prepare('SELECT receipt_json FROM ga_slack_interaction_replies WHERE provider_event_id=?')
    .get('Ev-rebound-current-approval');
  assert.equal(JSON.parse(currentReceipt.receipt_json).status, 'answered');
});
