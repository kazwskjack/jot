import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openProductDatabase } from '../db/database.ts';
import { RuntimeEventClient } from '../harness/runtime-events.ts';
import { ArtifactService } from './service.ts';
import { ArtifactRequestService } from './requests.ts';
import { DocumentRenderer } from './document-renderer.ts';
import { ArtifactRequestWorker } from './worker.ts';

function run(executable: string, arguments_: string[], options: { env?: NodeJS.ProcessEnv;
  timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill('SIGKILL'); reject(new Error('artifact_process_timeout'));
    }, options.timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) reject(new Error(`artifact_process_failed:${stderr.replace(/\s+/g, ' ').slice(0, 160)}`));
      else resolve({ stdout, stderr });
    });
  });
}

const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
const artifactRoot = process.env.GENERAL_AGENT_FILE_ROOT?.trim()
  || process.env.GENERAL_AGENT_ARTIFACT_ROOT?.trim()
  || '/var/lib/jot/jot-files';
const temporaryRoot = process.env.GENERAL_AGENT_ARTIFACT_TEMP_ROOT?.trim()
  || '/var/lib/jot/jot-docx-tmp';
const exporter = process.env.GENERAL_AGENT_DOCX_EXPORTER?.trim()
  || '/opt/jot/general-agent-web/current/vendor/jot-article-docx-export.py';
const python = process.env.jot_PYTHON?.trim() || '/usr/bin/python3';
const libreOffice = process.env.GENERAL_AGENT_LIBREOFFICE?.trim() || '/usr/bin/libreoffice';
const runtimeBaseUrl = process.env.GENERAL_AGENT_RUNTIME_BASE_URL?.trim() || '';
const runtimeSecretFile = process.env.GENERAL_AGENT_RUNTIME_SECRET_FILE?.trim() || '';
if (!runtimeBaseUrl || !runtimeSecretFile) throw new Error('artifact_runtime_config_required');
mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });

const db = openProductDatabase(databasePath);
const artifacts = new ArtifactService(db, artifactRoot);
const requests = new ArtifactRequestService(db);
const runtime = new RuntimeEventClient(runtimeBaseUrl, readFileSync(runtimeSecretFile));
const renderer = new DocumentRenderer({
  async exportBundle(payload, request) {
    const job = createHash('sha256').update(String(request.request_id)).digest('hex').slice(0, 32);
    const directory = join(temporaryRoot, `artifact-${job}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const input = join(directory, 'bundle.json');
    writeFileSync(input, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    const output = await run(python, ['-S', exporter, input, directory], {
      timeoutMs: 10 * 60_000,
      env: { ...process.env, jot_ARTICLE_DOCX_ROOT: temporaryRoot,
        jot_DOCUMENT_TEMPLATE_PROFILE: String(request.template || 'default') },
    });
    try { return JSON.parse(output.stdout.trim().split(/\r?\n/).at(-1) || '{}'); }
    catch { throw new Error('artifact_export_response_invalid'); }
  },
  async verifyDocument(path) {
    if (!path || !existsSync(path)) throw new Error('artifact_document_missing');
    const stat = statSync(path);
    if (stat.size < 1 || stat.size > 19 * 1024 * 1024) {
      throw new Error('artifact_document_size_invalid');
    }
    const qaRoot = join(dirname(path), `qa-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`);
    mkdirSync(qaRoot, { recursive: true, mode: 0o700 });
    const profile = join(qaRoot, 'profile').replaceAll('\\', '/');
    await run(libreOffice, [`-env:UserInstallation=file://${profile}`, '--headless',
      '--convert-to', 'pdf', '--outdir', qaRoot, path], { timeoutMs: 120_000 });
    const pdf = join(qaRoot, basename(path).replace(/\.docx$/i, '.pdf'));
    if (!existsSync(pdf) || statSync(pdf).size < 100) throw new Error('artifact_libreoffice_qa_failed');
    const raw = readFileSync(path);
    rmSync(qaRoot, { recursive: true, force: true });
    return { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
  },
  registerDocuments(runId, requestId, documents) {
    return artifacts.registerGenerated(runId, requestId, documents);
  },
});
const worker = new ArtifactRequestWorker(requests, renderer, runtime, {
  workerId: process.env.GENERAL_AGENT_ARTIFACT_WORKER_ID?.trim() || `artifact-${process.pid}`,
  leaseSeconds: Math.max(60, Number(process.env.GENERAL_AGENT_ARTIFACT_LEASE_SECONDS || 900)),
});
const pollMs = Math.max(250, Number(process.env.GENERAL_AGENT_ARTIFACT_POLL_MS || 1000));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopping = true; });
while (!stopping) {
  try {
    if (!await worker.processNext()) await new Promise(resolve => setTimeout(resolve, pollMs));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', code:
      String(error instanceof Error ? error.message : error).slice(0, 160) })}\n`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
db.close();
