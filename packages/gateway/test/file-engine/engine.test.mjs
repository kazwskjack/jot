import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { FileEngineAdapter, fileEngineChildEnvironment } from '../../src/file-engine/engine.ts';
import { validateFileOperationRequest } from '../../src/file-engine/contracts.ts';

const python = process.env.GENERAL_AGENT_FILE_ENGINE_PYTHON;
const worker = resolve('file-engine/worker.py');

test('file engine child environment supplies a real LibreOffice executable when unset', () => {
  const environment = fileEngineChildEnvironment({ PATH: '/usr/bin', PYTHONPATH: '' });
  assert.equal(environment.GENERAL_AGENT_LIBREOFFICE, '/usr/bin/libreoffice');
});

test('lightweight engine reads DOCX paragraphs without starting LibreOffice', { skip: !python }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-engine-docx-'));
  const input = join(directory, 'sample.docx');
  try {
    const code = `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('[Content_Types].xml','<Types/>')\n z.writestr('word/document.xml','''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>\\u6807\\u9898</w:t></w:r></w:p><w:p><w:r><w:t>\\u6b63\\u6587\\u5185\\u5bb9</w:t></w:r></w:p></w:body></w:document>''')`;
    assert.equal(spawnSync(python, ['-c', code, input]).status, 0);
    const adapter = new FileEngineAdapter({ python, workerPath: worker, timeoutMs: 10_000 });
    const result = await adapter.run({ operation: 'document.read', input_path: input,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      job_dir: directory, request: {} });
    assert.equal(result.ok, true); assert.deepEqual(result.content.paragraphs, ['标题', '正文内容']);
    assert.equal(result.engine.name, 'python_ooxml');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('engine rejects unknown operations with a fixed reason code', { skip: !python }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-engine-invalid-'));
  try {
    const adapter = new FileEngineAdapter({ python, workerPath: worker, timeoutMs: 10_000 });
    await assert.rejects(() => adapter.run({ operation: 'made.up', input_path: '', media_type: '',
      job_dir: directory, request: {} }), /UNSUPPORTED_FORMAT_OPERATION/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('contract accepts explicit Office to PDF conversion but rejects arbitrary targets', () => {
  const base = { operation: 'office.export_pdf', base_version: 1, base_sha256: 'a'.repeat(64),
    save_as: { format: 'pdf', new_version: true } };
  assert.equal(validateFileOperationRequest(base).operation, 'office.export_pdf');
  assert.throws(() => validateFileOperationRequest({ ...base, save_as: { format: 'docx', new_version: true } }),
    /UNSUPPORTED_FORMAT_OPERATION/);
});

test('contract accepts trusted template filling as a fixed new DOCX version', () => {
  const request = validateFileOperationRequest({ operation: 'writer.fill_template', base_version: 1,
    base_sha256: 'a'.repeat(64), target: { template_id: 'technical-report-v1',
      template_version: '1.0.0', template_sha256: 'a'.repeat(64) },
    change: { fields: { report_title: '报告标题' } }, save_as: { format: 'docx', new_version: true } });
  assert.equal(request.operation, 'writer.fill_template');
});

test('contract normalizes semantic replace aliases and supplies the DOCX new-version format', () => {
  const request = validateFileOperationRequest({ operation: 'writer.replace_text', base_version: 1,
    base_sha256: 'a'.repeat(64), target: { find_text: '项目状态：待更新。', scope: 'body' },
    expected: { match_count: 1 }, change: { type: 'replace_text', new_text: '项目状态：已完成。' } });
  assert.deepEqual(request.target, { old_text: '项目状态：待更新。', expected_matches: 1 });
  assert.deepEqual(request.change, { new_text: '项目状态：已完成。' });
  assert.deepEqual(request.save_as, { format: 'docx', new_version: true });
});

test('contract normalizes zero-based table coordinates and expected text', () => {
  const request = validateFileOperationRequest({ operation: 'writer.set_table_cell', base_version: 1,
    base_sha256: 'a'.repeat(64), target: { table_index: 0, row_index: 2, column_index: 1 },
    expected: { old_text: '待审核' }, change: { type: 'set_text', new_text: '已完成' } });
  assert.deepEqual(request.target, { table_index: 0, cell: 'B3', old_value: '待审核' });
  assert.deepEqual(request.change, { value: '已完成' });
  assert.deepEqual(request.save_as, { format: 'docx', new_version: true });
});

test('contract accepts mapped record filling as a fixed new XLSX version', () => {
  const request = validateFileOperationRequest({ operation: 'calc.fill_records', base_version: 1,
    base_sha256: 'a'.repeat(64), target: { template_id: 'evidence-table-v1',
      template_version: '1.0.0', template_sha256: 'a'.repeat(64) },
    change: { schema_version: 'evidence-records/1.0', records: [] },
    save_as: { format: 'xlsx', new_version: true } });
  assert.equal(request.operation, 'calc.fill_records');
});

test('Python worker routes Office PDF export through the dedicated converter', { skip: !python }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-engine-export-route-'));
  const input = join(directory, 'sample.docx'); const output = join(directory, 'output.pdf');
  try {
    const script = `import importlib.util,json,pathlib,sys\n` +
      `spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)\n` +
      `pathlib.Path(sys.argv[2]).write_bytes(b'PK\\x03\\x04docx')\n` +
      `w.uno_export_pdf=lambda req,input_path,output_path,job_dir:{'output_path':str(output_path),'checks':{'saved_and_reopened':'PASS','page_count':1}}\n` +
      `r=w.execute({'operation':'office.export_pdf','input_path':sys.argv[2],'output_path':sys.argv[3],'media_type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','job_dir':sys.argv[4],'request':{'save_as':{'format':'pdf','new_version':True}}})\n` +
      `print(json.dumps(r))`;
    const result = spawnSync(python, ['-c', script, worker, input, output, directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout.trim());
    assert.equal(value.ok, true); assert.equal(value.engine.name, 'libreoffice_uno');
    assert.equal(value.checks.page_count, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Python worker validates trusted template identity and complete bounded fields before Writer starts', { skip: !python }, () => {
  const templateRoot = resolve('file-engine/templates');
  const catalog = JSON.parse(readFileSync(join(templateRoot, 'catalog.json'), 'utf8'));
  const row = catalog.templates.find(item => item.template_id === 'copy-brief-v1');
  const fields = Object.fromEntries(Object.keys(row.fields).map(key => [key, `${key}内容`]));
  const script = `import importlib.util,json,sys\n` +
    `spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)\n` +
    `req=json.loads(sys.argv[3]); print(json.dumps(w.validate_template_fill(req,w.Path(sys.argv[2]))))`;
  const request = { target: { template_id: row.template_id, template_version: row.version,
    template_sha256: row.sha256 }, change: { fields } };
  const result = spawnSync(python, ['-c', script, worker, join(templateRoot, row.file), JSON.stringify(request)],
    { encoding: 'utf8', env: { ...process.env, GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT: templateRoot } });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout.trim()); assert.equal(Object.keys(value.replacements).length, Object.keys(row.fields).length);
  const incomplete = structuredClone(request); delete incomplete.change.fields.body;
  const rejected = spawnSync(python, ['-c', script, worker, join(templateRoot, row.file), JSON.stringify(incomplete)],
    { encoding: 'utf8', env: { ...process.env, GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT: templateRoot } });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /TEMPLATE_CONTENT_INVALID/);
});

test('Python worker validates mapped records, duplicate keys, and template capacity before Calc starts', { skip: !python }, () => {
  const templateRoot = resolve('file-engine/templates');
  const catalog = JSON.parse(readFileSync(join(templateRoot, 'catalog.json'), 'utf8'));
  const row = catalog.templates.find(item => item.template_id === 'evidence-table-v1');
  const record = { entity_id: 'project-1', metric: 'stars', value: 100, unit: 'count', period: '2026-09',
    source_url: 'https://example.com/project-1', observed_at: '2026-09-13T00:00:00Z',
    evidence_ref: 'source-1', verification: 'verified', note: '' };
  const script = `import importlib.util,json,sys\n` +
    `spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)\n` +
    `req=json.loads(sys.argv[3]); print(json.dumps(w.validate_record_fill(req,w.Path(sys.argv[2]))))`;
  const request = { target: { template_id: row.template_id, template_version: row.version,
    template_sha256: row.sha256 }, change: { schema_version: 'evidence-records/1.0', records: [record] } };
  const ok = spawnSync(python, ['-c', script, worker, join(templateRoot, row.file), JSON.stringify(request)],
    { encoding: 'utf8', env: { ...process.env, GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT: templateRoot } });
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).rows.length, 1);
  const duplicate = structuredClone(request); duplicate.change.records.push(structuredClone(record));
  const rejected = spawnSync(python, ['-c', script, worker, join(templateRoot, row.file), JSON.stringify(duplicate)],
    { encoding: 'utf8', env: { ...process.env, GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT: templateRoot } });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /TEMPLATE_CONTENT_INVALID/);
});
