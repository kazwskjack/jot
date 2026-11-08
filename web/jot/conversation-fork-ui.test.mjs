import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {buildServer} from '../../packages/gateway/src/server.ts';
import {HarnessCoordinator} from '../../packages/gateway/src/harness/coordinator.ts';
import {pinRunNativeSession} from '../../packages/gateway/src/harness/run-native-session.ts';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

async function installFixtureEventStream(context, replay) {
  await context.exposeBinding('__jotFixtureEvents', async (_source, id, after) => replay(id, Number(after)));
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    const encoder = new TextEncoder();
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.pathname.endsWith('/events')) return original(input, init);
      const parts = url.pathname.split('/');
      const id = decodeURIComponent(parts[parts.indexOf('conversations') + 1]);
      const headers = new Headers(init.headers);
      const cursor = {value: Number(headers.get('Last-Event-ID') ?? 0)};
      const signal = init.signal;
      let closed = false;
      let timer;
      const stream = new ReadableStream({
        start(controller) {
          const poll = async () => {
            if (closed || signal?.aborted) return;
            try {
              const events = await window.__jotFixtureEvents(id, cursor.value);
              for (const event of events) {
                controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
                cursor.value = Number(event.seq);
              }
              timer = setTimeout(poll, 30);
            } catch (error) {
              controller.error(error);
            }
          };
          controller.enqueue(encoder.encode(': live fixture stream\n\n'));
          void poll();
        },
        cancel() {
          closed = true;
          clearTimeout(timer);
        }
      });
      signal?.addEventListener('abort', () => {
        closed = true;
        clearTimeout(timer);
      }, {once: true});
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: {'content-type': 'text/event-stream', 'cache-control': 'no-cache'}
      }));
    };
  });
}

test('Workbench forks a completed original message and retries a lost receipt without creating a second branch', {timeout: 60000}, async t => {
  const scratch = resolve('.test-tmp');
  await mkdir(scratch, {recursive: true});
  const root = await mkdtemp(join(scratch, 'm02-05-fork-ui-'));
  let service;
  let browser;
  const faults = [];
  const writes = [];
  const snapshots = [];
  const csrf = 'synthetic-conversation-fork-csrf';
  const origin = 'https://jot.test';
  const sessionId = 'native-fork-ui-session';
  let sourceReads = 0;
  let sourceRunId = '';
  let loseFirstReceipt = true;

  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../workbench-entry.tsx', import.meta.url))],
    bundle: true,
    write: false,
    outfile: join(root, 'bundle.js'),
    format: 'iife',
    platform: 'browser',
    nodePaths: ['E:/codex/yunticket/.test-tmp/jot-permissive-20261021/integration/node_modules'],
    logLevel: 'silent'
  });

  try {
    await mkdir(join(root, 'workspaces'), {recursive: true});
    service = await buildServer({
      databasePath: join(root, 'gateway.sqlite'),
      uploadRoot: join(root, 'uploads'),
      workbenchRoot: join(root, 'workspaces'),
      workspaces: ['ws'],
      templateRoot: fileURLToPath(new URL('../../packages/gateway/file-engine/templates', import.meta.url)),
      csrfToken: csrf,
      allowedOrigins: ['https://fixture.invalid'],
      conversationForkSourceClient: {
        inspectConversationForkSource: async requestedSession => {
          sourceReads += 1;
          assert.equal(requestedSession, sessionId);
          return {
            meta: {id: sessionId, version: 4, createdAt: 123, origin: 'main', isSeeded: false},
            inheritedEventCount: 0,
            events: [{seq: 0, time: 1, type: 'user/message', data: {source: {kind: 'user', rpcId: sourceRunId}}}]
          };
        }
      }
    });

    const source = service.conversations.create('ui-owner', {
      workspace_id: 'ws',
      title: 'Original source',
      model: {provider: 'fixture', model: 'fixture'}
    });
    const now = new Date().toISOString();
    service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)')
      .run(source.conversation_id, 'ui-owner', sessionId, now, now);
    const sourceInput = service.runs.enqueue(source.conversation_id, 'ui-owner', {
      client_message_id: 'client-source-fork-ui',
      content: [{type: 'text', text: 'Original transcript body'}]
    });
    const messageId = sourceInput.message_id;
    sourceRunId = sourceInput.run_id;
    const coordinator = new HarnessCoordinator(service.db, service.runs, service.events);
    const lease = coordinator.claimNext('fork-ui-worker', 30000);
    assert.ok(lease);
    coordinator.start(lease);
    pinRunNativeSession(service.db, sourceInput.run_id, {owner: lease.owner, generation: lease.generation}, sessionId);
    service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(sourceInput.run_id);

    const originalBefore = service.db.prepare('SELECT id,owner_id,version,title,model,updated_at FROM ga_conversations WHERE id=?')
      .get(source.conversation_id);
    const sourceMessagesBefore = service.db.prepare('SELECT id,role,status,content_json FROM ga_messages WHERE conversation_id=? ORDER BY id')
      .all(source.conversation_id);
    const capabilities = await service.app.inject({method: 'GET', url: '/v1/capabilities', headers: {'x-user-id': 'ui-owner'}});
    assert.equal(capabilities.statusCode, 200, capabilities.body);
    assert.deepEqual(capabilities.json().conversation_forks, {protocol: 1, available: true});

    browser = await chromium.launch({headless: true, ...await browserTestLaunchOptions(chromium), env: {...process.env}});
    const context = await browser.newContext({viewport: {width: 1100, height: 850}});
    await context.exposeBinding('__jotFixtureSnapshotSeen', async (_source, path) => snapshots.includes(path));
    await installFixtureEventStream(context, (id, after) => {
      service.conversations.get(id, 'ui-owner');
      return service.events.replay(id, after, 1000);
    });
    await context.route('**/*', async route => {
      try {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/') return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'
        });
        if (url.pathname === '/bundle.js') return route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: bundle.outputFiles.find(file => file.path.endsWith('.js')).text
        });
        if (url.pathname === '/bundle.css') return route.fulfill({
          status: 200,
          contentType: 'text/css',
          body: bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
        });
        if (url.pathname === '/favicon.ico') return route.fulfill({status: 204, body: ''});

        const path = url.pathname.replace('/workbench-api', '');
        const body = request.postData() ? JSON.parse(request.postData()) : undefined;
        if (path.endsWith('/events')) return route.fulfill({status: 404, body: ''});
        if (request.method() === 'GET' && /\/v1\/conversations\/[^/]+\/snapshot$/.test(path)) snapshots.push(path);
        if (request.method() !== 'GET') writes.push({
          method: request.method(),
          path,
          body,
          key: request.headers()['idempotency-key'],
          actor: request.headers()['x-jot-actor'],
          csrf: request.headers()['x-csrf-token']
        });

        const response = await service.app.inject({
          method: request.method(),
          url: path + url.search,
          headers: {
            ...request.headers(),
            host: 'fixture.invalid',
            origin: 'https://fixture.invalid',
            'x-user-id': 'ui-owner'
          },
          ...(body === undefined ? {} : {payload: body})
        });
        if (loseFirstReceipt && request.method() === 'POST' && /\/fork$/.test(path) && response.statusCode === 201) {
          loseFirstReceipt = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({error: {code: 'SYNTHETIC_RECEIPT_LOST_AFTER_COMMIT'}})
          });
        }
        return route.fulfill({
          status: response.statusCode,
          headers: Object.fromEntries(Object.entries(response.headers)
            .filter(([key]) => !['content-length', 'transfer-encoding', 'connection'].includes(key))),
          body: response.body
        });
      } catch (error) {
        faults.push(error instanceof Error ? error.message : String(error));
        return route.fulfill({status: 500, contentType: 'text/plain', body: 'fixture failure'});
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => faults.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', {name: '我的对话', exact: true}).click();
    await page.getByRole('button', {name: 'Original source', exact: true}).click();
    await page.getByText('Original transcript body', {exact: true}).waitFor();

    const fork = page.getByRole('button', {name: '在新对话中继续', exact: true});
    assert.equal(await fork.count(), 1, 'the original completed message exposes the fork action');
    await fork.click();
    const retry = page.getByRole('button', {name: '重试创建新对话', exact: true});
    await retry.waitFor();
    assert.equal(service.db.prepare('SELECT count(*) n FROM ga_conversation_forks WHERE source_conversation_id=?')
      .get(source.conversation_id).n, 1, 'the lost response happens after the original database commits once');
    await retry.click();

    const forkRow = service.db.prepare('SELECT * FROM ga_conversation_forks WHERE source_conversation_id=?')
      .get(source.conversation_id);
    assert.ok(forkRow);
    const targetSnapshot = `/v1/conversations/${forkRow.target_conversation_id}/snapshot`;
    await page.waitForFunction(async path => window.__jotFixtureSnapshotSeen(path), targetSnapshot);

    const calls = writes.filter(write => write.method === 'POST' && write.path === `/v1/conversations/${source.conversation_id}/fork`);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0], 'retry repeats the exact owner, CSRF, actor, body and idempotency key');
    assert.equal(calls[0].actor, 'web');
    assert.equal(calls[0].csrf, csrf);
    assert.deepEqual(calls[0].body, {expected_version: 1, through_message_id: messageId});
    assert.equal(sourceReads, 1, 'the exact retry returns the durable receipt without rereading the native source');
    assert.equal(service.db.prepare('SELECT count(*) n FROM ga_conversation_forks WHERE source_conversation_id=?')
      .get(source.conversation_id).n, 1);
    assert.deepEqual(service.db.prepare('SELECT id,owner_id,version,title,model,updated_at FROM ga_conversations WHERE id=?')
      .get(source.conversation_id), originalBefore, 'forking leaves the original conversation row intact');
    assert.deepEqual(service.db.prepare('SELECT id,role,status,content_json FROM ga_messages WHERE conversation_id=? ORDER BY id')
      .all(source.conversation_id), sourceMessagesBefore, 'forking leaves the original transcript intact');
    assert.equal(service.db.prepare('SELECT count(*) n FROM ga_messages WHERE conversation_id=?')
      .get(forkRow.target_conversation_id).n, 1);

    const post = (owner, key, payload) => service.app.inject({
      method: 'POST',
      url: `/v1/conversations/${source.conversation_id}/fork`,
      headers: {
        'x-user-id': owner,
        'x-jot-actor': 'web',
        'x-csrf-token': csrf,
        origin: 'https://fixture.invalid',
        'idempotency-key': key
      },
      payload
    });
    const readsBeforeRejects = sourceReads;
    const foreign = await post('other-owner', 'foreign-fork-key', {expected_version: 1, through_message_id: messageId});
    assert.equal(foreign.statusCode, 404, 'a different owner cannot fork the original conversation');
    const staleVersion = await post('ui-owner', 'stale-version-key', {expected_version: 2, through_message_id: messageId});
    assert.equal(staleVersion.statusCode, 409, 'a stale source version is rejected');
    const staleMessage = await post('ui-owner', 'stale-message-key', {expected_version: 1, through_message_id: 'message-no-longer-present'});
    assert.equal(staleMessage.statusCode, 409, 'a missing old message boundary is rejected');
    assert.equal(sourceReads, readsBeforeRejects, 'rejected owner and stale boundaries never inspect native history');
    assert.equal(service.db.prepare('SELECT count(*) n FROM ga_conversation_forks').get().n, 1);
    assert.deepEqual(faults, []);
  } finally {
    await browser?.close();
    if (service) {
      await service.app.close();
      if (service.db.isOpen) service.db.close();
    }
    await rm(root, {recursive: true, force: true});
  }
});
