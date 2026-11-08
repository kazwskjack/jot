import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerSkillCatalogRoutes } from '../../src/skills/catalog-routes.ts';

test('closing the client response aborts a selected skill resource read', async () => {
  let route;
  let signal;
  const app = { get(_path, handler) { route = handler; } };
  const service = {
    readResource(_owner, _runId, _name, _path, requestSignal) {
      signal = requestSignal;
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason ?? new Error('aborted')), { once: true });
      });
    },
  };
  registerSkillCatalogRoutes(app, service, () => 'alice');
  const request = { raw: new EventEmitter(), params: { runId: 'run-1' }, query: { name: 'notes', path: 'references/help.md' }, headers: {} };
  const reply = Object.assign(new EventEmitter(), {
    raw: new EventEmitter(),
    header() { return this; },
    code(status) { this.statusCode = status; return this; },
    send(body) { this.body = body; return body; },
  });

  const pending = route(request, reply);
  reply.raw.emit('close');
  const abortedOnClose = signal.aborted;
  if (!abortedOnClose) request.raw.emit('aborted');
  await assert.rejects(pending, /aborted/);
  assert.equal(abortedOnClose, true, 'the resource read should stop as soon as its response closes');
});
