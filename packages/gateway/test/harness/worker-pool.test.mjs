import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWorkerConcurrency, runWorkerPool } from '../../src/harness/worker-pool.ts';

test('worker concurrency is bounded to five active sessions', () => {
  assert.equal(parseWorkerConcurrency(undefined), 1);
  assert.equal(parseWorkerConcurrency('0'), 1);
  assert.equal(parseWorkerConcurrency('3'), 3);
  assert.equal(parseWorkerConcurrency('5'), 5);
  assert.equal(parseWorkerConcurrency('9'), 5);
  assert.equal(parseWorkerConcurrency('bad'), 1);
});

test('five worker slots may process five independent jobs concurrently', async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  let claims = 0;
  let stopping = false;
  const processNext = async () => {
    if (claims >= 5) return null;
    claims += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active -= 1;
    if (claims >= 5 && active === 0) stopping = true;
    return { run_id: `run-${claims}`, runtime_status: 'ok' };
  };
  const running = runWorkerPool({ concurrency: 5, pollMs: 1, processNext, shouldStop: () => stopping });
  while (releases.length < 5) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(peak, 5);
  for (const release of releases) release();
  await running;
  assert.equal(active, 0);
});

