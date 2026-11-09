const PREVIEW_LIMIT = 20 * 1024 * 1024;
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set(['application/json', 'application/xml']);
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const PREVIEW_ERRORS = new Map([
  ['artifact_preview_metadata_invalid', '附件信息无效，无法预览'],
  ['artifact_preview_format_unsupported', '此文件格式暂不支持预览，请下载查看'],
  ['artifact_preview_too_large', '文件过大，暂不支持预览，请下载查看'],
  ['artifact_preview_unavailable', '暂时无法读取附件，请稍后重试'],
  ['artifact_preview_integrity_failed', '附件校验失败，无法预览，请重新下载'],
  ['DOCUMENT_PREVIEW_TIMEOUT', '文件内容读取超时，请稍后重试'],
  ['DOCUMENT_PREVIEW_FAILED', '暂时无法读取文件内容，请下载查看'],
  ['DOCUMENT_PREVIEW_RESULT_INVALID', '文件内容校验失败，无法预览'],
  ['DOCUMENT_PREVIEW_TOO_LARGE', '文件过大，暂不支持在线预览，请下载查看'],
  ['DOCUMENT_PREVIEW_CONTAINER_LIMIT', '文件内容超出安全预览范围，请下载查看'],
  ['DOCUMENT_PREVIEW_FORMAT_INVALID', '文件格式无效或内容损坏，请下载查看'],
  ['DOCUMENT_PREVIEW_XML_INVALID', '文件内容无效或已损坏，请下载查看'],
  ['DOCUMENT_PREVIEW_XML_UNSAFE', '文件包含不安全的 XML 内容，无法预览'],
  ['PDF_ENGINE_UNAVAILABLE', 'PDF 内容读取组件暂不可用，请稍后重试'],
  ['PDF_PASSWORD_REQUIRED', '此 PDF 受密码保护，请下载后查看'],
  ['FILE_CONTAINER_LIMIT', '文件内容超出安全预览范围，请下载查看'],
  ['FILE_SOURCE_INTEGRITY_FAILED', '附件版本校验失败，无法预览，请重新下载'],
  ['STALE_FILE_VERSION', '附件版本已变化，请重新打开预览'],
  ['UNAUTHORIZED_FILE', '无权读取此附件'],
  ['ENGINE_CRASH', '文件内容读取失败，请下载查看'],
  ['FILE_JOB_FENCE_LOST', '文件读取状态已变化，请重新打开预览'],
  ['FILE_REQUEST_INVALID', '预览请求无效，请重新打开预览'],
  ['UNSUPPORTED_FORMAT_OPERATION', '此文件格式暂不支持在线预览，请下载查看'],
]);

const normalizedType = value => String(value ?? '').toLowerCase().split(';', 1)[0].trim();
const failure = code => new Error(code);

export function artifactPreviewErrorMessage(error) {
  if (!(error instanceof Error)) return '操作未确认，请重试';
  return PREVIEW_ERRORS.get(error.message)
    ?? (/^[A-Z][A-Z0-9_]{2,95}$/.test(error.message) ? '暂时无法完成文件预览，请下载查看' : error.message);
}

/** @param {AbortSignal} [signal] */
export async function fetchVerifiedArtifactPreviewBytes(file, kind, signal = undefined) {
  signal?.throwIfAborted();
  const mediaType = normalizedType(file?.media_type);
  if (!file || !ARTIFACT_ID.test(file.artifact_id) || !Number.isSafeInteger(file.version) || file.version < 1
    || file.part_index !== undefined && (!Number.isSafeInteger(file.part_index) || file.part_index < 1 || file.part_index > 50)
    || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw failure('artifact_preview_metadata_invalid');
  }
  if ((kind === 'image' && !RASTER_IMAGE_TYPES.has(mediaType))
    || (kind === 'text' && !mediaType.startsWith('text/') && !TEXT_TYPES.has(mediaType))
    || !['image', 'text'].includes(kind)) {
    throw failure('artifact_preview_format_unsupported');
  }
  if (file.size_bytes > PREVIEW_LIMIT) throw failure('artifact_preview_too_large');

  const url = `/workbench-api/v1/artifacts/${encodeURIComponent(file.artifact_id)}${file.part_index === undefined ? '' : `/parts/${file.part_index}`}/download?version=${file.version}`;
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw failure('artifact_preview_unavailable');
  }
  if (!response.body || normalizedType(response.headers.get('content-type')) !== mediaType) {
    await response.body?.cancel().catch(() => {});
    throw failure('artifact_preview_integrity_failed');
  }

  const bytes = await readVerifiedPreviewBytes(response, file, signal);
  return Object.freeze({ bytes, media_type: mediaType });
}

/** Callers bind the response status, identity and content type before reading.
 * @param {AbortSignal} [signal]
 */
export async function readVerifiedPreviewBytes(response, file, signal = undefined) {
  if (!file || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw failure('artifact_preview_metadata_invalid');
  }
  if (file.size_bytes > PREVIEW_LIMIT) {
    await response.body.cancel().catch(() => {});
    throw failure('artifact_preview_too_large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > file.size_bytes) throw failure('artifact_preview_integrity_failed');
      if (length > PREVIEW_LIMIT) throw failure('artifact_preview_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  signal?.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const sha256 = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  signal?.throwIfAborted();
  if (bytes.byteLength !== file.size_bytes || sha256 !== file.sha256) {
    throw failure('artifact_preview_integrity_failed');
  }
  return bytes;
}
