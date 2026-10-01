import { openProductDatabase } from '../db/database.ts'
import { ArtifactArchiveService } from './archive-service.ts'
import { BaiduPcsClient } from './baidu-client.ts'

const mode = process.argv[2] ?? ''
if (!['archive','cleanup','restore'].includes(mode)) throw new Error('usage: archive-main.js archive|cleanup|restore')
const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db'
const root = process.env.GENERAL_AGENT_FILE_ROOT?.trim() || '/var/lib/jot/jot-files'
const db = openProductDatabase(databasePath)
try {
  const service = new ArtifactArchiveService(db, root, new BaiduPcsClient(
    process.env.BAIDUPCS_EXECUTABLE?.trim() || '/usr/local/bin/BaiduPCS-Go', `${root}/sessions/archive-stage`))
  const result = mode === 'archive' ? await service.archivePending()
    : mode === 'restore' ? await service.restorePending() : service.cleanupVerified(new Date(), 24)
  if (Object.values(result).some(value => value > 0)) process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`)
  if ('failed' in result && result.failed > 0) process.exitCode = 1
} finally { db.close() }
