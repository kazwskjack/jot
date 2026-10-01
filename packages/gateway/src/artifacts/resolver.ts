import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface ResolvedAttachment {
  artifactId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  localPath: string;
  kind: 'image' | 'text' | 'document' | 'file';
  version?: number;
}

export class AttachmentResolver {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly limits: { maxCount: number; maxAggregateBytes: number; leaseMs: number };
  constructor(db: DatabaseSync, root: string,
    limits: { maxCount: number; maxAggregateBytes: number; leaseMs?: number } = {
      maxCount: 10, maxAggregateBytes: 200 * 1024 * 1024, leaseMs: 30 * 60 * 1000,
    }) {
    this.db = db; this.root = root;
    this.limits = { ...limits, leaseMs: limits.leaseMs ?? 30 * 60 * 1000 };
  }

  resolveForMessage(ownerId: string, conversationId: string, artifactIds: string[], leaseId: string): ResolvedAttachment[] {
    if (!leaseId) throw new Error('attachment_lease_invalid');
    if (!artifactIds.length || artifactIds.length > this.limits.maxCount) throw new Error('attachment_count_invalid');
    const root = resolve(this.root);
    const resolved: ResolvedAttachment[] = [];
    let total = 0;
    for (const artifactId of artifactIds) {
      const row = this.db.prepare(`SELECT a.id,a.kind,a.current_version,v.server_path,v.sha256,v.size_bytes,v.mime_type,v.metadata_json,
        COALESCE(ar.local_state,'present') local_state
        FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
        LEFT JOIN ga_artifact_archives ar ON ar.artifact_id=a.id
        WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(artifactId, ownerId, conversationId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('artifact_not_found');
      const metadata = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
      if (metadata.status !== 'ready') throw new Error('attachment_not_ready');
      if (row.local_state !== 'present') throw new Error('attachment_restore_required');
      const localPath = resolve(String(row.server_path));
      if (localPath === root || !localPath.startsWith(root + sep)) throw new Error('attachment_path_denied');
      if (!existsSync(localPath)) throw new Error('attachment_local_missing');
      const sizeBytes = Number(row.size_bytes); total += sizeBytes;
      if (total > this.limits.maxAggregateBytes) throw new Error('attachment_aggregate_size_invalid');
      const mediaType = String(row.mime_type);
      const kind = mediaType.startsWith('image/') && mediaType !== 'image/svg+xml' ? 'image'
        : mediaType.startsWith('text/') || ['application/json','application/xml'].includes(mediaType) ? 'text'
        : mediaType === 'application/pdf' || /officedocument|msword|excel|powerpoint/.test(mediaType) ? 'document' : 'file';
      resolved.push({ artifactId, displayName: String(metadata.file_name || artifactId), mediaType,
        sizeBytes, sha256: String(row.sha256), localPath, kind, version: Number(row.current_version) });
    }
    const now = new Date(); const expires = new Date(now.getTime() + this.limits.leaseMs).toISOString();
    const insert = this.db.prepare('INSERT OR REPLACE INTO ga_artifact_leases(artifact_id,lease_id,expires_at,created_at) VALUES(?,?,?,?)');
    for (const item of resolved) insert.run(item.artifactId, leaseId, expires, now.toISOString());
    return resolved;
  }

  resolveOutputs(ownerId: string, conversationId: string, artifactIds: string[],
    presentedFiles: Array<{ path: string; description?: string }>, leaseId: string): ResolvedAttachment[] {
    if (!leaseId) throw new Error('attachment_lease_invalid');
    const root = resolve(this.root);
    const ids = [...artifactIds];
    const hasTrustedArtifactRefs = artifactIds.length > 0;
    if (presentedFiles.length) {
      const rows = this.db.prepare(`SELECT a.id,v.server_path FROM ga_artifacts a
        JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
        WHERE a.owner_id=? AND a.conversation_id=?`).all(ownerId, conversationId) as Array<Record<string, unknown>>;
      for (const file of presentedFiles) {
        const presentedPath = resolve(String(file.path || ''));
        if (presentedPath === root || !presentedPath.startsWith(root + sep)) {
          if (hasTrustedArtifactRefs) continue;
          throw new Error('presented_file_path_denied');
        }
        const matched = rows.find(item => resolve(String(item.server_path)) === presentedPath);
        if (!matched) {
          if (hasTrustedArtifactRefs) continue;
          throw new Error('presented_file_not_registered');
        }
        ids.push(String(matched.id));
      }
    }
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) throw new Error('output_attachment_missing');
    return this.resolveForMessage(ownerId, conversationId, uniqueIds, leaseId);
  }

  releaseLease(leaseId: string): void {
    this.db.prepare('DELETE FROM ga_artifact_leases WHERE lease_id=?').run(leaseId);
  }
}
