import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

const catalog = {
  providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto', 'zh', 'en'],
    preparation: { phase: 'ready' } }],
  selection: { providerId: 'sensevoice-local', language: 'auto' }, maxAudioBytes: 2 * 1024 * 1024,
  maxDurationSeconds: 60,
};

function wave() {
  const data = Buffer.alloc(200);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}

function multipart(fields, audio, boundary = 'jot-voice-test-boundary') {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  chunks.push(audio, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function setup(t, adapterOverrides = {}, voiceEnabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'ga-voice-'));
  const calls = [];
  const voiceAdapter = {
    catalog: async () => catalog,
    transcribe: async (input, signal) => {
      calls.push({ ...input, signal });
      return { text: '查找官方文档', audioSeconds: 0.01, inferenceSeconds: 0.02 };
    },
    ...adapterOverrides,
  };
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws-1'],
    csrfToken: 'c'.repeat(32), allowedOrigins: ['https://jot.test'], voiceEnabled, voiceAdapter });
  t.after(async () => {
    await service.app.close(); service.db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const actor = { 'x-user-id': 'user-1', origin: 'https://jot.test', 'x-csrf-token': 'c'.repeat(32) };
  const created = await service.app.inject({ method: 'POST', url: '/v1/conversations', headers: {
    ...actor, 'idempotency-key': 'conversation-create-001',
  }, payload: { workspace_id: 'ws-1', title: 'Voice test', model: { provider: 'harness', model: 'automatic' } } });
  assert.equal(created.statusCode, 201);
  return { service, voiceAdapter, calls, actor, conversationId: created.json().conversation_id };
}

test('voice capability reports the selected DSH provider readiness and the current CSRF token', async t => {
  const { service, actor } = await setup(t);
  const result = await service.app.inject({ method: 'GET', url: '/v1/capabilities', headers: actor });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['x-csrf-token'], 'c'.repeat(32));
  assert.deepEqual(result.json().voice, { enabled: true, status: 'ready', max_duration_ms: 60000,
    max_bytes: 2 * 1024 * 1024, accepted_mime_types: ['audio/wav'], languages: ['auto', 'zh', 'en'] });
});

test('default configuration keeps voice disabled even if a DSH adapter is present', async t => {
  const { service, calls, actor, conversationId } = await setup(t, {}, false);
  const capability = await service.app.inject({ method: 'GET', url: '/v1/capabilities', headers: actor });
  assert.equal(capability.json().voice.enabled, false);
  assert.equal(capability.json().voice.status, 'disabled');
  const result = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...multipart({ client_request_id: 'voice-request-disabled', language: 'zh' }, wave()).headers },
    payload: multipart({ client_request_id: 'voice-request-disabled', language: 'zh' }, wave()).payload });
  assert.equal(result.statusCode, 503);
  assert.equal(calls.length, 0);
});

test('same-owner upload transcribes asynchronously, supports idempotent replay, and retains no transcript in SQLite', async t => {
  const { service, calls, actor, conversationId } = await setup(t);
  const parts = multipart({ client_request_id: 'voice-request-0001', language: 'zh' }, wave());
  const created = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...parts.headers }, payload: parts.payload });
  assert.equal(created.statusCode, 202);
  const id = created.json().transcription_id;
  assert.equal(created.json().status, 'queued');

  const replay = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...parts.headers }, payload: parts.payload });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().transcription_id, id);
  const differentAudio = wave(); differentAudio[44] = 1;
  const conflictBody = multipart({ client_request_id: 'voice-request-0001', language: 'zh' }, differentAudio);
  const conflict = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...conflictBody.headers }, payload: conflictBody.payload });
  assert.equal(conflict.statusCode, 409);
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await service.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/voice/transcriptions/${id}`, headers: actor });
    if (state.json().status === 'succeeded') {
      assert.equal(state.json().text, '查找官方文档');
      assert.equal(state.json().language, 'zh');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider_id, 'sensevoice-local');
  assert.equal(calls[0].language, 'zh');
  assert.equal(calls[0].audio.toString('ascii', 0, 4), 'RIFF');
  const columns = service.db.prepare('PRAGMA table_info(ga_voice_transcriptions)').all().map(value => value.name);
  assert.equal(columns.includes('text'), false);
  assert.equal(columns.includes('audio'), false);
  const stored = service.db.prepare('SELECT * FROM ga_voice_transcriptions WHERE id=?').get(id);
  assert.equal(JSON.stringify(stored).includes('查找官方文档'), false);
});

test('invalid WAV, unsupported language, missing CSRF, and cross-owner reads are rejected', async t => {
  const { service, calls, actor, conversationId } = await setup(t);
  const invalid = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...multipart({ client_request_id: 'voice-request-invalid', language: 'zh' }, Buffer.from('not a wave')).headers },
    payload: multipart({ client_request_id: 'voice-request-invalid', language: 'zh' }, Buffer.from('not a wave')).payload });
  assert.equal(invalid.statusCode, 422);

  const unsupported = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...multipart({ client_request_id: 'voice-request-language', language: 'xx' }, wave()).headers },
    payload: multipart({ client_request_id: 'voice-request-language', language: 'xx' }, wave()).payload });
  assert.equal(unsupported.statusCode, 422);

  const noCsrf = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, 'x-csrf-token': '', ...multipart({ client_request_id: 'voice-request-csrf', language: 'zh' }, wave()).headers },
    payload: multipart({ client_request_id: 'voice-request-csrf', language: 'zh' }, wave()).payload });
  assert.equal(noCsrf.statusCode, 403);

  const own = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...multipart({ client_request_id: 'voice-request-owner', language: 'zh' }, wave()).headers },
    payload: multipart({ client_request_id: 'voice-request-owner', language: 'zh' }, wave()).payload });
  assert.equal(own.statusCode, 202);
  const denied = await service.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/voice/transcriptions/${own.json().transcription_id}`,
    headers: { 'x-user-id': 'other' } });
  assert.equal(denied.statusCode, 404);
  const wrongConversation = await service.app.inject({ method: 'GET', url: `/v1/conversations/not-this-conversation/voice/transcriptions/${own.json().transcription_id}`,
    headers: actor });
  assert.equal(wrongConversation.statusCode, 404);
  assert.equal(calls.length, 1);
});

test('cancel awaits provider settlement and discards any late transcript', async t => {
  let started;
  let finish;
  const entered = new Promise(resolve => { started = resolve; });
  const adapter = { catalog: async () => catalog, transcribe: async (_input, signal) => {
    started();
    await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true }); });
    return { text: '迟到内容不得入草稿', audioSeconds: 0.01, inferenceSeconds: 0.02 };
  } };
  const { service, actor, conversationId } = await setup(t, adapter);
  const created = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/voice/transcriptions`,
    headers: { ...actor, ...multipart({ client_request_id: 'voice-request-cancel', language: 'zh' }, wave()).headers },
    payload: multipart({ client_request_id: 'voice-request-cancel', language: 'zh' }, wave()).payload });
  assert.equal(created.statusCode, 202);
  const id = created.json().transcription_id;
  await entered;
  const cancelled = await service.app.inject({ method: 'DELETE', url: `/v1/conversations/${conversationId}/voice/transcriptions/${id}`, headers: actor });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, 'cancelled');
  const read = await service.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/voice/transcriptions/${id}`, headers: actor });
  assert.equal(read.json().status, 'cancelled');
  assert.equal('text' in read.json(), false);
});
