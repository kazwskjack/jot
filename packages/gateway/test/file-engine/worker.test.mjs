import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { ArtifactService } from '../../src/artifacts/service.ts';
import { FileJobService } from '../../src/file-engine/jobs.ts';
import { FileEngineWorker } from '../../src/file-engine/worker.ts';

test('worker preserves original and publishes a verified new artifact version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-worker-'));
  const db = openProductDatabase(join(directory, 'db.sqlite')); const root = join(directory, 'files');
  const input = join(directory, 'input.pdf'); const original = Buffer.from('%PDF-1.7\noriginal'); writeFileSync(input, original);
  const sha = createHash('sha256').update(original).digest('hex');
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
  db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('artifact-1', 'conv', 'owner', 'upload', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('artifact-1', 1, input, sha, original.length, 'application/pdf', JSON.stringify({ file_name: 'input.pdf', status: 'ready' }), 'now');
  db.prepare("INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run('artifact-1', 'pending', 'present', 'now', 'now', 'now');
  try {
    const jobs = new FileJobService(db);
    const queued = jobs.enqueue('owner', 'conv', 'artifact-1', { operation: 'pdf.rotate_pages', base_version: 1,
      base_sha256: sha, target: { pages: [1] }, change: { degrees: 90 }, save_as: { format: 'pdf', new_version: true } }, 'idem-worker-1');
    let receivedInput = '';
    const worker = new FileEngineWorker(jobs, new ArtifactService(db, root), {
      run: async value => { receivedInput = String(value.input_path); assert.deepEqual(readFileSync(receivedInput), original);
        const output = value.output_path; writeFileSync(output, '%PDF-1.7\nedited');
        return { ok: true, engine: { name: 'test', version: '1' }, output_path: output,
          checks: { saved_and_reopened: 'PASS' } }; },
    }, { workerId: 'worker', workRoot: join(root, 'sessions', 'file-engine') });
    assert.equal(await worker.processNext(), true);
    assert.notEqual(receivedInput, input);
    assert.match(receivedInput, /input\.pdf$/);
    assert.deepEqual(readFileSync(input), original);
    const done = jobs.get('owner', queued.job_id); assert.equal(done.status, 'completed'); assert.equal(done.output_version, 2);
    assert.equal(db.prepare('SELECT current_version FROM ga_artifacts WHERE id=?').get('artifact-1').current_version, 2);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ga_artifact_versions WHERE artifact_id=?').get('artifact-1').count, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker derives the output extension from the requested save format', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-convert-'));
  const db = openProductDatabase(join(directory, 'db.sqlite')); const root = join(directory, 'files');
  const input = join(directory, 'input.docx'); const original = Buffer.from('PK\x03\x04docx'); writeFileSync(input, original);
  const sha = createHash('sha256').update(original).digest('hex');
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
  db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('artifact-1', 'conv', 'owner', 'upload', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('artifact-1', 1, input, sha, original.length,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      JSON.stringify({ file_name: 'input.docx', status: 'ready' }), 'now');
  db.prepare("INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run('artifact-1', 'pending', 'present', 'now', 'now', 'now');
  try {
    const jobs = new FileJobService(db);
    jobs.enqueue('owner', 'conv', 'artifact-1', { operation: 'office.export_pdf', base_version: 1,
      base_sha256: sha, save_as: { format: 'pdf', new_version: true } }, 'idem-convert-1');
    let receivedPath = '';
    const worker = new FileEngineWorker(jobs, new ArtifactService(db, root), {
      run: async value => { receivedPath = String(value.output_path); writeFileSync(receivedPath, '%PDF-1.7\nconverted');
        return { ok: true, engine: { name: 'test', version: '1' }, output_path: receivedPath,
          checks: { saved_and_reopened: 'PASS' } }; },
    }, { workerId: 'worker', workRoot: join(root, 'sessions', 'file-engine') });
    assert.equal(await worker.processNext(), true);
    assert.match(receivedPath, /output\.pdf$/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker stages an extensionless uploaded DOCX with a MIME-derived input suffix', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-input-suffix-'));
  const db = openProductDatabase(join(directory, 'db.sqlite')); const root = join(directory, 'files');
  const input = join(directory, 'artifact-without-extension'); const original = Buffer.from('PK\x03\x04docx'); writeFileSync(input, original);
  const sha = createHash('sha256').update(original).digest('hex');
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
  db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('artifact-1', 'conv', 'owner', 'upload', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('artifact-1', 1, input, sha, original.length,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      JSON.stringify({ file_name: 'sample.docx', status: 'ready' }), 'now');
  db.prepare("INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run('artifact-1', 'pending', 'present', 'now', 'now', 'now');
  try {
    const jobs = new FileJobService(db);
    jobs.enqueue('owner', 'conv', 'artifact-1', { operation: 'writer.replace_text', base_version: 1,
      base_sha256: sha, target: { old_text: 'old', expected_matches: 1 }, change: { new_text: 'new' },
      save_as: { format: 'docx', new_version: true } }, 'idem-input-suffix-1');
    let receivedInput = '';
    const worker = new FileEngineWorker(jobs, new ArtifactService(db, root), {
      run: async value => { receivedInput = String(value.input_path);
        assert.match(receivedInput, /input\.docx$/); assert.deepEqual(readFileSync(receivedInput), original);
        const output = String(value.output_path); writeFileSync(output, Buffer.from('PK\x03\x04edited'));
        return { ok: true, engine: { name: 'test', version: '1' }, output_path: output,
          checks: { saved_and_reopened: 'PASS' } }; },
    }, { workerId: 'worker', workRoot: join(root, 'sessions', 'file-engine') });
    assert.equal(await worker.processNext(), true);
    assert.match(receivedInput, /input\.docx$/);
    assert.deepEqual(readFileSync(input), original);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
