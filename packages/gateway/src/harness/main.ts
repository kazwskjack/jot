import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openProductDatabase } from '../db/database.ts';
import { EventStore } from '../events/event-store.ts';
import { RunRepository } from '../runs/repository.ts';
import { HarnessCoordinator } from './coordinator.ts';
import { HarnessWorker } from './worker.ts';
import {chatPostAnswerEnabled,notifyCommittedChatAnswer} from './chat-post-answer.ts';
import {MemoryExtractionPump} from './memory-extraction-pump.ts';
import { RuntimeEventClient } from './runtime-events.ts';
import { SessionControllerClient } from './session-controller-client.ts';
import { OfficialSessionRunner } from './official-session-runner.ts';
import { SessionBindingRepository } from './session-bindings.ts';
import { AttachmentResolver } from '../artifacts/resolver.ts';
import { parseWorkerConcurrency, runWorkerPool } from './worker-pool.ts';
import { SessionCommandDispatcher } from './command-dispatcher.ts';
import {OrdinarySteeringReconciler} from './ordinary-steering-reconciliation.ts';
import {OrdinaryFinalPublisher} from './ordinary-final-publication.ts';
import {OrdinaryFinalRecoveryPump,ordinaryFinalRecoveryEnabled} from './ordinary-final-recovery.ts';
import {HistoricalFinalDeliveryIntents} from '../channels/historical-final-intents.ts';
import { TaskCompletionPump } from './task-completion-pump.ts';
import { ChannelDeliveryService } from '../channels/delivery.ts';
import {NotificationArchiveMaintenance,notificationArchiveMaintenanceConfig} from '../channels/notification-maintenance.ts';
import { WorkbenchService } from '../workbench/service.ts';
import {createNativeWorkRuntime} from '../always-on/native-work-runtime.ts';
import {readIsolatedTaskFileVersion} from '../persistent-tasks/isolated-output-source.ts';
import {configureTaskOutputReader} from '../persistent-tasks/output-content.ts';
import {configureTaskOutputDelivery} from '../persistent-tasks/output-delivery.ts';
import {ArtifactService} from '../artifacts/service.ts';
import { WORKBENCH_TOOL_IDS } from '../workbench/execution.ts';
import { PersistentTaskService } from '../persistent-tasks/service.ts';
import {TaskReplyDispatch,taskReplyDispatchEnabled} from '../persistent-tasks/reply-dispatch.ts';
import { maintainWorkbench } from '../persistent-tasks/scheduler.ts';
import { WorkbenchBudgetPolicy, workbenchExecutionConfiguration } from '../workbench/model-budget-policy.ts';

const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
const workerId = process.env.GENERAL_AGENT_WORKER_ID?.trim() || `worker-${process.pid}`;
const leaseMs = Math.max(60_000, Number(process.env.GENERAL_AGENT_WORKER_LEASE_MS || 900_000));
const pollMs = Math.max(250, Number(process.env.GENERAL_AGENT_WORKER_POLL_MS || 1000));
const concurrency = parseWorkerConcurrency(process.env.GENERAL_AGENT_WORKER_CONCURRENCY);
const {workbenchExecutionReady,modelBudgetPolicy:budgetConfig} = workbenchExecutionConfiguration(process.env);
const replyExecutionRequested=taskReplyDispatchEnabled(process.env);
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
const runs = new RunRepository(db, events,{workAgentPreset:agentPreset});
const workbenchRoot = process.env.GENERAL_AGENT_WORKBENCH_ROOT?.trim() || join(dirname(databasePath), 'jot-workspaces');
const budgetPolicy=budgetConfig?new WorkbenchBudgetPolicy(db,budgetConfig):undefined;
const workbench = new WorkbenchService(db, {
  workspaceIds: String(process.env.GENERAL_AGENT_WORKSPACES || 'jot').split(',').map(value => value.trim()).filter(Boolean),
  root: workbenchRoot, allowedToolIds: WORKBENCH_TOOL_IDS,
  ...(budgetPolicy ? {modelBudgetPolicy:budgetPolicy} : {}),
});
const nativeWork=createNativeWorkRuntime({db,workbench,executionReady:workbenchExecutionReady,...(process.env.GENERAL_AGENT_NATIVE_WORK_ROOT!==undefined?{root:process.env.GENERAL_AGENT_NATIVE_WORK_ROOT.trim()}:{}),...(budgetPolicy?{budgetPolicy}:{})});
const persistentTasks = new PersistentTaskService(db, workbench, { projectionRoot: join(workbenchRoot, 'tasks'), events,...(budgetPolicy?{modelBudgetPolicy:budgetPolicy}:{}),...(nativeWork?{discoveryWorkOperations:nativeWork}:{}) });
configureTaskOutputReader(db,input=>input.source?.source==='isolated'?readIsolatedTaskFileVersion(db,input.source):workbench.readFileVersion(input.owner,input.workspace,input.project,input.path,input.version,input.runId));
configureTaskOutputDelivery(db,new ArtifactService(db,fileRoot),events);
const coordinator = new HarnessCoordinator(db, runs, events, Date.now, {
  maxBackgroundRuns: Math.max(0, concurrency - 1), allowBackgroundRuns: workbenchExecutionReady,
});
const channelDelivery = new ChannelDeliveryService(db);
const archiveMaintenanceConfig=notificationArchiveMaintenanceConfig(process.env);
const archiveMaintenance=archiveMaintenanceConfig?new NotificationArchiveMaintenance(db,archiveMaintenanceConfig):undefined;
const replyDispatch=new TaskReplyDispatch(db,events,{enabled:workbenchExecutionReady&&replyExecutionRequested});
const sessionBindings = new SessionBindingRepository(db, sessionPrefix);
// Only the claimed original work run may allocate its initial saved Session.
// All subsequent resolver reads require that same saved binding to exist.
const workContextForRun=(runId:string,initialize=false)=>{
 const base=workbench.contextForRun(runId);
 const work=db.prepare("SELECT conversation_id FROM wb_task_run_occurrences WHERE run_id=? AND trigger_key LIKE 'discovery-work:%'").get(runId) as {conversation_id:string}|undefined;
 if(!work)return base;
 if(!nativeWork)throw Error('work_admission_execution_unavailable');
 if(initialize&&!db.prepare('SELECT 1 FROM ga_harness_session_bindings WHERE conversation_id=?').get(work.conversation_id))sessionBindings.getOrCreateForConversation(work.conversation_id);
 const context=nativeWork.resolver.context(runId);
 if(!context)throw Error('work_admission_execution_unavailable');
 return {...base,work_binding:context.work_binding,native_workspace:context.native_workspace,objective:context.objective};
};
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
const workCompactionFlag=process.env.GENERAL_AGENT_WORK_COMPACTION_PROJECTION_ENABLED;
if(workCompactionFlag!==undefined&&workCompactionFlag!=='true'&&workCompactionFlag!=='false')throw Error('work_compaction_projection_config_invalid');
const runner = new OfficialSessionRunner(sessionClient, {
  visibleWorkCompaction:workCompactionFlag==='true',
  ...(process.env.GENERAL_AGENT_CHAT_ENABLED==='true'?{chatAgentPreset:'jot-chat' as const}:{}),
  cwd: harnessCwd, agentPreset,...(process.env.GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET?.trim()?{workbenchAgentPreset:process.env.GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET.trim()}:{}),
});
const ordinarySteeringEnabled=process.env.GENERAL_AGENT_ORDINARY_STEERING_ENABLED==='true';
if(ordinarySteeringEnabled&&process.env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED!=='true')throw Error('ordinary_steering_requires_original_input_recovery');
const ordinaryReconciliationEnabled=process.env.GENERAL_AGENT_ORDINARY_STEERING_RECONCILIATION_ENABLED==='true';
if(ordinaryReconciliationEnabled&&!ordinarySteeringEnabled)throw Error('ordinary_reconciliation_requires_steering');
const ordinaryReconciler=ordinaryReconciliationEnabled?new OrdinarySteeringReconciler(db,events,sessionClient):undefined;
const finalRecoveryEnabled=ordinaryFinalRecoveryEnabled(process.env);
if(finalRecoveryEnabled&&(await sessionClient.ordinaryRunHistoryReadiness()).ready!==true)throw Error('ordinary_final_history_unavailable');
const finalRecovery=finalRecoveryEnabled?new OrdinaryFinalRecoveryPump(db,
  new OrdinaryFinalPublisher(db,events,sessionClient,{resolver:attachmentResolver,artifactRoot:fileRoot,historicalChannels:channelDelivery}),
  new HistoricalFinalDeliveryIntents(db,channelDelivery),{enabled:true,workerId:`${workerId}:history`}):undefined;
const worker = new HarnessWorker(db, coordinator, runner, {
  workerId, leaseMs,
  ordinaryInputRecoveryEnabled:process.env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED==='true',ordinarySteeringEnabled,
  ...(chatPostAnswerEnabled(process.env)?{chatPostAnswer:(runId:string)=>notifyCommittedChatAnswer(db,runId,sessionClient,AbortSignal.timeout(15000))}:{}),
  sessionResolver: conversationId => sessionBindings.getOrCreateForConversation(conversationId).session_id,
  attachmentResolver,
  channelDelivery,
  ...(nativeWork?{workRunWorkspaceResolver:nativeWork.resolver}:{}),
  executionGuard: { assertRunActive(runId) { workbench.assertRunActive(runId); persistentTasks.assertRunActive(runId); },
    contextForRun: runId => workContextForRun(runId,true) },
  ...(runtimeClient ? { contextStager: {
    stageContext: input => runtimeClient.stageContext(input, leafBridgeBaseUrl),
  } } : {}),
});
const memoryShutdown=new AbortController();
const memoryPump=new MemoryExtractionPump(db,workbench,coordinator,sessionClient,{
  enabled:workbenchExecutionReady&&concurrency>1&&process.env.GENERAL_AGENT_MEMORY_EXTRACTION_ENABLED==='true',
  workerId:`${workerId}:memory`,leaseMs,cwd:harnessCwd,
  sessionResolver:conversationId=>sessionBindings.getOrCreateForConversation(conversationId).session_id,
});
let stopping = false;
const finalRecoveryLoop=async()=>{
 if(!finalRecovery)return;
 while(!stopping){
  try{await finalRecovery.processNext(memoryShutdown.signal);}catch{if(!stopping)process.stderr.write('ordinary_final_observation_retry\n');}
  if(!stopping)await new Promise(resolve=>setTimeout(resolve,1000));
 }
};
const completions=new TaskCompletionPump(db,coordinator,sessionClient,{workerId:`${workerId}:completion`});
const completionLoop=async()=>{
 while(!stopping){
  if(workbenchExecutionReady){try{await completions.processNext();}catch{process.stderr.write('task_completion_dispatch_retry\n');}}
  if(!stopping)await new Promise(resolve=>setTimeout(resolve,1000));
 }
};


const commands = new SessionCommandDispatcher(db,events,sessionClient,runId=>worker.isReady(runId), {
  assertRunActive(runId) {workbench.assertRunActive(runId); persistentTasks.assertRunActive(runId);},
  contextForRun: runId => workContextForRun(runId),
  inheritChatRun: (owner, original, next) => workbench.inheritChatRun(owner, original, next),
},ordinarySteeringEnabled?{currentExecutionFor:runId=>worker.readyExecutionFor(runId),...(ordinaryReconciler?{reconcileHistorical:(runId:string,sessionId:string,commandId:string)=>ordinaryReconciler.reconcile(runId,sessionId,commandId,AbortSignal.timeout(20000))}:{})}:undefined);
const commandLoop = async()=>{
 while(!stopping){
  try{await commands.processNext()}catch{process.stderr.write('session_command_dispatch_retry\n')}
  if(!stopping)await new Promise(resolve=>setTimeout(resolve,500));
 }
};
const workbenchLoop = async () => {
  while (!stopping) {
    try{archiveMaintenance?.processNext();}catch{process.stderr.write('notification_archive_maintenance_retry\n');}
    try { replyDispatch.processNext(); } catch { process.stderr.write('task_reply_dispatch_retry\n'); }
    try {
      await maintainWorkbench(workbench, persistentTasks, workbenchExecutionReady);
    } catch { process.stderr.write('workbench_dispatch_retry\n'); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
  }
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopping = true;memoryShutdown.abort(new Error('worker_shutdown')); });
await Promise.all([completionLoop(),commandLoop(),workbenchLoop(),finalRecoveryLoop(),runWorkerPool({
  concurrency,
  pollMs,
  shouldStop: () => stopping,
  processNext: async () => await worker.processNext() ?? await memoryPump.processNext(memoryShutdown.signal),
  onError: error => {
    const code = error instanceof Error ? error.message : 'worker_error';
    process.stderr.write(`${JSON.stringify({ level: 'error', code: code.slice(0, 96) })}\n`);
  },
})]);
db.close();
