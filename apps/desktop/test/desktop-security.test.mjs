import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { isDesktopAppUrl, mayGrantNotificationPermission } from '../desktop-security.mjs';

const appOrigin = 'http://127.0.0.1:43123';

test('rejects same-origin app URLs containing credentials', () => {
  for (const requestingUrl of [
    'http://alice@127.0.0.1:43123/tasks',
    'http://alice:secret@127.0.0.1:43123/tasks',
    'http://:secret@127.0.0.1:43123/tasks',
  ]) {
    assert.equal(isDesktopAppUrl(requestingUrl, appOrigin), false);
    assert.equal(mayGrantNotificationPermission({
      permission: 'notifications',
      requestingUrl,
      appOrigin,
      mainFrame: true,
      deviceEnabled: true,
    }), false);
  }
});

test('keeps credential-free app URLs eligible for their existing permission checks', () => {
  const requestingUrl = `${appOrigin}/tasks`;
  assert.equal(isDesktopAppUrl(requestingUrl, appOrigin), true);
  assert.equal(mayGrantNotificationPermission({
    permission: 'notifications',
    requestingUrl,
    appOrigin,
    mainFrame: true,
    deviceEnabled: true,
  }), true);
});

test('preload exposes native file selection without accepting renderer options', async () => {
  const source = await readFile(fileURLToPath(new URL('../preload.cjs', import.meta.url)), 'utf8');
  const exposed = Object.create(null);
  const invocations = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, bridge) => { exposed[name] = bridge; } },
    ipcRenderer: {
      invoke: (...args) => { invocations.push(args); return Promise.resolve(null); },
      on: () => {},
    },
  };

  runInNewContext(source, {
    require: name => {
      if (name !== 'electron') throw new Error(`unexpected module: ${name}`);
      return electron;
    },
    process: { isMainFrame: true },
    globalThis: { Notification: null },
  });

  assert.equal(typeof exposed.jotDesktop.selectFile, 'function');
  assert.equal(await exposed.jotDesktop.selectFile(), null);
  assert.deepEqual(invocations, [['dialog.selectFile', undefined]]);
});
