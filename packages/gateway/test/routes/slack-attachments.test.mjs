import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { readAcceptedChannelAttachmentInputV2 } from '../../src/channels/attachment-input-v2.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { HarnessWorker } from '../../src/harness/worker.ts';
import { RunCommandService } from '../../src/runs/commands.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../src/channels/worker.ts';
import { createSlackDeliveryProvider, resolveSlackReplyContext } from '../../src/channels/slack.ts';

const signingSecret = 'slack-signing-secret-fixture-000000000000';
const botToken = 'xoxb-12345678901234567890';
const bytes = Buffer.from('synthetic Slack attachment');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function signedHeaders(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(body).digest('hex');
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${signature}` };
}

function eventBody(eventId = 'Ev-file-1') {
  return Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111', api_app_id: 'A111',
    event_id: eventId, event: { type: 'message', channel: 'C111', user: 'U111',
      ts: '1761000000.000005', thread_ts: '1761000000.000001', text: '', files: [{
        id: 'F111', created: 1761000000, user: 'U111', name: 'report.txt', mimetype: 'text/plain',
        size: bytes.length, is_external: false, mode: 'hosted', editable: false,
      }] } }));
}

function textEventBody(eventId) {
  return Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111', api_app_id: 'A111',
    event_id: eventId, event: { type: 'message', channel: 'C111', user: 'U111',
      ts: '1761000000.000005', thread_ts: '1761000000.000001', text: 'make a report' } }));
}

async function fixture(t, { mode = 'ok', bind = true } = {}) {
  const root = mkdtempSync(join(resolve('test-tmp'), 'slack-attachment-v2-'));
  const file = { id: 'F111', created: 1761000000, user: 'U111', name: 'report.txt',
    mimetype: 'text/plain', size: bytes.length, is_external: false, mode: 'hosted', editable: false,
    url_private_download: 'https://files.slack.com/files-pri/T111-F111/report.txt' };
  const calls = [];
  let onDownload;
  const transport = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, `Bearer ${botToken}`);
    if (url.pathname === '/api/files.info') return Response.json({ ok: true,
      file: mode === 'version' ? { ...file, size: file.size + 1 } : mode === 'origin'
        ? { ...file, url_private_download: 'https://files.slack.com.evil.test/report.txt' } : file });
    assert.equal(url.hostname, 'files.slack.com');
    onDownload?.();
    if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    if (mode === 'oversize') return new Response(null, { headers: {
      'content-type': 'text/plain', 'content-length': String(21 * 1024 * 1024) } });
    return new Response(bytes, { headers: { 'content-type': mode === 'mime' ? 'text/html' : 'text/plain',
      'content-length': String(bytes.length) } });
  };
  const recovery = { stageVerifiedFile: async () => ({}), recoverInput: async () => ({}),
    ordinaryRunHistoryReadiness: async () => ({ protocol: 1, ready: true, execution_authorized: false }) };
  const service = await buildServer({ databasePath: ':memory:', workspaces: ['jot'],
    uploadRoot: join(root, 'uploads'), workbenchRoot: join(root, 'workspaces'),
    internalChannelToken: 'test-intake-token-123456', ordinaryInputRecoveryEnabled: true,
    channelAttachmentIntakeV2: true, conversationGoalClient: recovery,
    slackWebhook: { teamId: 'T111', signingSecret, appId: 'A111', botUserId: 'B111', attachmentBotToken: botToken },
    slackTransport: transport });
  const bindings = new OwnerChannelBindings(service.db, { enabled: ['slack'] });
  if (bind) {
    const challenge = bindings.create('alice', 'slack', 'slack-attachment-bind');
    bindings.acceptProof('slack', 'slack:T111:U111', challenge.code);
  }
  t.after(async () => { await service.app.close(); service.db.close(); rmSync(root, { recursive: true, force: true }); });
  const post = (body = eventBody()) => service.app.inject({ method: 'POST', url: '/hooks/v1/channels/slack',
    headers: signedHeaders(body), payload: body });
  return { service, calls, post, bindings, setOnDownload: action => { onDownload = action; } };
}

async function queueSlackOutput(t) {
  const f = await fixture(t);
  const response = await f.post(textEventBody('Ev-output-source'));
  assert.equal(response.statusCode, 200, response.body);
  const source = f.service.db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='slack' AND provider_message_id=?")
    .get('Ev-output-source');
  const output = Buffer.from('synthetic assistant report');
  const outputHash = createHash('sha256').update(output).digest('hex');
  const upload = f.service.artifacts.initUpload(source.conversation_id, 'alice', { file_name: 'report.txt',
    media_type: 'text/plain', sha256: outputHash, size_bytes: output.length });
  await f.service.artifacts.writeContent(upload.upload_id, 'alice', (async function* () { yield output; })());
  const artifact = f.service.artifacts.complete(upload.upload_id, 'alice', { sha256: outputHash });
  const version = f.service.artifacts.version(artifact.artifact_id, 'alice', artifact.version);
  const deliveries = new ChannelDeliveryService(f.service.db);
  const resolver = { resolveForMessage: () => [], resolveOutputs: () => [{ artifactId: artifact.artifact_id,
    displayName: 'report.txt', mediaType: 'text/plain', sizeBytes: output.length, sha256: outputHash,
    localPath: version.server_path, kind: 'text', version: artifact.version }], releaseLease: () => {} };
  const harness = new HarnessWorker(f.service.db,
    new HarnessCoordinator(f.service.db, f.service.runs, f.service.events), {
      run: async () => ({ observed: true, completed: true, reason_code: 'SESSION_TURN_COMPLETED',
        runtime_status: 'not_required', final_text: 'Report ready', output_artifact_refs: [artifact.artifact_id],
        presented_files: [{ path: version.server_path }] }),
    }, { workerId: 'worker-slack-output', leaseMs: 30_000, attachmentResolver: resolver, channelDelivery: deliveries });
  await harness.processNext();
  const textEffect = f.service.db.prepare("SELECT * FROM ga_channel_deliveries WHERE destination='slack' AND artifact_ref IS NULL").get();
  const fileEffect = f.service.db.prepare("SELECT * FROM ga_channel_deliveries WHERE destination='slack' AND artifact_ref IS NOT NULL").get();
  assert.ok(textEffect);
  assert.ok(fileEffect);
  f.service.db.prepare("UPDATE ga_channel_deliveries SET status='delivered' WHERE effect_id=?").run(textEffect.effect_id);
  return { ...f, deliveries, fileEffect, artifact, output, outputHash };
}

test('signed Slack attachment event is admitted with the binding-pinned v2 manifest', async t => {
  const f = await fixture(t);
  const response = await f.post();
  assert.equal(response.statusCode, 200, response.body);
  const event = f.service.db.prepare(`SELECT e.* FROM ga_channel_message_events e
    WHERE e.channel='slack' AND e.provider_message_id='Ev-file-1'`).get();
  assert.equal(event.content_protocol, 2);
  const envelope = JSON.parse(event.attachments_json);
  assert.equal(envelope.protocol, 2);
  assert.equal(envelope.source.owner_id, 'alice');
  assert.equal(envelope.source.event.message_id, 'Ev-file-1');
  assert.equal(envelope.source.attachments[0].sha256, sha256);
  const accepted = readAcceptedChannelAttachmentInputV2(f.service.db, event.run_id);
  assert.equal(accepted.source.channel_binding_id, envelope.source.channel_binding_id);
  assert.equal(accepted.pinned.attachments[0].artifact_id, envelope.source.attachments[0].artifact_id);
  const artifact = f.service.artifacts.download(accepted.pinned.attachments[0].artifact_id, 'alice', 1);
  assert.deepEqual(readFileSync(artifact.server_path), bytes);
  assert.equal(f.calls.length, 2);
});

test('checkpoint continuation validates the source run attachment proof without replaying it or limiting valid lineage depth', async t => {
  const f = await fixture(t);
  const response = await f.post();
  assert.equal(response.statusCode, 200, response.body);
  const source = f.service.db.prepare("SELECT run_id FROM ga_channel_message_events WHERE channel='slack' AND provider_message_id='Ev-file-1'").get();
  const accepted = readAcceptedChannelAttachmentInputV2(f.service.db, source.run_id);
  assert.ok(accepted);
  const checkpointId = 'checkpoint-slack-attachment';
  f.service.db.prepare("UPDATE ga_runs SET status='interrupted',checkpoint_id=? WHERE id=?").run(checkpointId, source.run_id);
  const parent = f.service.runs.get(source.run_id, 'alice');
  const commands = new RunCommandService(f.service.db, f.service.events);
  const resumed = commands.resume(source.run_id, 'alice', { expected_run_version: parent.version, checkpoint_id: checkpointId }, 'slack-attachment-resume');

  assert.throws(() => readAcceptedChannelAttachmentInputV2(f.service.db, resumed.run_id), /channel_attachment_input_unproven/);
  const worker = new HarnessWorker(f.service.db, new HarnessCoordinator(f.service.db, f.service.runs, f.service.events),
    { run: async () => ({ observed: true, completed: false, reason_code: 'CHAT', runtime_status: 'not_required' }) },
    { workerId: 'worker-slack-attachment-resume', leaseMs: 30_000 });
  const input = worker.messageInput(resumed.run_id);
  assert.match(input.text, /继续当前已授权任务/);
  assert.deepEqual(input.attachmentIds, []);
  assert.equal(input.attachmentManifest, undefined);

  let leafRunId = resumed.run_id;
  for (let depth = 0; depth < 65; depth++) {
    f.service.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(leafRunId);
    const current = f.service.runs.get(leafRunId, 'alice');
    leafRunId = commands.resume(leafRunId, 'alice',
      { expected_run_version: current.version, checkpoint_id: checkpointId }, `slack-attachment-resume-${depth}`).run_id;
  }
  const deepInput = worker.messageInput(leafRunId);
  assert.match(deepInput.text, /继续当前已授权任务/);
  assert.deepEqual(deepInput.attachmentIds, []);
  assert.equal(deepInput.attachmentManifest, undefined);

  f.service.db.prepare('UPDATE ga_runs SET input_message_id=NULL WHERE id=?').run(source.run_id);
  assert.throws(() => worker.messageInput(leafRunId), /continuation_input_unproven/);
  f.service.db.prepare('UPDATE ga_runs SET continuation_of=id WHERE id=?').run(leafRunId);
  assert.throws(() => worker.messageInput(leafRunId), /continuation_input_unproven/);
});

test('Slack attachment staging stays within the verified owner binding', async t => {
  const f = await fixture(t, { bind: false });
  const response = await f.post();
  assert.notEqual(response.statusCode, 200, response.body);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM ga_channel_message_events WHERE channel='slack'").get().n, 0);
});

for (const [mode, status] of [['redirect', 502], ['oversize', 422], ['mime', 422], ['version', 409], ['origin', 422]]) {
  test(`Slack attachment ${mode} response is rejected before admission`, async t => {
    const f = await fixture(t, { mode });
    const response = await f.post();
    assert.equal(response.statusCode, status, response.body);
    assert.equal(f.service.db.prepare("SELECT count(*) n FROM ga_channel_message_events WHERE channel='slack'").get().n, 0);
    assert.ok(f.calls.length <= 2);
  });
}

test('Slack attachment download cannot cross a revocation and rebind generation', async t => {
  const f = await fixture(t);
  f.setOnDownload(() => {
    const previous = f.service.db.prepare("SELECT channel_binding_id,version FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=?")
      .get('slack:T111:U111');
    f.bindings.revoke('alice', previous.channel_binding_id, previous.version);
    const replacement = f.bindings.create('alice', 'slack', 'slack-attachment-rebind');
    f.bindings.acceptProof('slack', 'slack:T111:U111', replacement.code);
  });
  const response = await f.post();
  assert.notEqual(response.statusCode, 200, response.body);
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM ga_channel_message_events WHERE channel='slack'").get().n, 0);
});

test('Slack generated artifact travels through the authorized outbox and stores its provider receipt', async t => {
  const f = await queueSlackOutput(t);
  assert.deepEqual(resolveSlackReplyContext(f.service.db, f.fileEffect.effect_id), {
    recipient: 'slack:T111:U111', teamId: 'T111', channelId: 'C111', threadTs: '1761000000.000001',
  });
  const calls = [];
  const provider = createSlackDeliveryProvider({ botToken, teamId: 'T111' }, f.service.db, async (url, init) => {
    calls.push(String(url));
    if (url.pathname === '/api/files.getUploadURLExternal') return Response.json({ ok: true, file_id: 'FOUT1',
      upload_url: 'https://files.slack.com/upload/v1/FOUT1' });
    if (url.pathname === '/upload/v1/FOUT1') return new Response(null, { status: 200 });
    if (url.pathname === '/api/files.completeUploadExternal') return Response.json({ ok: true, files: [{ id: 'FOUT1' }] });
    throw new Error(`unexpected Slack API request: ${url}`);
  });
  const worker = new ChannelDeliveryWorker(f.deliveries, { providers: { slack: provider } },
    { registerDeliveryReceipt: async () => ({ ok: true }) }, {
      artifacts: f.service.artifacts,
      resolveRuntime: runId => ({ runtimeRunId: `runtime-${runId}`, clientRunId: runId }),
    });
  assert.equal(await worker.processNext(), true);
  const sent = f.deliveries.get(f.fileEffect.effect_id);
  assert.equal(sent.status, 'delivered');
  assert.deepEqual(JSON.parse(sent.provider_receipt_json), { provider_message_id: `group:${createHash('sha256')
    .update('slack-file:C111:FOUT1').digest('hex').slice(0, 32)}`,
    receipts: [{ part_index: 1, provider_message_id: 'slack-file:C111:FOUT1' }], total: 1 });
  assert.deepEqual(calls.map(value => new URL(value).pathname), [
    '/api/files.getUploadURLExternal', '/upload/v1/FOUT1', '/api/files.completeUploadExternal' ]);
});

test('Slack file send is cancelled after its source binding is revoked and rebound', async t => {
  const f = await queueSlackOutput(t);
  const binding = f.service.db.prepare("SELECT channel_binding_id,version FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=?")
    .get('slack:T111:U111');
  f.bindings.revoke('alice', binding.channel_binding_id, binding.version);
  const rebound = f.bindings.create('alice', 'slack', 'slack-file-output-rebind');
  f.bindings.acceptProof('slack', 'slack:T111:U111', rebound.code);
  let calls = 0;
  const claim = f.deliveries.claim('worker-slack', 30, ['slack'], f.service.artifacts);
  assert.equal(claim, null);
  assert.equal(f.deliveries.get(f.fileEffect.effect_id).status, 'cancelled');
  assert.equal(f.deliveries.get(f.fileEffect.effect_id).last_reason_code, 'SLACK_ARTIFACT_AUTHORIZATION_REVOKED');
  assert.equal(calls, 0);
});

test('Slack file send rechecks the binding after upload and before thread publication', async t => {
  const f = await queueSlackOutput(t);
  const calls = [];
  const provider = createSlackDeliveryProvider({ botToken, teamId: 'T111' }, f.service.db, async url => {
    calls.push(url.pathname);
    if (url.pathname === '/api/files.getUploadURLExternal') return Response.json({ ok: true, file_id: 'FOUT2',
      upload_url: 'https://files.slack.com/upload/v1/FOUT2' });
    if (url.pathname === '/upload/v1/FOUT2') {
      const binding = f.service.db.prepare("SELECT channel_binding_id,version FROM ga_owner_channel_bindings WHERE channel='slack' AND principal=?")
        .get('slack:T111:U111');
      f.bindings.revoke('alice', binding.channel_binding_id, binding.version);
      const rebound = f.bindings.create('alice', 'slack', 'slack-file-upload-race');
      f.bindings.acceptProof('slack', 'slack:T111:U111', rebound.code);
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/api/files.completeUploadExternal') return Response.json({ ok: true, files: [{ id: 'FOUT2' }] });
    throw new Error(`unexpected Slack API request: ${url}`);
  });
  const worker = new ChannelDeliveryWorker(f.deliveries, { providers: { slack: provider } },
    { registerDeliveryReceipt: async () => ({ ok: true }) }, {
      artifacts: f.service.artifacts,
      resolveRuntime: runId => ({ runtimeRunId: `runtime-${runId}`, clientRunId: runId }),
    });
  assert.equal(await worker.processNext(), true);
  const effect = f.deliveries.get(f.fileEffect.effect_id);
  assert.equal(effect.status, 'cancelled');
  assert.equal(effect.last_reason_code, 'SLACK_ARTIFACT_AUTHORIZATION_REVOKED');
  assert.deepEqual(calls, ['/api/files.getUploadURLExternal', '/upload/v1/FOUT2']);
});

test('Slack file send with an unknown provider outcome is not retried', async t => {
  const f = await queueSlackOutput(t);
  let calls = 0;
  const provider = createSlackDeliveryProvider({ botToken, teamId: 'T111' }, f.service.db, async () => {
    calls++;
    throw new Error('network timeout after acceptance');
  });
  const worker = new ChannelDeliveryWorker(f.deliveries, { providers: { slack: provider } },
    { registerDeliveryReceipt: async () => ({ ok: true }) }, {
      artifacts: f.service.artifacts,
      resolveRuntime: runId => ({ runtimeRunId: `runtime-${runId}`, clientRunId: runId }),
    });
  assert.equal(await worker.processNext(), true);
  assert.equal(f.deliveries.get(f.fileEffect.effect_id).status, 'outcome_unknown');
  assert.equal(await worker.processNext(), false);
  assert.equal(calls, 1);
});
