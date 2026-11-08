import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { FileEngineAdapter } from '../../src/file-engine/engine.ts';
import { FileEngineWorker } from '../../src/file-engine/worker.ts';
import { artifactPreviewErrorMessage } from '../../../../web/jot/artifact-preview-bytes.mjs';
import { formatDocumentPreviewContent } from '../../../../web/jot/document-preview-content.mjs';

const python = process.env.GENERAL_AGENT_FILE_ENGINE_PYTHON;
const base = resolve(fileURLToPath(new URL('../../../../test-tmp/m21-02-http-preview/', import.meta.url)));
const origin = 'https://preview.fixture.jot.example';
const csrf = 'preview-fixture-csrf-token';
assert.ok(isAbsolute(base), 'test fixture root must be resolved before cleanup');
mkdirSync(base, { recursive: true });

test('owned historical PDF and Office content travels through HTTP, worker and the plain-text UI consumer',
  { skip: !python }, async t => {
    const root = mkdtempSync(join(base, 'case-'));
    let service;
    t.after(async () => {
      if (service) { await service.app.close(); service.db.close(); }
      const child = relative(base, resolve(root));
      assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'cleanup target must remain inside the fixture root');
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });
    const files = join(root, 'files'); mkdirSync(files, { recursive: true });
    const make = `import sys,zipfile,random,string\nfrom pathlib import Path\nfrom reportlab.pdfgen import canvas\nr=Path(sys.argv[1])\n` +
      `pdf=canvas.Canvas(str(r/'sample.pdf'));pdf.drawString(72,720,'PDF known body');pdf.save()\n` +
      `with zipfile.ZipFile(r/'sample.docx','w',zipfile.ZIP_DEFLATED) as z:z.writestr('word/document.xml','''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX known body &lt;script&gt;globalThis.previewPwned=1&lt;/script&gt;</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>DOCX known table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>''')\n` +
      `with zipfile.ZipFile(r/'sample.xlsx','w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('xl/workbook.xml','''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>''')\n z.writestr('xl/_rels/workbook.xml.rels','''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>''')\n z.writestr('xl/sharedStrings.xml','''<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>XLSX known cell</t></si></sst>''')\n z.writestr('xl/worksheets/sheet1.xml','''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>''')\n` +
      `with zipfile.ZipFile(r/'sample.pptx','w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('ppt/presentation.xml','''<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>''')\n z.writestr('ppt/slides/slide1.xml','''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>PPTX known slide</a:t></p:sld>''')\n` +
      `long_text='L'*100+''.join(random.Random(11).choices(string.ascii_letters+string.digits,k=200400))\nwith zipfile.ZipFile(r/'large.docx','w',zipfile.ZIP_DEFLATED) as z:z.writestr('word/document.xml','''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'''+long_text+'''</w:t></w:r></w:p></w:body></w:document>''')\n` +
      `with zipfile.ZipFile(r/'unsafe.docx','w',zipfile.ZIP_DEFLATED) as z:z.writestr('word/document.xml','''<!DOCTYPE w:document [<!ENTITY bad "expanded">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&bad;</w:t></w:r></w:p></w:body></w:document>''')\n`;
    const created = (await import('node:child_process')).spawnSync(python, ['-c', make, files], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);

    service = await buildServer({ databasePath: join(root, 'db.sqlite'), workspaces: ['ws'], uploadRoot: join(root, 'uploads'),
      templateRoot: resolve('file-engine/templates'), csrfToken: csrf, allowedOrigins: [origin] });
    service.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('preview-conversation', 'preview-owner', 'ws', 'Preview', '{}', 'now', 'now');

    const cases = [
      ['pdf', 'sample.pdf', 'application/pdf', 'PDF known body'],
      ['docx', 'sample.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX known table cell'],
      ['xlsx', 'sample.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'XLSX known cell'],
      ['pptx', 'sample.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PPTX known slide'],
      ['large', 'large.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'L'.repeat(100)],
      ['unsafe', 'unsafe.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ''],
    ];
    for (const [id, name, mime, expected] of cases) {
      const originalPath = join(files, name), original = readFileSync(originalPath);
      const currentPath = join(files, `current-${name}`), currentBytes = Buffer.from(`newer version of ${name}`);
      writeFileSync(currentPath, currentBytes);
      const sha = createHash('sha256').update(original).digest('hex');
      service.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(`artifact-${id}`, 'preview-conversation', 'preview-owner', 'upload', 2, 'now', 'now');
      const insert = service.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)');
      insert.run(`artifact-${id}`, 1, originalPath, sha, original.length, mime,
        JSON.stringify({ file_name: name, status: 'ready', preview_kind: 'unsupported' }), 'earlier');
      insert.run(`artifact-${id}`, 2, currentPath, createHash('sha256').update(currentBytes).digest('hex'), currentBytes.length, mime,
        JSON.stringify({ file_name: name, status: 'ready', preview_kind: 'unsupported' }), 'later');
      service.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(`artifact-${id}`, 'pending', 'present', 'now', 'now', 'now');
      cases[cases.findIndex(item => item[0] === id)].push(sha);
    }

    const headers = (owner, key) => ({ 'x-user-id': owner, origin, 'x-csrf-token': csrf, 'idempotency-key': key });
    const post = (id, version, sha, owner, key) => service.app.inject({ method: 'POST',
      url: `/v1/artifacts/artifact-${id}/file-operations`, headers: headers(owner, key), payload: {
        conversation_id: 'preview-conversation', operation: 'document.inspect', base_version: version, base_sha256: sha,
      } });
    const pdfCase = cases[0], [pdfId, , , , pdfSha] = pdfCase;
    const foreign = await post(pdfId, 1, pdfSha, 'other-owner', 'preview-foreign-owner');
    assert.equal(foreign.statusCode, 401);
    const staleVersion = await post(pdfId, 99, pdfSha, 'preview-owner', 'preview-wrong-version');
    assert.equal(staleVersion.statusCode, 409);
    const staleSha = await post(pdfId, 1, 'f'.repeat(64), 'preview-owner', 'preview-wrong-sha');
    assert.equal(staleSha.statusCode, 409);

    const overflowBytes = readFileSync(join(files, 'sample.pdf'));
    const overflowSha = createHash('sha256').update(overflowBytes).digest('hex');
    service.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('artifact-oversized', 'preview-conversation', 'preview-owner', 'upload', 1, 'now', 'now');
    service.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('artifact-oversized', 1, join(files, 'sample.pdf'), overflowSha, 20 * 1024 * 1024 + 1, 'application/pdf',
        JSON.stringify({ file_name: 'oversized.pdf', status: 'ready', preview_kind: 'unsupported' }), 'now');
    service.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('artifact-oversized', 'pending', 'present', 'now', 'now', 'now');
    const overflow = await service.app.inject({ method: 'POST', url: '/v1/artifacts/artifact-oversized/file-operations',
      headers: headers('preview-owner', 'preview-size-limit'), payload: { conversation_id: 'preview-conversation',
        operation: 'document.inspect', base_version: 1, base_sha256: overflowSha } });
    assert.equal(overflow.statusCode, 413, overflow.body);
    assert.equal(overflow.json().error.code, 'DOCUMENT_PREVIEW_TOO_LARGE');

    const worker = new FileEngineWorker(service.fileJobs, service.artifacts,
      new FileEngineAdapter({ python, workerPath: resolve('file-engine/worker.py'), timeoutMs: 30_000 }),
      { workerId: 'preview-http-test', workRoot: join(root, 'worker') });
    for (const [id, , mime, expected, sha] of cases) {
      const metadata = await service.app.inject({ method: 'GET', url: `/v1/artifacts/artifact-${id}/preview?version=1`,
        headers: { 'x-user-id': 'preview-owner' } });
      assert.equal(metadata.statusCode, 200, metadata.body);
      assert.deepEqual({ artifact_id: metadata.json().artifact_id, version: metadata.json().version, kind: metadata.json().kind },
        { artifact_id: `artifact-${id}`, version: 1, kind: 'unsupported' });
      const queued = await post(id, 1, sha, 'preview-owner', `preview-http-${id}`);
      assert.equal(queued.statusCode, 202, queued.body);
      const accepted = queued.json();
      assert.equal(accepted.artifact_ref, `artifact-${id}`); assert.equal(accepted.base_version, 1);
      assert.equal(accepted.operation, 'document.inspect');
      assert.equal(await worker.processNext(), true);
      const completed = await service.app.inject({ method: 'GET', url: `/v1/file-jobs/${accepted.job_id}`,
        headers: { 'x-user-id': 'preview-owner' } });
      assert.equal(completed.statusCode, 200, completed.body);
      const job = completed.json();
      assert.equal(job.status, id === 'unsafe' ? 'failed' : 'completed', `${id}: ${job.error_code ?? 'no error code'}`);
      assert.equal(job.artifact_ref, `artifact-${id}`); assert.equal(job.base_version, 1);
      if (id === 'unsafe') {
        assert.equal(job.error_code, 'DOCUMENT_PREVIEW_XML_UNSAFE');
        assert.equal(artifactPreviewErrorMessage(new Error(job.error_code)), '文件包含不安全的 XML 内容，无法预览');
        continue;
      }
      assert.deepEqual(job.result.source, { artifact_id: `artifact-${id}`, version: 1, sha256: sha });
      const formatted = formatDocumentPreviewContent(mime, job.result.content);
      assert.ok(formatted.text.includes(expected), `${id} preview content did not reach formatter`);
      if (id === 'large') {
        assert.equal(job.result.content.paragraphs[0].length, 200_000);
        assert.equal(job.result.content.truncated, true);
        assert.equal(formatted.text.length, 200_000);
        assert.equal(formatted.truncated, true);
      }
      if (id === 'xlsx') assert.match(formatted.text, /B1: 2 \[=1\+1\]/);
      if (id === 'docx') {
        const markup = renderToStaticMarkup(React.createElement('pre', null, formatted.text));
        assert.match(markup, /&lt;script&gt;globalThis\.previewPwned=1&lt;\/script&gt;/);
        assert.equal(markup.includes('<script>'), false);
      }
      assert.equal(service.db.prepare('SELECT current_version FROM ga_artifacts WHERE id=?').get(`artifact-${id}`).current_version, 2);
    }
  });
