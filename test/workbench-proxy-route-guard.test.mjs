import assert from 'node:assert/strict';
import test from 'node:test';

import { registerWorkbenchProxy } from '../src/workbench-proxy.mjs';

function proxyFixture(respond = () => new Response('{"public_key":"public-only"}', {
  headers: { 'content-type': 'application/json' },
})) {
  const routes = [];
  const calls = [];
  const app = {
    addContentTypeParser() {},
    route(definition) { routes.push(definition); },
  };
  registerWorkbenchProxy(app, {
    url: 'http://127.0.0.1:18831', owner: 'local-user', csrf: 'server-csrf-token',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  }, 'local-csrf-token');
  return { handler: routes.find(route => route.url === '/workbench-api/v1/*').handler, calls, routes };
}

async function invoke(handler, method, url, body, extraHeaders = {}) {
  const reply = {
    statusCode: 200,
    raw: { once() {} },
    code(status) { this.statusCode = status; return this; },
    header() { return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
  const request = {
    method, url, headers: { host: 'localhost', accept: 'application/json', ...extraHeaders }, body,
    raw: { once() {} },
  };
  await handler(request, reply);
  return reply;
}

test('workbench proxy forwards only exact Push routes and rejects the bare family path', async () => {
  const { handler, calls } = proxyFixture();
  const accepted = await invoke(handler, 'GET', '/workbench-api/v1/push/vapid-public-key');
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(Buffer.from(accepted.body).toString()), { public_key: 'public-only' });
  assert.equal(calls[0].url, 'http://127.0.0.1:18831/v1/push/vapid-public-key');
  assert.equal(calls[0].init.headers['x-user-id'], 'local-user');

  const revokeBody = { expected_version: 2 };
  const revoked = await invoke(handler, 'POST', '/workbench-api/v1/push/subscriptions/push-binding-123/revoke',
    revokeBody, { 'idempotency-key': 'push-proxy-revoke-1' });
  assert.equal(revoked.statusCode, 200);
  assert.equal(calls[1].url, 'http://127.0.0.1:18831/v1/push/subscriptions/push-binding-123/revoke');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['idempotency-key'], 'push-proxy-revoke-1');
  assert.equal(calls[1].init.body, JSON.stringify(revokeBody));

  for (const [method, url] of [
    ['GET', '/workbench-api/v1/push'],
    ['GET', '/workbench-api/v1/push/admin'],
    ['POST', '/workbench-api/v1/push/vapid-public-key'],
    ['PATCH', '/workbench-api/v1/push/subscriptions'],
  ]) {
    assert.equal((await invoke(handler, method, url)).statusCode, 400, `${method} ${url}`);
  }
  assert.equal(calls.length, 2);
});

test('workbench binary imports forward the raw byte body and idempotency key', async () => {
  const { handler, calls, routes } = proxyFixture(), bytes = Buffer.from([0, 255, 65, 128]);
  const result = await invoke(handler, 'PUT', '/workbench-api/v1/workspaces/ws-1/files/binary?project_id=p-1&path=assets%2Fphoto.bin&expected_version=0',
    bytes, { 'content-type': 'application/octet-stream', 'idempotency-key': 'directory-import-001' });
  assert.equal(routes.find(route => route.url === '/workbench-api/v1/workspaces/:workspaceId/files/binary')?.bodyLimit, 104857600);
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].url, 'http://127.0.0.1:18831/v1/workspaces/ws-1/files/binary?project_id=p-1&path=assets%2Fphoto.bin&expected_version=0');
  assert.equal(calls[0].init.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(calls[0].init.body, bytes);
  assert.equal(calls[0].init.headers['idempotency-key'], 'directory-import-001');
});

test('workbench binary downloads stream the exact octet body to the local client', async () => {
  const bytes = Buffer.from([0, 255, 65, 128]);
  const { handler, calls } = proxyFixture(() => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  const result = await invoke(handler, 'GET', '/workbench-api/v1/workspaces/ws-1/files/binary?project_id=p-1&path=assets%2Fphoto.bin&version=3&sha256=ac7fa209');
  assert.equal(calls[0].url, 'http://127.0.0.1:18831/v1/workspaces/ws-1/files/binary?project_id=p-1&path=assets%2Fphoto.bin&version=3&sha256=ac7fa209');
  assert.equal(Buffer.isBuffer(result.body), false, 'large downloads are streamed rather than buffered in the BFF');
  const chunks = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
});
