import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDesktop } from '../../../apps/desktop/main.mjs';
import { registerDesktopIpcHandlers } from '../src/ipc-handlers.mjs';
import { createDesktopNotificationRuntime } from '../src/notification-runtime.mjs';

const appOrigin = 'http://127.0.0.1:43123';

function createIpcHarness(senderUrl, { selectFile = async () => null } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const mainFrame = { url: senderUrl };
  const sent = [];
  const contents = { mainFrame, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const window = { webContents: contents, isDestroyed: () => false };
  const state = Object.freeze({ version: 1 });
  let readCount = 0;

  registerDesktopIpcHandlers({
    ipcMain,
    appOrigin,
    getWindow: () => window,
    stateStore: {
      read: async () => { readCount += 1; return state; },
      write: async () => {},
    },
    notificationRuntime: {},
    readPermission: async () => 'granted',
    selectFile,
  });

  return {
    handler: handlers.get('notification.state.read'),
    openTaskHandler: handlers.get('window.openTask'),
    rendererEventHandler: handlers.get('notification.renderer-event'),
    selectFileHandler: handlers.get('dialog.selectFile'),
    event: { sender: contents, senderFrame: mainFrame },
    sent,
    state,
    get readCount() { return readCount; },
  };
}

test('registered IPC route rejects credential-bearing same-origin main-frame senders', async () => {
  for (const senderUrl of [
    'http://alice@127.0.0.1:43123/tasks',
    'http://alice:secret@127.0.0.1:43123/tasks',
  ]) {
    const harness = createIpcHarness(senderUrl);
    await assert.rejects(harness.handler(harness.event), { message: 'desktop_sender_denied' });
    assert.equal(harness.readCount, 0);
  }
});

test('registered IPC route serves a credential-free same-origin main-frame sender', async () => {
  const harness = createIpcHarness(`${appOrigin}/tasks`);
  assert.equal(await harness.handler(harness.event), harness.state);
  assert.equal(harness.readCount, 1);
});

test('openTask preserves task and occurrence identity and keeps the trusted sender guard', async () => {
  const identity = { task_id: 'task-9', occurrence_id: 'occurrence-3' };
  const trusted = createIpcHarness(`${appOrigin}/workbench`);
  assert.equal(await trusted.openTaskHandler(trusted.event, identity), true);
  assert.deepEqual(trusted.sent, [['desktop:open-task', identity]]);

  const untrusted = createIpcHarness('https://untrusted.example/');
  await assert.rejects(untrusted.openTaskHandler(untrusted.event, identity), { message: 'desktop_sender_denied' });
  assert.deepEqual(untrusted.sent, []);
});

test('does not register renderer-owned notification lifecycle IPC', () => {
  const harness = createIpcHarness(`${appOrigin}/workbench`);
  assert.equal(harness.rendererEventHandler, undefined);
});

test('main creates action-capable notifications with Electron native Notification', async () => {
  const mainSource = await readFile(fileURLToPath(new URL('../../../apps/desktop/main.mjs', import.meta.url)), 'utf8');
  assert.match(mainSource, /NotificationClass\s*:\s*electron\.Notification/);
  assert.doesNotMatch(mainSource, /createRendererNotificationClass/);
});

test('renderer crash reload keeps the existing preload authority and requires an explicit window restore', async () => {
  const origin = 'http://127.0.0.1:43123';
  const appDataPath = resolve(fileURLToPath(new URL('../../../.test-output', import.meta.url)), `desktop-crash-${randomUUID()}`);
  const preloadPath = fileURLToPath(new URL('../../../apps/desktop/preload.cjs', import.meta.url));
  const app = new EventEmitter();
  app.getPath = () => appDataPath;
  app.setPath = () => {};
  app.setName = () => {};
  app.setAppUserModelId = () => {};
  app.whenReady = async () => {};
  app.requestSingleInstanceLock = () => true;
  app.quit = () => {};
  app.isReady = () => true;

  const defaultSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  });
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => handlers.delete(channel),
  };
  const windows = [];
  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.session = defaultSession;
      this.sent = [];
      this.url = '';
      this.crashed = false;
      this.loading = false;
      this.destroyed = false;
    }
    get mainFrame() { return { url: this.url }; }
    isDestroyed() { return this.destroyed; }
    isCrashed() { return this.crashed; }
    isLoadingMainFrame() { return this.loading; }
    isLoading() { return this.loading; }
    getURL() { return this.url; }
    executeJavaScript() { return Promise.resolve('default'); }
    setWindowOpenHandler() {}
    send(...args) { this.sent.push(args); }
  }
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.loadUrls = [];
      this.visible = false;
      this.showCount = 0;
      this.focusCount = 0;
      this.destroyed = false;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() { this.visible = true; this.showCount += 1; }
    hide() { this.visible = false; }
    focus() { this.focusCount += 1; this.emit('focus'); }
    async loadURL(url) {
      this.loadUrls.push(url);
      this.webContents.url = url;
      this.webContents.crashed = false;
      this.webContents.loading = true;
      await Promise.resolve();
      this.webContents.loading = false;
      this.webContents.emit('did-finish-load');
    }
    destroy() {
      this.destroyed = true;
      this.webContents.destroyed = true;
    }
  }
  class FakeTray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  class FakeNotification extends EventEmitter {
    static isSupported() { return false; }
  }
  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { buildFromTemplate: template => template, setApplicationMenu: () => {} },
    Tray: FakeTray,
    ipcMain,
    nativeImage: { createFromBuffer: () => Buffer.alloc(0) },
    session: { defaultSession },
    Notification: FakeNotification,
  };
  const desktop = await startDesktop(electron, {
    loadJotServer: async () => ({ buildServer: () => ({}) }),
    startLocalBackendImpl: async () => ({ origin, close: async () => {} }),
  });

  try {
    await desktop.lifecycle.start();
    const [window] = windows;
    assert.equal(windows.length, 1);
    assert.equal(window.visible, true);
    assert.deepEqual(window.options.webPreferences, {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
    const channelsBeforeCrash = [...handlers.keys()].sort();

    let closePrevented = false;
    window.emit('close', { preventDefault: () => { closePrevented = true; } });
    assert.equal(closePrevented, true);
    assert.equal(window.visible, false);
    const showsBeforeCrash = window.showCount;
    const focusesBeforeCrash = window.focusCount;

    window.webContents.crashed = true;
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 550));

    assert.deepEqual(window.loadUrls, [`${origin}/workbench.html`, `${origin}/workbench.html`]);
    assert.equal(windows.length, 1);
    assert.equal(window.visible, false);
    assert.equal(window.showCount, showsBeforeCrash);
    assert.equal(window.focusCount, focusesBeforeCrash);
    assert.deepEqual([...handlers.keys()].sort(), channelsBeforeCrash);
    assert.deepEqual(window.webContents.sent, []);

    app.emit('activate');
    assert.equal(window.visible, true);
    assert.equal(window.showCount, showsBeforeCrash + 1);
    assert.equal(window.focusCount, focusesBeforeCrash + 1);
  } finally {
    await desktop.lifecycle.stop('test');
    await rm(appDataPath, { recursive: true, force: true });
  }
});

test('native notification action opens the original task and occurrence only for action zero', async () => {
  const notifications = [];
  const opened = [];
  let storedState = { version: 1, preferences: { enabled: true, quiet_hours: null }, seen: [], initialized_at: null };
  class NativeNotificationHarness extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { queueMicrotask(() => this.emit('show')); }
    close() { this.emit('close'); }
  }
  const runtime = createDesktopNotificationRuntime({
    NotificationClass: NativeNotificationHarness,
    stateStore: {
      read: async () => storedState,
      write: async value => { storedState = value; },
    },
    permission: async () => 'granted',
    openTask: async identity => { opened.push(identity); },
    now: () => new Date('2026-10-25T07:00:00.000Z'),
  });

  assert.equal(await runtime.show({
    candidate: {
      task_id: 'task-9', occurrence_id: 'occurrence-3', generation: 2,
      event_kind: 'completed', title: 'Task complete', body: 'Open this occurrence',
    },
    task_settings: {
      task_id: 'task-9', version: 1, channel_binding_ids: [], events: ['completed'],
      delivery_policy: { min_interval_seconds: 60, max_per_24_hours: 20, quiet_hours: null },
    },
  }), true);

  assert.deepEqual(notifications[0].options.actions, [{ type: 'button', text: '打开任务' }]);
  notifications[0].emit('action', { actionIndex: 0 });
  notifications[0].emit('action', { actionIndex: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [{ task_id: 'task-9', occurrence_id: 'occurrence-3' }]);
});

test('native file picker returns the selected path for a trusted main-frame request', async () => {
  const selectedPath = 'C:\\users\\person\\notes.txt';
  let calls = 0;
  const harness = createIpcHarness(`${appOrigin}/workbench`, {
    selectFile: async () => { calls += 1; return selectedPath; },
  });

  assert.equal(typeof harness.selectFileHandler, 'function');
  assert.equal(await harness.selectFileHandler(harness.event), selectedPath);
  assert.equal(calls, 1);
});

test('native file picker reports cancellation as null', async () => {
  let calls = 0;
  const harness = createIpcHarness(`${appOrigin}/workbench`, {
    selectFile: async () => { calls += 1; return null; },
  });

  assert.equal(typeof harness.selectFileHandler, 'function');
  assert.equal(await harness.selectFileHandler(harness.event), null);
  assert.equal(calls, 1);
});

test('native file picker rejects caller-supplied options before opening a dialog', async () => {
  let calls = 0;
  const harness = createIpcHarness(`${appOrigin}/workbench`, {
    selectFile: async () => { calls += 1; return 'C:\\users\\person\\notes.txt'; },
  });

  assert.equal(typeof harness.selectFileHandler, 'function');
  await assert.rejects(harness.selectFileHandler(harness.event, { properties: ['openDirectory'] }), {
    message: 'desktop_file_picker_payload_invalid',
  });
  assert.equal(calls, 0);
});

test('native file picker rejects untrusted main-frame origins before opening a dialog', async () => {
  let calls = 0;
  const harness = createIpcHarness('https://untrusted.example/', {
    selectFile: async () => { calls += 1; return 'C:\\users\\person\\notes.txt'; },
  });

  assert.equal(typeof harness.selectFileHandler, 'function');
  await assert.rejects(harness.selectFileHandler(harness.event), { message: 'desktop_sender_denied' });
  assert.equal(calls, 0);
});
