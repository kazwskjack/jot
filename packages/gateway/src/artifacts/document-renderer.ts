import type { GeneratedArtifactReceipt } from './requests.ts';

type JsonRecord = Record<string, any>;

function pageBundle(source: JsonRecord): JsonRecord {
  const result = source.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) {
    throw new Error('artifact_source_result_invalid');
  }
  const blocks = (Array.isArray(result.body_blocks) ? result.body_blocks
    : Array.isArray(result.blocks) ? result.blocks : [])
    .filter((item: unknown): item is JsonRecord => Boolean(item && typeof item === 'object'
      && !Array.isArray(item) && String((item as JsonRecord).text || '').trim()))
    .map((item: JsonRecord) => ({ type: String(item.type || 'paragraph'),
      ...(Number.isInteger(item.level) ? { level: Number(item.level) } : {}),
      text: String(item.text).trim() }));
  if (!blocks.length) throw new Error('artifact_source_body_empty');
  const images = (Array.isArray(result.images) ? result.images : [])
    .filter((item: unknown): item is JsonRecord => Boolean(item && typeof item === 'object'
      && !Array.isArray(item) && (item as JsonRecord).scope === 'body'
      && /^https?:\/\//.test(String((item as JsonRecord).url || ''))))
    .map((item: JsonRecord) => ({ scope: 'body', url: String(item.url),
      alt: String(item.alt || ''), caption: String(item.caption || ''),
      anchor_block_index: Number.isInteger(item.anchor_block_index)
        ? Number(item.anchor_block_index) : 0 }));
  return { ok: true, kind: 'article_bundle', title: String(result.title || '未命名页面'),
    canonical_url: String(result.canonical_url || result.source_url || ''),
    source_url: String(result.source_url || result.canonical_url || ''),
    published_at: String(result.published_at || ''), body_blocks: blocks, images };
}

function failedSource(source: JsonRecord, error: unknown): JsonRecord {
  const result = source.result && typeof source.result === 'object' && !Array.isArray(source.result)
    ? source.result as JsonRecord : {};
  const inputIndex = Number.isInteger(source.input_index) ? Number(source.input_index) : undefined;
  const url = String(source.url || result.source_url || result.canonical_url || '');
  const explicit = String(source.error_code || result.error_code || '').trim();
  const fallback = error instanceof Error && error.message === 'artifact_source_body_empty'
    ? 'BODY_EMPTY' : error instanceof Error && error.message === 'artifact_source_result_invalid'
      ? 'RESULT_INVALID' : 'ARTIFACT_SOURCE_INVALID';
  return { ...(inputIndex === undefined ? {} : { input_index: inputIndex }), url,
    ...(source.title || result.title ? { title: String(source.title || result.title) } : {}),
    error_code: explicit || fallback,
    ...(source.result_ref || result.result_ref ? { result_ref: String(source.result_ref || result.result_ref) } : {}) };
}

export function buildDocumentPayload(requestId: string,
  sourceResults: Array<Record<string, unknown>>): JsonRecord {
  if (!Array.isArray(sourceResults) || sourceResults.length < 1 || sourceResults.length > 50) {
    throw new Error('artifact_sources_invalid');
  }
  const bundles: JsonRecord[] = [];
  const failures: JsonRecord[] = [];
  for (const source of sourceResults) {
    try {
      bundles.push(pageBundle(source));
    } catch (error) {
      failures.push(failedSource(source, error));
    }
  }
  if (!bundles.length) throw new Error('artifact_sources_empty');
  if (bundles.length === 1 && !failures.length) return { ...bundles[0], request_id: requestId };
  return { ok: true, kind: 'article_bundle_collection', request_id: requestId,
    articles: bundles.map((bundle, sourceIndex) => ({ source_index: sourceIndex,
      source_title: bundle.title, source_url: bundle.source_url, bundle })), failures };
}

interface DocumentRendererDependencies {
  exportBundle(payload: JsonRecord, request: JsonRecord): Promise<JsonRecord>;
  verifyDocument(path: string): Promise<{ bytes: number; sha256: string }>;
  registerDocuments(runId: string, requestId: string,
    documents: Array<{ path: string; display_name: string }>): JsonRecord;
}

export class DocumentRenderer {
  private readonly dependencies: DocumentRendererDependencies;

  constructor(dependencies: DocumentRendererDependencies) {
    this.dependencies = dependencies;
  }

  async render(request: Record<string, unknown>): Promise<GeneratedArtifactReceipt> {
    if (request.format !== 'docx' || typeof request.request_id !== 'string'
      || typeof request.client_run_id !== 'string' || !Array.isArray(request.source_results)) {
      throw new Error('artifact_document_request_invalid');
    }
    const payload = buildDocumentPayload(request.request_id,
      request.source_results as Array<Record<string, unknown>>);
    const exported = await this.dependencies.exportBundle(payload, request as JsonRecord);
    const documents = Array.isArray(exported.documents) && exported.documents.length
      ? exported.documents : exported.doc_path
        ? [{ doc_path: exported.doc_path, display_name: 'Universe结果.docx' }] : [];
    if (exported.ok !== true || !documents.length || documents.length > 50) {
      throw new Error('artifact_document_export_invalid');
    }
    const registered: Array<{ path: string; display_name: string }> = [];
    for (const document of documents) {
      const path = String(document.doc_path || '');
      const displayName = String(document.display_name || 'Universe结果.docx');
      const qa = await this.dependencies.verifyDocument(path);
      if (!Number.isInteger(qa.bytes) || qa.bytes < 1 || qa.bytes > 19 * 1024 * 1024
        || !/^[0-9a-f]{64}$/.test(qa.sha256)) {
        throw new Error('artifact_document_qa_failed');
      }
      registered.push({ path, display_name: displayName });
    }
    const group = this.dependencies.registerDocuments(
      request.client_run_id, request.request_id, registered
    );
    if (typeof group.artifact_ref !== 'string' || !Number.isInteger(group.size_bytes)
      || !/^[0-9a-f]{64}$/.test(String(group.sha256 || ''))
      || !Array.isArray(group.parts) || group.parts.length !== registered.length) {
      throw new Error('artifact_document_registration_invalid');
    }
    return { artifact_ref: group.artifact_ref, size_bytes: group.size_bytes,
      sha256: group.sha256, render_status: 'passed', parts: group.parts.length };
  }
}
