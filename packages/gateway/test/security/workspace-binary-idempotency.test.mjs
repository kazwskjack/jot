import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
const start = source.indexOf("app.addHook('preHandler', async (request, reply) => {");
const end = source.indexOf("\n  app.addHook('onSend'", start);
assert.ok(start >= 0 && end > start);
const hookSource = source.slice(start, end).trim().slice("app.addHook('preHandler', ".length, -2);
const canonicalJson = value => value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  : JSON.stringify(value) ?? 'null';
const hash = value => createHash('sha256').update(value).digest('hex');
const original = { workspace_id: 'ws-1', project_id: 'project-1', path: 'first.bin', expected_version: 0,
  sha256: hash(Buffer.from('first')), size: 5, source: { kind: 'directory_import', relative_path: 'first.bin' } };
const receipt = { protocol: 1, path: 'first.bin', version: 1 };

function fixture() {
  let actorCalls = 0, genericQueries = 0;
  const scope = new Proxy({ config: { csrfToken: 'csrf-token-123456', allowedOrigins: ['http://localhost'] },
    actor: () => { actorCalls++; return 'alice'; }, canonicalJson, createHash,
    db: { prepare: sql => ({ get: () => {
      genericQueries++;
      if (sql.includes('ga_uploads')) return undefined;
      assert.match(sql, /ga_idempotency/);
      return { request_sha256: hash(canonicalJson({ upload_id: '', sha256: null, size: null })),
        response_status: 200, response_json: JSON.stringify(receipt), receipt_protocol: null };
    } }) },
  }, { has: () => true, get: (object, key) => key === Symbol.unscopables ? undefined
    : key in object ? object[key] : key in globalThis ? globalThis[key] : () => false });
  const hook = new Function('scope', `with (scope) { return (${stripTypeScriptTypes(hookSource)}); }`)(scope);
  return { hook, get actorCalls() { return actorCalls; }, get genericQueries() { return genericQueries; } };
}

function request(overrides = {}) {
  return { method: 'PUT', url: '/v1/workspaces/ws-1/files/binary?path=second.bin',
    routeOptions: { url: '/v1/workspaces/:workspaceId/files/binary', config: {} }, params: { workspaceId: 'ws-1' },
    headers: { origin: 'http://localhost', 'x-csrf-token': 'csrf-token-123456',
      'idempotency-key': 'binary-key-1', 'content-type': 'application/octet-stream' }, ...overrides };
}

const servicePath = process.env.WORKSPACE_BINARY_SERVICE_SOURCE
  || new URL('../../src/workbench/service.ts', import.meta.url);
const serviceSource = readFileSync(servicePath, 'utf8');
const methodStart = serviceSource.indexOf('  writeBinaryFile(');
const methodEnd = serviceSource.indexOf('  readBinaryFile(', methodStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart, 'binary service source required');
const method = stripTypeScriptTypes(`function ${serviceSource.slice(methodStart, methodEnd).trim()}`);
const writeBinary = new Function('createHash', 'canonicalJson', 'hash', 'text', 'integer', `return (${method});`)
  (createHash, canonicalJson, hash, value => value, value => value);
const prior = { request_sha256: hash(canonicalJson(original)), receipt_json: JSON.stringify(receipt) };
const service = { workspace: value => value, filePath: value => value, fileLifecycleRequestKey: value => value,
  projects: { assertOwned() {} }, transaction: operation => operation(),
  db: { prepare: sql => { assert.match(sql, /wb_file_binary_import_commands/); return { get: () => prior }; } },
  fileLifecycleReceipt: value => JSON.parse(value.receipt_json) };

for (const [name, path, bytes] of [['changed path', 'second.bin', 'first'], ['changed bytes', 'first.bin', 'other']]) {
  test(`binary hook allows the service receipt to reject same-key ${name}`, async () => {
    const f = fixture(); let cached = false;
    const reply = { code() { return this; }, send() { cached = true; return this; }, header() { return this; } };
    await f.hook(request(), reply);
    assert.equal(cached, false, 'global hook returned stale 200 before the service');
    assert.equal(f.genericQueries, 0);
    assert.ok(f.actorCalls >= 1);
    assert.throws(() => writeBinary.call(service, 'alice', 'ws-1',
      { project_id: 'project-1', path, expected_version: 0, command_key: 'binary-key-1' }, Buffer.from(bytes)),
    /idempotency_conflict/); // Existing HTTP error mapping returns 409.
  });
}

test('binary exemption retains Origin, CSRF and idempotency-key fences', async () => {
  for (const [header, value, error] of [['origin', 'http://evil.test', /origin_forbidden/],
    ['x-csrf-token', 'wrong', /csrf_invalid/], ['idempotency-key', '', /idempotency_key_invalid/]]) {
    const req = request(); req.headers[header] = value;
    await assert.rejects(fixture().hook(req, {}), error);
  }
});

test('raw URL lookalikes do not receive the registered-route exemption', async () => {
  const f = fixture(); let cached = false;
  await f.hook(request({ routeOptions: { url: '/v1/uploads/:uploadId/content', config: {} } }),
    { code() { return this; }, send() { cached = true; return this; } });
  assert.equal(cached, true);
  assert.ok(f.genericQueries > 0);
});
