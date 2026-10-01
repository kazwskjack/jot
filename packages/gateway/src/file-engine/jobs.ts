import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import { validateFileOperationRequest, type FileOperationRequest } from './contracts.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class FileJobService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, now = () => Date.now()) { this.db = db; this.now = now; }

  enqueue(ownerId: string, conversationId: string, artifactId: string,
    input: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
    if (!/^[\x21-\x7E]{8,128}$/.test(idempotencyKey)) throw new Error('FILE_REQUEST_INVALID');
    const request = validateFileOperationRequest(input);
    const version = this.db.prepare(`SELECT a.current_version,v.sha256,v.server_path,v.mime_type,v.metadata_json
      FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=?
      WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(
        request.base_version, artifactId, ownerId, conversationId) as Record<string, unknown> | undefined;
    if (!version) {
      const owned = this.db.prepare('SELECT current_version FROM ga_artifacts WHERE id=? AND owner_id=? AND conversation_id=?')
        .get(artifactId, ownerId, conversationId) as { current_version?: number } | undefined;
      if (!owned) throw new Error('UNAUTHORIZED_FILE');
      throw new Error('STALE_FILE_VERSION');
    }
    if (Number(version.current_version) !== request.base_version || String(version.sha256) !== request.base_sha256) {
      throw new Error('STALE_FILE_VERSION');
    }
    const requestJson = canonical(request);
    const digest = createHash('sha256').update(requestJson).digest('hex');
    const existing = this.db.prepare('SELECT * FROM ga_file_jobs WHERE owner_id=? AND idempotency_key=?')
      .get(ownerId, idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.request_sha256 !== digest) throw new Error('IDEMPOTENCY_CONFLICT');
      return this.public(existing);
    }
    const id = `file-job-${randomUUID()}`; const at = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO ga_file_jobs(id,owner_id,conversation_id,artifact_id,base_version,
      base_sha256,operation,request_json,request_sha256,idempotency_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, ownerId, conversationId, artifactId,
        request.base_version, request.base_sha256, request.operation, requestJson, digest,
        idempotencyKey, 'queued', at, at);
    return this.get(ownerId, id);
  }

  get(ownerId: string, jobId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM ga_file_jobs WHERE id=? AND owner_id=?').get(jobId, ownerId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('UNAUTHORIZED_FILE');
    return this.public(row);
  }

  claim(workerId: string, leaseSeconds: number): Record<string, any> | null {
    return withImmediateTransaction(this.db, () => {
      const now = this.now();
      const row = this.db.prepare(`SELECT j.*,v.server_path,v.mime_type,v.metadata_json
        FROM ga_file_jobs j JOIN ga_artifact_versions v ON v.artifact_id=j.artifact_id AND v.version=j.base_version
        WHERE j.status='queued' ORDER BY j.created_at,j.id LIMIT 1`).get() as Record<string, any> | undefined;
      if (!row) return null;
      const generation = Number(row.generation) + 1;
      const changed = this.db.prepare(`UPDATE ga_file_jobs SET status='running',generation=?,lease_owner=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND status='queued'`).run(generation, workerId, now + leaseSeconds * 1000,
          new Date(now).toISOString(), row.id).changes;
      return changed === 1 ? { ...row, job_id: row.id, status: 'running', generation,
        request: JSON.parse(String(row.request_json)) as FileOperationRequest } : null;
    });
  }

  complete(jobId: string, generation: number, result: Record<string, unknown>, outputVersion?: number): void {
    const changed = this.db.prepare(`UPDATE ga_file_jobs SET status='completed',result_json=?,output_version=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND generation=?`)
      .run(JSON.stringify(result), outputVersion ?? null, new Date(this.now()).toISOString(), jobId, generation).changes;
    if (changed !== 1) throw new Error('FILE_JOB_FENCE_LOST');
  }

  fail(jobId: string, generation: number, errorCode: string): void {
    this.db.prepare(`UPDATE ga_file_jobs SET status='failed',error_code=?,lease_owner=NULL,lease_expires_at=NULL,
      updated_at=? WHERE id=? AND status='running' AND generation=?`)
      .run(errorCode.slice(0, 96), new Date(this.now()).toISOString(), jobId, generation);
  }

  private public(row: Record<string, unknown>): Record<string, unknown> {
    return { job_id: row.id, artifact_ref: row.artifact_id, operation: row.operation,
      status: row.status, base_version: Number(row.base_version), output_version: row.output_version ?? null,
      result: row.result_json ? JSON.parse(String(row.result_json)) : null,
      error_code: row.error_code ?? null, created_at: row.created_at, updated_at: row.updated_at };
  }
}
