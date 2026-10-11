import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';

test('file operation API enqueues an owned fixed artifact version and returns its job', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-api-')); const file = join(directory, 'input.pdf');
  const bytes = Buffer.from('%PDF-1.7\ninput'); writeFileSync(file, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'], uploadRoot: join(directory, 'files'),
    csrfToken: '1234567890abcdef', allowedOrigins: ['https://jot.example'] });
  try {
    service.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
    service.db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('artifact-1', 'conv', 'owner', 'upload', 1, 'now', 'now');
    service.db.prepare("INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run('artifact-1', 1, file, sha, bytes.length, 'application/pdf', JSON.stringify({ file_name: 'input.pdf', status: 'ready' }), 'now');
    const headers = { 'x-user-id': 'owner', origin: 'https://jot.example', 'x-csrf-token': '1234567890abcdef',
      'idempotency-key': 'file-api-request-1' };
    const response = await service.app.inject({ method: 'POST', url: '/v1/artifacts/artifact-1/file-operations', headers,
      payload: { conversation_id: 'conv', operation: 'document.read', base_version: 1, base_sha256: sha } });
    assert.equal(response.statusCode, 202, response.body); const job = response.json(); assert.equal(job.status, 'queued');
    const read = await service.app.inject({ method: 'GET', url: `/v1/file-jobs/${job.job_id}`, headers: { 'x-user-id': 'owner' } });
    assert.equal(read.statusCode, 200); assert.equal(read.json().job_id, job.job_id);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('internal universe_file can list registered templates without an artifact reference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-template-api-'));
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'],
    uploadRoot: join(directory, 'files'), internalChannelToken: 'test-b9673ba349916aa5',
    templateRoot: resolve('file-engine/templates') });
  try {
    service.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
    service.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('conv', 'owner', 'session-1', 'now', 'now');
    const response = await service.app.inject({ method: 'POST', url: '/internal/v1/file-tools',
      headers: { authorization: 'Bearer test-b9673ba349916aa5' },
      payload: { session_ref: 'session-1', call_id: 'template-list-1', arguments: { operation: 'document.templates' } } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().templates.map(row => row.template_id),
      ['technical-report-v1', 'copy-brief-v1', 'evidence-table-v1']);
    assert.equal(JSON.stringify(response.json()).includes('path'), false);
    const copy = response.json().templates.find(row => row.template_id === 'copy-brief-v1');
    assert.deepEqual(copy.fill_contract.target, {
      template_id: copy.template_id, template_version: copy.version, template_sha256: copy.sha256,
    });
    assert.equal(copy.fill_contract.operation, 'writer.fill_template');
    assert.deepEqual(copy.fill_contract.required_fields, Object.keys(copy.fields));
    assert.deepEqual(copy.fill_contract.save_as, { format: 'docx', new_version: true });
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('internal universe_file returns an actionable 422 contract error for incomplete template fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-template-invalid-'));
  const templateRoot = resolve('file-engine/templates');
  const catalog = JSON.parse(readFileSync(join(templateRoot, 'catalog.json'), 'utf8'));
  const selected = catalog.templates.find(row => row.template_id === 'copy-brief-v1');
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'],
    uploadRoot: join(directory, 'files'), internalChannelToken: 'test-b9673ba349916aa5', templateRoot });
  try {
    service.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
    service.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('conv', 'owner', 'session-1', 'now', 'now');
    const response = await service.app.inject({ method: 'POST', url: '/internal/v1/file-tools',
      headers: { authorization: 'Bearer test-b9673ba349916aa5' }, payload: {
        session_ref: 'session-1', call_id: 'template-invalid-1', arguments: {
          operation: 'writer.fill_template', target: { template_id: selected.template_id,
            template_version: selected.version, template_sha256: selected.sha256 },
          change: { fields: { title: '只有标题' } }, save_as: { format: 'docx', new_version: true },
        },
      } });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'TEMPLATE_CONTENT_INVALID');
    assert.deepEqual(response.json().error.details.missing_fields.sort(),
      Object.keys(selected.fields).filter(key => key !== 'title').sort());
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('internal universe_file instantiates a trusted template and queues a fill job', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-template-fill-'));
  const templateRoot = resolve('file-engine/templates');
  const catalog = JSON.parse(readFileSync(join(templateRoot, 'catalog.json'), 'utf8'));
  const selected = catalog.templates.find(row => row.template_id === 'copy-brief-v1');
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'],
    uploadRoot: join(directory, 'files'), internalChannelToken: 'test-b9673ba349916aa5', templateRoot });
  try {
    service.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
    service.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('conv', 'owner', 'session-1', 'now', 'now');
    const fields = Object.fromEntries(Object.keys(selected.fields).map(key => [key, `${key}内容`]));
    const response = await service.app.inject({ method: 'POST', url: '/internal/v1/file-tools',
      headers: { authorization: 'Bearer test-b9673ba349916aa5' },
      payload: { session_ref: 'session-1', call_id: 'template-fill-1', arguments: {
        operation: 'writer.fill_template', target: { template_id: selected.template_id,
          template_version: selected.version, template_sha256: selected.sha256 },
        change: { fields }, save_as: { format: 'docx', new_version: true } } } });
    assert.equal(response.statusCode, 202, response.body);
    const job = response.json(); assert.equal(job.operation, 'writer.fill_template');
    assert.match(String(job.artifact_ref), /^artifact-/); assert.equal(job.base_version, 1);
    const base = service.db.prepare('SELECT sha256,mime_type FROM ga_artifact_versions WHERE artifact_id=? AND version=1')
      .get(job.artifact_ref);
    assert.equal(base.sha256, selected.sha256);
    assert.match(base.mime_type, /wordprocessingml/);
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('internal universe_file instantiates the evidence table and queues mapped records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-file-record-fill-'));
  const templateRoot = resolve('file-engine/templates');
  const catalog = JSON.parse(readFileSync(join(templateRoot, 'catalog.json'), 'utf8'));
  const selected = catalog.templates.find(row => row.template_id === 'evidence-table-v1');
  const service = await buildServer({ databasePath: join(directory, 'db.sqlite'), workspaces: ['ws'],
    uploadRoot: join(directory, 'files'), internalChannelToken: 'test-b9673ba349916aa5', templateRoot });
  try {
    service.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('conv', 'owner', 'ws', 't', '{}', 'now', 'now');
    service.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('conv', 'owner', 'session-1', 'now', 'now');
    const response = await service.app.inject({ method: 'POST', url: '/internal/v1/file-tools',
      headers: { authorization: 'Bearer test-b9673ba349916aa5' }, payload: {
        session_ref: 'session-1', call_id: 'record-fill-1', arguments: { operation: 'calc.fill_records',
          target: { template_id: selected.template_id, template_version: selected.version,
            template_sha256: selected.sha256 }, save_as: { format: 'xlsx', new_version: true },
          change: { schema_version: 'evidence-records/1.0', records: [] } } } });
    assert.equal(response.statusCode, 202, response.body); assert.equal(response.json().operation, 'calc.fill_records');
  } finally { await service.app.close(); service.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
