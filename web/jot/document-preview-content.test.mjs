import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDocumentPreviewContent, isDocumentPreviewMediaType } from './document-preview-content.mjs';

test('recognizes only document formats handled by the existing read-only worker', () => {
  assert.equal(isDocumentPreviewMediaType('application/pdf'), true);
  assert.equal(isDocumentPreviewMediaType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.equal(isDocumentPreviewMediaType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  assert.equal(isDocumentPreviewMediaType('application/vnd.openxmlformats-officedocument.presentationml.presentation'), true);
  assert.equal(isDocumentPreviewMediaType('image/svg+xml'), false);
  assert.equal(isDocumentPreviewMediaType('application/octet-stream'), false);
});

test('formats PDF pages as plain text and retains active-looking text literally', () => {
  const result = formatDocumentPreviewContent('application/pdf', {
    page_count: 2, pages: [{ number: 1, text: '<script>not executed</script>' }, { number: 2, text: 'second page' }], truncated: false,
  });
  assert.match(result.text, /第 1 页/);
  assert.match(result.text, /<script>not executed<\/script>/);
  assert.match(result.text, /第 2 页/);
  assert.equal(result.truncated, false);
});

test('formats DOCX paragraphs and tables without interpreting markup', () => {
  const result = formatDocumentPreviewContent('application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
    paragraphs: ['标题', '<img src=x onerror=alert(1)>'], tables: [[['姓名', '状态'], ['A', '完成']]], truncated: false,
  });
  assert.match(result.text, /标题/);
  assert.match(result.text, /<img src=x onerror=alert\(1\)>/);
  assert.match(result.text, /姓名 \| 状态/);
  assert.match(result.text, /A \| 完成/);
});

test('formats XLSX cell values and formulas as inert text', () => {
  const result = formatDocumentPreviewContent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {
    sheets: [{ name: 'Summary', cells: { B2: { value: 'ready', formula: null }, A1: { value: 'Title', formula: null }, C3: { value: '2', formula: 'SUM(A1:B2)' } } }],
    truncated: false,
  });
  assert.ok(result.text.indexOf('A1: Title') < result.text.indexOf('B2: ready'));
  assert.match(result.text, /C3: 2 \[=SUM\(A1:B2\)\]/);
});

test('formats PPTX slide text and caps the visible output', () => {
  const result = formatDocumentPreviewContent('application/vnd.openxmlformats-officedocument.presentationml.presentation', {
    slides: [{ number: 1, text: 'Intro' }, { number: 2, text: 'Summary' }], truncated: true,
  }, 16);
  assert.equal(result.text.length, 16);
  assert.equal(result.truncated, true);
});

test('rejects malformed worker content instead of stringifying arbitrary objects', () => {
  assert.throws(() => formatDocumentPreviewContent('application/pdf', { pages: [{ text: {} }] }), /DOCUMENT_PREVIEW_RESULT_INVALID/);
});
