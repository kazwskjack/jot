import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { SnapshotCopyWorkspaceProvider } from '../../src/always-on/snapshot-provider.ts';
import { validateWorkspaceManifest } from '../../src/always-on/workspace-provider.ts';

const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const base = resolve('.test-tmp');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'workspace-checkpoints-'));
  const sourceRoot = join(root, 'project');
  const storageRoot = join(root, 'snapshots');
  mkdirSync(sourceRoot);
  mkdirSync(storageRoot);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return { root, sourceRoot, storageRoot };
}

test('workspace checkpoint manifest records absent selections and preserves binary bytes and executable state', async t => {
  const f = fixture(t), sourceDirectory = join(f.sourceRoot, 'src');
  mkdirSync(sourceDirectory);
  const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
  writeFileSync(join(sourceDirectory, 'data.bin'), binary);
  writeFileSync(join(sourceDirectory, 'tool.sh'), '#!/bin/sh\nprintf fixture\n', { mode: 0o700 });
  chmodSync(join(sourceDirectory, 'tool.sh'), 0o700);
  const sourceExecutable = (statSync(join(sourceDirectory, 'tool.sh')).mode & 0o100) !== 0;
  const provider = new SnapshotCopyWorkspaceProvider();
  const snapshot = await provider.create({
    sourceRoot: f.sourceRoot,
    storageRoot: f.storageRoot,
    paths: ['src/data.bin', 'src/missing.txt', 'src/tool.sh'],
    includeAbsentPaths: true,
    guard: () => {},
    signal: new AbortController().signal,
  });

  assert.equal(snapshot.manifest.protocol, 2);
  assert.deepEqual(snapshot.manifest.entries.find(entry => entry.path === 'src/data.bin'), {
    path: 'src/data.bin', kind: 'file', sha256: sha(binary), bytes: binary.length, executable: false,
  });
  assert.deepEqual(snapshot.manifest.entries.find(entry => entry.path === 'src/missing.txt'), {
    path: 'src/missing.txt', kind: 'absent',
  });
  assert.equal(snapshot.manifest.entries.find(entry => entry.path === 'src/tool.sh').executable, sourceExecutable);
  assert.deepEqual(readFileSync(join(snapshot.isolated_root, 'src/data.bin')), binary);
  assert.equal((statSync(join(snapshot.isolated_root, 'src/tool.sh')).mode & 0o100) !== 0, sourceExecutable);
  assert.equal(snapshot.receipt.file_count, 2);
  assert.equal(snapshot.receipt.directory_count, 1);
  assert.equal(snapshot.receipt.total_bytes, binary.length + Buffer.byteLength('#!/bin/sh\nprintf fixture\n'));
  assert.equal(JSON.stringify(snapshot.manifest).includes(f.root), false);
  assert.equal(validateWorkspaceManifest(snapshot.manifest).entries.some(entry => entry.kind === 'absent'), true);
  assert.throws(() => validateWorkspaceManifest({
    protocol: 2,
    provider: 'snapshot-copy',
    paths: ['src/missing.txt'],
    entries: [{ path: 'src', kind: 'directory' }],
  }), /workspace_manifest_invalid/);
});
