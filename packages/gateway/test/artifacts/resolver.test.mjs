import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { AttachmentResolver } from '../../src/artifacts/resolver.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-resolver-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
  const file = join(directory, 'artifact-file'); writeFileSync(file, 'hello');
  db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('artifact-1', 'conv', 'owner', 'upload', 1, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
  db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('artifact-1', 1, file, 'a'.repeat(64), 5, 'text/plain', JSON.stringify({ file_name: 'a.txt', status: 'ready', preview_kind: 'text', origin: 'upload' }), '2026-09-13T00:00:00.000Z');
  db.prepare("INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run('artifact-1', 'pending', 'present', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
  return { directory, db };
}

test('resolves owned ready attachment and holds a cleanup lease', () => {
  const { directory, db } = fixture();
  try {
    const resolver = new AttachmentResolver(db, directory);
    const [item] = resolver.resolveForMessage('owner', 'conv', ['artifact-1'], 'lease-1');
    assert.equal(item.displayName, 'a.txt'); assert.equal(item.kind, 'text');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ga_artifact_leases WHERE lease_id=?').get('lease-1').count, 1);
    resolver.releaseLease('lease-1');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ga_artifact_leases WHERE lease_id=?').get('lease-1').count, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rejects foreign owner, wrong conversation, missing local file and path escape', () => {
  const { directory, db } = fixture();
  try {
    const resolver = new AttachmentResolver(db, directory);
    assert.throws(() => resolver.resolveForMessage('other', 'conv', ['artifact-1'], 'lease-a'), /artifact_not_found/);
    assert.throws(() => resolver.resolveForMessage('owner', 'other', ['artifact-1'], 'lease-b'), /artifact_not_found/);
    db.prepare('UPDATE ga_artifact_versions SET server_path=? WHERE artifact_id=?').run(join(directory, '..', 'escape'), 'artifact-1');
    assert.throws(() => resolver.resolveForMessage('owner', 'conv', ['artifact-1'], 'lease-c'), /attachment_path_denied/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('enforces attachment count and aggregate byte limits', () => {
  const { directory, db } = fixture();
  try {
    const resolver = new AttachmentResolver(db, directory, { maxCount: 1, maxAggregateBytes: 4 });
    assert.throws(() => resolver.resolveForMessage('owner', 'conv', ['artifact-1', 'artifact-1'], 'lease-count'), /attachment_count_invalid/);
    assert.throws(() => resolver.resolveForMessage('owner', 'conv', ['artifact-1'], 'lease-size'), /attachment_aggregate_size_invalid/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('resolves generated outputs only by owned artifact id or exact stored path', () => {
  const { directory, db } = fixture();
  try {
    const resolver = new AttachmentResolver(db, directory);
    const storedPath = join(directory, 'artifact-file');
    const outputs = resolver.resolveOutputs('owner', 'conv', ['artifact-1'],
      [{ path: storedPath }, { path: storedPath }], 'lease-output');
    assert.deepEqual(outputs.map(item => item.artifactId), ['artifact-1']);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ga_artifact_leases WHERE lease_id=?')
      .get('lease-output').count, 1);
    assert.throws(() => resolver.resolveOutputs('other', 'conv', ['artifact-1'], [], 'lease-foreign'),
      /artifact_not_found/);
    assert.throws(() => resolver.resolveOutputs('owner', 'conv', [], [{ path: join(directory, 'unknown.docx') }],
      'lease-unknown'), /presented_file_not_registered/);
    assert.deepEqual(resolver.resolveOutputs('owner', 'conv', ['artifact-1'],
      [{ path: join(directory, 'session-copy.docx') }], 'lease-artifact-wins').map(item => item.artifactId),
      ['artifact-1']);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
