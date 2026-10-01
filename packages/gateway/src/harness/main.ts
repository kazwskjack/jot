import { readFileSync } from 'node:fs';
import { openProductDatabase } from '../db/database.ts';
import { EventStore } from '../events/event-store.ts';
import { RunRepository } from '../runs/repository.ts';
import { HarnessCoordinator } from './coordinator.ts';
import { HarnessWorker } from './worker.ts';
import { RuntimeEventClient } from './runtime-events.ts';
import { SessionControllerClient } from './session-controller-client.ts';
import { OfficialSessionRunner } from './official-session-runner.ts';
import { SessionBindingRepository } from './session-bindings.ts';
import { AttachmentResolver } from '../artifacts/resolver.ts';
import { parseWorkerConcurrency, runWorkerPool } from './worker-pool.ts';
import { SessionCommandDispatcher } from './command-dispatcher.ts';
import { ChannelDeliveryService } from '../channels/delivery.ts';

const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
const workerId = process.env.GENERAL_AGENT_WORKER_ID?.trim() || `worker-${process.pid}`;
const leaseMs = Math.max(60_000, Number(process.env.GENERAL_AGENT_WORKER_LEASE_MS || 900_000));
const pollMs = Math.max(250, Number(process.env.GENERAL_AGENT_WORKER_POLL_MS || 1000));
const concurrency = parseWorkerConcurrency(process.env.GENERAL_AGENT_WORKER_CONCURRENCY);
const adapterBaseUrl = process.env.GENERAL_AGENT_SESSION_ADAPTER_URL?.trim() || 'http://127.0.0.1:18841';
const adapterTokenFile = process.env.GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE?.trim()
  || '/etc/jot/dsh-session-adapter.token';
const harnessCwd = process.env.GENERAL_AGENT_HARNESS_CWD?.trim() || '/opt/jot';
const agentPreset = process.env.GENERAL_AGENT_DSH_AGENT_PRESET?.trim() || 'jot-general';
const sessionPrefix = process.env.GENERAL_AGENT_DSH_SESSION_PREFIX?.trim() || 'jot-ugs1';
const fileRoot = process.env.GENERAL_AGENT_FILE_ROOT?.trim()
  || process.env.GENERAL_AGENT_UPLOAD_ROOT?.trim() || '/var/lib/jot/jot-files';
const db = openProductDatabase(databasePath);
const events = new EventStore(db);
const runs = new RunRepository(db, events);
const coordinator = new HarnessCoordinator(db, runs, events);
const channelDelivery = new ChannelDeliveryService(db);
const sessionBindings = new SessionBindingRepository(db, sessionPrefix);
const attachmentResolver = new AttachmentResolver(db, fileRoot);
const runtimeBaseUrl = process.env.GENERAL_AGENT_RUNTIME_BASE_URL?.trim();
const runtimeSecretFile = process.env.GENERAL_AGENT_RUNTIME_SECRET_FILE?.trim();
const leafBridgeBaseUrl = process.env.GENERAL_AGENT_LEAF_BRIDGE_BASE_URL?.trim()
  || 'http://127.0.0.1:18792';
const runtimeClient = runtimeBaseUrl && runtimeSecretFile
  ? new RuntimeEventClient(runtimeBaseUrl, readFileSync(runtimeSecretFile))
  : undefined;
const sessionClient = new SessionControllerClient(adapterBaseUrl, readFileSync(adapterTokenFile, 'utf8').trim(),
  globalThis.fetch, leafBridgeBaseUrl);
const runner = new OfficialSessionRunner(sessionClient, {
  cwd: harnessCwd, agentPreset,
});
const worker = new HarnessWorker(db, coordinator, runner, {
  workerId, leaseMs,
  sessionResolver: conversationId => sessionBindings.getOrCreateForConversation(conversationId).session_id,
  attachmentResolver,
  channelDelivery,
  ...(runtimeClient ? { contextStager: {
    stageContext: input => runtimeClient.stageContext(input, leafBridgeBaseUrl),
  } } : {}),
});
let stopping = false;
const commands = new SessionCommandDispatcher(db,events,sessionClient,runId=>worker.isReady(runId));
const commandLoop = async()=>{
 while(!stopping){
  try{await commands.processNext()}catch{process.stderr.write('session_command_dispatch_retry\n')}
  if(!stopping)await new Promise(resolve=>setTimeout(resolve,500));
 }
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopping = true; });
await Promise.all([commandLoop(),runWorkerPool({
  concurrency,
  pollMs,
  shouldStop: () => stopping,
  processNext: () => worker.processNext(),
  onError: error => {
    const code = error instanceof Error ? error.message : 'worker_error';
    process.stderr.write(`${JSON.stringify({ level: 'error', code: code.slice(0, 96) })}\n`);
  },
})]);
db.close();
