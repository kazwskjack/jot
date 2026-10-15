import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { TemplateCatalog } from '../../src/file-engine/templates.ts';

const source = resolve('file-engine/templates');

test('evidence template declares every verification state accepted by both validators',()=>{
 const mapping=JSON.parse(readFileSync(join(source,'evidence-table-v1.mapping.json'),'utf8'));
 assert.deepEqual(Object.keys(mapping.status_labels??{}).sort(),['missing','partial','synthetic','verified']);
 for(const value of Object.values(mapping.status_labels))assert.ok(typeof value==='string'&&value.trim());
});

test('template catalog returns only hash-verified registered templates', () => {
  const catalog = new TemplateCatalog(source);
  const rows = catalog.list();
  assert.deepEqual(rows.map(row => row.template_id), [
    'technical-report-v1', 'copy-brief-v1', 'evidence-table-v1',
  ]);
  const selected = catalog.resolve('technical-report-v1', '1.0.0', rows[0].sha256);
  assert.equal(selected.format, 'docx');
  assert.match(selected.path, /technical-report-v1\.docx$/);
  // Original neutral templates can compress below 1 KB; require an OOXML ZIP container.
  assert.equal(readFileSync(selected.path).subarray(0,4).toString('hex'), '504b0304');
});

test('template catalog rejects physical files that no longer match the registered hash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-template-catalog-'));
  try {
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, 'technical-report-v1.docx'), 'tampered');
    assert.throws(() => new TemplateCatalog(directory), /TEMPLATE_HASH_MISMATCH/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('template identity must include exact id, version, and sha256', () => {
  const catalog = new TemplateCatalog(source); const row = catalog.list()[0];
  assert.throws(() => catalog.resolve(row.template_id, '9.9.9', row.sha256), /TEMPLATE_NOT_FOUND/);
  assert.throws(() => catalog.resolve(row.template_id, row.version, '0'.repeat(64)), /TEMPLATE_NOT_FOUND/);
});
