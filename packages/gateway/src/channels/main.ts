import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProductDatabase } from '../db/database.ts';
import { ChannelDeliveryService } from './delivery.ts';
import { ChannelDeliveryWorker } from './worker.ts';
import { RuntimeEventClient } from '../harness/runtime-events.ts';
import { ArtifactService } from '../artifacts/service.ts';

const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
const runtimeBaseUrl = String(process.env.GENERAL_AGENT_RUNTIME_BASE_URL || '').trim();
const runtimeSecretFile = String(process.env.GENERAL_AGENT_RUNTIME_SECRET_FILE || '').trim();
if (!runtimeBaseUrl || !runtimeSecretFile) throw new Error('delivery_runtime_config_required');
const modulePath = process.env.GENERAL_AGENT_WECOM_MODULE?.trim()
  || '/opt/jot/services/monitor/wecom-app.mjs';
const module = await import(pathToFileURL(modulePath).href) as {
  createWecomApp(options: Record<string, unknown>): {
    sendFile(path: string, recipient: string, displayName: string): Promise<Record<string, unknown>>;
    send(text: string, msgtype: string, recipient: string): Promise<Record<string, unknown>>;
  };
};
const wecom = module.createWecomApp({
  corpId: process.env.jot_WECOM_APP_CORP_ID,
  agentId: process.env.jot_WECOM_APP_AGENT_ID,
  secret: process.env.jot_WECOM_APP_SECRET,
  touser: process.env.jot_WECOM_APP_TOUSER,
  sendMode: process.env.jot_WECOM_SEND_MODE,
});
const provider = {
  sendFile: wecom.sendFile.bind(wecom),
  send: (text: string, recipient: string) => wecom.send(text, 'text', recipient),
};
const db = openProductDatabase(databasePath);
const store = new ChannelDeliveryService(db);
const runtime = new RuntimeEventClient(runtimeBaseUrl, readFileSync(runtimeSecretFile));
const artifactRoot = process.env.GENERAL_AGENT_FILE_ROOT?.trim()
  || process.env.GENERAL_AGENT_ARTIFACT_ROOT?.trim()
  || '/var/lib/jot/jot-files';
const artifacts = new ArtifactService(db, artifactRoot);
const worker = new ChannelDeliveryWorker(store, provider, runtime, {
  resolveArtifact(artifactRef) {
    const row = db.prepare(`SELECT v.server_path,v.metadata_json FROM ga_artifacts a
      JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
      WHERE a.id=? OR a.runtime_ref=? ORDER BY CASE WHEN a.id=? THEN 0 ELSE 1 END LIMIT 1`)
      .get(artifactRef, artifactRef, artifactRef) as Record<string, unknown> | undefined;
    if (!row) throw new Error('delivery_artifact_not_found');
    const metadata = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
    return { path: String(row.server_path),
      displayName: String(metadata.filename || metadata.display_name || 'Universe报告.docx') };
  },
  resolveArtifacts(artifactRef) {
    const artifact = db.prepare('SELECT id FROM ga_artifacts WHERE id=? OR runtime_ref=? LIMIT 1')
      .get(artifactRef, artifactRef) as { id?: string } | undefined;
    if (!artifact?.id) throw new Error('delivery_artifact_not_found');
    const parts = db.prepare(`SELECT server_path,display_name FROM ga_artifact_parts
      WHERE artifact_id=? ORDER BY part_index`).all(artifact.id) as
      Array<{ server_path: string; display_name: string }>;
    if (parts.length) return parts.map(part => ({ path: part.server_path,
      displayName: part.display_name }));
    const row = db.prepare(`SELECT v.server_path,v.metadata_json FROM ga_artifacts a
      JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
      WHERE a.id=?`).get(artifact.id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('delivery_artifact_not_found');
    const metadata = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
    return [{ path: String(row.server_path),
      displayName: String(metadata.filename || metadata.display_name || 'Universe报告.docx') }];
  },
  cleanupArtifact(artifactRef) {
    artifacts.markDeliveredAndDelete(artifactRef);
  },
  resolveRuntime(clientRunId) {
    const row = db.prepare('SELECT runtime_run_id FROM ga_runtime_bindings WHERE run_id=?')
      .get(clientRunId) as { runtime_run_id?: string } | undefined;
    if (!row?.runtime_run_id) throw new Error('delivery_runtime_binding_missing');
    return { runtimeRunId: row.runtime_run_id, clientRunId };
  },
});
const pollMs = Math.max(250, Number(process.env.GENERAL_AGENT_DELIVERY_POLL_MS || 1000));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopping = true; });
while (!stopping) {
  try {
    if (!await worker.processNext()) await new Promise(resolve => setTimeout(resolve, pollMs));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', code:
      String(error instanceof Error ? error.message : error).slice(0, 96) })}\n`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
db.close();
