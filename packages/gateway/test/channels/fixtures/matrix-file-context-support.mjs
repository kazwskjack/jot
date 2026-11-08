import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

import { ArtifactService } from '../../../src/artifacts/service.ts';
import { ChannelDeliveryService } from '../../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../../src/channels/worker.ts';
import { OwnerChannelBindings } from '../../../src/channels/owner-bindings.ts';
import { installChannelAuthorityMigration } from '../../../src/channels/authority-migration.ts';
import { canonicalJson } from '../../../src/db/canonical-json.ts';
import { openProductDatabase } from '../../../src/db/database.ts';
import { withImmediateTransaction } from '../../../src/db/database.ts';
import { provePendingPinnedChannelArtifact } from '../../../src/channels/authority-proofs.ts';
import { TaskNotifications } from '../../../src/persistent-tasks/notifications.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const effectIdFor = (effect, payload) => 'delivery-' + sha(JSON.stringify([
  'artifact-pin-v1', effect.run_id, effect.message_id, effect.destination,
  effect.recipient, effect.artifact_ref, sha(canonicalJson(payload)),
])).slice(0, 32);

export function fixture(t, prefix = 'ga-pinned-delivery-') {
  const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,prefix));
  const taskTemp=process.env.TEMP,taskTmp=process.env.TMP;process.env.TEMP=root;process.env.TMP=root;
  t.after(()=>{if(taskTemp===undefined)delete process.env.TEMP;else process.env.TEMP=taskTemp;if(taskTmp===undefined)delete process.env.TMP;else process.env.TMP=taskTmp;});
  const db = openProductDatabase(':memory:');
  db.exec(`CREATE TABLE wb_persistent_tasks(task_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,
    generation INTEGER NOT NULL,version INTEGER NOT NULL,projection_pending INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE wb_agents(agent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,capability_epoch INTEGER NOT NULL);
    CREATE TABLE wb_task_finalizations(occurrence_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,message_id TEXT NOT NULL);`);
  new OwnerChannelBindings(db, { enabled: ['wecom'] });
  installChannelAuthorityMigration(db);
  const artifacts = new ArtifactService(db, join(root, 'artifacts'));
  const delivery = new ChannelDeliveryService(db, () => 1000);
  const notifications = new TaskNotifications(db);
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-a', 'owner-a', 'wecom', 'provider-user', 'verified', 1000, 1000);
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv-a', 'owner-a', 'ws', 'title', '{}', 1, 'now', 'now');
  db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('message-a', 'conv-a', 'run-a', 'user', 'complete', JSON.stringify({ blocks: [], attachments: [] }), 'client-a', 'now', 'now');
  db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('run-a', 'conv-a', 'message-a', 'queued', 1, 'now', 'now');
  db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('message-final', 'conv-a', 'run-a', 'assistant', 'complete', JSON.stringify({blocks:[{block_id:'message-final:0',kind:'text',text:'Reviewed final'}],attachments:[]}), null, 'now', 'now');
  db.prepare("INSERT INTO wb_persistent_tasks VALUES(?,?,'active',1,1,0,'now')").run('task-a','owner-a');
  db.prepare("INSERT INTO wb_agents VALUES(?,?,'active',1)").run('agent-a','owner-a');
  db.prepare('INSERT INTO wb_task_finalizations VALUES(?,?,?,?)').run('occurrence-a','owner-a','run-a','message-final');
  db.prepare(`INSERT INTO wb_task_notification_settings(task_id,owner_id,version,bindings_json,created_at,updated_at,delivery_policy_json,events_json)
    VALUES(?,?,?,?,?,?,?,?)`).run('task-a','owner-a',1,JSON.stringify([{channel_binding_id:'binding-a',version:1,artifact_delivery:true}]),'now','now',
    JSON.stringify({min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null}),JSON.stringify(['completed']));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, artifacts, delivery, notifications, messageId:'message-final' };
}

export function registerTaskOutput(f, { artifactId = 'artifact-file', version = 1, bytes = Buffer.from('pinned bytes'), name = 'report.txt' } = {}) {
  const path = join(f.root, artifactId + '-v' + version + '.txt');
  writeFileSync(path, bytes);
  const digest = sha(bytes);
  const now = 'now';
  f.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(artifactId, 'conv-a', 'owner-a', 'task_output_file', version, now, now);
  f.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(artifactId, version, path, digest, bytes.length, 'text/plain', JSON.stringify({
      file_name: name, status: 'ready', origin: 'generated', task_file: { run_id: 'run-a', receipt_id: 'receipt-a', sha256: digest },
    }), now);
  f.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(artifactId, 'pending', 'present', now, now, now);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run('run-a', artifactId, version, now);
  return { artifactId, path, bytes, digest, name };
}

function authorizeTaskArtifact(f,effect,{grant=true}={}){
  withImmediateTransaction(f.db,()=>{
    f.delivery.bindTaskAuthorization(effect.effect_id,{owner_id:'owner-a',task_id:'task-a',occurrence_id:'occurrence-a',generation:1,task_version:1,agent_id:'agent-a',epoch:1},'conv-a','provider-user');
    if(grant)f.notifications.grant(effect.effect_id,'owner-a','task-a',{channel_binding_id:'binding-a',channel:'wecom',principal:'provider-user',version:1,settings_version:1,artifact_delivery:true});
  });
}

export function enqueuePinned(f, artifactId, version = 1, destination = 'wecom', {grant=true,attach=true} = {}) {
  if(attach){
    const row=f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(f.messageId),content=JSON.parse(row.content_json);
    if(!content.attachments.includes(artifactId))content.attachments.push(artifactId);
    f.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run(JSON.stringify(content),f.messageId);
  }
  const effect=f.delivery.enqueuePinnedArtifact({ runId: 'run-a', messageId: f.messageId, destination,
    recipient: 'provider-user', ownerId: 'owner-a', artifactId, version }, f.artifacts);
  authorizeTaskArtifact(f,effect,{grant});
  return effect;
}

export function workerFor(f, provider, extra = {}, runtime = {}) {
  return new ChannelDeliveryWorker(f.delivery, provider, {
    registerDeliveryReceipt: async () => ({ ok: true }),
    ...runtime,
  }, {
    artifacts: f.artifacts,
    resolveArtifact: () => { throw new Error('legacy_single_resolver_must_not_run'); },
    resolveArtifacts: () => { throw new Error('legacy_group_resolver_must_not_run'); },
    cleanupArtifact: pin => f.artifacts.markPinnedDeliveredAndDelete(pin.run_id, pin),
    resolveRuntime: clientRunId => ({ runtimeRunId: 'runtime-' + clientRunId, clientRunId }),
    ...extra,
  });
}
