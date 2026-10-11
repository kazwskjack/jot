import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BaiduPcsClient, parseBaiduMeta } from '../../src/artifacts/baidu-client.ts'

test('parses exact BaiduPCS-Go byte size and md5 without accepting human display size', () => {
  assert.deepEqual(parseBaiduMeta('文件大小 5, 5B\nmd5 5d41402abc4b2a76b9719d911017c592\n'),
    { size: 5, md5: '5d41402abc4b2a76b9719d911017c592' })
  assert.equal(parseBaiduMeta('文件大小 5MB\n'), null)
})

for (const mode of ['success', 'missing', 'failure']) {
  test(`download uses explicit saveto argv and preserves original on ${mode}`, async () => {
    const root = mkdtempSync(fileURLToPath(new URL('./baidu-cli-', import.meta.url)))
    const preload = join(root, 'fake-cli.cjs'); const argvFile = join(root, 'argv.json')
    const originalOptions = process.env.NODE_OPTIONS
    try {
      // A real subprocess runs this CLI emulator before Node resolves its entry
      // script, so the production spawn argv and staging behavior are exercised.
      writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
        const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(args));
        const valid=args.length===3&&args[0]==='--saveto';
        if(valid&&${JSON.stringify(mode)}==='success')fs.writeFileSync(path.join(args[1],path.basename(args[2])),'restored');
        process.exit(${JSON.stringify(mode)}==='failure'?1:0);`)
      process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`
      const stage = join(root, 'stage'); const destination = join(root, 'original')
      writeFileSync(destination, 'original')
      const client = new BaiduPcsClient(process.execPath, stage)
      if (mode === 'success') {
        await client.download('/jot_file/test/report.txt', destination)
        assert.equal(readFileSync(destination, 'utf8'), 'restored')
      } else {
        await assert.rejects(client.download('/jot_file/test/report.txt', destination),
          { message: mode === 'missing' ? 'baidu_download_missing' : 'baidu_download_failed' })
        assert.equal(readFileSync(destination, 'utf8'), 'original')
      }
      const args = JSON.parse(readFileSync(argvFile, 'utf8'))
      assert.equal(args[0], '--saveto'); assert.equal(args.length, 3)
      assert.equal(args[2], '/jot_file/test/report.txt')
      assert.equal(readdirSync(stage).length, 0)
    } finally {
      if (originalOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalOptions
      rmSync(root, { recursive: true, force: true })
    }
  })
}
