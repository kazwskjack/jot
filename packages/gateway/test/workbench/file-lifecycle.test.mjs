import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { registerWorkbenchRoutes } from '../../src/workbench/routes.ts';
import { TaskExecutionEvidence } from '../../src/persistent-tasks/execution-evidence.ts';
import { installWorkspaceCoordination } from '../../src/workbench/workspace-coordination.ts';

const base = resolve('../../.test-tmp/workbench-file-lifecycle');
mkdirSync(base, { recursive: true });
function fixture(t) {
  const root = mkdtempSync(join(base, 'case-'));
  const databasePath = join(root, 'fixture.sqlite');
  let db = openProductDatabase(databasePath);
  const options = { workspaceIds: ['ws-1', 'ws-2'], root: join(root, 'shared') };
  let service = new WorkbenchService(db, options);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, get service() { return service; }, options, root,
    reopen() { db.close(); db = openProductDatabase(databasePath); service = new WorkbenchService(db, options); return { db, service }; } };
}

test('rename previews exact source references and moves only the current pointer', t => {
  const f = fixture(t), agent = f.service.createAgent('alice', { name: 'Writer' });
  const { db, service } = f;
  const run = service.enqueueAgentMessage('alice', agent.agent_id, { text: 'Write a source', client_message_id: 'file-lifecycle-source' });
  const first = service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'draft.md', content: 'Original source', expected_version: 0 }, run.run_id);
  const proof = withImmediateTransaction(db, () => new TaskExecutionEvidence(db).record(run.run_id, 'file-lifecycle-write', 'files.write', first));
  db.exec('CREATE TABLE wb_task_completion_candidates(candidate_id TEXT,snapshot_json TEXT)');
  db.prepare('INSERT INTO wb_task_completion_candidates VALUES(?,?)').run('candidate-pinned-draft', JSON.stringify({
    file_outputs: [{ path: 'draft.md', version: 1, receipt_id: proof.reference, sha256: first.sha256, size: first.size }],
  }));
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'draft.md', content: 'Current source', expected_version: 1 });

  const preview = service.previewFileRename('alice', 'ws-1', {
    project_id: agent.project_id, path: 'draft.md', target_path: 'published/final.md', expected_version: 2,
  });
  assert.equal(preview.action, 'rename');
  assert.equal(preview.source.path, 'draft.md');
  assert.equal(preview.source.version, 2);
  assert.match(preview.preview_sha256, /^[a-f0-9]{64}$/);
  assert.ok(preview.source_refs.some(ref => ref.kind === 'task_file_execution' && ref.receipt_id === proof.reference && ref.path === 'draft.md' && ref.version === 1));
  assert.ok(preview.source_refs.some(ref => ref.kind === 'task_completion_file_output' && ref.candidate_id === 'candidate-pinned-draft' && ref.version === 1));

  const request = {
    project_id: agent.project_id, path: 'draft.md', target_path: 'published/final.md', expected_version: 2,
    preview_sha256: preview.preview_sha256, command_key: 'rename-draft-001',
  };
  const applied = service.applyFileRename('alice', 'ws-1', request);
  assert.equal(applied.source.path, 'draft.md');
  assert.equal(applied.source.version, 2);
  assert.equal(applied.target.path, 'published/final.md');
  assert.equal(applied.target.version, 1);
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'published/final.md').content, 'Current source');
  assert.equal(service.readFileVersion('alice', 'ws-1', agent.project_id, 'draft.md', 1).content, 'Original source');
  assert.equal(service.readFileVersion('alice', 'ws-1', agent.project_id, 'draft.md', 2).content, 'Current source');
  assert.equal(db.prepare('SELECT path,version FROM wb_task_file_execution_receipts WHERE receipt_id=?').get(proof.reference).path, 'draft.md');
  assert.equal(db.prepare('SELECT count(*) n FROM wb_file_write_runs WHERE path=?').get('published/final.md').n, 0,
    'rename must not counterfeit a files.write source receipt at the new path');
  assert.deepEqual(service.listFiles('alice', 'ws-1', agent.project_id).items.map(file => [file.path, file.version]), [['published/final.md', 1]]);

  const restarted = f.reopen();
  assert.deepEqual(restarted.service.reconcileFileLifecycle('alice', 'ws-1', { project_id: agent.project_id, command_key: request.command_key }), {
    state: 'applied', receipt: applied,
  });
  assert.deepEqual(restarted.service.applyFileRename('alice', 'ws-1', request), applied, 'lost acknowledgement replay returns the original receipt');
});

test('delete removes the current pointer while historical versions, blobs, and source receipts remain readable', t => {
  const { db, service } = fixture(t), agent = service.createAgent('alice', { name: 'Writer' });
  const run = service.enqueueAgentMessage('alice', agent.agent_id, { text: 'Write a source', client_message_id: 'file-lifecycle-delete-source' });
  const first = service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'notes/source.txt', content: 'Version one', expected_version: 0 }, run.run_id);
  const proof = withImmediateTransaction(db, () => new TaskExecutionEvidence(db).record(run.run_id, 'delete-source-write', 'files.write', first));
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'notes/source.txt', content: 'Version two', expected_version: 1 });
  const versionsBefore = db.prepare('SELECT count(*) n FROM wb_file_versions WHERE path=?').get('notes/source.txt').n;
  const preview = service.previewFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'notes/source.txt', expected_version: 2 });
  assert.ok(preview.source_refs.some(ref => ref.kind === 'task_file_execution' && ref.receipt_id === proof.reference && ref.version === 1));

  const request = { project_id: agent.project_id, path: 'notes/source.txt', expected_version: 2,
    preview_sha256: preview.preview_sha256, command_key: 'delete-source-001' };
  const applied = service.applyFileDelete('alice', 'ws-1', request);
  assert.equal(applied.action, 'delete');
  assert.throws(() => service.readFile('alice', 'ws-1', agent.project_id, 'notes/source.txt'), /file_not_found/);
  assert.equal(service.readFileVersion('alice', 'ws-1', agent.project_id, 'notes/source.txt', 1).content, 'Version one');
  assert.equal(service.readFileVersion('alice', 'ws-1', agent.project_id, 'notes/source.txt', 2).content, 'Version two');
  assert.equal(db.prepare('SELECT count(*) n FROM wb_file_versions WHERE path=?').get('notes/source.txt').n, versionsBefore);
  assert.equal(db.prepare('SELECT path,version FROM wb_task_file_execution_receipts WHERE receipt_id=?').get(proof.reference).path, 'notes/source.txt');
  assert.equal(db.prepare('SELECT count(*) n FROM wb_file_lifecycle_commands WHERE command_key=?').get(request.command_key).n, 1);
  assert.throws(() => db.prepare('UPDATE wb_file_lifecycle_commands SET receipt_json=? WHERE command_key=?').run('{}', request.command_key), /file_lifecycle_receipt_immutable/);
  assert.throws(() => db.prepare('DELETE FROM wb_file_lifecycle_commands WHERE command_key=?').run(request.command_key), /file_lifecycle_receipt_immutable/);
  assert.equal(service.projectWorkspaceReady('alice', 'ws-1', agent.project_id), true);
  const recreated = service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'notes/source.txt', content: 'Recreated after delete', expected_version: 0 });
  assert.equal(recreated.version, 3, 'recreating a deleted path must continue its immutable path history');
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'notes/source.txt').content, 'Recreated after delete');
  assert.deepEqual(service.reconcileFileLifecycle('alice', 'ws-1', { project_id: agent.project_id, command_key: request.command_key }), {
    state: 'applied', receipt: applied,
  });
});

test('binary directory imports preserve exact bytes and replay their verifiable source receipt', t => {
  const { service } = fixture(t), agent = service.createAgent('alice', { name: 'Binary writer' });
  const bytes = Buffer.from([0, 255, 65, 128]);
  const input = { project_id: agent.project_id, path: 'assets/photo.bin', expected_version: 0, command_key: 'dir-import-001' };

  const receipt = service.writeBinaryFile('alice', 'ws-1', input, bytes);
  assert.deepEqual({ path: receipt.path, version: receipt.version, sha256: receipt.sha256, size: receipt.size, source: receipt.source }, {
    path: 'assets/photo.bin', version: 1, sha256: 'ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1', size: 4,
    source: { kind: 'directory_import', relative_path: 'assets/photo.bin' },
  });
  assert.deepEqual(service.readBinaryFile('alice', 'ws-1', agent.project_id, input.path, 1, receipt.sha256).content, bytes);
  assert.deepEqual(service.writeBinaryFile('alice', 'ws-1', input, bytes), receipt, 'same key and bytes return the committed receipt');
  assert.throws(() => service.writeBinaryFile('alice', 'ws-1', input, Buffer.from([0, 255, 66, 128])), /idempotency_conflict/);
  assert.throws(() => service.writeBinaryFile('alice', 'ws-1', { ...input, command_key: 'dir-import-002' }, bytes), /version_conflict/);
  assert.throws(() => service.readBinaryFile('alice', 'ws-1', agent.project_id, input.path, 1, '0'.repeat(64)), /file_source_stale/);
});

test('binary workspace routes accept streamed bytes and return the pinned octet body', async t => {
  const { service } = fixture(t), agent = service.createAgent('alice', { name: 'Binary route' }), routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (url, options, handler) => {
    routes.set(`${method.toUpperCase()} ${url}`, handler ?? options);
  }]));
  let owner = 'alice';
  registerWorkbenchRoutes(app, service, () => owner);
  const send = body => ({ status: 200, headers: {}, header(name, value) { this.headers[name] = value; return this; },
    type(value) { this.headers['content-type'] = value; return this; }, code(status) { this.status = status; return this; }, send(value) { this.body = value; return value; } });
  const path = 'assets/photo.bin', bytes = Buffer.from([0, 255, 65, 128]), key = 'directory-import-route-001';
  const put = routes.get('PUT /v1/workspaces/:workspaceId/files/binary');
  assert.equal(typeof put, 'function', 'the binary import route is registered');
  const writeReply = send();
  await put({ params: { workspaceId: 'ws-1' }, query: { project_id: agent.project_id, path, expected_version: '0' },
    headers: { 'content-type': 'application/octet-stream', 'idempotency-key': key }, body: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]) }, writeReply);
  assert.equal(writeReply.status, 200);
  assert.equal(writeReply.body.sha256, 'ac7fa209c616517439d0e93add6855a02d7c4340f990084224ea290315ee3bd1');
  assert.equal(writeReply.body.source.relative_path, path);

  const get = routes.get('GET /v1/workspaces/:workspaceId/files/binary');
  assert.equal(typeof get, 'function', 'the binary download route is registered');
  const readReply = send();
  await get({ params: { workspaceId: 'ws-1' }, query: { project_id: agent.project_id, path, version: '1', sha256: writeReply.body.sha256 } }, readReply);
  assert.equal(readReply.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(readReply.body, bytes);

  owner = 'bob';
  const denied = send();
  await get({ params: { workspaceId: 'ws-1' }, query: { project_id: agent.project_id, path, version: '1', sha256: writeReply.body.sha256 } }, denied);
  assert.equal(denied.status, 404, 'binary downloads remain owner-scoped');

  service.writeBinaryFile = () => { throw new Error('workspace_coordination_required'); };
  const blocked = send();
  await put({ params: { workspaceId: 'ws-1' }, query: { project_id: agent.project_id, path: 'assets/blocked.bin', expected_version: '0' },
    headers: { 'content-type': 'application/octet-stream', 'idempotency-key': 'directory-import-blocked-001' }, body: bytes }, blocked);
  assert.equal(blocked.status, 409, 'workspace coordination lock is a conflict, not a server error');
});

test('stale previews, occupied rename targets, and conflicting command-key replays fail closed', t => {
  const { service } = fixture(t), agent = service.createAgent('alice', { name: 'Writer' });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'from.txt', content: 'source', expected_version: 0 });
  const preview = service.previewFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'from.txt', target_path: 'to.txt', expected_version: 1 });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'from.txt', content: 'changed', expected_version: 1 });
  assert.throws(() => service.applyFileRename('alice', 'ws-1', {
    project_id: agent.project_id, path: 'from.txt', target_path: 'to.txt', expected_version: 1,
    preview_sha256: preview.preview_sha256, command_key: 'rename-stale-001',
  }), /version_conflict/);
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'from.txt').content, 'changed');

  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'to.txt', content: 'occupied', expected_version: 0 });
  assert.throws(() => service.previewFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'from.txt', target_path: 'to.txt', expected_version: 2 }), /file_target_exists/);
  const occupied = service.previewFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'to.txt', expected_version: 1 });
  service.applyFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'to.txt', expected_version: 1,
    preview_sha256: occupied.preview_sha256, command_key: 'delete-occupied-001' });
  const renamed = service.previewFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'from.txt', target_path: 'to.txt', expected_version: 2 });
  assert.equal(renamed.target.version, 2, 'a rename gets a fresh path-local version after retained target history');
  service.applyFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'from.txt', target_path: 'to.txt', expected_version: 2,
    preview_sha256: renamed.preview_sha256, command_key: 'rename-history-001' });
  assert.equal(service.readFileVersion('alice', 'ws-1', agent.project_id, 'to.txt', 1).content, 'occupied');
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'to.txt').version, 2);
  const currentPreview = service.previewFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'to.txt', expected_version: 2 });
  const request = { project_id: agent.project_id, path: 'to.txt', expected_version: 2,
    preview_sha256: currentPreview.preview_sha256, command_key: 'delete-key-conflict-01' };
  service.applyFileDelete('alice', 'ws-1', request);
  assert.throws(() => service.applyFileDelete('alice', 'ws-1', { ...request, expected_version: 1 }), /idempotency_conflict/);
});

test('failed receipt persistence rolls the logical file mutation back atomically', t => {
  const { db, service } = fixture(t), agent = service.createAgent('alice', { name: 'Writer' });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'source.txt', content: 'keep', expected_version: 0 });
  const preview = service.previewFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'source.txt', target_path: 'target.txt', expected_version: 1 });
  db.exec("CREATE TRIGGER reject_file_lifecycle_receipt BEFORE INSERT ON wb_file_lifecycle_commands BEGIN SELECT RAISE(ABORT,'controlled receipt failure'); END");
  assert.throws(() => service.applyFileRename('alice', 'ws-1', {
    project_id: agent.project_id, path: 'source.txt', target_path: 'target.txt', expected_version: 1,
    preview_sha256: preview.preview_sha256, command_key: 'rename-atomic-001',
  }), /controlled receipt failure/);
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'source.txt').content, 'keep');
  assert.throws(() => service.readFile('alice', 'ws-1', agent.project_id, 'target.txt'), /file_not_found/);
  assert.equal(db.prepare('SELECT count(*) n FROM wb_file_versions WHERE path=?').get('target.txt').n, 0);
  assert.equal(service.reconcileFileLifecycle('alice', 'ws-1', { project_id: agent.project_id, command_key: 'rename-atomic-001' }).state, 'not_applied');
});

test('rename and delete apply obey an unresolved workspace reservation', t => {
  const { db, service } = fixture(t), agent = service.createAgent('alice', { name: 'Writer' });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'source.txt', content: 'reserved delete', expected_version: 0 });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'rename.txt', content: 'reserved rename', expected_version: 0 });
  const deletePreview = service.previewFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'source.txt', expected_version: 1 });
  const renamePreview = service.previewFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'rename.txt', target_path: 'target.txt', expected_version: 1 });
  installWorkspaceCoordination(db);
  db.prepare('INSERT INTO wb_workspace_reservations VALUES(?,?,?,?,?,?,?,?)').run('reservation-file-lifecycle', 'alice', agent.project_id,
    'git_index', 'execution-file-lifecycle', 'a'.repeat(64), new Date().toISOString(), 'b'.repeat(64));
  assert.throws(() => service.applyFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'source.txt', expected_version: 1,
    preview_sha256: deletePreview.preview_sha256, command_key: 'delete-reserved-001' }), /workspace_coordination_required/);
  assert.throws(() => service.applyFileRename('alice', 'ws-1', { project_id: agent.project_id, path: 'rename.txt', target_path: 'target.txt', expected_version: 1,
    preview_sha256: renamePreview.preview_sha256, command_key: 'rename-reserved-001' }), /workspace_coordination_required/);
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'source.txt').content, 'reserved delete');
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'rename.txt').content, 'reserved rename');
  assert.throws(() => service.readFile('alice', 'ws-1', agent.project_id, 'target.txt'), /file_not_found/);
  assert.equal(service.reconcileFileLifecycle('alice', 'ws-1', { project_id: agent.project_id, command_key: 'delete-reserved-001' }).state, 'not_applied');
});

test('lifecycle apply refuses to run while the project has an active run', t => {
  const { db, service } = fixture(t), agent = service.createAgent('alice', { name: 'Writer' });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'active.txt', content: 'keep', expected_version: 0 });
  const run = service.enqueueAgentMessage('alice', agent.agent_id, { text: 'Active project run', client_message_id: 'file-lifecycle-active-run' });
  db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
  const preview = service.previewFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'active.txt', expected_version: 1 });
  assert.throws(() => service.applyFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'active.txt', expected_version: 1,
    preview_sha256: preview.preview_sha256, command_key: 'delete-active-001' }), /workspace_project_busy/);
  assert.equal(service.readFile('alice', 'ws-1', agent.project_id, 'active.txt').content, 'keep');
});

test('preview refuses to rename or delete a source blob that fails its stored digest', t => {
  const { db, service } = fixture(t), agent = service.createAgent('alice', { name: 'Writer' });
  service.writeFile('alice', 'ws-1', { project_id: agent.project_id, path: 'damaged.txt', content: 'expected', expected_version: 0 });
  const row = db.prepare('SELECT blob_name FROM wb_files WHERE path=?').get('damaged.txt');
  writeFileSync(join(service.projectRoot('alice', 'ws-1', agent.project_id), 'blobs', row.blob_name), 'damaged');
  assert.throws(() => service.previewFileDelete('alice', 'ws-1', { project_id: agent.project_id, path: 'damaged.txt', expected_version: 1 }), /file_integrity_failed/);
  assert.equal(db.prepare('SELECT count(*) n FROM wb_file_lifecycle_commands').get().n, 0);
});
