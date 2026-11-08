import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ChannelARuntime } from '../../src/channels/adapters/channel-a-runtime.ts';
import { createMatrixAdapter } from '../../src/channels/adapters/matrix.ts';
import { createChannelAttachmentForwardV2 } from '../../src/channels/attachment-forward-v2.ts';
import { channelAttachmentManifestDigestV2 } from '../../src/channels/attachment-manifest-v2.ts';
import { channelStageRequestDigestV2 } from '../../src/channels/attachment-stage-v2.ts';

const TOKEN = 'synthetic-channel-service-token-32';
const PREFIX = '/internal/v2/channel/attachment-batches';
const RECEIPT = Object.freeze({ accepted: true, message_id: 'message-1', run_id: 'run-1', conversation_id: 'conversation-1' });
const bytes = Buffer.from('exact Matrix attachment bytes');

function sourceInput(overrides = {}) {
  return {
    channel: 'matrix', principal: '@alice:example.org', thread_id: '!room:example.org',
    message_id: '$event-1:example.org', text: 'Read this file', authenticated: true,
    attachments: [{ provider_file_id: 'mxc://media.example.org/file-1', file_name: 'notes.txt',
      media_type: 'text/plain', size_bytes: bytes.length, bytes: new Uint8Array(bytes) }],
    ...overrides,
  };
}

function declaration(input, index = 0) {
  const part = input.attachments[index];
  return { index, provider_file_id: part.provider_file_id, file_name: part.file_name,
    media_type: part.media_type, size_bytes: part.bytes.length, sha256: createHash('sha256').update(part.bytes).digest('hex') };
}

function stageFor(input, state = 'staging') {
  const decl = input.attachments.map((_part, index) => declaration(input, index));
  const event = { channel: input.channel, principal: input.principal, thread_id: input.thread_id, message_id: input.message_id };
  const source = { protocol: 2, owner_id: 'owner-1', channel_binding_id: 'binding-1', binding_version: 1,
    conversation_id: 'conversation-reserved', event, text: input.text,
    attachments: decl.map((part) => ({ ...part, artifact_id: `artifact-${'c'.repeat(32)}`, version: 1, kind: 'text' })) };
  const manifestSha256 = channelAttachmentManifestDigestV2(source);
  return { protocol: 2, state, stage_key: `channel-stage-${'a'.repeat(64)}`, request_sha256: channelStageRequestDigestV2(source),
    manifest_sha256: manifestSha256, source,
    parts: source.attachments.map((part) => ({ ...part, upload_id: `upload-channel-${'e'.repeat(32)}` })),
    expires_at: '2099-10-23T12:00:00.000Z' };
}

function admitted(manifestSha256) {
  return { protocol: 2, state: 'admitted', event_sha256: manifestSha256, manifest_sha256: manifestSha256, receipt: RECEIPT };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('M19.09 sends authenticated Matrix bytes through the durable v2 batch contract', async () => {
  const input = sourceInput();
  const stage = stageFor(input);
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://127.0.0.1:18080/', token: TOKEN,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, init });
      if (parsed.pathname === `${PREFIX}/lookup`) return response({ protocol: 2, state: 'not_observed', original_admission: 'unproven', automatic_replay: false });
      if (parsed.pathname === PREFIX && init.method === 'POST') return response(stage, 201);
      if (parsed.pathname.endsWith('/parts/0')) return response({ protocol: 2, state: 'part_staged', index: 0 });
      if (parsed.pathname.endsWith('/admit')) return response(admitted(stage.manifest_sha256), 202);
      assert.fail(`unexpected request ${init.method} ${parsed.pathname}`);
    } });

  const result = await forward(input);
  assert.equal(result.statusCode, 202, JSON.stringify({ result, calls: calls.map(({ path, init }) => [init.method, path]) }));
  assert.deepEqual(result, { statusCode: 202, body: RECEIPT });
  assert.deepEqual(calls.map(call => [call.init.method, call.path]), [
    ['POST', `${PREFIX}/lookup`], ['POST', PREFIX], ['PUT', `${PREFIX}/${stage.stage_key}/parts/0`],
    ['POST', `${PREFIX}/${stage.stage_key}/admit`],
  ]);
  const request = JSON.parse(calls[0].init.body);
  assert.deepEqual(request, { protocol: 2, event: { channel: input.channel, principal: input.principal,
    thread_id: input.thread_id, message_id: input.message_id }, text: input.text,
    attachments: [declaration(input)] });
  assert.equal(Object.hasOwn(request, 'owner_id'), false);
  assert.equal(Object.hasOwn(request, 'conversation_id'), false);
  assert.equal(calls.every(({ init }) => init.headers.authorization === `Bearer ${TOKEN}`), true);
  assert.equal(Buffer.from(await calls[2].init.body.arrayBuffer()).equals(bytes), true);
});

test('M19.09 resolves a lost admission acknowledgement with one read-only original-event lookup', async () => {
  const input = sourceInput();
  const stage = stageFor(input);
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://localhost:18080/', token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method });
      if (path === `${PREFIX}/lookup`) return response(calls.filter(call => call.path === `${PREFIX}/lookup`).length === 1
        ? { protocol: 2, state: 'not_observed', original_admission: 'unproven', automatic_replay: false }
        : admitted(stage.manifest_sha256));
      if (path === PREFIX) return response(stage, 201);
      if (path.endsWith('/parts/0')) return response({ protocol: 2, state: 'part_staged', index: 0 });
      if (path.endsWith('/admit')) return response({ error: { code: 'CHANNEL_ATTACHMENT_UNAVAILABLE' } }, 500);
      assert.fail(`unexpected request ${init.method} ${path}`);
    } });

  const result = await forward(input);
  assert.equal(result.statusCode, 202, JSON.stringify({ result, calls }));
  assert.deepEqual(result, { statusCode: 202, body: RECEIPT });
  assert.deepEqual(calls.map(call => call.method), ['POST', 'POST', 'PUT', 'POST', 'POST']);
  assert.equal(calls.filter(call => call.path.endsWith('/admit')).length, 1);
});

test('M19.09 rejects an original-event receipt whose event and manifest digests differ', async () => {
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://127.0.0.1:18080/', token: TOKEN,
    fetch: async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method });
      return response({ protocol: 2, state: 'admitted', event_sha256: 'f'.repeat(64),
        manifest_sha256: 'd'.repeat(64), receipt: RECEIPT });
    } });

  const result = await forward(sourceInput());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, 'CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN');
  assert.deepEqual(calls, [{ path: `${PREFIX}/lookup`, method: 'POST' }]);
});

test('M19.09 does not upload when a reservation request digest does not match its pinned source', async () => {
  const input = sourceInput();
  const stage = { ...stageFor(input), request_sha256: 'b'.repeat(64) };
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://127.0.0.1:18080/', token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method });
      if (path === `${PREFIX}/lookup`) return response({ protocol: 2, state: 'not_observed', original_admission: 'unproven', automatic_replay: false });
      if (path === PREFIX) return response(stage, 201);
      assert.fail(`unproven reservation must not trigger ${init.method} ${path}`);
    } });

  const result = await forward(input);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, 'CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN');
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['POST', `${PREFIX}/lookup`], ['POST', PREFIX], ['POST', `${PREFIX}/lookup`],
  ]);
});

test('M19.09 treats an observed but unadmitted stage as receipt-only and never resumes its mutations', async () => {
  const input = sourceInput();
  const stage = stageFor(input);
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://127.0.0.1:18080/', token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method });
      if (path === `${PREFIX}/lookup`) return response({ protocol: 2, state: 'stage_observed', stage,
        automatic_replay: false });
      assert.fail(`stage observation must not trigger ${init.method} ${path}`);
    } });

  const result = await forward(input);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, 'CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN');
  assert.deepEqual(calls, [{ path: `${PREFIX}/lookup`, method: 'POST' }]);
});

test('M19.09 follows a lost reservation acknowledgement with lookup only', async () => {
  const input = sourceInput();
  const stage = stageFor(input);
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://127.0.0.1:18080/', token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method });
      if (path === `${PREFIX}/lookup`) return response(calls.filter(call => call.path === `${PREFIX}/lookup`).length === 1
        ? { protocol: 2, state: 'not_observed', original_admission: 'unproven', automatic_replay: false }
        : { protocol: 2, state: 'stage_observed', stage, automatic_replay: false });
      if (path === PREFIX) return response({ error: { code: 'CHANNEL_ATTACHMENT_UNAVAILABLE' } }, 500);
      assert.fail(`lost reservation acknowledgement must not trigger ${init.method} ${path}`);
    } });

  const result = await forward(input);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, 'CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN');
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['POST', `${PREFIX}/lookup`], ['POST', PREFIX], ['POST', `${PREFIX}/lookup`],
  ]);
});

test('M19.09 does not reserve or replay when original-event lookup is unproven', async () => {
  const calls = [];
  const forward = createChannelAttachmentForwardV2({ url: 'http://127.0.0.1:18080/', token: TOKEN,
    fetch: async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method });
      return response({ protocol: 2, state: 'unproven', original_admission: 'unproven', automatic_replay: false });
    } });
  const result = await forward(sourceInput());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, 'CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN');
  assert.deepEqual(calls, [{ path: `${PREFIX}/lookup`, method: 'POST' }]);
});

test('M19.09 Matrix poll downloads only verified MXC media and passes sealed bytes to the v2 consumer', async () => {
  const calls = [];
  const client = createMatrixAdapter({ baseUrl: 'https://matrix.example.org', accessToken: 'matrix-access-token', userId: '@bot:example.org' },
    async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed.href, init });
      if (parsed.pathname === '/_matrix/client/v3/sync') return response({ next_batch: 'next-1', rooms: { join: {
        '!room:example.org': { timeline: { events: [{ type: 'm.room.message', sender: '@alice:example.org',
          event_id: '$event-1:example.org', content: { msgtype: 'm.file', body: 'Read this file',
            filename: 'notes.txt', url: 'mxc://media.example.org/file-1', info: { mimetype: 'text/plain', size: bytes.length } } }] } },
      } } });
      if (parsed.pathname.includes('/_matrix/client/v1/media/download/')) {
        return new Response(bytes, { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length) } });
      }
      assert.fail(`unexpected Matrix request ${parsed.pathname}`);
    });
  let forwarded;
  const runtime = new ChannelARuntime({ channels: { matrix: { client } },
    forward: async () => assert.fail('attachment must not use v1 text intake'),
    attachmentForward: async (input) => {
      forwarded = input;
      return { statusCode: 202, body: RECEIPT };
    } });
  runtime.start();
  try {
    const batch = await runtime.pollMatrix();
    assert.equal(batch.nextBatch, 'next-1');
    assert.deepEqual(batch.receipts, [RECEIPT]);
    assert.equal(forwarded.authenticated, true);
    assert.equal(forwarded.principal, '@alice:example.org');
    assert.equal(forwarded.thread_id, '!room:example.org');
    assert.equal(forwarded.message_id, '$event-1:example.org');
    assert.equal(forwarded.attachments[0].provider_file_id, 'mxc://media.example.org/file-1');
    assert.equal(Buffer.from(forwarded.attachments[0].bytes).equals(bytes), true);
    assert.equal(calls[1].init.headers.authorization, 'Bearer matrix-access-token');
  } finally { await runtime.stop(); }
});
