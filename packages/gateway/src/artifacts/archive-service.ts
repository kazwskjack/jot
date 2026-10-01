import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export interface RemoteFileMeta { size: number; md5: string }
export interface ArtifactArchiveClient {
  mkdir(path: string): Promise<void>
  upload(localPath: string, remoteDirectory: string, remoteName: string): Promise<void>
  meta(path: string): Promise<RemoteFileMeta | null>
  download(remotePath: string, localPath: string): Promise<void>
}

type ArchiveFile = { localPath: string; remoteName: string; size: number; md5: string }

function safeName(value: string): string {
  const cleaned = value.normalize('NFKC').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || 'file').slice(0, 120)
}

async function md5(path: string): Promise<string> {
  const digest = createHash('md5')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

export class ArtifactArchiveService {
  private readonly db: DatabaseSync
  private readonly root: string
  private readonly client: ArtifactArchiveClient
  constructor(db: DatabaseSync, root: string, client: ArtifactArchiveClient) {
    this.db = db; this.root = root; this.client = client
  }

  async archivePending(now = new Date()): Promise<{ attempted: number; verified: number; failed: number }> {
    const rows = this.db.prepare(`SELECT ar.artifact_id,a.created_at FROM ga_artifact_archives ar
      JOIN ga_artifacts a ON a.id=ar.artifact_id
      WHERE ar.local_state='present' AND ar.backup_status IN ('pending','retry')
      AND (ar.next_retry_at IS NULL OR ar.next_retry_at<=?) ORDER BY a.created_at LIMIT 500`)
      .all(now.toISOString()) as Array<Record<string, unknown>>
    let verified = 0; let failed = 0
    for (const row of rows) {
      const artifactId = String(row.artifact_id)
      try {
        const date = new Date(String(row.created_at)); const remoteDirectory = `/jot_file/${date.getUTCFullYear()}/${String(date.getUTCMonth()+1).padStart(2,'0')}/${String(date.getUTCDate()).padStart(2,'0')}/${artifactId}`
        const files = await this.files(artifactId)
        await this.client.mkdir(remoteDirectory)
        const manifest = []
        for (const file of files) {
          const remotePath = `${remoteDirectory}/${file.remoteName}`
          let remote = await this.client.meta(remotePath)
          // A retry may already have uploaded the correct bytes. Verify that
          // object first instead of producing another provider-side copy.
          if (!remote || remote.size !== file.size) {
            await this.client.upload(file.localPath, remoteDirectory, file.remoteName)
            remote = await this.client.meta(remotePath)
          }
          await this.verifyRemote(file, remotePath, remote)
          manifest.push({ remote_name: file.remoteName, local_path: file.localPath, size: file.size, md5: file.md5 })
        }
        const total = files.reduce((sum, file) => sum + file.size, 0); const stamp = now.toISOString()
        this.db.prepare(`UPDATE ga_artifact_archives SET backup_status='verified',remote_path=?,remote_size=?,remote_md5=?,
          verified_at=?,attempts=attempts+1,last_error=NULL,next_retry_at=NULL,updated_at=? WHERE artifact_id=?`)
          .run(remoteDirectory, total, JSON.stringify(manifest), stamp, stamp, artifactId)
        verified += 1
      } catch (error) {
        const current = this.db.prepare('SELECT attempts FROM ga_artifact_archives WHERE artifact_id=?').get(artifactId) as { attempts: number }
        const attempts = Number(current.attempts) + 1; const minutes = Math.min(360, 2 ** Math.min(attempts, 8))
        this.db.prepare(`UPDATE ga_artifact_archives SET backup_status='retry',attempts=?,last_error=?,next_retry_at=?,updated_at=? WHERE artifact_id=?`)
          .run(attempts, String(error instanceof Error ? error.message : error).slice(0, 240),
            new Date(now.getTime()+minutes*60_000).toISOString(), now.toISOString(), artifactId)
        failed += 1
      }
    }
    return { attempted: rows.length, verified, failed }
  }

  private async verifyRemote(file: ArchiveFile, remotePath: string, remote: RemoteFileMeta | null): Promise<void> {
    if (!remote || remote.size !== file.size) throw new Error('archive_remote_verification_failed')
    if (remote.md5.toLowerCase() === file.md5) return
    // Baidu multipart metadata may not contain the hash of the actual bytes.
    // Never waive verification: download an isolated copy and hash it locally.
    const stagingRoot = join(this.root, 'sessions', 'archive-verify')
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
    const stage = mkdtempSync(join(stagingRoot, 'verify-'))
    const downloaded = join(stage, 'content')
    try {
      await this.client.download(remotePath, downloaded)
      if (!existsSync(downloaded) || statSync(downloaded).size !== file.size || await md5(downloaded) !== file.md5) {
        throw new Error('archive_remote_verification_failed')
      }
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }

  cleanupVerified(now = new Date(), retentionHours = 24): { eligible: number; deleted: number } {
    const cutoff = new Date(now.getTime() - Math.max(24, retentionHours) * 3600_000).toISOString()
    const rows = this.db.prepare(`SELECT ar.artifact_id,ar.remote_md5 FROM ga_artifact_archives ar
      JOIN ga_artifacts a ON a.id=ar.artifact_id
      WHERE ar.backup_status='verified' AND ar.local_state='present' AND a.created_at<=?
      AND NOT EXISTS(SELECT 1 FROM ga_artifact_leases l WHERE l.artifact_id=ar.artifact_id AND l.expires_at>?)`)
      .all(cutoff, now.toISOString()) as Array<Record<string, unknown>>
    let deleted = 0; const root = resolve(this.root)
    for (const row of rows) {
      const manifest = JSON.parse(String(row.remote_md5 || '[]')) as Array<{ local_path: string }>
      if (!Array.isArray(manifest) || !manifest.length) continue
      for (const item of manifest) {
        const path = resolve(item.local_path)
        if (path === root || !path.startsWith(root + sep)) throw new Error('archive_cleanup_path_denied')
        if (existsSync(path)) rmSync(path, { force: true })
        const parent = dirname(path); if (parent !== root && parent.startsWith(root + sep)) {
          try { rmSync(parent, { recursive: false }) } catch { /* shared or non-empty directory */ }
        }
      }
      const stamp = now.toISOString()
      this.db.prepare(`UPDATE ga_artifact_archives SET local_state='deleted',local_deleted_at=?,updated_at=? WHERE artifact_id=?`)
        .run(stamp, stamp, String(row.artifact_id))
      deleted += 1
    }
    this.db.prepare('DELETE FROM ga_artifact_leases WHERE expires_at<=?').run(now.toISOString())
    return { eligible: rows.length, deleted }
  }

  async restorePending(now = new Date()): Promise<{ attempted: number; restored: number; failed: number }> {
    const rows = this.db.prepare(`SELECT artifact_id,remote_path,remote_md5 FROM ga_artifact_archives
      WHERE backup_status='verified' AND local_state='restoring' ORDER BY updated_at LIMIT 50`)
      .all() as Array<Record<string, unknown>>
    let restored = 0; let failed = 0
    for (const row of rows) {
      try {
        const directory = String(row.remote_path || ''); const manifest = JSON.parse(String(row.remote_md5 || '[]')) as
          Array<{ remote_name: string; local_path: string; size: number; md5: string }>
        if (!directory.startsWith('/jot_file/') || !manifest.length) throw new Error('archive_restore_manifest_invalid')
        for (const item of manifest) {
          const localPath = resolve(item.local_path); const root = resolve(this.root)
          if (localPath === root || !localPath.startsWith(root + sep)) throw new Error('archive_restore_path_denied')
          mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 })
          await this.client.download(`${directory}/${item.remote_name}`, localPath)
          if (!existsSync(localPath) || statSync(localPath).size !== item.size || await md5(localPath) !== item.md5) {
            throw new Error('archive_restore_verification_failed')
          }
        }
        const stamp = now.toISOString(); this.db.prepare(`UPDATE ga_artifact_archives SET local_state='present',restored_at=?,
          last_used_at=?,last_error=NULL,updated_at=? WHERE artifact_id=? AND local_state='restoring'`)
          .run(stamp, stamp, stamp, String(row.artifact_id)); restored += 1
      } catch (error) {
        this.db.prepare(`UPDATE ga_artifact_archives SET local_state='deleted',last_error=?,updated_at=? WHERE artifact_id=?`)
          .run(String(error instanceof Error ? error.message : error).slice(0,240), now.toISOString(), String(row.artifact_id)); failed += 1
      }
    }
    return { attempted: rows.length, restored, failed }
  }

  private async files(artifactId: string): Promise<ArchiveFile[]> {
    const partRows = this.db.prepare(`SELECT server_path,display_name,size_bytes FROM ga_artifact_parts
      WHERE artifact_id=? ORDER BY part_index`).all(artifactId) as Array<Record<string, unknown>>
    const rows = partRows.length ? partRows : this.db.prepare(`SELECT v.server_path,v.size_bytes,
      json_extract(v.metadata_json,'$.file_name') display_name FROM ga_artifact_versions v
      JOIN ga_artifacts a ON a.id=v.artifact_id AND a.current_version=v.version WHERE v.artifact_id=?`)
      .all(artifactId) as Array<Record<string, unknown>>
    if (!rows.length) throw new Error('archive_files_missing')
    const names = new Set<string>(); const result: ArchiveFile[] = []
    for (const [index, row] of rows.entries()) {
      const localPath = resolve(String(row.server_path)); const root = resolve(this.root)
      if (localPath === root || !localPath.startsWith(root + sep) || !existsSync(localPath)) throw new Error('archive_local_file_missing')
      let remoteName = safeName(String(row.display_name || `part-${index+1}`))
      if (names.has(remoteName)) remoteName = `${String(index+1).padStart(3,'0')}-${remoteName}`
      names.add(remoteName)
      result.push({ localPath, remoteName, size: Number(row.size_bytes), md5: await md5(localPath) })
    }
    return result
  }
}
