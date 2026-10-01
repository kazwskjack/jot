import { resolve } from 'node:path';
import { openProductDatabase } from '../db/database.ts';
import { ArtifactService } from '../artifacts/service.ts';
import { FileJobService } from './jobs.ts';
import { FileEngineAdapter } from './engine.ts';
import { FileEngineWorker } from './worker.ts';

const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
const fileRoot = process.env.GENERAL_AGENT_FILE_ROOT?.trim() || '/var/lib/jot/jot-files';
const python = process.env.GENERAL_AGENT_FILE_ENGINE_PYTHON?.trim() || '/usr/bin/python3';
const workerPath = process.env.GENERAL_AGENT_FILE_ENGINE_SCRIPT?.trim()
  || resolve(process.cwd(), 'file-engine/worker.py');
const db = openProductDatabase(databasePath);
const jobs = new FileJobService(db);
const artifacts = new ArtifactService(db, fileRoot);
const engine = new FileEngineAdapter({ python, workerPath,
  timeoutMs: Math.max(10_000, Number(process.env.GENERAL_AGENT_FILE_ENGINE_TIMEOUT_MS || 180_000)) });
const worker = new FileEngineWorker(jobs, artifacts, engine, {
  workerId: process.env.GENERAL_AGENT_FILE_ENGINE_WORKER_ID?.trim() || `file-engine-${process.pid}`,
  workRoot: resolve(fileRoot, 'sessions', 'file-engine'), leaseSeconds: 300,
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
while (!stopping) {
  try { if (!await worker.processNext()) await new Promise(resolveWait => setTimeout(resolveWait, 500)); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', service: 'file-engine',
      code: error instanceof Error ? error.message.slice(0, 96) : 'FILE_ENGINE_WORKER_ERROR' })}\n`);
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
}
db.close();
