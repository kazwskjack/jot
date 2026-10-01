import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';

export interface ProjectedArtifactRequest {
  request_id: string;
  run_id: string;
  client_run_id: string;
  requirement_id: string;
  result_refs: string[];
  source_results: Array<Record<string, unknown>>;
  format: string;
  template: string;
  status: string;
  created_at: string;
}

export interface GeneratedArtifactReceipt {
  artifact_ref: string;
  size_bytes: number;
  sha256: string;
  render_status: 'passed' | 'verified';
  parts: number;
}

export class ArtifactRequestService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
  }

  enqueueProjected(input: ProjectedArtifactRequest): Record<string, any> {
    if (!/^artifact-request:[0-9a-z._:-]{1,128}$/i.test(input.request_id)
      || !input.client_run_id.trim() || !input.requirement_id.trim()
      || !Array.isArray(input.result_refs) || input.result_refs.length < 1
      || input.result_refs.some(item => typeof item !== 'string' || !item.trim())
      || !Array.isArray(input.source_results)
      || !['docx', 'md', 'pdf'].includes(input.format)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.template)) {
      throw new Error('projected_artifact_request_invalid');
    }
    const refs = JSON.stringify(input.result_refs);
    const sources = JSON.stringify(input.source_results);
    if (Buffer.byteLength(sources, 'utf8') > 8 * 1024 * 1024) {
      throw new Error('projected_artifact_payload_too_large');
    }
    const now = new Date(this.now() * 1000).toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO ga_artifact_requests(
      request_id,runtime_run_id,client_run_id,requirement_id,result_refs_json,
      source_results_json,format,template,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`).run(input.request_id, input.run_id,
      input.client_run_id, input.requirement_id, refs, sources, input.format,
      input.template, now, now);
    const row = this.get(input.request_id);
    if (row.runtime_run_id !== input.run_id || row.client_run_id !== input.client_run_id
      || row.requirement_id !== input.requirement_id || row.result_refs_json !== refs
      || row.source_results_json !== sources || row.format !== input.format
      || row.template !== input.template) {
      throw new Error('projected_artifact_request_conflict');
    }
    return row;
  }

  claim(owner: string, leaseSeconds: number): Record<string, any> | null {
    if (!owner || !Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new Error('artifact_lease_invalid');
    }
    return withImmediateTransaction(this.db, () => {
      const current = this.now();
      const stamp = new Date(current * 1000).toISOString();
      this.db.prepare(`UPDATE ga_artifact_requests SET status='outcome_unknown',
        last_reason_code='ARTIFACT_RENDER_OUTCOME_UNKNOWN',lease_owner=NULL,
        lease_expires_at=NULL,updated_at=?
        WHERE status='rendering' AND lease_expires_at<=?`).run(stamp, current);
      const row = this.db.prepare(`SELECT * FROM ga_artifact_requests
        WHERE status IN ('pending','receipt_pending')
          AND (lease_owner IS NULL OR lease_expires_at<=?)
        ORDER BY created_at,request_id LIMIT 1`).get(current) as Record<string, any> | undefined;
      if (!row) return null;
      const generation = Number(row.generation) + 1;
      const nextStatus = row.status === 'pending' ? 'rendering' : 'receipt_pending';
      this.db.prepare(`UPDATE ga_artifact_requests SET status=?,lease_owner=?,generation=?,
        lease_expires_at=?,updated_at=? WHERE request_id=?`).run(nextStatus, owner,
        generation, current + leaseSeconds, stamp, row.request_id);
      return { ...row, status: nextStatus, generation,
        phase: row.status === 'receipt_pending' ? 'receipt_only' : 'render',
        receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null };
    });
  }

  recordGenerated(requestId: string, generation: number, receipt: GeneratedArtifactReceipt): void {
    if (!receipt.artifact_ref.trim() || !Number.isInteger(receipt.size_bytes)
      || receipt.size_bytes < 1 || !/^[0-9a-f]{64}$/.test(receipt.sha256)
      || !['passed', 'verified'].includes(receipt.render_status)
      || !Number.isInteger(receipt.parts) || receipt.parts < 1) {
      throw new Error('artifact_receipt_invalid');
    }
    const changed = this.db.prepare(`UPDATE ga_artifact_requests
      SET status='receipt_pending',artifact_ref=?,receipt_json=?,lease_owner=NULL,
      lease_expires_at=NULL,updated_at=?
      WHERE request_id=? AND generation=? AND status='rendering'`).run(
        receipt.artifact_ref, JSON.stringify(receipt),
        new Date(this.now() * 1000).toISOString(), requestId, generation).changes;
    if (changed !== 1) throw new Error('artifact_lease_lost');
  }

  recordReceiptFailure(requestId: string, reasonCode: string): void {
    this.db.prepare(`UPDATE ga_artifact_requests SET status='receipt_pending',
      last_reason_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE request_id=? AND artifact_ref IS NOT NULL AND receipt_json IS NOT NULL`)
      .run(reasonCode, new Date(this.now() * 1000).toISOString(), requestId);
  }

  recordVerified(requestId: string): void {
    const changed = this.db.prepare(`UPDATE ga_artifact_requests SET status='verified',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE request_id=? AND status='receipt_pending' AND receipt_json IS NOT NULL`)
      .run(new Date(this.now() * 1000).toISOString(), requestId).changes;
    if (changed !== 1) throw new Error('artifact_receipt_not_ready');
  }

  get(requestId: string): Record<string, any> {
    const row = this.db.prepare('SELECT * FROM ga_artifact_requests WHERE request_id=?')
      .get(requestId) as Record<string, any> | undefined;
    if (!row) throw new Error('artifact_request_not_found');
    return row;
  }
}
