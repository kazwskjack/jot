import {startMattermostOwnerService} from './mattermost-owner-service.ts';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProductDatabase } from '../db/database.ts';
import { ChannelDeliveryService } from './delivery.ts';
import { ChannelDeliveryWorker, type DeliveryProvider } from './worker.ts';
import { deliveryChannels, emailConfiguration, requireDeliveryRuntimeConfiguration, slackDeliveryConfiguration, smsDeliveryConfiguration } from './provider-config.ts';
import { createEmailProvider } from './email-provider.ts';
import { loadWebPushVapidConfiguration, createWebPushProvider } from './web-push-provider.ts';
import { PushSubscriptions } from './push-subscriptions.ts';
import { RuntimeEventClient } from '../harness/runtime-events.ts';
import { ArtifactService } from '../artifacts/service.ts';
import { writeChannelWorkerError } from './worker-error-log.ts';
import {startMatrixChannelService} from './matrix-service.ts';
import {createMattermostProvider} from './adapters/mattermost.ts';
import {mattermostOwnerAccount,type MattermostOwnerAccount} from './mattermost-owner-proof.ts';
import {createSlackDeliveryProvider} from './slack.ts';
import {createTwilioSmsDeliveryProvider} from './sms.ts';

const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
const runtimeBaseUrl = String(process.env.GENERAL_AGENT_RUNTIME_BASE_URL || '').trim();
const runtimeSecretFile = String(process.env.GENERAL_AGENT_RUNTIME_SECRET_FILE || '').trim();
const channels = deliveryChannels(process.env);
requireDeliveryRuntimeConfiguration(channels,runtimeBaseUrl,runtimeSecretFile);
let mattermostAccount:MattermostOwnerAccount|undefined;
if(channels.includes('mattermost')){
  const instance=process.env.GENERAL_AGENT_MATTERMOST_BASE_URL?.trim()??'';
  const botUserId=process.env.GENERAL_AGENT_MATTERMOST_BOT_USER_ID?.trim()??'';
  const botToken=process.env.GENERAL_AGENT_MATTERMOST_BOT_TOKEN??'';
  if(!instance||!botUserId||!botToken)throw new Error('mattermost_service_config_required');
  mattermostAccount=mattermostOwnerAccount({instance,botUserId});
}
const webPushVapid=loadWebPushVapidConfiguration(process.env);
if(channels.includes('webpush')&&!webPushVapid)throw new Error('push_vapid_configuration_invalid');
const smsConfig=channels.includes('sms')?smsDeliveryConfiguration(process.env):undefined;
const providers: Record<string, DeliveryProvider> = {};
if (channels.includes('email')) providers.email = await createEmailProvider(emailConfiguration(process.env));
if(channels.includes('mattermost'))providers.mattermost=createMattermostProvider({baseUrl:mattermostAccount!.instance,botToken:process.env.GENERAL_AGENT_MATTERMOST_BOT_TOKEN!});
if (channels.includes('wecom')) {
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
providers.wecom = {
  sendFile: wecom.sendFile.bind(wecom),
  send: (text: string, recipient: string) => wecom.send(text, 'text', recipient),
};
}
const db = openProductDatabase(databasePath);
const store = new ChannelDeliveryService(db);
if(channels.includes('slack'))providers.slack=createSlackDeliveryProvider(slackDeliveryConfiguration(process.env),db);
if(channels.includes('webpush')&&webPushVapid)providers.webpush=createWebPushProvider(new PushSubscriptions(db,webPushVapid),webPushVapid);
if(smsConfig)providers.sms=createTwilioSmsDeliveryProvider(smsConfig,db);
const runtime = runtimeBaseUrl && runtimeSecretFile
  ? new RuntimeEventClient(runtimeBaseUrl, readFileSync(runtimeSecretFile))
  : { async registerDeliveryReceipt(): Promise<Record<string, unknown>> { throw new Error('delivery_runtime_config_required'); } };
const artifactRoot = process.env.GENERAL_AGENT_FILE_ROOT?.trim()
  || process.env.GENERAL_AGENT_ARTIFACT_ROOT?.trim()
  || '/var/lib/jot/jot-files';
const artifacts = new ArtifactService(db, artifactRoot);
const worker = new ChannelDeliveryWorker(store, {providers}, runtime, {
  artifacts,
  ...(mattermostAccount?{mattermostAccount}:{}),
  cleanupArtifact(pin) {
    artifacts.markPinnedDeliveredAndDelete(pin.run_id, pin);
  },
  resolveRuntime(clientRunId) {
    const row = db.prepare('SELECT runtime_run_id FROM ga_runtime_bindings WHERE run_id=?')
      .get(clientRunId) as { runtime_run_id?: string } | undefined;
    if (!row?.runtime_run_id) throw new Error('delivery_runtime_binding_missing');
    return { runtimeRunId: row.runtime_run_id, clientRunId };
  },
});
const pollMs = Math.max(250, Number(process.env.GENERAL_AGENT_DELIVERY_POLL_MS || 1000));
let mattermostService:Awaited<ReturnType<typeof startMattermostOwnerService>>;
let matrixService:Awaited<ReturnType<typeof startMatrixChannelService>>;
let matrixPoll:Promise<void>|undefined;
let stopping = false;
let stoppingWork:Promise<void>|undefined;
const failures:unknown[]=[];
try {
matrixService=await startMatrixChannelService(process.env,{db});
mattermostService=await startMattermostOwnerService(process.env,{db});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  stopping = true;
  stoppingWork??=Promise.all([matrixService?.stop(),mattermostService?.stop()]).then(()=>undefined).catch(error=>{failures.push(error);});
});
while (!stopping) {
  if(mattermostService&&!mattermostService.running()){
    await mattermostService.uninstall();
    try{mattermostService=await startMattermostOwnerService(process.env,{db});}catch(error){writeChannelWorkerError(error,line=>process.stderr.write(line));}
  }
  // Matrix long polling shares the service lifetime without blocking delivery work.
  if(matrixService&&!matrixPoll){
    matrixPoll=matrixService.poll().then(()=>undefined,error=>{
      if(stopping)return;
      writeChannelWorkerError(error, line => process.stderr.write(line));
    }).finally(()=>{matrixPoll=undefined;});
  }
  if(stopping)break;
  try {
    if (!await worker.processNext()) await new Promise(resolve => setTimeout(resolve, pollMs));
  } catch (error) {
    writeChannelWorkerError(error, line => process.stderr.write(line));
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
} catch(error){failures.unshift(error);} finally {
  try{await stoppingWork;}catch(error){failures.push(error);}
  try{await matrixService?.close();}catch(error){failures.push(error);}
  try{await matrixPoll;}catch(error){failures.push(error);}
  try{await mattermostService?.uninstall();}catch(error){failures.push(error);}
  try{db.close();}catch(error){failures.push(error);}
}
if(failures.length){
  for(const error of failures)writeChannelWorkerError(error, line => process.stderr.write(line));
  process.exitCode=1;
}
