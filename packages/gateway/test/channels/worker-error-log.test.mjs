import assert from 'node:assert/strict';
import test from 'node:test';
import { writeChannelWorkerError } from '../../src/channels/worker-error-log.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('worker error log emits an allowlisted code and drops provider secrets and endpoint data', () => {
  const lines = [];
  const syntheticToken = randomBytes(32).toString('base64url');
  const privateUrl = new URL('https://push.example.test/subscription');
  privateUrl.searchParams.set('token', syntheticToken);
  const privatePath = join(process.env.JOT_TEST_TMP ?? tmpdir(), 'channel-worker', randomUUID(), 'private-token.txt');
  const failure = new Error(`network failure ${privateUrl.href} ${privatePath}`);
  failure.code = 'ERR_NETWORK';
  assert.ok(failure.message.includes(privateUrl.href));
  assert.ok(failure.message.includes(syntheticToken));
  assert.ok(failure.message.includes(privatePath));
  writeChannelWorkerError(failure, line => lines.push(line));
  assert.equal(lines[0].includes(privateUrl.href), false);
  assert.equal(lines[0].includes(syntheticToken), false);
  assert.equal(lines[0].includes(privatePath), false);
  assert.deepEqual(lines, ['{"level":"error","code":"DELIVERY_WORKER_ERROR"}\n']);
  assert.doesNotMatch(lines[0], /push\.example|private-token|alice|smtp-password|ERR_NETWORK/);
});

test('worker error log preserves only a known fixed delivery error code', () => {
  const lines = [];
  writeChannelWorkerError(new Error('delivery_channel_not_configured'), line => lines.push(line));
  assert.deepEqual(lines, ['{"level":"error","code":"DELIVERY_CHANNEL_NOT_CONFIGURED"}\n']);
});
