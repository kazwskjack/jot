import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { FileJobService } from '../../src/file-engine/jobs.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-jobs-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const path = join(directory, 'input.docx'); writeFileSync(path, 'input');
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
  db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('artifact-1', 'conv', 'owner', 'upload', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('artifact-1', 1, path, 'a'.repeat(64), 5,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      JSON.stringify({ file_name: 'input.docx', status: 'ready' }), 'now');
  return { directory, db, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const request = { operation: 'writer.replace_text', base_version: 1, base_sha256: 'a'.repeat(64),
  target: { old_text: 'input', expected_matches: 1 }, change: { new_text: 'output' },
  save_as: { format: 'docx', new_version: true } };

test('enqueues one authorized immutable file job idempotently', () => {
  const f = fixture();
  try {
    const jobs = new FileJobService(f.db);
    const first = jobs.enqueue('owner', 'conv', 'artifact-1', request, 'idem-file-1');
    const second = jobs.enqueue('owner', 'conv', 'artifact-1', request, 'idem-file-1');
    assert.equal(first.job_id, second.job_id); assert.equal(first.status, 'queued');
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ga_file_jobs').get().count, 1);
  } finally { f.close(); }
});

test('rejects foreign artifacts and stale versions before enqueue', () => {
  const f = fixture();
  try {
    const jobs = new FileJobService(f.db);
    assert.throws(() => jobs.enqueue('other', 'conv', 'artifact-1', request, 'idem-file-2'), /UNAUTHORIZED_FILE/);
    assert.throws(() => jobs.enqueue('owner', 'conv', 'artifact-1', { ...request, base_version: 2 }, 'idem-file-3'), /STALE_FILE_VERSION/);
    assert.throws(() => jobs.enqueue('owner', 'conv', 'artifact-1', { ...request, base_sha256: 'b'.repeat(64) }, 'idem-file-4'), /STALE_FILE_VERSION/);
  } finally { f.close(); }
});

test('claims a queued job once and exposes only owned status', () => {
  const f = fixture();
  try {
    const jobs = new FileJobService(f.db, () => 1_000);
    const queued = jobs.enqueue('owner', 'conv', 'artifact-1', request, 'idem-file-5');
    const claim = jobs.claim('worker-1', 60);
    assert.equal(claim.job_id, queued.job_id); assert.equal(claim.status, 'running');
    assert.equal(jobs.claim('worker-2', 60), null);
    assert.equal(jobs.get('owner', queued.job_id).job_id, queued.job_id);
    assert.throws(() => jobs.get('other', queued.job_id), /UNAUTHORIZED_FILE/);
  } finally { f.close(); }
});
