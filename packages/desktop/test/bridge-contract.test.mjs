import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTrustedDesktopSender, parseDesktopCommand } from '../src/bridge-contract.mjs';

const appOrigin = 'http://127.0.0.1:43123';

test('rejects same-origin IPC sender URLs containing credentials', () => {
  for (const senderUrl of [
    'http://alice@127.0.0.1:43123/tasks',
    'http://alice:secret@127.0.0.1:43123/tasks',
    'http://:secret@127.0.0.1:43123/tasks',
  ]) {
    assert.throws(
      () => assertTrustedDesktopSender({ senderUrl, appOrigin, mainFrame: true }),
      { message: 'desktop_sender_denied' },
    );
  }
});

test('accepts a credential-free main-frame IPC sender on the app origin', () => {
  assert.equal(
    assertTrustedDesktopSender({ senderUrl: `${appOrigin}/tasks`, appOrigin, mainFrame: true }),
    true,
  );
});

test('does not accept renderer-originated notification lifecycle events', () => {
  assert.throws(
    () => parseDesktopCommand('notification.renderer-event', { id: 'notice-1', event: 'click' }),
    { message: 'desktop_ipc_channel_denied' },
  );
});
