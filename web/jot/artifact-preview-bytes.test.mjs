import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { artifactPreviewErrorMessage, fetchVerifiedArtifactPreviewBytes } from './artifact-preview-bytes.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const source = bytes => ({ artifact_id: 'artifact-1', version: 7, size_bytes: bytes.length, sha256: digest(bytes), media_type: 'image/png' });

test('turns preview validation errors into readable messages', () => {
  assert.equal(artifactPreviewErrorMessage(new Error('artifact_preview_format_unsupported')), '此文件格式暂不支持预览，请下载查看');
  assert.equal(artifactPreviewErrorMessage(new Error('artifact_preview_integrity_failed')), '附件校验失败，无法预览，请重新下载');
  assert.equal(artifactPreviewErrorMessage(new Error('network unavailable')), 'network unavailable');
  assert.equal(artifactPreviewErrorMessage(null), '操作未确认，请重试');
});

test('downloads the pinned version through the same-origin proxy and verifies bytes', async t => {
  const bytes = Buffer.from('trusted png bytes');
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  };

  const result = await fetchVerifiedArtifactPreviewBytes(source(bytes), 'image');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/workbench-api/v1/artifacts/artifact-1/download?version=7');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(Buffer.from(result.bytes), bytes);
  assert.equal(result.media_type, 'image/png');
});

test('does not pass SVG through the image preview branch', async t => {
  let called = false;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { called = true; return new Response(''); };

  await assert.rejects(fetchVerifiedArtifactPreviewBytes({
    artifact_id: 'artifact-1', version: 7, size_bytes: 30, sha256: 'a'.repeat(64), media_type: 'image/svg+xml'
  }, 'image'), /artifact_preview_format_unsupported/);
  assert.equal(called, false);
});

test('rejects an SVG response even when the pinned metadata claims PNG', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('<svg onload="attack()"></svg>', { headers: { 'content-type': 'image/svg+xml' } });

  const bytes = Buffer.from('<svg onload="attack()"></svg>');
  await assert.rejects(fetchVerifiedArtifactPreviewBytes(source(bytes), 'image'), /artifact_preview_integrity_failed/);
});

test('rejects previews above the bounded byte limit before fetching', async t => {
  let called = false;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { called = true; return new Response(''); };

  await assert.rejects(fetchVerifiedArtifactPreviewBytes({
    artifact_id: 'artifact-1', version: 7, size_bytes: 20 * 1024 * 1024 + 1, sha256: 'a'.repeat(64), media_type: 'image/png'
  }, 'image'), /artifact_preview_too_large/);
  assert.equal(called, false);
});

test('rejects a response whose bytes do not match the pinned digest', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('different bytes', { headers: { 'content-type': 'image/png' } });

  const bytes = Buffer.from('trusted png bytes');
  await assert.rejects(fetchVerifiedArtifactPreviewBytes(source(bytes), 'image'), /artifact_preview_integrity_failed/);
});

test('allows active HTML bytes only through the escaped-text preview branch', async t => {
  const bytes = Buffer.from('<script>attack()</script>');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  const result = await fetchVerifiedArtifactPreviewBytes({
    artifact_id: 'artifact-1', version: 7, size_bytes: bytes.length, sha256: digest(bytes), media_type: 'text/html'
  }, 'text');
  assert.equal(new TextDecoder().decode(result.bytes), '<script>attack()</script>');
  assert.equal(result.media_type, 'text/html');
  await assert.rejects(fetchVerifiedArtifactPreviewBytes({
    artifact_id: 'artifact-1', version: 7, size_bytes: bytes.length, sha256: digest(bytes), media_type: 'text/html'
  }, 'image'), /artifact_preview_format_unsupported/);
});
