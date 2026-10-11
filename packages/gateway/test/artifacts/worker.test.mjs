import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactRequestWorker } from '../../src/artifacts/worker.ts';

test('artifact worker renders once then reports the verified receipt', async () => {
  const calls = [];
  const store = {
    claim: () => ({ request_id: 'artifact-request:abc', runtime_run_id: 'a'.repeat(32),
      client_run_id: 'run-1', generation: 1, phase: 'render', format: 'docx',
      template: 'default', source_results_json: '[{"result_ref":"ref-1"}]' }),
    recordGenerated: (...args) => calls.push(['generated', ...args]),
    recordReceiptFailure: (...args) => calls.push(['receipt-failed', ...args]),
    recordVerified: (...args) => calls.push(['verified', ...args]),
  };
  let renders = 0;
  const worker = new ArtifactRequestWorker(store, {
    render: async () => { renders += 1; return { artifact_ref: 'artifact:doc-1',
      size_bytes: 4096, sha256: 'a'.repeat(64), render_status: 'passed', parts: 1 }; },
  }, { registerArtifactReceipt: async () => ({ ok: true, status: 'artifact_verified',
    artifact_ref: 'artifact:doc-1' }) }, { workerId: 'artifact-worker', leaseSeconds: 60 });
  assert.equal(await worker.processNext(), true);
  assert.equal(renders, 1);
  assert.deepEqual(calls.map(item => item[0]), ['generated', 'verified']);
});

test('receipt-only phase never invokes renderer', async () => {
  const calls = [];
  const receipt = { artifact_ref: 'artifact:doc-1', size_bytes: 4096,
    sha256: 'a'.repeat(64), render_status: 'passed', parts: 1 };
  const store = {
    claim: () => ({ request_id: 'artifact-request:abc', runtime_run_id: 'a'.repeat(32),
      client_run_id: 'run-1', generation: 2, phase: 'receipt_only',
      receipt, artifact_ref: receipt.artifact_ref }),
    recordGenerated: () => { throw new Error('must_not_record'); },
    recordReceiptFailure: (...args) => calls.push(['receipt-failed', ...args]),
    recordVerified: (...args) => calls.push(['verified', ...args]),
  };
  const worker = new ArtifactRequestWorker(store, {
    render: async () => { throw new Error('must_not_render'); },
  }, { registerArtifactReceipt: async () => ({ ok: true, status: 'artifact_verified',
    artifact_ref: receipt.artifact_ref }) }, { workerId: 'artifact-worker', leaseSeconds: 60 });
  assert.equal(await worker.processNext(), true);
  assert.deepEqual(calls.map(item => item[0]), ['verified']);
});
