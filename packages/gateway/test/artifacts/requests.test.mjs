import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { ArtifactRequestService } from '../../src/artifacts/requests.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-artifact-request-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('input', 'conv', null, 'user', 'complete', '{"blocks":[]}', 'now', 'now');
  db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('run-1', 'conv', 'input', 'running', 1, 'now', 'now');
  return { db, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const request = { request_id: 'artifact-request:abc', run_id: 'a'.repeat(32),
  client_run_id: 'run-1', requirement_id: 'r-artifact', result_refs: ['ref-1'],
  source_results: [{ result_ref: 'ref-1', result: { ok: true, text: '正文' } }],
  format: 'docx', template: 'default', status: 'requested', created_at: 'now' };

test('one C artifact request projects once and preserves immutable inputs', () => {
  const f = fixture();
  try {
    const service = new ArtifactRequestService(f.db);
    const first = service.enqueueProjected(request);
    const second = service.enqueueProjected(request);
    assert.equal(first.request_id, second.request_id);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM ga_artifact_requests').get().count, 1);
    assert.deepEqual(JSON.parse(first.source_results_json), request.source_results);
  } finally { f.close(); }
});

test('generated artifact retries only the C receipt and never returns to render', () => {
  const f = fixture();
  try {
    let now = 1000;
    const service = new ArtifactRequestService(f.db, () => now);
    service.enqueueProjected(request);
    const render = service.claim('worker-1', 30);
    assert.equal(render.phase, 'render');
    service.recordGenerated(render.request_id, render.generation, {
      artifact_ref: 'artifact:doc-1', size_bytes: 4096, sha256: 'a'.repeat(64),
      render_status: 'passed', parts: 1,
    });
    service.recordReceiptFailure(render.request_id, 'RUNTIME_TRANSPORT_UNAVAILABLE');
    now += 31;
    const retry = service.claim('worker-1', 30);
    assert.equal(retry.phase, 'receipt_only');
    assert.equal(retry.artifact_ref, 'artifact:doc-1');
  } finally { f.close(); }
});

test('expired render lease becomes outcome_unknown instead of rendering twice', () => {
  const f = fixture();
  try {
    let now = 1000;
    const service = new ArtifactRequestService(f.db, () => now);
    service.enqueueProjected(request);
    service.claim('worker-1', 30);
    now += 31;
    assert.equal(service.claim('worker-2', 30), null);
    assert.equal(service.get(request.request_id).status, 'outcome_unknown');
  } finally { f.close(); }
});
