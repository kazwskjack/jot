import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync,lstatSync,renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts'
import {artifactArchiveReferences,artifactArchiveManifest} from './archive-references.ts'
import {signature,currentFileHashes} from './file-integrity.ts'

export interface RemoteFileMeta { size: number; md5: string }
export interface ArtifactArchiveClient {
  mkdir(path: string): Promise<void>
  upload(localPath: string, remoteDirectory: string, remoteName: string): Promise<void>
  meta(path: string): Promise<RemoteFileMeta | null>
  download(remotePath: string, localPath: string): Promise<void>
}

type ArchiveFile = { localPath: string; remoteName: string; size: number; md5: string; sha256: string }

function safeName(value: string): string {
  const cleaned = value.normalize('NFKC').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || 'file').slice(0, 120)
}

async function fileHash(path: string,algorithm='md5'): Promise<string> {
  const digest = createHash(algorithm)
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
const md5=(path:string)=>fileHash(path)
function assertArchivePath(path:string,root:string):void{
 const absolute=resolve(path),boundary=resolve(root);
 if(absolute===boundary||!absolute.startsWith(boundary+sep))throw new Error('archive_path_denied')
 for(let current=absolute;;){
  if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('archive_path_unsafe')
  const parent=dirname(current);if(parent===current)break;current=parent
 }
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
    // Legacy verified manifests are upgraded before they can authorize historical cleanup.
    if (rows.length < 500) {
      const legacy = this.db.prepare(`SELECT ar.artifact_id,ar.remote_md5,a.created_at FROM ga_artifact_archives ar
        JOIN ga_artifacts a ON a.id=ar.artifact_id WHERE ar.backup_status='verified' AND ar.local_state='present'
        AND (ar.next_retry_at IS NULL OR ar.next_retry_at<=?) ORDER BY a.created_at`).iterate(now.toISOString())
      for (const row of legacy) {
        if (!artifactArchiveManifest(this.fileRows(String(row.artifact_id)),String(row.remote_md5))) rows.push(row)
        if (rows.length === 500) break
      }
    }
    let verified = 0; let failed = 0
    for (const row of rows) {
      const artifactId = String(row.artifact_id)
      const source = this.archiveSource(artifactId)
      if (!source || source.record.local_state !== 'present' || !['pending','retry','verified'].includes(String(source.record.backup_status))
        || source.record.next_retry_at && String(source.record.next_retry_at) > now.toISOString()) continue
      if (source.record.backup_status === 'verified' && artifactArchiveManifest(source.files,String(source.record.remote_md5))) continue
      const identity = JSON.stringify(source)
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
          manifest.push({ remote_name: file.remoteName, local_path: file.localPath, size: file.size, md5: file.md5, sha256: file.sha256 })
        }
        const encoded = JSON.stringify(manifest)
        const proof = this.verifiedCleanupPaths(artifactId, encoded)
        if (!proof) throw new Error('archive_local_content_mismatch')
        const total = files.reduce((sum, file) => sum + file.size, 0); const stamp = now.toISOString()
        const saved = withImmediateTransaction(this.db, () => {
          if (JSON.stringify(this.archiveSource(artifactId)) !== identity || !this.sameFiles(proof.files)) return false
          this.db.prepare(`UPDATE ga_artifact_archives SET backup_status='verified',remote_path=?,remote_size=?,remote_md5=?,
            verified_at=?,attempts=attempts+1,last_error=NULL,next_retry_at=NULL,updated_at=? WHERE artifact_id=?`)
            .run(remoteDirectory, total, encoded, stamp, stamp, artifactId)
          return true
        })
        if (saved) verified += 1
      } catch (error) {
        const saved = withImmediateTransaction(this.db, () => {
          if (JSON.stringify(this.archiveSource(artifactId)) !== identity) return false
          const attempts = Number(source.record.attempts) + 1; const minutes = Math.min(360, 2 ** Math.min(attempts, 8))
          this.db.prepare(`UPDATE ga_artifact_archives SET backup_status=?,attempts=?,last_error=?,next_retry_at=?,updated_at=? WHERE artifact_id=?`)
            .run(source.record.backup_status === 'verified' ? 'verified' : 'retry', attempts, String(error instanceof Error ? error.message : error).slice(0, 240),
              new Date(now.getTime()+minutes*60_000).toISOString(), now.toISOString(), artifactId)
          return true
        })
        if (saved) failed += 1
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
    assertArchivePath(stagingRoot,this.root)
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
      // Hash complete content outside SQLite writer admission. Frozen references
      // and file identities are rechecked in the short removal transaction.
      const proof=this.verifiedCleanupPaths(String(row.artifact_id),String(row.remote_md5))
      if(!proof)continue
      const didDelete=withImmediateTransaction(this.db,()=>{
        // The earlier candidate/content read is not deletion authority.
        const current=this.db.prepare(`SELECT ar.remote_md5 FROM ga_artifact_archives ar
          JOIN ga_artifacts a ON a.id=ar.artifact_id WHERE ar.artifact_id=?
          AND ar.backup_status='verified' AND ar.local_state='present' AND a.created_at<=?
          AND NOT EXISTS(SELECT 1 FROM ga_artifact_leases l WHERE l.artifact_id=ar.artifact_id AND l.expires_at>?)`)
          .get(String(row.artifact_id),cutoff,now.toISOString()) as {remote_md5:string}|undefined
        if(!current||current.remote_md5!==row.remote_md5
          ||JSON.stringify(this.fileRows(String(row.artifact_id)))!==proof.references)return false
        for(const file of proof.files){
          assertArchivePath(file.path,this.root)
          const now=lstatSync(file.path)
          if(!now.isFile()||now.isSymbolicLink()||JSON.stringify(signature(now))!==JSON.stringify(file.signature))return false
        }
        for (const {path} of proof.files) {
          if (path === root || !path.startsWith(root + sep)) throw new Error('archive_cleanup_path_denied')
          rmSync(path, { force: true })
          const parent = dirname(path); if (parent !== root && parent.startsWith(root + sep)) {
            try { rmSync(parent, { recursive: false }) } catch { /* shared or non-empty directory */ }
          }
        }
        const stamp = now.toISOString()
        this.db.prepare(`UPDATE ga_artifact_archives SET local_state='deleted',local_deleted_at=?,updated_at=? WHERE artifact_id=?`)
          .run(stamp, stamp, String(row.artifact_id))
        return true
      })
      if(didDelete)deleted += 1
    }
    this.db.prepare('DELETE FROM ga_artifact_leases WHERE expires_at<=?').run(now.toISOString())
    return { eligible: rows.length, deleted }
  }

  async restorePending(now = new Date()): Promise<{ attempted: number; restored: number; failed: number }> {
    const rows = this.db.prepare(`SELECT artifact_id FROM ga_artifact_archives
      WHERE (backup_status='verified' OR verified_at IS NOT NULL) AND remote_path IS NOT NULL
      AND local_state='restoring' ORDER BY updated_at LIMIT 50`)
      .all() as Array<Record<string, unknown>>
    let restored = 0; let failed = 0
    for (const row of rows) {
      const artifactId = String(row.artifact_id), source = this.archiveSource(artifactId)
      if (!source || (source.record.backup_status !== 'verified' && !source.record.verified_at) || source.record.local_state !== 'restoring') continue
      const identity = JSON.stringify(source)
      const stages:string[]=[]
      try {
        const directory = String(source.record.remote_path || '')
        const manifest = artifactArchiveManifest(source.files,String(source.record.remote_md5 || '[]'),[])
        if (!directory.startsWith('/jot_file/') || !manifest) throw new Error('archive_restore_manifest_invalid')
        const installs: Array<{path:string;staged:string;stagedSignature:ReturnType<typeof signature>;existing:ReturnType<typeof signature>|null;replace:boolean}> = []
        for (const item of manifest) {
          const localPath = item.local_path
          assertArchivePath(localPath,this.root)
          mkdirSync(dirname(localPath),{recursive:true,mode:0o700})
          assertArchivePath(localPath,this.root)
          const stage=mkdtempSync(join(dirname(localPath),'.jot-restore-'))
          stages.push(stage);assertArchivePath(stage,this.root)
          const staged = join(stage,'content')
          await this.client.download(`${directory}/${item.remote_name}`,staged)
          assertArchivePath(staged,this.root)
          const hash = currentFileHashes(staged)
          if (!hash || hash.size !== item.size || hash.md5 !== item.md5.toLowerCase() || hash.sha256 !== item.sha256) throw new Error('archive_restore_verification_failed')
          const existing = existsSync(localPath) ? currentFileHashes(localPath) : null
          if (existsSync(localPath) && !existing) throw new Error('archive_restore_destination_conflict')
          installs.push({path:localPath,staged,stagedSignature:hash.signature,existing:existing?.signature ?? null,replace:!existing || existing.size !== item.size || existing.sha256 !== item.sha256})
        }
        const saved = withImmediateTransaction(this.db, () => {
          if (JSON.stringify(this.archiveSource(artifactId)) !== identity) return false
          for (const item of installs) {
            assertArchivePath(item.path,this.root)
            if (item.existing) {
              if (!this.sameFiles([{path:item.path,signature:item.existing}])) throw new Error('archive_restore_destination_conflict')
            } else if (existsSync(item.path)) throw new Error('archive_restore_destination_conflict')
            if (item.replace) {
              if (!this.sameFiles([{path:item.staged,signature:item.stagedSignature}])) throw new Error('archive_restore_verification_failed')
              mkdirSync(dirname(item.path),{recursive:true,mode:0o700})
              assertArchivePath(item.path,this.root)
              renameSync(item.staged,item.path)
            }
          }
          const stamp = now.toISOString()
          this.db.prepare(`UPDATE ga_artifact_archives SET local_state='present',restored_at=?,last_used_at=?,last_error=NULL,next_retry_at=NULL,updated_at=? WHERE artifact_id=?`)
            .run(stamp,stamp,stamp,artifactId)
          return true
        })
        if (saved) restored += 1
      } catch (error) {
        const saved = withImmediateTransaction(this.db, () => {
          if (JSON.stringify(this.archiveSource(artifactId)) !== identity) return false
          this.db.prepare(`UPDATE ga_artifact_archives SET local_state='deleted',last_error=?,updated_at=? WHERE artifact_id=?`)
            .run(String(error instanceof Error ? error.message : error).slice(0,240),now.toISOString(),artifactId)
          return true
        })
        if (saved) failed += 1
      } finally {
        for(const stage of stages){assertArchivePath(stage,this.root);rmSync(stage,{recursive:true,force:true})}
      }
    }
    return { attempted: rows.length, restored, failed }
  }

  private archiveSource(artifactId:string) {
    return withReadTransaction(this.db, () => {
      const record = this.db.prepare(`SELECT ar.*,a.current_version FROM ga_artifact_archives ar
        JOIN ga_artifacts a ON a.id=ar.artifact_id WHERE ar.artifact_id=?`).get(artifactId) as Record<string,unknown>|undefined
      return record ? {record,files:this.fileRows(artifactId)} : undefined
    })
  }

  private sameFiles(files:Array<{path:string;signature:ReturnType<typeof signature>}>):boolean {
    return files.every(file => {
      assertArchivePath(file.path,this.root)
      if (!existsSync(file.path)) return false
      const current = lstatSync(file.path)
      return current.isFile() && !current.isSymbolicLink() && JSON.stringify(signature(current)) === JSON.stringify(file.signature)
    })
  }

  private fileRows(artifactId:string) {
    return artifactArchiveReferences(this.db,artifactId)
  }

  private verifiedCleanupPaths(artifactId:string,encoded:string):{files:Array<{path:string;signature:ReturnType<typeof signature>}>;references:string}|null{
    const rows=this.fileRows(artifactId),manifest=artifactArchiveManifest(rows,encoded)
    if(!manifest)return null
    const files:Array<{path:string;signature:ReturnType<typeof signature>}>=[]
    for(const item of manifest){
      const path=item.local_path
      assertArchivePath(path,this.root)
      if(!existsSync(path))return null
      const hash=currentFileHashes(path)
      if(!hash||hash.size!==item.size||hash.sha256!==item.sha256||hash.md5!==item.md5)return null
      files.push({path,signature:hash.signature})
    }
    return {files,references:JSON.stringify(rows)}
  }

  private async files(artifactId: string): Promise<ArchiveFile[]> {
    const rows=this.fileRows(artifactId)
    if (!rows.length) throw new Error('archive_files_missing')
    const names = new Set<string>(); const result: ArchiveFile[] = []
    for (const [index, row] of rows.entries()) {
      const localPath = resolve(String(row.server_path)); const root = resolve(this.root)
      if (localPath === root || !localPath.startsWith(root + sep) || !existsSync(localPath)) throw new Error('archive_local_file_missing')
      assertArchivePath(localPath,this.root)
      if(statSync(localPath).size!==Number(row.size_bytes)||await fileHash(localPath,'sha256')!==row.sha256)throw new Error('archive_local_content_mismatch')
      let remoteName = `${String(row.sha256)}-${safeName(String(row.display_name || `part-${index+1}`))}`
      if (names.has(remoteName)) remoteName = `${String(index+1).padStart(3,'0')}-${remoteName}`
      names.add(remoteName)
      result.push({ localPath, remoteName, size: Number(row.size_bytes), md5: await md5(localPath), sha256: String(row.sha256) })
    }
    return result
  }
}
