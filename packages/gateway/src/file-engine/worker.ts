import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ArtifactService } from '../artifacts/service.ts';
import type { FileEngineAdapter, FileEngineResult } from './engine.ts';
import type { FileJobService } from './jobs.ts';

export class FileEngineWorker {
  private readonly jobs: FileJobService;
  private readonly artifacts: ArtifactService;
  private readonly engine: Pick<FileEngineAdapter, 'run'>;
  private readonly options: { workerId: string; workRoot: string; leaseSeconds?: number };
  constructor(jobs: FileJobService, artifacts: ArtifactService, engine: Pick<FileEngineAdapter, 'run'>,
    options: { workerId: string; workRoot: string; leaseSeconds?: number }) {
    this.jobs = jobs; this.artifacts = artifacts; this.engine = engine; this.options = options;
  }

  async processNext(): Promise<boolean> {
    const job = this.jobs.claim(this.options.workerId, this.options.leaseSeconds ?? 180);
    if (!job) return false;
    const directory = join(this.options.workRoot, String(job.job_id)); mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const operation = String(job.operation); const request = job.request as Record<string, any>;
      const inputSuffix = new Map([
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
        ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
        ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
        ['application/vnd.ms-excel', '.xls'],
        ['application/pdf', '.pdf'],
      ]).get(String(job.mime_type));
      let engineInput = String(job.server_path);
      const readOnlyOperation = ['document.inspect', 'document.read'].includes(operation);
      let sourceIdentity: Record<string, unknown> | undefined;
      if (readOnlyOperation) {
        const source = this.artifacts.download(String(job.artifact_id), String(job.owner_id), Number(job.base_version));
        const content = source.verified_content instanceof Buffer
          ? source.verified_content : readFileSync(String(source.server_path));
        const digest = createHash('sha256').update(content).digest('hex');
        if (Number(source.version) !== Number(job.base_version) || String(source.sha256) !== String(job.base_sha256)
          || content.length !== Number(source.size_bytes) || digest !== String(job.base_sha256)) {
          throw new Error('FILE_SOURCE_INTEGRITY_FAILED');
        }
        if (operation === 'document.inspect' && content.length > 20 * 1024 * 1024) {
          throw new Error('DOCUMENT_PREVIEW_TOO_LARGE');
        }
        engineInput = join(directory, `input${inputSuffix || '.bin'}`);
        writeFileSync(engineInput, content, { flag: 'wx', mode: 0o600 });
        sourceIdentity = { artifact_id: String(job.artifact_id), version: Number(job.base_version), sha256: String(job.base_sha256) };
      } else {
        const suffix = extname(engineInput) || inputSuffix || '.bin';
        engineInput = join(directory, `input${suffix}`);
        copyFileSync(String(job.server_path), engineInput);
      }
      const requestedFormat = String(request.save_as?.format || '').toLowerCase();
      const outputExtension = /^[a-z0-9]{1,8}$/.test(requestedFormat)
        ? `.${requestedFormat}` : extname(String(job.server_path)) || '.bin';
      const output = join(directory, `output${outputExtension}`);
      const result = await this.engine.run({ operation, input_path: engineInput,
        ...(operation.startsWith('document.') && ['document.inspect', 'document.read'].includes(operation) ? {} : { output_path: output }),
        media_type: String(job.mime_type), job_dir: directory, request });
      if (!result.ok) throw new Error(result.error_code || 'ENGINE_CRASH');
      if (result.output_path) {
        if (!existsSync(result.output_path) || result.checks?.saved_and_reopened === 'FAIL') throw new Error('OUTPUT_CHECK_FAILED');
        const published = this.artifacts.registerEditedVersion({ artifactId: String(job.artifact_id),
          ownerId: String(job.owner_id), conversationId: String(job.conversation_id), baseVersion: Number(job.base_version),
          baseSha256: String(job.base_sha256), sourcePath: result.output_path,
          engine: result.engine, checks: result.checks ?? {}, warnings: result.warnings ?? [] });
        this.jobs.complete(String(job.job_id), Number(job.generation), { ...result, output_path: undefined, artifact: published }, Number(published.version));
      } else this.jobs.complete(String(job.job_id), Number(job.generation), {
        ...result, ...(sourceIdentity ? { source: sourceIdentity } : {}),
      });
    } catch (error) {
      this.jobs.fail(String(job.job_id), Number(job.generation), error instanceof Error ? error.message : 'ENGINE_CRASH');
    } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
    return true;
  }
}
