import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { ArtifactService } from '../../src/artifacts/service.ts';

test('upload is server-pathed, hashed, immutable, downloadable, previewable, and diffable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-artifact-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'], uploadRoot: join(directory, 'uploads') });
  const headers = { 'x-user-id': 'u', 'idempotency-key': 'upload-1' };
  try {
    const conv = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws', model: { provider: 'p', model: 'm' } } })).json();
    const content = Buffer.from('hello\nworld\n', 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const init = await service.app.inject({ method: 'POST', url: `/v1/conversations/${conv.conversation_id}/uploads`, headers,
      payload: { file_name: '../../safe.txt', media_type: 'text/plain', size_bytes: content.length, sha256 } });
    assert.equal(init.statusCode, 201);
    const upload = init.json();
    assert.doesNotMatch(service.db.prepare('SELECT server_path FROM ga_uploads WHERE id=?').get(upload.upload_id).server_path, /safe\.txt/);
    assert.equal((await service.app.inject({ method: 'PUT', url: `/v1/uploads/${upload.upload_id}/content`, headers: { 'x-user-id': 'u', 'content-type': 'application/octet-stream' }, payload: content })).statusCode, 204);
    const complete = await service.app.inject({ method: 'POST', url: `/v1/uploads/${upload.upload_id}/complete`, headers,
      payload: { sha256 } });
    assert.equal(complete.statusCode, 201);
    const artifact = complete.json();
    assert.equal(artifact.file_name, 'safe.txt');
    assert.equal(artifact.status, 'ready');
    assert.equal(artifact.backup_status, 'pending');
    assert.equal(artifact.local_state, 'present');
    const stored = service.db.prepare('SELECT server_path,mime_type FROM ga_artifact_versions WHERE artifact_id=?').get(artifact.artifact_id);
    assert.match(stored.server_path.replaceAll('\\','/'), /ready\/uploads\/artifact-/);
    assert.equal(stored.mime_type, 'text/plain');

    const preview = await service.app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.artifact_id}/preview?version=1`, headers });
    assert.equal(preview.json().text, 'hello\nworld\n');
    const download = await service.app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.artifact_id}/download?version=1`, headers });
    assert.equal(download.body, 'hello\nworld\n');
    assert.match(download.headers['content-disposition'], /attachment/);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');

    const secondPath = join(directory, 'uploads', `${artifact.artifact_id}-2`);
    writeFileSync(secondPath, 'hello\nagent\n');
    service.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(artifact.artifact_id, 2, secondPath, createHash('sha256').update('hello\nagent\n').digest('hex'), 12, 'text/plain', JSON.stringify({ file_name: 'safe.txt', status: 'ready', preview_kind: 'text', origin: 'edited' }), new Date().toISOString());
    service.db.prepare('UPDATE ga_artifacts SET current_version=2 WHERE id=?').run(artifact.artifact_id);
    const diff = await service.app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.artifact_id}/diff?from_version=1&to_version=2`, headers });
    assert.match(diff.json().unified_diff, /-world/);
    assert.match(diff.json().unified_diff, /\+agent/);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('binary upload bypasses the JSON body limit and is consumed as a stream', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-artifact-large-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'], uploadRoot: join(directory, 'uploads'),
    csrfToken: '0123456789abcdef', allowedOrigins: ['https://jot.example'] });
  const headers = { 'x-user-id': 'u', 'idempotency-key': 'upload-large', origin: 'https://jot.example', 'x-csrf-token': '0123456789abcdef' };
  try {
    const conv = (await service.app.inject({ method: 'POST', url: '/v1/conversations', headers,
      payload: { workspace_id: 'ws', model: { provider: 'p', model: 'm' } } })).json();
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const init = (await service.app.inject({ method: 'POST', url: `/v1/conversations/${conv.conversation_id}/uploads`, headers,
      payload: { file_name: 'large.bin', media_type: 'application/octet-stream', size_bytes: content.length, sha256 } })).json();
    const put = await service.app.inject({ method: 'PUT', url: `/v1/uploads/${init.upload_id}/content`,
      headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: content });
    assert.equal(put.statusCode, 204, put.body);
    assert.equal(service.db.prepare('SELECT received_size FROM ga_uploads WHERE id=?').get(init.upload_id).received_size, content.length);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('generated multi-volume document is registered once under one runtime artifact ref', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-generated-artifact-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const root = join(directory, 'artifacts');
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('input', 'conv', null, 'user', 'complete', '{"blocks":[]}', 'now', 'now');
  db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('run-1', 'conv', 'input', 'running', 1, 'now', 'now');
  const one = join(directory, 'one.docx'); const two = join(directory, 'two.docx');
  writeFileSync(one, 'one'); writeFileSync(two, 'two');
  try {
    const service = new ArtifactService(db, root);
    const created = service.registerGenerated('run-1', 'artifact-request:abc', [
      { path: one, display_name: '报告_第1卷.docx' },
      { path: two, display_name: '报告_第2卷.docx' },
    ]);
    assert.equal(created.parts.length, 2);
    assert.equal(created.size_bytes, 6);
    const repeated = service.registerGenerated('run-1', 'artifact-request:abc', []);
    assert.equal(repeated.artifact_ref, created.artifact_ref);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ga_artifact_parts WHERE artifact_id=?')
      .get(created.artifact_ref).count, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delivered generated documents remain local until verified archive cleanup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-generated-cleanup-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  const root = join(directory, 'artifacts');
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('input', 'conv', null, 'user', 'complete', '{"blocks":[]}', 'now', 'now');
  db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('run-1', 'conv', 'input', 'running', 1, 'now', 'now');
  const one = join(directory, 'one.docx'); const two = join(directory, 'two.docx');
  writeFileSync(one, 'one'); writeFileSync(two, 'two');
  try {
    const service = new ArtifactService(db, root);
    const created = service.registerGenerated('run-1', 'artifact-request:cleanup', [
      { path: one, display_name: '报告_第1卷.docx' },
      { path: two, display_name: '报告_第2卷.docx' },
    ]);
    const before = db.prepare(`SELECT part_index,server_path,sha256,size_bytes FROM ga_artifact_parts
      WHERE artifact_id=? ORDER BY part_index`).all(created.artifact_ref);
    assert.equal(before.every(part => existsSync(part.server_path)), true);
    const result = service.markDeliveredAndDelete('artifact-request:cleanup');
    assert.equal(result.deleted_files, 0);
    assert.equal(result.status, 'delivered_backup_pending');
    assert.equal(before.every(part => existsSync(part.server_path)), true);
    const after = db.prepare(`SELECT part_index,server_path,sha256,size_bytes,metadata_json
      FROM ga_artifact_parts WHERE artifact_id=? ORDER BY part_index`).all(created.artifact_ref);
    assert.deepEqual(after.map(part => [part.part_index, part.sha256, part.size_bytes]),
      before.map(part => [part.part_index, part.sha256, part.size_bytes]));
    assert.equal(after.every(part => JSON.parse(part.metadata_json).status === 'delivered'), true);
    assert.equal(service.markDeliveredAndDelete(created.artifact_ref).deleted_files, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
