import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDocumentPayload, DocumentRenderer } from '../../src/artifacts/document-renderer.ts';

test('page evidence becomes one article bundle without trusting local paths', () => {
  const payload = buildDocumentPayload('artifact-request:abc', [{ result_ref: 'ref-1', result: {
    ok: true, title: '页面标题', canonical_url: 'https://example.com/a',
    blocks: [{ type: 'heading', text: '标题' }, { type: 'paragraph', text: '正文内容' }],
    images: [{ scope: 'body', url: 'https://example.com/a.jpg' }], result_ref: 'ref-1',
  } }]);
  assert.equal(payload.kind, 'article_bundle');
  assert.equal(payload.body_blocks.length, 2);
  assert.equal(payload.canonical_url, 'https://example.com/a');
  assert.equal(JSON.stringify(payload).includes('server_path'), false);
});

test('multiple page evidence becomes a collection in source order', () => {
  const source = [1, 2].map(index => ({ result_ref: `ref-${index}`, result: {
    ok: true, title: `页面${index}`, source_url: `https://example.com/${index}`,
    body_blocks: [{ type: 'heading', text: `标题${index}` },
      { type: 'paragraph', text: `正文${index}` }], images: [],
  } }));
  const payload = buildDocumentPayload('artifact-request:abc', source);
  assert.equal(payload.kind, 'article_bundle_collection');
  assert.equal(payload.articles.length, 2);
  assert.equal(payload.articles[1].source_index, 1);
});

test('partial crawl results produce a document collection with failed URL reasons', () => {
  const payload = buildDocumentPayload('artifact-request:partial', [
    { input_index: 0, result_ref: 'ref-ok', result: {
      ok: true, title: '可用页面', source_url: 'https://example.com/ok',
      body_blocks: [{ type: 'paragraph', text: '正文' }], images: [],
    } },
    { input_index: 1, result_ref: 'ref-failed', url: 'https://example.com/timeout',
      error_code: 'PAGE_TIMEOUT', title: '超时页面', result: { ok: false } },
  ]);
  assert.equal(payload.kind, 'article_bundle_collection');
  assert.equal(payload.articles.length, 1);
  assert.deepEqual(payload.failures, [{ input_index: 1, url: 'https://example.com/timeout',
    title: '超时页面', error_code: 'PAGE_TIMEOUT', result_ref: 'ref-failed' }]);
});

test('a crawl batch with no successful pages is rejected instead of making an empty document', () => {
  assert.throws(() => buildDocumentPayload('artifact-request:empty', [
    { input_index: 0, result_ref: 'ref-failed', url: 'https://example.com/500',
      error_code: 'BRANCH_ERROR', result: { ok: false } },
  ]), /artifact_sources_empty/);
});

test('renderer verifies every volume before registering the group', async () => {
  const calls = [];
  const renderer = new DocumentRenderer({
    exportBundle: async payload => ({ ok: true, documents: [
      { doc_path: '/tmp/one.docx', display_name: '一.docx' },
      { doc_path: '/tmp/two.docx', display_name: '二.docx' },
    ], payload }),
    verifyDocument: async path => { calls.push(['verify', path]); return { bytes: 10, sha256: 'a'.repeat(64) }; },
    registerDocuments: (runId, requestId, documents) => {
      calls.push(['register', runId, requestId, documents.length]);
      return { artifact_ref: 'artifact:group-1', size_bytes: 20,
        sha256: 'b'.repeat(64), parts: [{}, {}] };
    },
  });
  const result = await renderer.render({ request_id: 'artifact-request:abc',
    client_run_id: 'run-1', format: 'docx', template: 'default',
    source_results: [{ result_ref: 'ref-1', result: { ok: true, title: 'A',
      source_url: 'https://example.com', blocks: [{ text: 'a' }, { text: 'b' }] } }] });
  assert.deepEqual(calls.map(item => item[0]), ['verify', 'verify', 'register']);
  assert.equal(result.parts, 2);
  assert.equal(result.render_status, 'passed');
});
