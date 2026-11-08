import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, isAbsolute } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { chatWebNetworkConfiguration } from '../../src/config.ts';
import { SessionBindingRepository } from '../../src/harness/session-bindings.ts';

const origin = 'https://fixture.jot.example';
const allowedRedirectOrigin = 'https://allowed.example';
const internalToken = 'test-web-read-origin-token-0123456789';
const csrfToken = 'test-web-read-origin-csrf';
const base = resolve(fileURLToPath(new URL('../../../../.test-tmp/gateway-web-read-network/', import.meta.url)));
mkdirSync(base, { recursive: true });

test('Workbench web.read applies configured origins before DNS and on each redirect', { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(base, 'case-'));
  const templateRoot = join(root, 'templates');
  mkdirSync(templateRoot);
  const templateBytes = Buffer.from('controlled web.read fixture; no document render is requested');
  writeFileSync(join(templateRoot, 'fixture.docx'), templateBytes);
  writeFileSync(join(templateRoot, 'catalog.json'), JSON.stringify({ templates: [{
    template_id: 'fixture-template',
    version: '1',
    format: 'docx',
    file: 'fixture.docx',
    sha256: createHash('sha256').update(templateBytes).digest('hex'),
    fields: {},
  }] }));
  let service;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (service) {
      await service.app.close();
      service.db.close();
    }
    const child = relative(base, resolve(root));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'cleanup target must stay inside fixture root');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const resolvedHosts = [];
  const requestedUrls = [];
  const chatWebNetwork=chatWebNetworkConfiguration({JOT_WEB_ORIGINS:`${origin},${allowedRedirectOrigin}`});
  assert.deepEqual(chatWebNetwork.allowedOrigins,[origin,allowedRedirectOrigin]);
  assert.throws(()=>chatWebNetworkConfiguration({JOT_WEB_ORIGINS:'https://fixture.jot.example/untrusted-path'}),/config_jot_web_origins_invalid/);
  let responsePlan = [];
  t.mock.method(dns, 'lookup', async hostname => {
    resolvedHosts.push(hostname);
    return [{ address: '8.8.8.8', family: 4 }];
  });
  t.mock.method(https, 'request', (url, _options, callback) => {
    requestedUrls.push(url.href);
    const request = new EventEmitter();
    request.destroy = error => {
      if (error) request.emit('error', error);
      request.emit('close');
    };
    request.end = () => {
      const plan = responsePlan.shift() ?? { status: 200, text: 'unexpected fixture response' };
      const response = new PassThrough();
      response.statusCode = plan.status;
      response.headers = {
        'content-type': 'text/html',
        ...(plan.location ? { location: plan.location } : {}),
      };
      callback(response);
      response.end(plan.text ?? '');
      request.emit('close');
    };
    return request;
  });
  syncBuiltinESMExports();

  service = await buildServer({
    databasePath: ':memory:',
    workspaces: ['main'],
    uploadRoot: join(root, 'uploads'),
    templateRoot,
    workbenchRoot: join(root, 'workspace'),
    csrfToken,
    allowedOrigins: [origin],
    internalChannelToken: internalToken,
    chatWebNetwork,
    modelBudgetRoutes: [{
      provider: 'fixture',
      model: 'bounded',
      revision: 'fixture-rates-v1',
      context_window: 100,
      max_output_tokens: 20,
      rates: { input: 2, output: 10, cache_read: 1, cache_write: 3 },
    }],
  });

  const headers = {
    'x-user-id': 'alice',
    origin,
    'x-csrf-token': csrfToken,
    'idempotency-key': 'web-read-origin-fixture',
  };
  const json = async (method, url, payload, expectedStatus) => {
    const response = await service.app.inject({ method, url, payload, headers });
    assert.equal(response.statusCode, expectedStatus, response.body);
    return response.json();
  };
  const agent = await json('POST', '/v1/agents', {
    name: 'Network policy reader',
    instructions: 'Read only public pages',
    workspace_id: 'main',
    allowed_tools: ['universe_search'],
  }, 201);
  const task = await json('POST', '/v1/persistent-tasks', {
    title: 'Public page source',
    agent_id: agent.agent_id,
    objective: 'Read an allowed public page',
    trigger: { kind: 'once', run_at: '2099-01-01T00:00:00Z' },
  }, 201);
  const occurrence = await json('POST', '/v1/persistent-tasks/' + task.task_id + '/run-now', {}, 202);
  service.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(occurrence.run_id);
  const sessionRef = new SessionBindingRepository(service.db)
    .getOrCreate('alice', occurrence.conversation_id).session_id;
  const invoke = (url, callId) => service.app.inject({
    method: 'POST',
    url: '/internal/v1/workbench/tool',
    headers: { authorization: 'Bearer ' + internalToken },
    payload: {
      run_id: occurrence.run_id,
      session_ref: sessionRef,
      operation: 'web.read',
      arguments: { url },
      call_id: callId,
    },
  });

  responsePlan = [
    { status: 302, location: allowedRedirectOrigin + '/final' },
    { status: 200, text: 'Allowed fixture page' },
  ];
  const allowed = await invoke(origin + '/start', 'allowed-origin');
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.json().url, allowedRedirectOrigin + '/final');
  assert.equal(allowed.json().text, 'Allowed fixture page');
  assert.deepEqual(resolvedHosts, ['fixture.jot.example', 'allowed.example']);
  assert.deepEqual(requestedUrls, [origin + '/start', allowedRedirectOrigin + '/final']);

  const beforeDenied = { resolved: resolvedHosts.length, requested: requestedUrls.length };
  responsePlan = [{ status: 200, text: 'must not be fetched' }];
  const denied = await invoke('https://denied.example/start', 'denied-origin');
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, 'UNSAFE_PAGE_URL');
  assert.equal(resolvedHosts.length, beforeDenied.resolved);
  assert.equal(requestedUrls.length, beforeDenied.requested);

  const beforeRedirect = { resolved: resolvedHosts.length, requested: requestedUrls.length };
  responsePlan = [
    { status: 302, location: 'https://outside.example/redirect' },
    { status: 200, text: 'must not follow redirect' },
  ];
  const redirected = await invoke(origin + '/redirect-start', 'out-of-policy-redirect');
  assert.equal(redirected.statusCode, 403, redirected.body);
  assert.equal(redirected.json().error.code, 'UNSAFE_PAGE_URL');
  assert.equal(resolvedHosts.length, beforeRedirect.resolved + 1);
  assert.equal(requestedUrls.length, beforeRedirect.requested + 1);
});
