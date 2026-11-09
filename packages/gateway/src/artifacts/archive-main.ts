import { openProductDatabase } from '../db/database.ts'
import { ArtifactArchiveService } from './archive-service.ts'
import { BaiduPcsClient } from './baidu-client.ts'
import {ownArchiveWindowsJob,type ArchiveWindowsJob} from './archive-windows-job.ts'

const mode = process.argv[2] ?? ''
if (!['archive','cleanup','restore'].includes(mode)) throw new Error('usage: archive-main.js archive|cleanup|restore')
const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db'
const root = process.env.GENERAL_AGENT_FILE_ROOT?.trim() || '/var/lib/jot/jot-files'
const control=new AbortController()
const interrupt=()=>{process.exitCode=130;control.abort()}
const terminate=()=>{process.exitCode=143;control.abort()}
let windowsJob:ArchiveWindowsJob|undefined
process.once('SIGINT',interrupt);process.once('SIGTERM',terminate)
try {
  windowsJob=await ownArchiveWindowsJob(control.signal)
  control.signal.throwIfAborted()
  const db = openProductDatabase(databasePath)
  try {
    const service = new ArtifactArchiveService(db, root, new BaiduPcsClient(
      process.env.BAIDUPCS_EXECUTABLE?.trim() || '/usr/local/bin/BaiduPCS-Go', `${root}/sessions/archive-stage`))
    const result = mode === 'archive' ? await service.archivePending(undefined,control.signal)
      : mode === 'restore' ? await service.restorePending(undefined,control.signal) : service.cleanupVerified(new Date(), 24)
    if (Object.values(result).some(value => value > 0)) process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`)
    if ('failed' in result && result.failed > 0) process.exitCode = 1
  }finally {db.close()}
} catch(error){
  if(!control.signal.aborted||error!==control.signal.reason&&!(error instanceof Error&&error.name==='AbortError'))throw error
} finally {
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate)
  await windowsJob?.close()
}
