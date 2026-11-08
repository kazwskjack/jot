import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson } from '../../src/db/canonical-json.ts';
import { fileDeliveryContext } from '../../src/channels/delivery-effect-context.ts';
import {
  createSlackDeliveryProvider,
  createSlackWebhookAdapter,
  verifySlackWebhookSignature,
} from '../../src/channels/slack.ts';
import { encodeSlackArtifactRef } from '../../src/channels/slack-artifact-ref.ts';

const signingSecret = 'slack-signing-secret-fixture';
const officialBody = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
const officialSignature = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503';

function signedHeaders(body, secret = signingSecret, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const digest = createHmac('sha256', secret).update('v0:' + timestamp + ':' + body).digest('hex');
  return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=' + digest };
}

test('Slack signature verification matches the official vector and rejects tampering and stale requests', () => {
  assert.equal(verifySlackWebhookSignature({ secret: '8f742231b10e8888abcd99yyyzzz85a5',
    timestamp: '1531420618', signature: officialSignature, body: Buffer.from(officialBody),
    nowMs: 1531420618000 }), true);
  assert.equal(verifySlackWebhookSignature({ secret: '8f742231b10e8888abcd99yyyzzz85a5',
    timestamp: '1531420618', signature: officialSignature, body: Buffer.from(officialBody + ' '),
    nowMs: 1531420618000 }), false);
  assert.equal(verifySlackWebhookSignature({ secret: '8f742231b10e8888abcd99yyyzzz85a5',
    timestamp: '1531420618', signature: officialSignature, body: Buffer.from(officialBody),
    nowMs: 1531421218000 }), false);
});

test('Slack URL verification is signed and returns the challenge without intake', async () => {
  let intakeCalls = 0;
  const adapter = createSlackWebhookAdapter({ signingSecret, teamId: 'T111', intake: {
    accept() { intakeCalls++; throw new Error('challenge_must_not_enter_intake'); },
  } });
  const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'challenge-fixture' }));
  const result = await adapter.handle({ headers: signedHeaders(body), body });
  assert.deepEqual(result, { status: 200, body: { challenge: 'challenge-fixture' } });
  assert.equal(intakeCalls, 0);
});

test('Slack message events normalize workspace, user, thread, and globally unique event identity', async () => {
  const calls = [];
  const adapter = createSlackWebhookAdapter({ signingSecret, teamId: 'T111', intake: { accept(input, options) {
    calls.push({ input, options });
    return { accepted: true, run_id: 'run-slack-fixture' };
  } } });
  const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111', api_app_id: 'A111',
    event_id: 'Ev111', event: { type: 'message', channel: 'C111', user: 'U111',
      ts: '1761000000.000005', thread_ts: '1761000000.000001', text: 'hello from Slack' } }));
  const result = await adapter.handle({ headers: signedHeaders(body), body });
  assert.deepEqual(calls, [{ input: { channel: 'slack', principal: 'slack:T111:U111',
    thread_id: 'C111:1761000000.000001', message_id: 'Ev111', text: 'hello from Slack' },
    options: { providerSignatureVerified: true } }]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.intake_result.run_id, 'run-slack-fixture');
});

test('signed Slack interaction reply messages require the configured bot mention and preserve the original thread', async () => {
  const calls = [];
  const intakeCalls = [];
  const adapter = createSlackWebhookAdapter({ signingSecret, teamId: 'T111', botUserId: 'B111', intake: { accept(input) {
    intakeCalls.push(input);
    return { accepted: true };
  } }, handleInteractionReply(input) {
    calls.push(input);
    return { accepted: true, interaction_id: 'int-1', run_id: 'run-1' };
  } });
  const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111', event_id: 'Ev-approval',
    event: { type: 'message', channel: 'C111', user: 'U111', ts: '1761000001.000001',
      thread_ts: '1761000000.000001', text: '<@B111> /approve int-1' } }));
  const result = await adapter.handle({ headers: signedHeaders(body), body });
  assert.deepEqual(calls, [{ teamId: 'T111', channelId: 'C111', principal: 'slack:T111:U111',
    providerThreadId: 'C111:1761000000.000001', eventId: 'Ev-approval', text: '/approve int-1' }]);
  assert.equal(result.intake_result.run_id, 'run-1');

  const unmentioned = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111', event_id: 'Ev-unmentioned',
    event: { type: 'message', channel: 'C111', user: 'U111', ts: '1761000002.000001',
      thread_ts: '1761000000.000001', text: '/approve int-2' } }));
  await adapter.handle({ headers: signedHeaders(unmentioned), body: unmentioned });
  assert.equal(calls.length, 1);
  assert.deepEqual(intakeCalls, [{ channel: 'slack', principal: 'slack:T111:U111',
    thread_id: 'C111:1761000000.000001', message_id: 'Ev-unmentioned', text: '/approve int-2' }]);
});

test('Slack interaction routing requires an explicit configured bot user id', () => {
  assert.throws(() => createSlackWebhookAdapter({ signingSecret, teamId: 'T111', intake: { accept() { return {}; } },
    handleInteractionReply() { return {}; } }), /slack_config_invalid/);
});

test('Slack rejects invalid signatures before intake and ignores non-message and bot events', async () => {
  const accepted = [];
  const adapter = createSlackWebhookAdapter({ signingSecret, teamId: 'T111', intake: { accept(input) {
    accepted.push(input);
    return { accepted: true };
  } } });
  const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111',
    event_id: 'Ev111', event: { type: 'message', channel: 'C111', user: 'U111',
      ts: '1761000000.000005', text: 'hello' } }));
  await assert.rejects(adapter.handle({ headers: { ...signedHeaders(body), 'x-slack-signature': 'v0=' + '0'.repeat(64) }, body }),
    /slack_signature_invalid/);
  const reaction = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111',
    event_id: 'Ev112', event: { type: 'reaction_added', channel: 'C111', user: 'U111' } }));
  assert.deepEqual(await adapter.handle({ headers: signedHeaders(reaction), body: reaction }),
    { status: 200, body: { ok: true }, ignored: true });
  const botMessage = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111',
    event_id: 'Ev113', event: { type: 'message', subtype: 'bot_message', channel: 'C111',
      user: 'U111', ts: '1761000000.000006', text: 'bot echo' } }));
  assert.equal((await adapter.handle({ headers: signedHeaders(botMessage), body: botMessage })).ignored, true);
  assert.deepEqual(accepted, []);
});

test('Slack delivery resolves original channel/thread from existing event and outbox rows and records ts receipt', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ga_conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    CREATE TABLE ga_runs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,input_message_id TEXT NOT NULL);
    CREATE TABLE ga_messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content_json TEXT NOT NULL);
    CREATE TABLE ga_channel_threads(channel TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,conversation_id TEXT NOT NULL,channel_binding_id TEXT,binding_version INTEGER);
    CREATE TABLE ga_owner_channel_bindings(channel_binding_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,channel TEXT NOT NULL,principal TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,verified_at INTEGER NOT NULL,revoked_at INTEGER,created_at INTEGER NOT NULL);
    CREATE TABLE ga_channel_deliveries(effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, message_id TEXT NOT NULL, recipient TEXT NOT NULL, destination TEXT NOT NULL);
    CREATE TABLE ga_channel_message_events(channel TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,provider_message_id TEXT NOT NULL,
      run_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at TEXT NOT NULL,channel_binding_id TEXT,binding_version INTEGER);`);
  db.prepare('INSERT INTO ga_conversations VALUES(?,?)').run('conv-1', 'owner-slack');
  db.prepare('INSERT INTO ga_runs VALUES(?,?,?)').run('run-1', 'conv-1','input-1');
  db.prepare('INSERT INTO ga_messages VALUES(?,?,?,?,?)').run('answer-1','run-1','conv-1','assistant','{}');
  db.prepare('INSERT INTO ga_channel_threads VALUES(?,?,?,?,?,?)').run('slack','slack:T111:U111','C111:1761000000.000001','conv-1','binding-1',1);
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-1','owner-slack','slack','slack:T111:U111','verified',1,1);
  db.prepare('INSERT INTO ga_channel_deliveries VALUES(?,?,?,?,?)')
    .run('slack-effect-1', 'run-1', 'answer-1', 'slack:T111:U111', 'slack');
  db.prepare('INSERT INTO ga_channel_message_events VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('slack', 'slack:T111:U111', 'C111:1761000000.000001', 'Ev111', 'run-1', 'conv-1','input-1', new Date().toISOString(),'binding-1',1);
  const calls = [];
  const provider = createSlackDeliveryProvider({ botToken: 'xoxb-fixture-token', teamId: 'T111' }, db,
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, channel: 'C111', ts: '1761000001.000007' }), { status: 200 });
    });
  const receipt = await provider.sendWithKey('reply text', 'slack:T111:U111', 'slack-effect-1');
  assert.deepEqual(receipt, { provider_message_id: 'C111:1761000001.000007' });
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xoxb-fixture-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { channel: 'C111', thread_ts: '1761000000.000001',
    text: 'reply text', reply_broadcast: false });
  await assert.rejects(provider.sendWithKey('wrong destination', 'slack:T222:U222', 'slack-effect-1'),
    /slack_reply_context_missing/);
  assert.equal(typeof provider.sendFileWithKey, 'function');
  await assert.rejects(provider.sendFile('unused', 'slack:T111:U111', 'unused.txt'),
    /channel_delivery_context_invalid/);
  assert.equal(calls.length, 1);
  db.close();
});

test('Slack file delivery uploads the resolved artifact bytes to the original thread and returns a file receipt', async t => {
  const fixtureRoot = resolve('.test-tmp/slack-file-delivery');
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, 'fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'report.txt');
  const bytes = Buffer.from('synthetic artifact bytes');
  writeFileSync(path, bytes);
  const manifest = [{ part_index: 1, display_name: 'report.txt',
    sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, mime_type: 'text/plain' }];
  const manifestSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  const payload = { kind: 'artifact', schema_version: 1, artifact_id: 'artifact-1', version: 1,
    owner_id: 'owner-slack', conversation_id: 'conv-1', manifest, manifest_sha256: manifestSha256 };
  const fileContext = fileDeliveryContext('slack-effect-file-1', 1, {
    artifactId: 'artifact-1', version: 1, manifestSha256, partIndex: 1,
    partSha256: manifest[0].sha256, partSizeBytes: bytes.length, displayName: 'report.txt',
  });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ga_conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    CREATE TABLE ga_runs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,input_message_id TEXT NOT NULL);
    CREATE TABLE ga_messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content_json TEXT NOT NULL);
    CREATE TABLE ga_channel_deliveries(effect_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,message_id TEXT NOT NULL,recipient TEXT NOT NULL,destination TEXT NOT NULL,artifact_ref TEXT,payload_json TEXT);
    CREATE TABLE ga_channel_threads(channel TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,conversation_id TEXT NOT NULL,channel_binding_id TEXT,binding_version INTEGER);
    CREATE TABLE ga_channel_message_events(channel TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,provider_message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,run_id TEXT NOT NULL,attachments_json TEXT NOT NULL,event_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,channel_binding_id TEXT,binding_version INTEGER);
    CREATE TABLE ga_owner_channel_bindings(channel_binding_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,channel TEXT NOT NULL,principal TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,verified_at INTEGER NOT NULL,revoked_at INTEGER,created_at INTEGER NOT NULL);
    CREATE TABLE ga_artifacts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,owner_id TEXT NOT NULL);
    CREATE TABLE ga_artifact_versions(artifact_id TEXT NOT NULL,version INTEGER NOT NULL,server_path TEXT NOT NULL,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,mime_type TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE ga_run_artifacts(run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE ga_slack_artifact_delivery_pins(effect_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,source_message_id TEXT NOT NULL,recipient TEXT NOT NULL,channel_binding_id TEXT NOT NULL,
      binding_version INTEGER NOT NULL,artifact_id TEXT NOT NULL,artifact_version INTEGER NOT NULL,server_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,display_name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE ga_artifact_parts(artifact_id TEXT NOT NULL);`);
  db.prepare('INSERT INTO ga_conversations VALUES(?,?)').run('conv-1', 'owner-slack');
  db.prepare('INSERT INTO ga_runs VALUES(?,?,?)').run('run-1', 'conv-1', 'input-1');
  db.prepare('INSERT INTO ga_channel_threads VALUES(?,?,?,?,?,?)').run('slack','slack:T111:U111','C111:1761000000.000001','conv-1','binding-1',1);
  db.prepare('INSERT INTO ga_messages VALUES(?,?,?,?,?)').run('answer-1','run-1','conv-1','assistant',JSON.stringify({attachments:['artifact-1']}));
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-1','owner-slack','slack','slack:T111:U111','verified',1,1);
  db.prepare('INSERT INTO ga_artifacts VALUES(?,?,?)').run('artifact-1','conv-1','owner-slack');
  db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)').run('artifact-1',1,path,
    createHash('sha256').update(bytes).digest('hex'),bytes.length,'text/plain',JSON.stringify({status:'ready',file_name:'report.txt'}),new Date().toISOString());
  db.prepare('INSERT INTO ga_run_artifacts VALUES(?,?,?)').run('run-1','artifact-1',1);
  db.prepare('INSERT INTO ga_channel_deliveries VALUES(?,?,?,?,?,?,?)')
    .run('slack-effect-file-1', 'run-1','answer-1', 'slack:T111:U111', 'slack', encodeSlackArtifactRef('artifact-1',1), JSON.stringify(payload));
  db.prepare('INSERT INTO ga_channel_message_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('slack', 'slack:T111:U111', 'C111:1761000000.000001', 'Ev111','conv-1','input-1','run-1','[]','a'.repeat(64), new Date().toISOString(),'binding-1',1);
  db.prepare('INSERT INTO ga_slack_artifact_delivery_pins VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('slack-effect-file-1','owner-slack','conv-1','run-1','input-1','slack:T111:U111','binding-1',1,
      'artifact-1',1,path,createHash('sha256').update(bytes).digest('hex'),bytes.length,'report.txt',new Date().toISOString());
  const calls = [];
  const provider = createSlackDeliveryProvider({ botToken: 'xoxb-fixture-token', teamId: 'T111' }, db,
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === 'https://slack.com/api/files.getUploadURLExternal') {
        return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/v1/fixture-ticket', file_id: 'F111' }), { status: 200 });
      }
      if (String(url) === 'https://files.slack.com/upload/v1/fixture-ticket') return new Response('', { status: 200 });
      if (String(url) === 'https://slack.com/api/files.completeUploadExternal') {
        return new Response(JSON.stringify({ ok: true, files: [{ id: 'F111', title: 'report.txt' }] }), { status: 200 });
      }
      throw new Error('unexpected_fixture_url');
    });
  const receipt = await provider.sendFileWithKey(path, 'slack:T111:U111', 'report.txt', fileContext);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://slack.com/api/files.getUploadURLExternal');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xoxb-fixture-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { filename: 'report.txt', length: bytes.length });
  assert.equal(calls[1].url, 'https://files.slack.com/upload/v1/fixture-ticket');
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.redirect, 'manual');
  assert.deepEqual(Buffer.from(calls[1].init.body), bytes);
  assert.equal(calls[2].url, 'https://slack.com/api/files.completeUploadExternal');
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    files: [{ id: 'F111', title: 'report.txt' }], channel_id: 'C111', thread_ts: '1761000000.000001',
  });
  assert.deepEqual(receipt, {
    provider_message_id: 'slack-file:C111:F111', provider_file_id: 'F111',
    artifact_sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length,
  });
  await assert.rejects(provider.sendFileWithKey(path, 'slack:T222:U222', 'report.txt', fileContext),
    /delivery_preflight_SLACK_REPLY_CONTEXT_MISSING/);
  writeFileSync(path, Buffer.from('tampered file bytes'));
  await assert.rejects(provider.sendFileWithKey(path, 'slack:T111:U111', 'report.txt', fileContext),
    /delivery_preflight_SLACK_FILE_CHANGED/);
  writeFileSync(path, bytes);
  db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1 WHERE channel_binding_id='binding-1'").run();
  await assert.rejects(provider.sendFileWithKey(path, 'slack:T111:U111', 'report.txt', fileContext),
    /delivery_preflight_SLACK_REPLY_CONTEXT_MISSING/);
  assert.equal(calls.length, 3);
  db.close();
});

test('Slack webhook rejects a signed callback from a different workspace before intake', async () => {
  let intakeCalls = 0;
  const adapter = createSlackWebhookAdapter({ signingSecret, teamId: 'T222', intake: {
    accept() { intakeCalls++; return { accepted: true }; },
  } });
  const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T111',
    event_id: 'Ev-workspace-mismatch', event: { type: 'message', channel: 'C111', user: 'U111',
      ts: '1761000000.000005', text: 'must not cross workspaces' } }));
  await assert.rejects(adapter.handle({ headers: signedHeaders(body), body }), /slack_workspace_mismatch/);
  assert.equal(intakeCalls, 0);
});
