import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ArtifactArchiveClient, RemoteFileMeta } from './archive-service.ts'

export function parseBaiduMeta(output: string): RemoteFileMeta | null {
  const size = output.match(/^\s*文件大小\s+(\d+)(?:,|\s|$)/m)
  const md5 = output.match(/^\s*md5\b[^\n]*?\b([0-9a-f]{32})\b/im)
  return size?.[1] && md5?.[1] ? { size: Number(size[1]), md5: md5[1].toLowerCase() } : null
}

type CommandResult = { code: number; stdout: string; stderr: string }

export class BaiduPcsClient implements ArtifactArchiveClient {
  private readonly executable: string; private readonly stagingRoot: string
  constructor(executable = '/usr/local/bin/BaiduPCS-Go', stagingRoot = '/var/lib/jot/jot-files/sessions/archive-stage') {
    this.executable = executable; this.stagingRoot = stagingRoot; mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
  }
  async mkdir(path: string): Promise<void> { const result = await this.run(['mkdir', path], 60_000); if (result.code !== 0 && !/exist|已存在/i.test(result.stdout+result.stderr)) throw new Error('baidu_mkdir_failed') }
  async upload(localPath: string, remoteDirectory: string, remoteName: string): Promise<void> {
    const stage = join(this.stagingRoot, `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`); mkdirSync(stage, { mode: 0o700 })
    const stagedPath = join(stage, basename(remoteName))
    try {
      try { linkSync(localPath, stagedPath) } catch { copyFileSync(localPath, stagedPath) }
      const result = await this.run(['upload', stagedPath, remoteDirectory], 24 * 3600_000)
      if (result.code !== 0) throw new Error('baidu_upload_failed')
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }
  async meta(path: string): Promise<RemoteFileMeta | null> {
    const result = await this.run(['meta', path], 90_000); return result.code === 0 ? parseBaiduMeta(result.stdout) : null
  }
  async download(remotePath: string, localPath: string): Promise<void> {
    const stage = join(this.stagingRoot, `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`); mkdirSync(stage, { mode: 0o700 })
    try {
      const result = await this.run(['download', '--saveto', stage, remotePath], 24 * 3600_000); if (result.code !== 0) throw new Error('baidu_download_failed')
      const downloaded = join(stage, basename(remotePath)); if (!existsSync(downloaded)) throw new Error('baidu_download_missing')
      rmSync(localPath, { force: true }); renameSync(downloaded, localPath)
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }
  private async run(args: string[], timeoutMs: number): Promise<CommandResult> {
    const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(http|https|all)_proxy$/i.test(key)) delete env[key]
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { env, stdio: ['ignore','pipe','pipe'] }); const stdout: Buffer[] = []; const stderr: Buffer[] = []
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout.on('data', chunk => { if (Buffer.concat(stdout).length < 1024*1024) stdout.push(Buffer.from(chunk)) })
      child.stderr.on('data', chunk => { if (Buffer.concat(stderr).length < 256*1024) stderr.push(Buffer.from(chunk)) })
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }) })
    })
  }
}
