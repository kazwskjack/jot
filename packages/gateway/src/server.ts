import {OFFICE_PRINT_SOURCE_MAX_BYTES} from './artifacts/office-preview-format.js';
import {createOfficePreviewCandidatePager} from './file-engine/office-preview-candidate-pages.ts';
import {OfficePreviewConfigurationStore} from './file-engine/office-preview-configuration.ts';
import {createOfficePreviewCandidateReader} from './file-engine/office-preview-candidates.ts';
import {signOfficePrintProof} from './messages/office-print-proof.ts';
import {createOfficePreviewStatusReader} from './file-engine/office-preview-status.ts';
import {readActivityFileDocument,readActivityFileOfficePdf,parseOfficePrintQuery} from './events/activity-file-document.ts';
import {messageReferenceSnapshotsInstalled,commandReferenceSnapshotsInstalled,captureRunCommandReferenceSnapshots,assertReferenceSnapshotImages} from './messages/reference-snapshots.ts';
import {prepareReferenceSteeringText,type ReferenceSnapshotInput} from './messages/content-reference.js';
import {createPinnedByteStore} from './artifacts/pinned-byte-source.ts';
import {readActivityToolResult,searchActivityToolResults,readActivityToolResultFile,readActivityToolResultFileBytes,parseActivityFileDownloadQuery,readActivityToolResultFileDownload} from './events/activity-tool-result.ts';
import {registerNativeSearchSourceRoutes,searchNativeActivitySources,type NativeSearchSourceClient} from './events/native-search-source.ts';
import {readActivityHistory} from './events/activity-history.ts';
import {registerPluginProfileRoutes,type PluginProfileClient} from './workbench/plugin-profile-routes.ts';
import {createPluginProfileReceiptExecutor,PLUGIN_PROFILE_RECEIPT_PROTOCOL} from './workbench/plugin-profile-receipts.ts';
import {registerHostSettingsInternalRoutes} from './host-admin/settings-internal-routes.ts';
import {registerHostAdminRoutes,type HostSettingsClient} from './host-admin/routes.ts';
import {registerChatCompactionCheckpoints} from './conversations/chat-compaction-checkpoint-route.ts';
import {reserveOrdinarySteeringCustody} from './harness/ordinary-steering-custody.ts';
import {registerOrdinarySteeringBinding} from './conversations/ordinary-steering-binding.ts';
import {registerOrdinarySteeringHistory} from './conversations/ordinary-steering-history.ts';
import {registerOrdinaryRunHistory} from './conversations/ordinary-run-history.ts';
import {ConversationGoalControls} from './conversations/goal-controls.ts';
import {registerConversationGoalExecution} from './conversations/goal-control-execution.ts';
import {registerOrdinaryInputBinding} from './conversations/ordinary-input-binding.ts';
import {registerOrdinaryModelPolicy} from './conversations/model-policy.ts';
import {readHostModelCatalog,type ModelCatalogClient} from './harness/model-catalog.ts';
import {ConversationModes} from './conversations/modes.ts';
import {registerOrdinaryExecutionPolicy} from './conversations/execution-policy.ts';
import {registerOrdinaryChatContext} from './conversations/chat-context-route.ts';
import {registerOrdinaryChatWeb} from './conversations/chat-web-route.ts';
import type {ChatWebNetworkOptions} from './conversations/chat-web-effects.ts';
import {registerChatCompactionSource} from './conversations/chat-compaction-source-route.ts';
import {registerChatCompactionAttempts} from './conversations/chat-compaction-attempt-route.ts';
import type {ConversationModeClient} from './conversations/mode-policy.ts';
import {TaskReplyDrafts} from './persistent-tasks/reply-drafts.ts';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { openProductDatabase, withImmediateTransaction } from './db/database.ts';
import {canonicalJson} from './db/canonical-json.ts';
import {ArtifactCommandRecovery} from './artifacts/command-recovery.ts';
import { ConversationRepository } from './conversations/repository.ts';
import { ProjectRepository } from './projects/repository.ts';
import {GitWorkbench,type GitRepositoryBinding} from './git/service.ts';
import {registerGitRoutes} from './git/routes.ts';
import {GitMutationIntents} from './git/intents.ts';
import {registerGitReviewRoutes} from './git/review-routes.ts';
import {GitBranchIntents} from './git/branch-intents.ts';
import {GitCheckoutIntents} from './git/checkout-intents.ts';
import {registerGitCheckoutReviewRoutes} from './git/checkout-review-routes.ts';
import {registerGitBranchReviewRoutes} from './git/branch-review-routes.ts';
import {GitInitializationIntents} from './git/initialization-intents.ts';
import {registerGitInitializationReviewRoutes} from './git/initialization-review-routes.ts';
import {GitIndexExecutions} from './git/index-executions.ts';
import {gitCommitExecutionSchema} from './git/commit-execution-upgrade.ts';
import {registerGitExecutionHistoryRoutes} from './git/execution-history-routes.ts';
import {registerIndexDispatchRoutes} from './git/index-dispatch-routes.ts';
import {registerGitWorkspaceSource} from './git/workspace-source-route.ts';
import {WorkPublicationIntents} from './persistent-tasks/work-publication-intents.ts';
import {FinalizedWorkSources} from './persistent-tasks/finalized-work-sources.ts';
import {registerPublicationReviewRoutes} from './git/publication-review-routes.ts';
import {registerPublicationExecutionRoutes} from './git/publication-execution-routes.ts';
import {registerPublicationDispatchRoutes} from './git/publication-dispatch-routes.ts';
import type {NativeGitClient} from './git/native-transport-client.ts';
import {WorkPublicationExecutions} from './persistent-tasks/work-publication-executions.ts';
import {readTerminalWaitReceipt,replayTerminalWaitReceipt} from './terminal/wait-receipts.ts';
import {validateTerminalCommand} from './terminal/control.js';
import {registerTerminalStreamRoutes,type TerminalStreamClient} from './terminal/stream-routes.ts';
import {registerTerminalReceiptRoutes} from './terminal/receipt-routes.ts';
import {registerTerminalControlRoutes,type TerminalControlClient} from './terminal/control-routes.ts';
import {registerTerminalInventoryRoutes,type TerminalInventoryClient} from './terminal/inventory-routes.ts';
import { EventStore, ExpiredCursorError, FutureCursorError } from './events/event-store.ts';
import { RunRepository } from './runs/repository.ts';
import {readRunRuntimeDiagnostics} from './events/runtime-diagnostics.ts';
import { buildSnapshot } from './events/snapshot.ts';
import { EmotionAdvisor, taskEmotionEvent, userEmotionSignal, emotionAccountingRoutesFromPolicy, type EmotionAccounting } from './harness/emotion-advisor.ts';
import { RunCommandService } from './runs/commands.ts';
import { InteractionService } from './interactions/service.ts';
import {TaskWaitResponder} from './persistent-tasks/task-wait.ts';
import {TaskReviewOutputs} from './persistent-tasks/review-outputs.ts';
import { ArtifactService } from './artifacts/service.ts';
import type {ArtifactArchiveExecutor} from './artifacts/archive-executor.ts';
import { createReadStream, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { SourceRepository } from './sources/repository.ts';
import { ContractValidator } from './contracts/validator.ts';
import { ChannelIntakeService } from './channels/intake.ts';
import {registerChannelAttachmentIntakeV2,isChannelAttachmentIntakeV2Route} from './channels/attachment-routes-v2.ts';
import {requireChannelAttachmentInputReadiness,assertChannelAttachmentInputClient} from './channels/attachment-config-v2.ts';
import {enableChannelAttachmentProtocolV2,channelAttachmentProtocolV2Installed} from './channels/attachment-protocol-migration-v2.ts';
import { isQQWebhookRequestAuthenticated, registerQQRoutes } from './channels/qq-routes.ts';
import {isTwilioSmsWebhookRequest,registerTwilioSmsRoutes} from './channels/sms-routes.ts';
import { createSlackWebhookAdapter, type SlackTransport } from './channels/slack.ts';
import { createSlackInteractionReplyHandler } from './channels/slack-interactions.ts';
import { slackWebhookRoutes } from './channels/slack-routes.ts';
import type { SlackWebhookRuntimeConfig } from './channels/provider-config.ts';
import {OwnerChannelBindings} from './channels/owner-bindings.ts';
import { installChannelAuthorityMigration } from './channels/authority-migration.ts';
import {EmailChannelBindings} from './channels/email-bindings.ts';
import {PushSubscriptions} from './channels/push-subscriptions.ts';
import { FileJobService } from './file-engine/jobs.ts';
import { TemplateCatalog, TemplateContractError } from './file-engine/templates.ts';
import { CrawlBatchService } from './crawl-batch/service.ts';
import { ChannelDeliveryService } from './channels/delivery.ts';
import { VoiceTranscriptionService } from './voice/service.ts';
import type { VoiceAdapter } from './voice/adapter-client.ts';
import { VOICE_MAX_BYTES, validateVoiceWave } from './voice/wav.ts';
import { WorkbenchService } from './workbench/service.ts';
import type {MemoryReasoningClient} from './workbench/memory-reasoning-client.ts';
import { WorkspaceCheckpointService } from './workbench/workspace-checkpoints.ts';
import {DiscoveryPolicies} from './always-on/discovery-policy.ts';
import {createNativeWorkRuntime} from './always-on/native-work-runtime.ts';
import {readIsolatedTaskFileVersion} from './persistent-tasks/isolated-output-source.ts';
import {registerDiscoveryPolicyRoutes} from './always-on/discovery-policy-routes.ts';
import {DiscoveryHistory} from './always-on/discovery-history.ts';
import {registerDiscoveryHistoryRoutes} from './always-on/discovery-history-routes.ts';
import {configureTaskOutputReader} from './persistent-tasks/output-content.ts';
import {configureTaskOutputDelivery} from './persistent-tasks/output-delivery.ts';
import { registerWorkbenchRoutes } from './workbench/routes.ts';
import { registerWorkbenchMcpRoutes } from './workbench/mcp-routes.ts';
import { McpRegistryService } from './workbench/mcp-registry.ts';
import { listUnknownMcpOperations } from './workbench/mcp-execution.ts';
import { PersistentTaskService } from './persistent-tasks/service.ts';
import {TaskNotifications} from './persistent-tasks/notifications.ts';
import {TaskReplyPolicies} from './persistent-tasks/reply-policy.ts';
import {TaskReplyHistory} from './persistent-tasks/reply-history.ts';
import { registerPersistentTaskRoutes } from './persistent-tasks/routes.ts';
import {TaskPrdService} from './persistent-tasks/prd.ts';
import type {TaskmasterInstallationClient} from './persistent-tasks/taskmaster-installation.ts';
import {registerTaskPrdRoutes} from './persistent-tasks/prd-routes.ts';
import {TaskDelegationService} from './workbench/task-delegation.ts';
import {TaskCollaborationService} from './workbench/task-collaboration.ts';
import { registerWorkbenchExecution, WORKBENCH_TOOL_IDS } from './workbench/execution.ts';
import type {ReplyJudgeClient} from './persistent-tasks/reply-judge-client.ts';
import { ModelBudgetLedger, type ModelBudgetRoute } from './workbench/model-budget.ts';
import { WorkbenchBudgetPolicy, type ModelBudgetPolicyConfig } from './workbench/model-budget-policy.ts';
import { TaskBudgetService, registerTaskBudgetRoutes } from './workbench/budget-public.ts';
import {createAuxiliaryRunGuard} from './workbench/auxiliary-run-guard.ts';
import {registerConversationGoalRoutes,type ConversationGoalClient} from './conversations/goal-routes.ts';
import {SkillCatalogService,type SkillCatalogHost} from './skills/catalog.ts';
import {registerSkillCatalogRoutes} from './skills/catalog-routes.ts';
import {registerNativeCommandQueryRoutes,registerNativePlanModeRoutes} from './skills/command-query-routes.ts';
import {AttachmentResolver} from './artifacts/resolver.ts';
import {attachmentKindForMime} from './artifacts/pinned-manifest.ts';
import {readAttachmentSteeringReadiness,type OrdinaryAttachmentSteeringClient} from './harness/ordinary-attachment-readiness.ts';
import {ConversationForks,installConversationForks} from './harness/conversation-fork.ts';
import {registerConversationForkRoutes,registerConversationForkContextRoute} from './harness/conversation-fork-routes.ts';
import type {NativeMemberControlClient} from './workbench/native-member-owner-controls.ts';
import {createConversationForkSourceReader} from './harness/conversation-fork-source.ts';
import {prepareForkAttachmentClones} from './harness/conversation-fork-attachments.ts';
import {observeBrowserActionReadiness} from './events/browser-driver-readiness.ts';

type GatewayIngressMode = 'standalone-local' | 'public-api';
const MAX_OWNER_PRINCIPAL_EXPIRY_EPOCH_SECONDS = 253_402_300_799; // 9999-12-31T23:59:59Z
type VerifiedOwnerPrincipal = { ownerId: string; issuer: string; subject: string; /** Unix epoch seconds, never milliseconds. */ expiresAtEpochSeconds: number };
type VerifiedOwnerPrincipalResolver = {
  /** Server-only verifier. It must derive ownerId from a trusted issuer/session, never from x-user-id. */
  resolve(request: { headers: Record<string, unknown> }): VerifiedOwnerPrincipal | null;
};

function headerActor(request: { headers: Record<string, unknown> }) {
  const id = String(request.headers['x-user-id'] || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('unauthorized');
  return id;
}

function verifiedPrincipalActor(request: { headers: Record<string, unknown> }, resolver: VerifiedOwnerPrincipalResolver) {
  let principal: VerifiedOwnerPrincipal | null;
  try { principal = resolver.resolve(request); } catch { throw new Error('unauthorized'); }
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  if (!principal
    || typeof principal.ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principal.ownerId)
    || typeof principal.issuer !== 'string' || !principal.issuer.trim() || principal.issuer.length > 512
    || typeof principal.subject !== 'string' || !principal.subject.trim() || principal.subject.length > 512
    || !Number.isSafeInteger(principal.expiresAtEpochSeconds)
    || principal.expiresAtEpochSeconds <= nowEpochSeconds
    || principal.expiresAtEpochSeconds > MAX_OWNER_PRINCIPAL_EXPIRY_EPOCH_SECONDS) {
    throw new Error('unauthorized');
  }
  return principal.ownerId;
}

export async function buildServer(config: {
  officePreviewOwnerId?:string;
  channelAttachmentIntakeV2?:boolean;
  modelCatalogClient?:ModelCatalogClient;
  conversationModeClient?:ConversationModeClient;
  chatModeEnabled?:boolean;
  ordinarySteeringEnabled?:boolean;
  ordinaryInputRecoveryEnabled?:boolean;
  mattermostOwnerBinding?:{instance:string;botUserId:string};
  matrixOwnerBindingEnabled?:boolean;
  ordinaryAttachmentSteeringEnabled?:boolean;
  ordinaryAttachmentSteeringClient?:OrdinaryAttachmentSteeringClient;
  chatWebNetwork?:ChatWebNetworkOptions;
  workAgentPreset?:string;
  databasePath: string;
  workspaces: string[];
  ingressMode?: GatewayIngressMode;
  ownerPrincipalResolver?: VerifiedOwnerPrincipalResolver;
  pluginProfileClient?:PluginProfileClient;
  hostAdmin?:{enabled?:boolean;namespaces?:string[];client?:HostSettingsClient;writeEnabled?:boolean;writeNamespace?:string};
  uploadRoot?: string;
  artifactArchiveExecutor?:ArtifactArchiveExecutor;
  csrfToken?: string;
  allowedOrigins?: string[];
  internalChannelToken?: string;
  qqWebhook?: { appId: string; botSecret: string };
  smsWebhook?: {accountSid:string;authToken:string;webhookUrl:string;apiKeySid:string;apiKeySecret:string};
  slackWebhook?: SlackWebhookRuntimeConfig;
  slackTransport?: SlackTransport;
  emailBindingSend?: (text:string,recipient:string)=>Promise<Record<string,unknown>>;
  webPushVapid?: {publicKey:string;generation:string};
  templateRoot?: string;
  voiceEnabled?: boolean;
  voiceAdapter?: VoiceAdapter;
  workbenchRoot?: string;
  nativeWorkRoot?: string;
  gitRepositories?:GitRepositoryBinding[];
  gitExecutable?:string;
  nativeGitClient?:NativeGitClient;
  workbenchExecutionReady?: boolean;
  modelBudgetRoutes?: ModelBudgetRoute[];
  modelBudgetPolicy?: ModelBudgetPolicyConfig | undefined;
  replyJudge?: ReplyJudgeClient;
  /** Trusted, budgeted host client; request payloads cannot choose a provider. */
  memoryReasoningClient?:MemoryReasoningClient;
  conversationGoalClient?: ConversationGoalClient;
  nativeMemberClient?:NativeMemberControlClient;
  nativeSearchSourceClient?:NativeSearchSourceClient;
  terminalInventoryClient?:TerminalInventoryClient;
  terminalControlClient?:TerminalControlClient;
  terminalStreamClient?:TerminalStreamClient;
  taskmasterInstallationClient?:TaskmasterInstallationClient;
  skillCatalogClient?: SkillCatalogHost;
  conversationForkSourceClient?:{inspectConversationForkSource(sessionId:string,signal?:AbortSignal):Promise<unknown>};
  conversationGoalResumeEnabled?:boolean;
  /** Server-only trusted provider configuration; never populated from request bodies. */
  emotion?: {env?:NodeJS.ProcessEnv;transport?:typeof fetch;accountingRoutes?:EmotionAccounting['routes']};
}) {

  if(config.officePreviewOwnerId!==undefined&&(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.officePreviewOwnerId)
    ||!config.csrfToken||config.csrfToken.length<16||!config.allowedOrigins?.length))throw Error('office_preview_owner_configuration_invalid');
  if(config.hostAdmin?.writeEnabled&&config.hostAdmin.enabled!==true)throw Error('host_settings_write_configuration_invalid');
  const ingressMode = config.ingressMode ?? 'standalone-local';
  if (ingressMode !== 'standalone-local' && ingressMode !== 'public-api') throw new Error('config_ingress_mode_invalid');
  if (ingressMode === 'public-api' && typeof config.ownerPrincipalResolver?.resolve !== 'function') throw new Error('config_public_api_identity_required');
  if (ingressMode === 'public-api'
    && (typeof config.csrfToken !== 'string' || config.csrfToken.length < 16
      || !Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0
      || config.allowedOrigins.some(origin => typeof origin !== 'string' || !origin.trim()))) {
    throw new Error('config_public_api_browser_protection_required');
  }
  const ownerByRequest = new WeakMap<object, string>();
  const actor = (request: { headers: Record<string, unknown> }) => {
    const bound = ownerByRequest.get(request);
    if (bound) return bound;
    const owner = ingressMode === 'public-api'
      ? verifiedPrincipalActor(request, config.ownerPrincipalResolver!)
      : headerActor(request);
    ownerByRequest.set(request, owner);
    return owner;
  };

  if(config.matrixOwnerBindingEnabled!==undefined&&typeof config.matrixOwnerBindingEnabled!=='boolean')throw Error('matrix_binding_configuration_invalid');
  let channelAttachmentInputReady=false;
  if(config.channelAttachmentIntakeV2!==undefined&&typeof config.channelAttachmentIntakeV2!=='boolean')throw Error('channel_attachment_configuration_invalid');
  if(config.channelAttachmentIntakeV2===true){
    if(config.ordinaryInputRecoveryEnabled!==true||!config.internalChannelToken||config.internalChannelToken.length<16)throw Error('channel_attachment_original_recovery_required');
    assertChannelAttachmentInputClient(config.conversationGoalClient);
    try{await requireChannelAttachmentInputReadiness(config.conversationGoalClient);channelAttachmentInputReady=true;}catch{/* Original SQL receipts remain readable during a native outage. */}
  }
  if(config.slackWebhook?.attachmentBotToken&&!channelAttachmentInputReady)throw Error('channel_attachment_native_recovery_unavailable');
  for(const value of [config.ordinarySteeringEnabled,config.ordinaryInputRecoveryEnabled,config.ordinaryAttachmentSteeringEnabled]){if(value!==undefined&&typeof value!=='boolean')throw Error('ordinary_steering_configuration_invalid');}
  if(config.ordinarySteeringEnabled===true&&config.ordinaryInputRecoveryEnabled!==true)throw Error('ordinary_steering_recovery_required');
  if(config.ordinaryAttachmentSteeringEnabled===true&&(config.ordinarySteeringEnabled!==true||config.ordinaryInputRecoveryEnabled!==true||typeof config.ordinaryAttachmentSteeringClient?.steeringAttachmentsReadiness!=='function'))throw Error('ordinary_attachment_steering_configuration_invalid');
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const eventStreamClosers=new Set<()=>void>();
  app.addHook('preClose',async()=>{for(const close of [...eventStreamClosers])close();});
  await app.register(multipart, { limits: { fileSize: VOICE_MAX_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 256 } });
  const db = openProductDatabase(config.databasePath);
  try {
  const budgetPolicy = config.modelBudgetPolicy === undefined ? undefined : new WorkbenchBudgetPolicy(db,config.modelBudgetPolicy);
  const modelBudgets = budgetPolicy?.ledger ?? (config.modelBudgetRoutes === undefined ? undefined : new ModelBudgetLedger(db,{routes: config.modelBudgetRoutes}));
  if(config.memoryReasoningClient&&!modelBudgets)throw new Error('memory_reasoning_budget_required');
  const events = new EventStore(db);
  const projects = new ProjectRepository(db);
  const gitWorkbench=new GitWorkbench(projects,config.gitRepositories??[],config.gitExecutable);
  const gitReviewIntents=new GitMutationIntents(db,projects,gitWorkbench);
  const gitBranchIntents=new GitBranchIntents(db,projects,gitWorkbench);
  const gitInitializationIntents=new GitInitializationIntents(db,projects,gitWorkbench);
  const conversations = new ConversationRepository(db, projects);
  let conversationForks:ConversationForks|undefined;
  if(config.conversationForkSourceClient){
    installConversationForks(db);
    conversationForks=new ConversationForks(db,{
      prepareAttachments:(scope,pins,key,signal)=>prepareForkAttachmentClones(db,config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads'),scope,pins,key,signal),
      readSource:createConversationForkSourceReader(db,{inspect:(sessionId,signal)=>config.conversationForkSourceClient!.inspectConversationForkSource(sessionId,signal)}),
      verifyAttachments:async(scope,pins,signal)=>{
        const resolver=new AttachmentResolver(db,config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads'));
        const lease=`fork-verify-${randomUUID()}`;
        try{
          for(const pin of pins)await resolver.resolvePinnedForMessage(scope.owner_id,scope.conversation_id,{protocol:1,attachments:[{...pin,kind:attachmentKindForMime(pin.media_type)}]},lease,signal);
        }finally{resolver.releaseLease(lease);}
      },
    });
  }
  const runs = new RunRepository(db, events,{workAgentPreset:config.workAgentPreset??'jot-general',officePrintProofKey:config.internalChannelToken});
  const conversationModes=new ConversationModes(db,conversations,runs,config.conversationModeClient,config.chatModeEnabled===true,config.modelCatalogClient);
  const commands = new RunCommandService(db, events);
  const artifactRoot=config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads');
  const archiveExecutor=config.artifactArchiveExecutor;
  if(archiveExecutor&&(resolve(archiveExecutor.binding.databasePath)!==resolve(config.databasePath)
    ||resolve(archiveExecutor.binding.fileRoot)!==resolve(artifactRoot)))throw Error('config_artifact_archive_binding_mismatch');
  const archiveStatus=()=>archiveExecutor?.status()??{mode:'external' as const,state:'unmanaged' as const};
  if(archiveExecutor){
    app.addHook('onReady',async()=>archiveExecutor.start());
    app.addHook('preClose',async()=>archiveExecutor.close());
    app.addHook('onClose',async()=>archiveExecutor.close());
  }
  const artifacts = new ArtifactService(db,artifactRoot);
  try{artifacts.cleanupExpiredUploads();}catch(error){app.log.error(error);}
  const uploadExpirySweep=setInterval(()=>{try{artifacts.cleanupExpiredUploads();}catch(error){app.log.error(error);}},60_000);
  uploadExpirySweep.unref();
  app.addHook('onClose',async()=>clearInterval(uploadExpirySweep));
  const sources = new SourceRepository(db);
  const contracts = new ContractValidator();
  const artifactCommands = new ArtifactCommandRecovery(db,artifacts,contracts);
  const ownerChannels=new OwnerChannelBindings(db,{enabled:[...(config.internalChannelToken?['wecom',...(config.matrixOwnerBindingEnabled===true?['matrix']:[]),...(config.mattermostOwnerBinding?['mattermost']:[]),...(config.slackWebhook?['slack']:[])]:[]),...(config.smsWebhook?['sms']:[])],...(config.mattermostOwnerBinding?{mattermost:config.mattermostOwnerBinding}:{})});
  installChannelAuthorityMigration(db);
  const channelIntake = new ChannelIntakeService(db, runs, config.workspaces[0] ?? 'jot', ownerChannels);
  if(channelAttachmentInputReady){enableChannelAttachmentProtocolV2(db);artifacts.cleanupExpiredChannelUploads();}
  const emailBindings=new EmailChannelBindings(db,config.emailBindingSend?{send:config.emailBindingSend}:{});
  const pushSubscriptions=config.webPushVapid?new PushSubscriptions(db,config.webPushVapid):undefined;
  const fileJobs = new FileJobService(db);
  const templates = new TemplateCatalog(config.templateRoot ?? resolve(process.cwd(), 'file-engine/templates'));
  const channelDelivery = new ChannelDeliveryService(db);
  const crawlBatches = new CrawlBatchService(db, events, channelDelivery);
  const voiceTranscriptions = new VoiceTranscriptionService(db,
    config.voiceEnabled ? config.voiceAdapter : undefined);
  const workbenchRoot = config.workbenchRoot ?? join(dirname(config.databasePath), 'jot-workspaces');
  const workbench = new WorkbenchService(db, { workspaceIds: config.workspaces,
    root: workbenchRoot, allowedToolIds: WORKBENCH_TOOL_IDS,modelMetadataClient:config.modelCatalogClient, ...(budgetPolicy ? {modelBudgetPolicy: budgetPolicy} : {}) });
  const mcpRegistry = new McpRegistryService(db, workbench);
  const checkpointRoot=join(realpathSync(workbenchRoot),'workspace-checkpoints');
  try{mkdirSync(checkpointRoot,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const checkpointRootStat=lstatSync(checkpointRoot);
  if(checkpointRootStat.isSymbolicLink()||!checkpointRootStat.isDirectory()||realpathSync(checkpointRoot)!==checkpointRoot)throw Error('workspace_checkpoint_storage_invalid');
  const workspaceCheckpoints=new WorkspaceCheckpointService(db,workbench,{storageRoot:checkpointRoot});
  configureTaskOutputReader(db,input=>input.source?.source==='isolated'?readIsolatedTaskFileVersion(db,input.source):workbench.readFileVersion(input.owner,input.workspace,input.project,input.path,input.version,input.runId));
  configureTaskOutputDelivery(db,artifacts,events);
  const taskWaitResponder=new TaskWaitResponder(db,workbench,commands);
  const nativeWork=createNativeWorkRuntime({db,workbench,...(config.nativeWorkRoot!==undefined?{root:config.nativeWorkRoot}:{}),executionReady:config.workbenchExecutionReady===true,...(budgetPolicy?{budgetPolicy}:{})});

  const persistentTasks = new PersistentTaskService(db, workbench, {
    projectionRoot: join(workbenchRoot, 'tasks'), events,
    ...(budgetPolicy?{modelBudgetPolicy:budgetPolicy}:{}),
    ...(nativeWork?{discoveryWorkOperations:nativeWork}:{}),
  });
  const taskNotifications=new TaskNotifications(db);
  const taskPrd=new TaskPrdService(db,workbench,persistentTasks,artifacts,{uploadRoot:config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads'),mcpRegistry,projectSource:gitWorkbench,...(nativeWork?{handoffCommands:commands,workResources:nativeWork}:{}),...(config.taskmasterInstallationClient?{installationClient:config.taskmasterInstallationClient}:{})});
  const taskReplyPolicies=new TaskReplyPolicies(db);
  const replyDrafts=new TaskReplyDrafts(db,events);
  const replyHistory=new TaskReplyHistory(db);
  const taskInteractionResponder={
    resolve:(row:Record<string,unknown>,owner:string,status:string,input:Record<string,unknown>,key:string)=>replyDrafts.resolve(row,owner,status,input,key)||taskWaitResponder.resolve(row,owner,status,input,key),
    recordReceipt:(row:Record<string,unknown>,input:unknown,key:string,operation:string,receipt:Record<string,unknown>)=>replyDrafts.owns(String(row.id))?replyDrafts.recordReceipt(row,input,key,operation,receipt):taskWaitResponder.recordReceipt(row,input,key,operation,receipt),
  };
  const interactions = new InteractionService(db,events,taskInteractionResponder);
  const idempotencyRequests = new WeakMap<object, { owner: string; operation: string; key: string }>();
  const isArtifactArchiveRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/artifacts/:artifactId/archive';
  const isArtifactRestoreRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/artifacts/:artifactId/restore';
  const isUploadCancelRoute=(request:any)=>request.method==='DELETE'&&['/v1/uploads/:uploadId','/v1/upload-batches/:batchId'].includes(request.routeOptions.url);
  const isUploadRoute=(request:any)=>isUploadCancelRoute(request)||['/v1/conversations/:conversationId/uploads','/v1/conversations/:conversationId/upload-batches','/v1/uploads/:uploadId/content','/v1/uploads/:uploadId/complete'].includes(request.routeOptions.url);
  const isMemoryImportRoute=(request:any)=>request.method==='POST'&&['/v1/workspaces/:workspaceId/memory/import/preview','/v1/workspaces/:workspaceId/memory/import/:importId/apply'].includes(request.routeOptions.url);
  const isMemoryRestoreRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/workspaces/:workspaceId/memory/:memoryId/restore';
  const isMemoryConsolidationRoute=(request:any)=>request.method==='POST'&&['/v1/workspaces/:workspaceId/memory-consolidations',...['propose','apply','rollback','reject'].map(action=>`/v1/workspaces/:workspaceId/memory-consolidations/:consolidationId/${action}`)].includes(request.routeOptions.url);
  const isMemoryCaptureRoute=(request:any)=>(request.method==='PATCH'&&request.routeOptions.url==='/v1/agents/:agentId/memory-capture-policy')||(request.method==='POST'&&['/v1/agents/:agentId/memory-capture-policy/collect',...['apply','reject','reconcile'].map(action=>`/v1/agents/:agentId/memory-captures/:captureId/${action}`)].includes(request.routeOptions.url));
  const isMemoryBrainRoute=(request:any)=>request.method==='POST'&&['/v1/workspaces/:workspaceId/brain-publications/preview',...['apply','reject'].map(action=>`/v1/workspaces/:workspaceId/brain-publications/:publicationId/${action}`)].includes(request.routeOptions.url);
  const isMemoryDreamPolicyRoute=(request:any)=>request.method==='PATCH'&&request.routeOptions.url==='/v1/agents/:agentId/memory-dream-policy';
  const isGoalResumeRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/conversations/:conversationId/goal'&&request.body?.action==='resume';
  const isDiscoveryPolicyRoute=(request:any)=>(request.method==='PATCH'&&request.routeOptions.url==='/v1/agents/:agentId/discovery-policy')||(request.method==='POST'&&request.routeOptions.url==='/v1/agents/:agentId/discovery-policy/control');
  const isModeMutationRoute=(request:any)=>request.method==='POST'&&['/v1/conversations','/v1/conversations/:conversationId/messages'].includes(request.routeOptions.url)||request.method==='PATCH'&&request.routeOptions.url==='/v1/conversations/:conversationId'&&request.body?.mode!==undefined;
  const isRunCommandRoute=(request:any)=>request.method==='POST'&&['/v1/runs/:runId/steer','/v1/runs/:runId/cancel'].includes(request.routeOptions.url);
  const isWorkspaceSelectionRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/workspaces/selection';
  const isProjectMutationRoute=(request:any)=>request.method==='POST'&&['/v1/projects','/v1/projects/:projectId/lifecycle'].includes(request.routeOptions.url)||request.method==='PATCH'&&request.routeOptions.url==='/v1/projects/:projectId';
  const isGitReviewRoute=(request:any)=>request.method==='POST'&&['/v1/projects/:projectId/git/intents','/v1/projects/:projectId/git/intents/:intentId/control','/v1/projects/:projectId/git/branch-intents','/v1/projects/:projectId/git/branch-intents/:intentId/control','/v1/projects/:projectId/git/initialization-intents','/v1/projects/:projectId/git/initialization-intents/:intentId/control','/v1/projects/:projectId/git/checkout-intents','/v1/projects/:projectId/git/checkout-intents/:intentId/control'].includes(request.routeOptions.url);
  const isIndexAdmissionRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/projects/:projectId/git/intents/:intentId/admissions';
  const isIndexTransportRoute=(request:any)=>request.method==='POST'&&['/v1/projects/:projectId/git/executions/:executionId/dispatch','/v1/projects/:projectId/git/executions/:executionId/resolve'].includes(request.routeOptions.url);
  const isIndexControlAdmissionRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/projects/:projectId/git/executions/:executionId/controls';
  const isPublicationReviewRoute=(request:any)=>request.method==='POST'&&['/v1/projects/:projectId/work-publications','/v1/projects/:projectId/work-publications/:intentId/control'].includes(request.routeOptions.url);
  const isPublicationAdmissionRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/projects/:projectId/work-publications/:intentId/admissions';
  const isFileLifecycleRoute=(request:any)=>request.method==='POST'&&['/v1/workspaces/:workspaceId/files/rename','/v1/workspaces/:workspaceId/files/delete'].includes(request.routeOptions.url);
  const isPublicationTransportRoute=(request:any)=>request.method==='POST'&&['/v1/projects/:projectId/work-publication-executions/:executionId/dispatch','/v1/projects/:projectId/work-publication-executions/:executionId/settle'].includes(request.routeOptions.url);
  const isConversationForkRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/conversations/:conversationId/fork';
  const isMcpMutationRoute=(request:any)=>['POST /v1/agents/:agentId/mcp/connections','PATCH /v1/agents/:agentId/mcp/connections/:connectionId/config','PATCH /v1/agents/:agentId/mcp/connections/:connectionId/enabled','PUT /v1/agents/:agentId/mcp/connections/:connectionId/tools','POST /v1/agents/:agentId/mcp/connections/:connectionId/reload','DELETE /v1/agents/:agentId/mcp/connections/:connectionId'].includes(`${request.method} ${request.routeOptions.url}`);
  const persistentTaskMutationRoutes = new Set([
    'POST /v1/persistent-tasks',
    'PATCH /v1/persistent-tasks/:taskId',
    'POST /v1/persistent-tasks/:taskId/pause',
    'POST /v1/persistent-tasks/:taskId/resume',
    'POST /v1/persistent-tasks/:taskId/archive',
    'POST /v1/persistent-tasks/:taskId/run-now',
    'POST /v1/persistent-tasks/:taskId/occurrences/:occurrenceId/cancel',
    'POST /v1/persistent-tasks/:taskId/subtasks',
    'PATCH /v1/persistent-tasks/:taskId/collaboration',
    'POST /v1/persistent-tasks/:taskId/delegations',
    'POST /v1/persistent-tasks/:taskId/prd/taskmaster-import',
    'POST /v1/persistent-tasks/:taskId/prd/template-apply',
    'POST /v1/persistent-tasks/:taskId/prd/taskmaster-prd-import',
    'POST /v1/persistent-tasks/:taskId/prd/work-plan-accept',
    'POST /v1/persistent-tasks/:taskId/prd/work-plan-cycle',
    'POST /v1/persistent-tasks/:taskId/prd/work-plan-handoff',
    'POST /v1/persistent-tasks/:taskId/prd/work-plan-prepare',
    'POST /v1/persistent-tasks/:taskId/prd/work-plan-grant',
    'POST /v1/persistent-tasks/:taskId/prd/work-plan-admit',
  ]);
  const isPersistentTaskMutationRoute=(request:any)=>persistentTaskMutationRoutes.has(`${request.method} ${request.routeOptions.url}`);
  const isPluginProfileMutationRoute=(request:any)=>request.routeOptions.config?.pluginProfileMutation===true;
  const atomicProtocol=(request:any)=>isArtifactArchiveRoute(request)?'artifact-archive-atomic-v1':isArtifactRestoreRoute(request)?'artifact-restore-atomic-v2':isPluginProfileMutationRoute(request)?PLUGIN_PROFILE_RECEIPT_PROTOCOL:isPersistentTaskMutationRoute(request)?'persistent-task-atomic-v1':isWorkspaceSelectionRoute(request)?'workspace-selection-atomic-v1':isProjectMutationRoute(request)?'project-metadata-atomic-v1':isConversationForkRoute(request)?'conversation-fork-atomic-v1':isFileLifecycleRoute(request)?'file-lifecycle-atomic-v1':isIndexAdmissionRoute(request)?'git-index-admission-atomic-v1':isIndexControlAdmissionRoute(request)?'git-index-control-admission-atomic-v1':isPublicationAdmissionRoute(request)?'work-publication-admission-atomic-v1':isPublicationReviewRoute(request)?'work-publication-review-atomic-v1':isGitReviewRoute(request)?'git-review-atomic-v1':isRunCommandRoute(request)?'run-command-atomic-v1':isModeMutationRoute(request)?'conversation-mode-atomic-v1':isDiscoveryPolicyRoute(request)?'discovery-policy-atomic-v1':isGoalResumeRoute(request)?'conversation-goal-resume-atomic-v1':isMcpMutationRoute(request)?'workbench-mcp-atomic-v1':isUploadRoute(request)?'upload-atomic-v1':isMemoryImportRoute(request)?'memory-import-atomic-v1':isMemoryRestoreRoute(request)?'memory-restore-atomic-v1':isMemoryConsolidationRoute(request)?'memory-consolidation-atomic-v1':isMemoryBrainRoute(request)?'memory-brain-atomic-v1':isMemoryCaptureRoute(request)?'memory-capture-atomic-v1':isMemoryDreamPolicyRoute(request)?'memory-dream-policy-atomic-v1':null;
  const readBrainReceipt=(request:any,owner:string,value:unknown)=>{
    const receipt=value as {publication_id?:unknown}|null;
    if(!receipt||typeof receipt.publication_id!=='string')throw Error('brain_publication_receipt_invalid');
    return workbench.memoryBrain.get(owner,String(request.params.workspaceId),receipt.publication_id);
  };
  const assertGitReceiptOwner=(request:any,owner:string)=>{
    const route=request.routeOptions.url;
    if(typeof route==='string'&&route.startsWith('/v1/projects/:projectId/git/'))projects.get(String(request.params.projectId),owner);
  };
  // Receipt protocol is reserved with the original request. Legacy pending rows
  // have no proof of an atomic business boundary and must not be re-executed.
  const atomicCommand=<T>(request:any,status:number,operation:()=>T):T=>{
    const pending=idempotencyRequests.get(request),protocol=atomicProtocol(request);
    const value=withImmediateTransaction(db,()=>{
      if(pending){
        const cached=db.prepare('SELECT response_status,response_json,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(pending.owner,pending.operation,pending.key) as Record<string,unknown>|undefined;
        if(!protocol||!cached||cached.receipt_protocol!==protocol)throw new Error('idempotency_in_progress');
        if(cached.response_status!==null){assertGitReceiptOwner(request,pending.owner);if(cached.response_status!==status)throw new Error('idempotency_conflict');const saved=JSON.parse(String(cached.response_json));return (isMemoryBrainRoute(request)?readBrainReceipt(request,pending.owner,saved):saved) as T;}
      }
      if(isArtifactArchiveRoute(request)||isArtifactRestoreRoute(request)){
        if(!pending)throw new Error('idempotency_in_progress');
        artifactCommands.assertOpen(pending.owner,pending.operation,pending.key);
      }
      const registeredRoute=request.routeOptions.url;
      if(typeof registeredRoute!=='string')throw new Error('contract_response_invalid');
      const result=operation(),operationId=contracts.operationFor(request.method,registeredRoute);
      if(!operationId||!contracts.validateResponse(operationId,status,result??null).valid)throw new Error('contract_response_invalid');
      if(pending&&db.prepare('UPDATE ga_idempotency SET response_status=?,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=? AND response_status IS NULL AND receipt_protocol=?')
        .run(status,JSON.stringify(result??null),pending.owner,pending.operation,pending.key,protocol).changes!==1)throw new Error('idempotency_in_progress');
      return result;
    });
    idempotencyRequests.delete(request);return value;
  };
  if(conversationForks){
    registerConversationForkRoutes(app,{forks:conversationForks,actor,atomicCommand});
  }
  registerConversationForkContextRoute(app,{db,token:config.internalChannelToken,...(conversationForks?{forks:conversationForks}:{})});
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));

  app.addHook('preValidation', async request => {
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0];
    if (contentType === 'application/octet-stream' || contentType === 'multipart/form-data') return;
    const registeredRoute=request.routeOptions.url;
    const operationId=typeof registeredRoute==='string'?contracts.operationFor(request.method,registeredRoute):null;
    if (!operationId) return;
    const result = contracts.validateRequest(operationId, request.body);
    if (!result.valid) {
      if(operationId==='initUploadBatch'&&result.errors.some(error=>error.keyword==='maxItems'||error.keyword==='maximum'))throw new Error('upload_batch_limit_exceeded');
      throw new Error(operationId==='updateTaskNotifications'?'invalid_task_notification_settings':['createOwnerChannelBinding','revokeOwnerChannelBinding'].includes(operationId)?'invalid_channel_binding_request':operationId==='updateTaskModelBudget'?'budget_limit_invalid':'contract_request_invalid');
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    // These server-registered component routes verify their own mandatory bearer.
    if((request.routeOptions.config as {hostSettingsInternal?:boolean}).hostSettingsInternal===true)return;
    if((request.routeOptions.config as {pluginProfileInternal?:boolean}).pluginProfileInternal===true)return;
    if((request.routeOptions.config as {hookExecutionInternal?:boolean}).hookExecutionInternal===true)return;
    if((request.routeOptions.config as {skillReadInternal?:boolean}).skillReadInternal===true)return;
    // Original service bearer already ran in this registered route's onRequest.
    if(isChannelAttachmentIntakeV2Route(request))return;
    // The provider callback is public only behind its exact-URL Twilio signature check.
    if(isTwilioSmsWebhookRequest(request))return;
    // This exact internal route retains its mandatory service bearer check.
    if(['/internal/v1/workbench/chat-compaction-attempt','/internal/v1/workbench/chat-compaction-checkpoint','/internal/v1/workbench/git-workspace-source','/internal/v1/workbench/native-workspace-admission','/internal/v1/workbench/native-git-database','/hooks/v1/channels/slack'].includes(request.url.split('?')[0]!))return;
    if (['/internal/v1/workbench/chat-compaction-source', '/internal/v1/workbench/ordinary-chat-web', '/internal/v1/workbench/ordinary-chat-context', '/internal/v1/workbench/ordinary-fork-context', '/internal/v1/workbench/ordinary-execution-policy', '/internal/v1/workbench/ordinary-run-history', '/internal/v1/workbench/ordinary-steering-history', '/internal/v1/workbench/ordinary-steering-binding', '/internal/v1/workbench/ordinary-input-binding', '/internal/v1/workbench/ordinary-model-policy', '/internal/v1/workbench/conversation-goal-control', '/internal/v1/channel/messages', '/internal/v1/channel/mattermost/proof-receipt', '/internal/v1/channel/mattermost/event-receipt', '/internal/v1/file-tools', '/internal/v1/crawl-batches/bind', '/internal/v1/crawl-batches/events', '/internal/v1/workbench/guard','/internal/v1/workbench/mcp-current','/internal/v1/workbench/mcp-prepare','/internal/v1/workbench/mcp-settle', '/internal/v1/workbench/handoff', '/internal/v1/workbench/native-task-intent', '/internal/v1/workbench/native-task-intents', '/internal/v1/workbench/native-child-reservation', '/internal/v1/workbench/native-child-request', '/internal/v1/workbench/native-child-abort', '/internal/v1/workbench/native-child-published', '/internal/v1/workbench/native-child-bind', '/internal/v1/workbench/native-child-close', '/internal/v1/workbench/native-child-activities', '/internal/v1/workbench/native-child-activate', '/internal/v1/workbench/native-child-source', '/internal/v1/workbench/native-model-recovery', '/internal/v1/workbench/tool', '/internal/v1/workbench/browser-approval', '/internal/v1/workbench/context-delivery', '/internal/v1/workbench/goal-binding', '/internal/v1/workbench/model-budget','/internal/v1/workbench/web-budget-grant','/internal/v1/workbench/web-budget-grant/close','/internal/v1/workbench/web-model-budget','/internal/v1/workbench/checkpoint','/internal/v1/workbench/task-state','/internal/v1/workbench/step-admission','/internal/v1/workbench/goal-proposal','/internal/v1/workbench/completion-intent','/internal/v1/workbench/completion-confirm','/internal/v1/workbench/completion-recovery'].includes(request.url.split('?')[0]!)) return;
    if (isQQWebhookRequestAuthenticated(request)) return;
    if ((!config.csrfToken && !isPluginProfileMutationRoute(request)) || request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    actor(request as any);
    if(config.csrfToken){
      const origin = String(request.headers.origin ?? '');
      if (!(config.allowedOrigins ?? []).includes(origin)) throw new Error('origin_forbidden');
      const csrf = String(request.headers['x-csrf-token'] ?? '');
      if (config.csrfToken.length < 16 || csrf !== config.csrfToken) throw new Error('csrf_invalid');
    }
    // Host tickets and writes use the original Host context and attempt receipt.
    const hostReceipt=(request.routeOptions.config as {hostSettingsReceiptProtocol?:string}).hostSettingsReceiptProtocol;
    if(request.method==='PATCH'&&hostReceipt==='host-settings-original-attempt-v1')return;
    if(request.method==='POST'&&['/v1/host/bootstrap/redeem','/v1/host/settings/approval-requests'].includes(request.routeOptions.url??''))return;
    // Only these server-registered route markers use the PRD service's own
    // immutable transaction/receipt; previews and bounded observations stay transient.
    const prdCommand=(request.routeOptions.config as {taskPrdCommand?:string}).taskPrdCommand;
    if(request.method==='POST'&&['preview','bind','template-preview','project-prd-preview','runtime-version'].includes(prdCommand??''))return;
    // Preview only computes a schedule; retain authentication and CSRF without persisting requests.
    if (request.method === 'POST' && request.url.split('?')[0] === '/v1/persistent-tasks/preview') return;
    if ((request.routeOptions.url ?? request.url).includes('/voice/transcriptions')) return;
    if(isGitReviewRoute(request)||isIndexAdmissionRoute(request)||isIndexControlAdmissionRoute(request)||isIndexTransportRoute(request)||isPublicationReviewRoute(request)||isPublicationAdmissionRoute(request)||isPublicationTransportRoute(request)){
      projects.assertOwned(String((request.params as {projectId:string}).projectId),actor(request as any));
      if(isIndexAdmissionRoute(request)||isIndexControlAdmissionRoute(request)||isIndexTransportRoute(request))gitWorkbench.executionBinding(actor(request as any),String((request.params as {projectId:string}).projectId));
      reply.header('cache-control','private, no-store');
    }
    const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
    if (!/^[\x21-\x7E]{8,128}$/.test(idempotencyKey)) throw new Error('idempotency_key_invalid');
    if(request.method==='POST'&&request.routeOptions.url==='/v1/conversations/:conversationId/runs/:runId/terminals/commands'){
      const command=validateTerminalCommand(request.body),params=request.params as {conversationId:string;runId:string};
      if(idempotencyKey===command.request_id){
        const owner=actor(request),ended=readTerminalWaitReceipt(db,owner,params.conversationId,params.runId,command);
        if(ended){const replay=replayTerminalWaitReceipt(db,owner,command,ended);return reply.code(replay.status).send(replay.body);}
      }
    }
    if((request.routeOptions.config as {nativeCommandQueryMutation?:boolean}).nativeCommandQueryMutation===true){
      reply.header('cache-control','private, no-store');return;
    }
    if((request.routeOptions.config as {officePreviewConfigurationCommand?:boolean}).officePreviewConfigurationCommand===true)return;
    if(request.method==='POST'&&(request.routeOptions.config as {terminalReceiptReconciliation?:boolean}).terminalReceiptReconciliation===true)return;
    if(request.method==='POST'&&(request.routeOptions.config as {terminalStreamCommand?:boolean}).terminalStreamCommand===true)return;
    // Binary imports own a content-aware immutable receipt in the workspace service.
    if(request.method==='PUT'&&request.routeOptions.url==='/v1/workspaces/:workspaceId/files/binary')return;
    if(request.method==='POST'&&[
      '/v1/workspaces/:workspaceId/checkpoints',
      '/v1/workspaces/:workspaceId/checkpoint-commands/:commandKey/close',
      '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore-review',
      '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore',
      '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore-requests/:commandKey/close',
      '/v1/workspaces/:workspaceId/checkpoint-restores/:operationId/reconcile',
    ].includes(request.routeOptions.url??'')){
      reply.header('cache-control','private, no-store');return;
    }
    if(request.method==='POST'&&request.routeOptions.url==='/v1/artifacts/:artifactId/commands/:commandKey/close'){reply.header('cache-control','private, no-store');return;}
    // Binding codes are one-time secrets: the service deduplicates this request
    // by a hash, and a replay returns the challenge ID without redisclosing code.
    if(request.method==='POST'&&request.url.split('?')[0]==='/v1/channel-bindings')return;
    if(request.method==='POST'&&request.url.split('?')[0]==='/v1/push/subscriptions')return;
    // Mailbox proof must not enter the generic idempotency request cache.
    if(request.method==='POST'&&/^\/v1\/channel-bindings\/email(?:\/[^/]+\/confirm)?$/.test(request.url.split('?')[0]!))return;
    const owner = actor(request as any);
    const operation = `${request.method} ${request.url.split('?')[0]}`;
    let requestMaterial: string;
    if (request.method === 'PUT' && String(request.headers['content-type'] ?? '').split(';')[0] === 'application/octet-stream') {
      const uploadId = String((request.params as Record<string, unknown>).uploadId ?? '');
      const upload = db.prepare('SELECT declared_sha256,declared_size FROM ga_uploads WHERE id=? AND owner_id=?')
        .get(uploadId, owner) as Record<string, unknown> | undefined;
      requestMaterial = canonicalJson({ upload_id: uploadId, sha256: upload?.declared_sha256 ?? null, size: upload?.declared_size ?? null });
    } else requestMaterial = canonicalJson(request.body);
    const requestHash = createHash('sha256').update(requestMaterial).digest('hex');
    const existing = db.prepare(
      'SELECT request_sha256,response_status,response_json,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?',
    ).get(owner, operation, idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.request_sha256 !== requestHash) throw new Error('idempotency_conflict');
      const verifyCachedFork=(value:unknown)=>{
        if(!isConversationForkRoute(request)||!conversationForks)return;
        try{const frozen=conversationForks.recoverReceipt(owner,String((request.params as Record<string,unknown>).conversationId),request.body,idempotencyKey);
          if(!frozen||canonicalJson(frozen)!==canonicalJson(value))throw Error();
        }catch{throw new Error('idempotency_in_progress');}
      };
      if (existing.response_status === null) {
        if(isPluginProfileMutationRoute(request)&&existing.receipt_protocol===PLUGIN_PROFILE_RECEIPT_PROTOCOL)return;
        if(isConversationForkRoute(request)&&existing.receipt_protocol===null&&conversationForks){
          const recovered=withImmediateTransaction(db,()=>{
            const current=db.prepare('SELECT request_sha256,response_status,response_json,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?')
              .get(owner,operation,idempotencyKey) as Record<string,unknown>|undefined;
            if(!current||current.request_sha256!==requestHash)throw new Error('idempotency_conflict');
            if(current.response_status!==null){const body=JSON.parse(String(current.response_json));verifyCachedFork(body);return{status:Number(current.response_status),body};}
            if(current.receipt_protocol!==null)return undefined;
            const conversationId=String((request.params as Record<string,unknown>).conversationId);
            const receipt=conversationForks.recoverReceipt(owner,conversationId,request.body,idempotencyKey);
            if(!receipt)return undefined;
            const registeredRoute=request.routeOptions.url;
            if(typeof registeredRoute!=='string'||request.method!=='POST'||registeredRoute!=='/v1/conversations/:conversationId/fork')throw new Error('idempotency_in_progress');
            const operationId=contracts.operationFor(request.method,registeredRoute);
            if(!operationId||!contracts.validateResponse(operationId,201,receipt).valid)throw new Error('idempotency_in_progress');
            const saved=db.prepare('UPDATE ga_idempotency SET response_status=201,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=? AND request_sha256=? AND response_status IS NULL AND receipt_protocol IS NULL')
              .run(JSON.stringify(receipt),owner,operation,idempotencyKey,requestHash);
            if(saved.changes!==1)throw new Error('idempotency_in_progress');
            return{status:201,body:receipt};
          });
          if(recovered)return reply.code(recovered.status).send(recovered.body);
        }
        // Memory import effects and original batch receipts share one SQLite transaction, so legacy pending requests can safely re-enter that same batch.
        if(isMemoryImportRoute(request)&&existing.receipt_protocol===null){
          const upgraded=withImmediateTransaction(db,()=>db.prepare(`UPDATE ga_idempotency SET receipt_protocol='memory-import-atomic-v1'
            WHERE owner_id=? AND operation=? AND idempotency_key=? AND request_sha256=? AND response_status IS NULL AND receipt_protocol IS NULL`)
            .run(owner,operation,idempotencyKey,requestHash));
          if(upgraded.changes===1){idempotencyRequests.set(request,{owner,operation,key:idempotencyKey});return;}
        }
        if((isArtifactArchiveRoute(request)||isArtifactRestoreRoute(request)||isPersistentTaskMutationRoute(request)||isWorkspaceSelectionRoute(request)||isProjectMutationRoute(request)||isConversationForkRoute(request)||isFileLifecycleRoute(request)||isGitReviewRoute(request)||isIndexAdmissionRoute(request)||isIndexControlAdmissionRoute(request)||isPublicationReviewRoute(request)||isPublicationAdmissionRoute(request)||isRunCommandRoute(request)||isModeMutationRoute(request)||isDiscoveryPolicyRoute(request)||isGoalResumeRoute(request)||isMcpMutationRoute(request)||isMemoryImportRoute(request)||isMemoryRestoreRoute(request)||isMemoryConsolidationRoute(request)||isMemoryCaptureRoute(request)||isMemoryBrainRoute(request)||isMemoryDreamPolicyRoute(request))&&existing.receipt_protocol===atomicProtocol(request)){idempotencyRequests.set(request,{owner,operation,key:idempotencyKey});return;}
        if(isUploadRoute(request)&&existing.receipt_protocol==='upload-atomic-v1'){
          if(request.method==='PUT'){
            const uploadId=String((request.params as Record<string,unknown>).uploadId),upload=db.prepare('SELECT status,declared_size,received_size,declared_sha256,actual_sha256,writer_token,writer_lease_until FROM ga_uploads WHERE id=? AND owner_id=?').get(uploadId,owner) as Record<string,unknown>|undefined;
            if(upload)artifacts.assertUploadReceiptLive(uploadId,owner);
            if(upload&&['uploaded','completed'].includes(String(upload.status))&&upload.received_size===upload.declared_size&&upload.actual_sha256===upload.declared_sha256){
              idempotencyRequests.set(request,{owner,operation,key:idempotencyKey});atomicCommand(request,204,()=>undefined);return reply.code(204).send();
            }
            // Only an expired, identified generation can be replaced. Its old
            // stream writes another path and cannot commit or delete the new one.
            const expired=upload?.status==='uploading'&&typeof upload.writer_token==='string'&&typeof upload.writer_lease_until==='string'&&Date.parse(upload.writer_lease_until)<=Date.now();
            if(!upload||(upload.status!=='created'&&!expired))throw new Error('idempotency_in_progress');
          }
          idempotencyRequests.set(request,{owner,operation,key:idempotencyKey});return;
        }
        const route=request.routeOptions.url,kind=request.method==='POST'&&route==='/v1/interactions/:interactionId/response'?'interaction_response'
          :request.method==='POST'&&route==='/v1/interactions/:interactionId/decision'?'interaction_decision':undefined;
        if(kind){
          if(typeof route!=='string'||request.method!=='POST'||!['/v1/interactions/:interactionId/response','/v1/interactions/:interactionId/decision'].includes(route))throw new Error('task_wait_receipt_state_conflict');
          const recovered=withImmediateTransaction(db,()=>{
            const interactionId=String((request.params as Record<string,unknown>).interactionId);
            const receipt=replyDrafts.recoverReceipt(owner,interactionId,kind,idempotencyKey,requestHash)??taskWaitResponder.recoverReceipt(owner,interactionId,kind,idempotencyKey,requestHash);
            if(!receipt)return;
            const operationId=contracts.operationFor(request.method,route);
            if(!operationId||!contracts.validateResponse(operationId,202,receipt).valid)throw new Error('task_wait_receipt_state_conflict');
            db.prepare('UPDATE ga_idempotency SET response_status=202,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=? AND request_sha256=? AND response_status IS NULL')
              .run(JSON.stringify(receipt),owner,operation,idempotencyKey,requestHash);
            return receipt;
          });
          if(recovered)return reply.code(202).send(recovered);
        }
        throw new Error('idempotency_in_progress');
      }
      const responseBody = existing.response_json === null ? null : JSON.parse(String(existing.response_json));
      assertGitReceiptOwner(request,owner);
      verifyCachedFork(responseBody);
      if(isMemoryBrainRoute(request)){reply.header('cache-control','private, no-store');return reply.code(Number(existing.response_status)).send(readBrainReceipt(request,owner,responseBody));}
      if(existing.receipt_protocol==='upload-atomic-v1'){
        const route=request.routeOptions.url,body=responseBody as Record<string,unknown>|null,uploadId=String((request.params as Record<string,unknown>|undefined)?.uploadId??'');
        if(request.method==='POST'&&route==='/v1/conversations/:conversationId/upload-batches')artifacts.assertUploadBatchInitReceiptLive(String(body?.batch_id??''),owner);
        else if(request.method==='POST'&&route==='/v1/conversations/:conversationId/uploads')artifacts.assertUploadInitReceiptLive(String(body?.upload_id??''),owner);
        else if((request.method==='PUT'&&route==='/v1/uploads/:uploadId/content')||(request.method==='POST'&&route==='/v1/uploads/:uploadId/complete'))artifacts.assertUploadReceiptLive(uploadId,owner);
      }
      return reply.code(Number(existing.response_status)).send(responseBody);
    }
    const now = Date.now();
    db.prepare(
      'INSERT INTO ga_idempotency(owner_id,operation,idempotency_key,request_sha256,response_status,response_json,created_at,expires_at,receipt_protocol) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(owner, operation, idempotencyKey, requestHash, null, null, new Date(now).toISOString(), new Date(now + 86_400_000).toISOString(),atomicProtocol(request));
    idempotencyRequests.set(request, { owner, operation, key: idempotencyKey });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const registeredRoute=request.routeOptions.url;
    if(request.method==='GET'&&reply.statusCode<400&&String(reply.getHeader('content-type')??'').startsWith('application/octet-stream')
      &&['/v1/workspaces/:workspaceId/files/binary','/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore-reviews/:reviewId/target','/v1/conversations/:conversationId/activities/:activityId/tool-result/file/print','/v1/conversations/:conversationId/activities/:activityId/tool-result/members/:memberIndex/download'].includes(registeredRoute??''))return payload;
    const operationId=typeof registeredRoute==='string'?contracts.operationFor(request.method,registeredRoute):null;
    let responseValue: unknown = null;
    if (typeof payload === 'string' && payload.length) {
      try { responseValue = JSON.parse(payload); } catch { responseValue = payload; }
    } else if (Buffer.isBuffer(payload) && payload.length) responseValue = payload.toString('base64');
    if (operationId && reply.statusCode < 400 && !contracts.validateResponse(operationId, reply.statusCode, responseValue).valid) {
      reply.code(500).header('content-type', 'application/json; charset=utf-8');
      payload = JSON.stringify({ error: { code: 'CONTRACT_RESPONSE_INVALID' } });
      responseValue = { error: { code: 'CONTRACT_RESPONSE_INVALID' } };
    }
    // Plugin dispatch and unknown outcomes are settled only through their original receipt executor.
    if(isPluginProfileMutationRoute(request))return payload;
    const pending = idempotencyRequests.get(request);
    if (!pending) return payload;
    // An error response must not replace a recoverable reservation or another
    // writer's success. Successful upload receipts already committed atomically.
    // Server failures leave the original reservation available for reconciliation.
    if(reply.statusCode>=500||atomicProtocol(request)&&reply.statusCode>=400)return payload;
    db.prepare(
      'UPDATE ga_idempotency SET response_status=?,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=?',
    ).run(reply.statusCode, JSON.stringify(responseValue), pending.owner, pending.operation, pending.key);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof Error ? error.message : 'internal_error';
    if(['content_reference_request_invalid','content_reference_request_too_large','content_reference_attachment_mismatch','office_print_reference_unproven'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='terminal_command_invalid')return reply.code(422).send({error:{code:'TERMINAL_INPUT_INVALID'}});
    if(code==='terminal_receipt_conflict')return reply.code(409).send({error:{code:'TERMINAL_RECEIPT_CONFLICT'}});
    if(code==='office_preview_binary_unavailable')return reply.code(503).send({error:{code:'OFFICE_PREVIEW_BINARY_UNAVAILABLE'}});
    if(code==='office_preview_configuration_changed')return reply.code(409).send({error:{code:'OFFICE_PREVIEW_CONFIGURATION_CHANGED'}});
    if(code==='office_preview_candidate_query_invalid')return reply.code(422).send({error:{code:'OFFICE_PREVIEW_QUERY_INVALID'}});
    if(code==='office_preview_candidate_cursor_stale')return reply.code(409).send({error:{code:'OFFICE_PREVIEW_CANDIDATE_CURSOR_STALE'}});
    if(code==='office_preview_candidate_scan_busy')return reply.code(429).header('retry-after','1').send({error:{code:'OFFICE_PREVIEW_CANDIDATE_SCAN_BUSY'}});
    if(code==='office_preview_configuration_forbidden')return reply.code(403).send({error:{code:'OFFICE_PREVIEW_CONFIGURATION_FORBIDDEN'}});
    if(code==='office_preview_configuration_conflict')return reply.code(409).send({error:{code:'OFFICE_PREVIEW_CONFIGURATION_CONFLICT'}});
    if(code==='office_preview_configuration_invalid')return reply.code(422).send({error:{code:'OFFICE_PREVIEW_CONFIGURATION_INVALID'}});
    if(code==='office_print_retention_full')return reply.code(507).send({error:{code:'OFFICE_PRINT_RETENTION_FULL'}});
    if(code==='office_print_retained_unavailable')return reply.code(404).send({error:{code:'OFFICE_PRINT_RETAINED_UNAVAILABLE'}});
    if(code==='office_print_retained_invalid')return reply.code(409).send({error:{code:'OFFICE_PRINT_RETAINED_INVALID'}});
    if(code==='content_reference_request_conflict')return reply.code(409).send({error:{code:'CONTENT_REFERENCE_REQUEST_CONFLICT'}});
    if(code==='content_reference_storage_unavailable')return reply.code(503).send({error:{code:'CONTENT_REFERENCE_STORAGE_UNAVAILABLE'}});
    // Extended SQLite BUSY results retain primary result code 5.
    if(error instanceof Error&&'code' in error&&error.code==='ERR_SQLITE_ERROR'
      &&'errcode' in error&&typeof error.errcode==='number'&&(error.errcode&0xff)===5)
      return reply.code(503).send({error:{code:'DATABASE_BUSY'}});
    if(code==='host_settings_admission_fenced')return reply.code(503).send({error:{code:'HOST_SETTINGS_ADMISSION_FENCED'}});
    if(code==='contract_response_invalid')return reply.code(500).send({error:{code:'CONTRACT_RESPONSE_INVALID'}});
    if(code==='git_repository_unconfigured')return reply.code(503).send({error:{code:'GIT_REPOSITORY_UNCONFIGURED'}});
    if(code==='model_metadata_changed')return reply.code(409).send({error:{code:'MODEL_METADATA_CHANGED'}});
    if(['model_metadata_invalid','model_metadata_unavailable'].includes(code))return reply.code(503).send({error:{code:'MODEL_METADATA_UNAVAILABLE'}});
    if(code==='chat_mode_unavailable')return reply.code(503).send({error:{code:'CHAT_MODE_UNAVAILABLE'}});
    if(code==='invalid_activity_tool_result_query')return reply.code(400).send({error:{code:'ACTIVITY_TOOL_RESULT_QUERY_INVALID'}});
    if(code==='activity_tool_result_not_found')return reply.code(404).send({error:{code:'ACTIVITY_TOOL_RESULT_NOT_FOUND'}});
    if(code==='activity_tool_result_file_unsupported')return reply.code(422).send({error:{code:'ACTIVITY_TOOL_RESULT_FILE_UNSUPPORTED'}});
    if(['activity_tool_result_pending','activity_tool_result_source_changed'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='activity_tool_result_source_invalid')return reply.code(503).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_INVALID'}});
    if(code==='invalid_activity_history_query')return reply.code(400).send({error:{code:'ACTIVITY_HISTORY_QUERY_INVALID'}});
    if(code==='activity_history_cursor_future')return reply.code(409).send({error:{code:'ACTIVITY_HISTORY_CURSOR_FUTURE'}});
    if(code==='artifact_text_query_invalid')return reply.code(400).send({error:{code:'ARTIFACT_TEXT_QUERY_INVALID'}});
    if(code==='artifact_text_source_changed')return reply.code(409).send({error:{code:'ARTIFACT_TEXT_SOURCE_CHANGED'}});
    if(code==='artifact_text_unsupported')return reply.code(422).send({error:{code:'ARTIFACT_TEXT_UNSUPPORTED'}});
    if(code==='interaction_history_source_invalid')return reply.code(503).send({error:{code:'INTERACTION_HISTORY_SOURCE_INVALID'}});
    if(code==='activity_history_source_invalid')return reply.code(503).send({error:{code:'ACTIVITY_HISTORY_SOURCE_INVALID'}});
    if(code==='conversation_mode_invalid')return reply.code(400).send({error:{code:'CONVERSATION_MODE_INVALID'}});
    if(['invalid_file_range','invalid_file_history_query','invalid_file_history_cursor'].includes(code))return reply.code(400).send({error:{code:code.toUpperCase()}});
    if(['memory_import_id_conflict','memory_import_conflict','memory_import_digest_conflict','memory_import_write_conflict'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='memory_import_file_source_unavailable')return reply.code(503).send({error:{code:'MEMORY_IMPORT_FILE_SOURCE_UNAVAILABLE'}});
    if(code==='memory_import_file_source_changed')return reply.code(409).send({error:{code:'MEMORY_IMPORT_FILE_SOURCE_CHANGED'}});
    if(code==='memory_import_replace_unavailable')return reply.code(503).send({error:{code:'MEMORY_IMPORT_REPLACE_UNAVAILABLE'}});
    if(['brain_runtime_unavailable','brain_render_failed'].includes(code))return reply.code(503).send({error:{code:code.toUpperCase()}});
    if(code.startsWith('brain_publication_')&&code!=='brain_publication_not_found')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='memory_scope_forbidden')return reply.code(403).send({error:{code:'MEMORY_SCOPE_FORBIDDEN'}});
    if(code==='file_source_stale')return reply.code(409).send({error:{code:'FILE_SOURCE_STALE'}});
    if(code==='DOCUMENT_PREVIEW_TOO_LARGE')return reply.code(413).send({error:{code:'DOCUMENT_PREVIEW_TOO_LARGE'}});
    if(['DOCUMENT_VISUAL_LIMIT','DOCUMENT_PREVIEW_FORMAT_INVALID','DOCUMENT_PREVIEW_CONTAINER_LIMIT','DOCUMENT_PREVIEW_RESULT_INVALID','DOCUMENT_PREVIEW_XML_UNSAFE','DOCUMENT_PREVIEW_XML_INVALID','FILE_CONTAINER_LIMIT','ENGINE_OUTPUT_TOO_LARGE'].includes(code))return reply.code(422).send({error:{code}});
    if(['ENGINE_TIMEOUT','ENGINE_CRASH','ENGINE_RESULT_INVALID'].includes(code))return reply.code(503).send({error:{code}});
    if(['active_run_mode_change','chat_model_fixed','conversation_mode_conflict','conversation_mode_scope_invalid','conversation_mode_goal_active','conversation_mode_goal_unconfirmed','conversation_mode_legacy_unconfirmed','conversation_mode_session_missing','conversation_mode_admission_required'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_run_limit_unconfirmed')return reply.code(409).send({error:{code:'TASK_RUN_LIMIT_UNCONFIRMED'}});
    if(['memory_capture_policy_stale','memory_capture_source_conflict','memory_capture_not_ready','memory_restore_expired','memory_restore_source_conflict','memory_consolidation_state_conflict','memory_consolidation_source_conflict','memory_consolidation_pending_limit','memory_consolidation_source_limit'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(['native_creation_aborted','native_creation_outcome_unknown'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_review_output_not_found')return reply.code(404).send({error:{code:'TASK_REVIEW_OUTPUT_NOT_FOUND'}});
    if(code==='task_review_output_unavailable')return reply.code(409).send({error:{code:'TASK_REVIEW_OUTPUT_UNAVAILABLE'}});
    if(code==='task_review_output_expired')return reply.code(410).send({error:{code:'TASK_REVIEW_OUTPUT_EXPIRED'}});
    if(['handoff_request_invalid','handoff_identity_invalid'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['handoff_identity_forbidden','handoff_execution_forbidden','handoff_role_forbidden'].includes(code))return reply.code(403).send({error:{code:code.toUpperCase()}});
    if(['handoff_usage_unresolved','handoff_operation_unresolved','handoff_lease_changed','handoff_revision_conflict','handoff_execution_conflict','handoff_execution_unbound','handoff_already_started','handoff_not_started','handoff_closed','handoff_controller_changed','handoff_route_repeated','handoff_hop_exhausted'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(['channel_binding_rate_limited','email_binding_rate_limited'].includes(code))return reply.code(429).send({error:{code:code.toUpperCase()}});
    if(['channel_message_invalid','channel_attachments_invalid','channel_attachment_staging_missing'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='native_task_intent_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='native_child_request_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='native_child_identity_conflict')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(['native_child_closure_invalid','native_activation_invalid','native_spawn_publication_invalid'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['native_child_closure_pending','native_child_closure_conflict','native_child_closed','native_activation_source_pending','native_activation_source_changed','native_recovery_fence_live','native_spawn_publication_unbound'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='channel_binding_unavailable')return reply.code(503).send({error:{code:code.toUpperCase()}});
    if(['push_channel_unavailable','push_vapid_configuration_invalid'].includes(code))return reply.code(503).send({error:{code:code.toUpperCase()}});
    if(code==='push_subscription_not_found')return reply.code(404).send({error:{code:code.toUpperCase()}});
    if(code==='push_subscription_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['channel_binding_proof_invalid','email_binding_proof_invalid','email_address_invalid'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['channel_principal_already_bound','channel_binding_not_verified','channel_message_identity_conflict',
      'channel_authority_binding_ambiguous','channel_authority_owner_mismatch','channel_authority_mapping_invalid',
      'channel_authority_legacy_mapping_unpinned','channel_cached_event_source_mismatch','channel_cached_event_binding_mismatch',
      'channel_cached_thread_mismatch','channel_cached_event_link_mismatch','channel_cached_event_message_mismatch',
      'channel_root_generation_conflict',
      'channel_thread_generation_conflict'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_completion_handshake_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='task_completion_handshake_conflict')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_mailbox_binding_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='task_auxiliary_pending')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(['task_assignment_revoked','native_file_assignment_conflict'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_collaboration_exhausted')return reply.code(429).send({error:{code:code.toUpperCase()}});
    if(code==='task_reply_target_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='task_reply_run_active')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_notification_run_active')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='workspace_checkpoint_upgrade_required'||code==='workspace_checkpoint_service_unavailable'||code==='workspace_checkpoint_backup_verifier_unavailable'||code==='workspace_checkpoint_source_revision_unavailable')return reply.code(503).send({error:{code:code.toUpperCase()}});
    if(code==='workspace_checkpoint_review_content_limit')return reply.code(413).send({error:{code:code.toUpperCase()}});
    if(code.startsWith('workspace_checkpoint_')&&code.endsWith('_invalid'))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['workspace_checkpoint_path_is_directory','workspace_path_unsafe','workspace_private_path','workspace_paths_invalid','workspace_path_collision','workspace_limit'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code.startsWith('workspace_checkpoint_')&&(
      code.endsWith('_changed')||code.endsWith('_conflict')||code.endsWith('_corrupt')||
      ['workspace_checkpoint_restore_busy','workspace_checkpoint_restore_closed','workspace_checkpoint_pruned','workspace_checkpoint_path_not_selected','workspace_checkpoint_retained_reference','workspace_checkpoint_lease_revoked','workspace_checkpoint_current_changed','workspace_checkpoint_prepare_unknown','workspace_checkpoint_prepare_busy','workspace_checkpoint_command_closed','workspace_checkpoint_command_settled','workspace_checkpoint_roots_overlap'].includes(code)
    ))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='workspace_source_changed')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code.startsWith('budget_') && code.endsWith('_invalid')) return reply.code(422).send({error:{code:code.toUpperCase()}});
    if (code === 'model_budget_exhausted') return reply.code(429).send({error:{code:'MODEL_BUDGET_EXHAUSTED'}});
    if (code === 'budget_ceiling_exceeded') return reply.code(422).send({error:{code:'BUDGET_CEILING_EXCEEDED'}});
    if (code === 'budget_limit_below_commitment') return reply.code(409).send({error:{code:'BUDGET_LIMIT_BELOW_COMMITMENT'}});
    if (['budget_route_unavailable','budget_service_unavailable'].includes(code)) return reply.code(503).send({error:{code:code.toUpperCase()}});
    if (code.startsWith('budget_') && (code.endsWith('_conflict') || ['budget_binding_missing','budget_run_inactive','budget_usage_unknown','budget_usage_pending','budget_window_closed','budget_policy_stale'].includes(code))) return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (Number((error as { statusCode?: number }).statusCode) === 413) {
      if ((request.routeOptions.url ?? request.url).split('?')[0] === '/hooks/v1/channels/slack') {
        return reply.code(413).send({ error: { code: 'CHANNEL_EVENT_TOO_LARGE' } });
      }
      return reply.code(413).send({ error: { code: 'VOICE_AUDIO_TOO_LARGE' } });
    }
    if (error instanceof TemplateContractError) {
      return reply.code(422).send({ error: { code, details: error.details } });
    }
    if ((error as { validation?: unknown }).validation) return reply.code(422).send({ error: { code: 'INVALID_WORKBENCH_REQUEST' } });
    if (code.startsWith('invalid_') || code === 'unsupported_trigger' || code === 'idempotency_key_required' || code === 'memory_dream_policy_invalid' || code === 'mcp_control_invalid_request') return reply.code(422).send({ error: { code: code.toUpperCase() } });
    if (code === 'mcp_reload_unavailable') return reply.code(503).send({ error: { code: code.toUpperCase() } });
    if (['mcp_connections_limit','mcp_server_name_conflict','mcp_connection_disabled','mcp_connection_unavailable','mcp_reload_in_progress','mcp_reload_stale','mcp_tool_catalog_limit'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (code === 'memory_capture_reconcile_unavailable') return reply.code(503).send({error:{code:'MEMORY_CAPTURE_RECONCILE_UNAVAILABLE'}});
    if (['memory_capture_reconcile_conflict','memory_capture_reconcile_attempt_invalid','memory_capture_reconcile_run_not_interrupted','memory_capture_reconcile_live_lease','memory_capture_source_or_policy_stale','memory_capture_proposal_unavailable','memory_capture_unresolved_usage_held'].includes(code)) return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (['evidence_required','dependency_cycle'].includes(code)) return reply.code(422).send({error:{code:code.toUpperCase()}});
    if (['assessment_revision_conflict','observation_revision_conflict','dependency_not_completed','dependency_evidence_unverified','task_completion_evidence_required','task_acceptance_outputs_unverified'].includes(code)) return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code.endsWith('_forbidden') || code.endsWith('_path_escape') || code.endsWith('_scope_mismatch') || code.endsWith('_workspace_mismatch')) return reply.code(403).send({ error: { code: code.toUpperCase() } });
    if (code.endsWith('_revoked') || code.endsWith('_state_conflict') || ['agent_not_active', 'agent_unavailable', 'run_binding_conflict', 'memory_verification_required', 'memory_dream_policy_stale', 'task_not_active', 'task_budget_exhausted', 'task_active_occurrence', 'task_conversation_read_only', 'task_continuation_unsupported','task_continuation_conflict','task_checkpoint_unavailable','task_continuation_limit'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (code === 'mailbox_queue_full') return reply.code(429).send({ error: { code: code.toUpperCase() } });
    if (code === 'unsafe_page_url') return reply.code(403).send({error:{code:'UNSAFE_PAGE_URL'}});
    if (code.startsWith('page_')) return reply.code(502).send({error:{code:code.toUpperCase()}});
    if (code==='task_discovery_managed'||code==='task_discovery_admission_required')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code==='discovery_scope_unavailable')return reply.code(404).send({error:{code:code.toUpperCase()}});
    if (code==='discovery_history_corrupt')return reply.code(409).send({error:{code:'DISCOVERY_HISTORY_CORRUPT'}});
    if (['discovery_not_bound','discovery_authority_revoked','discovery_source_changed','discovery_source_unavailable','discovery_evidence_required','discovery_report_required','discovery_report_stale','discovery_report_steps_incomplete','discovery_planning_read_only'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code==='discovery_source_integrity_failed')return reply.code(409).send({error:{code:'DISCOVERY_SOURCE_INTEGRITY_FAILED'}});
    if (code==='discovery_planning_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if (code==='discovery_report_source_coverage_required')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (['discovery_role_changed','discovery_role_unavailable'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code==='discovery_policy_invalid'||code==='discovery_command_key_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='upload_expired')return reply.code(410).send({error:{code:'UPLOAD_EXPIRED'}});
    if(code==='upload_batch_limit_exceeded')return reply.code(413).send({error:{code:'UPLOAD_BATCH_LIMIT_EXCEEDED'}});
    if(code==='upload_batch_concurrency_limit')return reply.code(429).send({error:{code:'UPLOAD_BATCH_CONCURRENCY_LIMIT'}});
    if (['workspace_change_busy','project_deleted','project_has_active_tasks','project_has_pending_operations'].includes(code)) return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code.endsWith('_not_found')) return reply.code(404).send({ error: { code: code.toUpperCase() } });
    if (['reply_review_mode_conflict','reply_draft_corrupt','reply_review_state_conflict','task_wait_response_required','version_conflict','memory_dream_policy_version_conflict', 'active_run_model_change', 'run_state_conflict', 'run_version_conflict', 'checkpoint_invalid', 'reconciliation_required', 'interaction_kind_conflict', 'interaction_state_conflict', 'interaction_version_conflict', 'interaction_expired', 'action_digest_mismatch', 'idempotency_conflict', 'idempotency_in_progress', 'voice_idempotency_conflict', 'STALE_FILE_VERSION', 'IDEMPOTENCY_CONFLICT', 'crawl_batch_owner_mismatch'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (['reply_evidence_unverified','interaction_answer_invalid','interaction_history_query_invalid', 'interaction_decision_invalid', 'upload_size_invalid', 'upload_sha256_invalid', 'upload_filename_invalid', 'upload_size_mismatch', 'upload_sha256_mismatch','upload_batch_invalid', 'artifact_diff_unsupported', 'source_evidence_required', 'source_url_invalid', 'invalid_project_title', 'invalid_conversation_state', 'FILE_REQUEST_INVALID', 'TEMPLATE_CONTENT_INVALID', 'UNSUPPORTED_FORMAT_OPERATION', 'requested_count_invalid', 'event_seq_invalid', 'input_index_invalid', 'item_id_invalid', 'owner_id_invalid', 'run_id_invalid', 'batch_id_invalid', 'conversation_id_invalid', 'crawl_url_invalid'].includes(code)) return reply.code(422).send({ error: { code: code.toUpperCase() } });
    if (['artifact_not_restorable','artifact_restore_required','upload_state_conflict'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (code === 'origin_forbidden' || code === 'csrf_invalid') return reply.code(403).send({ error: { code: code.toUpperCase() } });
    if(code==='artifact_command_request_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['artifact_command_closed','artifact_command_unresolved','artifact_command_immutable'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code === 'idempotency_key_invalid') return reply.code(400).send({ error: { code: 'IDEMPOTENCY_KEY_INVALID' } });
    if(code==='ordinary_attachment_steering_unavailable')return reply.code(503).send({error:{code:'ORDINARY_ATTACHMENT_STEERING_UNAVAILABLE'}});
    if(code==='ordinary_steering_unavailable')return reply.code(503).send({error:{code:'ORDINARY_STEERING_UNAVAILABLE'}});
    if(code==='ordinary_steering_scope_unconfirmed')return reply.code(409).send({error:{code:'ORDINARY_STEERING_SCOPE_UNCONFIRMED'}});
    if (code === 'workspace_selection_invalid' || code === 'workspace_owner_invalid') return reply.code(422).send({error:{code:code.toUpperCase()}});
    if (code === 'contract_request_invalid') return reply.code(400).send({ error: { code: 'CONTRACT_REQUEST_INVALID' } });
    if (code === 'voice_multipart_required') return reply.code(415).send({ error: { code: 'VOICE_MULTIPART_REQUIRED' } });
    if (code === 'voice_busy') return reply.code(429).send({ error: { code: 'VOICE_BUSY' } });
    if (code === 'voice_provider_not_ready') return reply.code(503).send({ error: { code: 'VOICE_PROVIDER_NOT_READY' } });
    if (code === 'voice_provider_unavailable') return reply.code(503).send({ error: { code: 'VOICE_PROVIDER_UNAVAILABLE' } });
    if (code === 'voice_audio_too_large') return reply.code(413).send({ error: { code: 'VOICE_AUDIO_TOO_LARGE' } });
    if (code.startsWith('voice_')) return reply.code(422).send({ error: { code: code.toUpperCase() } });
    if (code === 'unauthorized' || code === 'UNAUTHORIZED_FILE') return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });

  app.get('/healthz', async () => ({ ok: true, service: 'jot-general-agent-bff' }));
  const officePreviewConfiguration=new OfficePreviewConfigurationStore(db,config.officePreviewOwnerId);
  const readOfficePreviewSettings=()=>officePreviewConfiguration.get();
  const officePreviewStatus=createOfficePreviewStatusReader(readOfficePreviewSettings),officePreviewCandidates=createOfficePreviewCandidateReader(readOfficePreviewSettings);
  const officePreviewCandidatePages=createOfficePreviewCandidatePager(readOfficePreviewSettings);
  const officePrintReferencesReady=typeof config.internalChannelToken==='string'&&config.internalChannelToken.length>=16;
  app.addHook('onClose',async()=>{await Promise.all([officePreviewStatus.close(),officePreviewCandidates.close(),officePreviewCandidatePages.close()]);});
  app.get('/v1/office-preview/configuration',async(request,reply)=>{
    const owner=actor(request as any);reply.header('cache-control','private, no-store');
    if(Object.keys(request.query as Record<string,unknown>).length)throw Error('office_preview_configuration_invalid');
    return officePreviewConfiguration.get(owner);
  });
  app.patch('/v1/office-preview/configuration',{config:{officePreviewConfigurationCommand:true}},async(request,reply)=>{
    const owner=actor(request as any);reply.header('cache-control','private, no-store');
    if(Object.keys(request.query as Record<string,unknown>).length)throw Error('office_preview_configuration_invalid');
    const value=officePreviewConfiguration.update(owner,String(request.headers['idempotency-key']??''),request.body);
    officePreviewStatus.invalidate();return value;
  });
  app.get('/v1/office-preview/status',async(request,reply)=>{
    actor(request as any);
    const query=request.query as Record<string,unknown>;
    if(Object.keys(query).some(key=>key!=='refresh')
      ||query.refresh!==undefined&&(typeof query.refresh!=='string'||!['1','true','0','false'].includes(query.refresh))){
      return reply.code(422).send({error:{code:'OFFICE_PREVIEW_QUERY_INVALID'}});
    }
    reply.header('cache-control','no-store');
    const controller=new AbortController(),abort=()=>controller.abort();
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    if(request.raw.aborted||reply.raw.destroyed)abort();
    try{return await officePreviewStatus.read(query.refresh==='1'||query.refresh==='true',controller.signal);}
    finally{request.raw.off('aborted',abort);reply.raw.off('close',abort);}
  });
  app.get('/v1/office-preview/candidates',async(request,reply)=>{
    const owner=actor(request as any),query=request.query as Record<string,unknown>;
    if(Object.keys(query).some(key=>!['refresh','scan_protocol','cursor'].includes(key))
      ||query.scan_protocol!==undefined&&(typeof query.scan_protocol!=='string'||!['1','2'].includes(query.scan_protocol))
      ||query.refresh!==undefined&&(typeof query.refresh!=='string'||!['1','true','0','false'].includes(query.refresh))
      ||query.cursor!==undefined&&(typeof query.cursor!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(query.cursor))
      ||query.scan_protocol==='2'&&query.refresh!==undefined||query.scan_protocol!=='2'&&query.cursor!==undefined){
      return reply.code(422).send({error:{code:'OFFICE_PREVIEW_QUERY_INVALID'}});
    }
    reply.header('cache-control','no-store');
    if(query.scan_protocol==='2')return officePreviewCandidatePages.read(owner,query.cursor as string|undefined);
    return officePreviewCandidates.read(query.refresh==='1'||query.refresh==='true');
  });
  app.get('/v1/push/vapid-public-key',async(_request,reply)=>{
    if(!pushSubscriptions)throw new Error('push_channel_unavailable');
    reply.header('cache-control','private, no-store');
    return pushSubscriptions.publicKey();
  });
  app.post('/v1/push/subscriptions',async(request,reply)=>{
    if(!pushSubscriptions)throw new Error('push_channel_unavailable');
    return reply.code(201).send(pushSubscriptions.register(actor(request as any),request.body as any,String(request.headers['idempotency-key']??'')));
  });
  app.post('/v1/push/subscriptions/:bindingId/revoke',async request=>{
    if(!pushSubscriptions)throw new Error('push_channel_unavailable');
    const input=request.body as Record<string,unknown>|undefined;
    if(!input||Object.keys(input).some(key=>key!=='expected_version'&&key!=='local_endpoint')||!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1||(input.local_endpoint!==undefined&&typeof input.local_endpoint!=='string'))throw new Error('push_subscription_invalid');
    return pushSubscriptions.revoke(actor(request as any),String((request.params as {bindingId:string}).bindingId),Number(input.expected_version),input.local_endpoint as string|undefined);
  });
  app.get('/v1/channel-bindings',async request=>ownerChannels.list(actor(request as any)));
  app.post('/v1/channel-bindings/email',async(request,reply)=>{
    const input=request.body as Record<string,unknown>;
    if(!input||typeof input.address!=='string'||Object.keys(input).some(key=>key!=='address'))throw new Error('invalid_channel_binding_request');
    return reply.code(201).send(await emailBindings.begin(actor(request as any),input.address,String(request.headers['idempotency-key']??'')));
  });
  app.post('/v1/channel-bindings/email/:bindingId/confirm',async request=>{
    const input=request.body as Record<string,unknown>;
    if(!input||typeof input.code!=='string'||Object.keys(input).some(key=>key!=='code'))throw new Error('invalid_channel_binding_request');
    return emailBindings.confirm(actor(request as any),String((request.params as {bindingId:string}).bindingId),input.code);
  });
  app.post('/v1/channel-bindings',async(request,reply)=>{
    const input=request.body as Record<string,unknown>|undefined;
    if(!input||typeof input.channel!=='string'||Object.keys(input).some(key=>key!=='channel'))throw new Error('invalid_channel_binding_request');
    return reply.code(201).send(ownerChannels.create(actor(request as any),input.channel,String(request.headers['idempotency-key']??'')));
  });
  app.post('/v1/channel-bindings/:bindingId/revoke',async request=>{
    const input=request.body as Record<string,unknown>|undefined;
    if(!input||Object.keys(input).some(key=>key!=='expected_version')||!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<1)throw new Error('invalid_channel_binding_request');
    return ownerChannels.revoke(actor(request as any),String((request.params as {bindingId:string}).bindingId),Number(input.expected_version));
  });
  app.get('/v1/persistent-tasks/:taskId/reply-policy',async request=>taskReplyPolicies.get(actor(request as any),String((request.params as {taskId:string}).taskId)));
  app.get('/v1/persistent-tasks/:taskId/replies',async request=>replyHistory.history(actor(request as any),String((request.params as {taskId:string}).taskId),(request.query as {cursor?:string}).cursor));
  app.patch('/v1/persistent-tasks/:taskId/reply-policy',async request=>taskReplyPolicies.update(actor(request as any),String((request.params as {taskId:string}).taskId),(request.body??{}) as Record<string,unknown>));
  app.get('/v1/persistent-tasks/:taskId/notifications',async request=>taskNotifications.get(actor(request as any),String((request.params as {taskId:string}).taskId)));
  app.patch('/v1/persistent-tasks/:taskId/notifications',async request=>taskNotifications.update(actor(request as any),String((request.params as {taskId:string}).taskId),(request.body??{}) as Record<string,unknown>));
  app.get('/v1/persistent-tasks/:taskId/occurrences/:occurrenceId/deliveries',async request=>{const params=request.params as {taskId:string;occurrenceId:string};return taskNotifications.deliveries(actor(request as any),params.taskId,params.occurrenceId);});
  app.get('/v1/persistent-tasks/:taskId/deliveries',async request=>{
    const query=request.query as Record<string,unknown>;
    if(Object.keys(query).some(key=>key!=='cursor')||(query.cursor!==undefined&&(typeof query.cursor!=='string'||!query.cursor||query.cursor.length>200)))throw new Error('invalid_task_notification_settings');
    return taskNotifications.history(actor(request as any),String((request.params as {taskId:string}).taskId),query.cursor as string|undefined);
  });
  if(config.pluginProfileClient){
    if(!config.internalChannelToken||config.internalChannelToken.length<16)throw Error('plugin_profile_routes_config_invalid');
    registerPluginProfileRoutes(app,{actor,client:config.pluginProfileClient,
      receipts:createPluginProfileReceiptExecutor(db),internalChannelToken:config.internalChannelToken});
  }
  registerWorkbenchRoutes(app, workbench, actor,(request,operation)=>atomicCommand(request,200,operation),workspaceCheckpoints);
  registerWorkbenchMcpRoutes(app, mcpRegistry, actor, (request,status,operation)=>atomicCommand(request,status,operation),
    (ownerId, agentId) => listUnknownMcpOperations(db, ownerId, agentId));
  const taskDelegations=new TaskDelegationService(db,workbench,persistentTasks);
  const taskCollaboration=new TaskCollaborationService(db,workbench,persistentTasks,taskDelegations);
  registerPersistentTaskRoutes(app, persistentTasks, actor,taskDelegations,taskCollaboration,atomicCommand);
  registerHostAdminRoutes(app,{...config.hostAdmin,authenticatedActor:request=>actor(request as {headers:Record<string,unknown>})});
  if(config.hostAdmin?.writeEnabled===true)registerHostSettingsInternalRoutes(app,{db,token:config.internalChannelToken??'',enabled:true,runs});
  registerTaskPrdRoutes(app,taskPrd,actor,atomicCommand);
  registerTaskBudgetRoutes(app,new TaskBudgetService(db,budgetPolicy),actor);
  registerWorkbenchExecution(app, db, workbench, persistentTasks, config.internalChannelToken, modelBudgets,taskCollaboration,config.replyJudge,nativeWork,
    new Set(config.chatWebNetwork?.allowedOrigins ?? []),config.nativeMemberClient,events,config.memoryReasoningClient, mcpRegistry,interactions,artifacts,config.modelCatalogClient,taskPrd);
  registerConversationGoalExecution(app,new ConversationGoalControls(db,events,runs),config.internalChannelToken);
  registerOrdinaryInputBinding(app,db,config.internalChannelToken);
  registerOrdinaryModelPolicy(app,db,config.internalChannelToken);
  registerOrdinaryExecutionPolicy(app,db,config.internalChannelToken);
  registerOrdinaryChatContext(app,db,config.internalChannelToken);
  registerOrdinaryChatWeb(app,db,config.internalChannelToken);
  registerChatCompactionSource(app,db,config.internalChannelToken);
  registerChatCompactionAttempts(app,db,config.internalChannelToken);
  registerChatCompactionCheckpoints(app,db,config.internalChannelToken);
  registerOrdinarySteeringBinding(app,db,config.internalChannelToken);
  registerOrdinarySteeringHistory(app,db,config.internalChannelToken);
  registerOrdinaryRunHistory(app,db,config.internalChannelToken);

  app.post('/internal/v1/channel/mattermost/event-receipt',async(request,reply)=>{
    const expected=String(config.internalChannelToken??'');
    if(expected.length<16||request.headers.authorization!==`Bearer ${expected}`)return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
    return reply.send(channelIntake.lookupOriginalChannelEventReceipt(request.body));
  });

  app.post('/internal/v1/channel/mattermost/proof-receipt',async(request,reply)=>{
    const expected=String(config.internalChannelToken??'');
    if(expected.length<16||request.headers.authorization!==`Bearer ${expected}`)return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
    return reply.send(ownerChannels.lookupMattermost(request.body));
  });

  app.post('/internal/v1/channel/messages', async (request, reply) => {
    const expected = String(config.internalChannelToken ?? '');
    if (expected.length < 16 || request.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
    }
    return reply.code(202).send(channelIntake.accept(request.body as Record<string, unknown>));
  });

  if(config.channelAttachmentIntakeV2===true||channelAttachmentProtocolV2Installed(db)&&String(config.internalChannelToken??'').length>=16)registerChannelAttachmentIntakeV2(app,{db,intake:channelIntake,artifacts,internalChannelToken:config.internalChannelToken!,admission:channelAttachmentInputReady?'enabled':config.channelAttachmentIntakeV2===true?'unavailable':'recovery_only'});
  if (config.qqWebhook) registerQQRoutes(app, { ...config.qqWebhook, intake: channelIntake });
  if(config.smsWebhook)registerTwilioSmsRoutes(app,{...config.smsWebhook,intake:channelIntake,artifacts});
  const slackAdapter = config.slackWebhook
    ? createSlackWebhookAdapter({ ...config.slackWebhook, intake: channelIntake,
      ...(config.slackWebhook.attachmentBotToken?{artifacts}:{}),
      handleInteractionReply: createSlackInteractionReplyHandler(db, interactions, config.slackWebhook.teamId),
      ...(config.slackTransport ? { transport: config.slackTransport } : {}) }) : undefined;
  app.register(slackWebhookRoutes, { adapter: slackAdapter });

  app.post('/internal/v1/file-tools', async (request, reply) => {
    const expected = String(config.internalChannelToken ?? '');
    if (expected.length < 16 || request.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
    }
    const body = request.body as Record<string, any>;
    const nativeRef=String(body.session_ref || '');
    const bindings = db.prepare(`SELECT conversation_id,owner_id FROM ga_harness_session_bindings WHERE session_id=?
      UNION SELECT r.native_conversation_id AS conversation_id,r.native_owner_id AS owner_id
        FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
        WHERE r.native_session_ref=? AND r.native_owner_id=c.owner_id AND r.native_conversation_id=c.id`)
      .all(nativeRef,nativeRef) as Array<{conversation_id:string;owner_id:string}>;
    const binding=bindings.length===1?bindings[0]:undefined;
    if (!binding?.conversation_id || !binding.owner_id) throw new Error('UNAUTHORIZED_FILE');
    const args = body.arguments as Record<string, unknown>;
    if (String(args.operation) === 'document.templates') return { templates: templates.list() };
    if (String(args.operation) === 'file.job_status') return fileJobs.get(binding.owner_id, String(args.job_id || ''));
    if (String(args.operation) === 'writer.fill_template') {
      const target = args.target as Record<string, unknown> | undefined;
      const change = args.change as Record<string, unknown> | undefined;
      const selected = templates.resolve(String(target?.template_id || ''), String(target?.template_version || ''),
        String(target?.template_sha256 || ''));
      if (selected.format !== 'docx') throw new Error('UNSUPPORTED_FORMAT_OPERATION');
      const fields = templates.validateFields(selected, change?.fields);
      const base = artifacts.registerTemplateInstance({ ownerId: binding.owner_id,
        conversationId: binding.conversation_id, callId: String(body.call_id || ''),
        templateId: selected.template_id, templateVersion: selected.version,
        templateSha256: selected.sha256, format: selected.format, sourcePath: selected.path });
      const operation = { ...args, base_version: Number(base.version), base_sha256: String(base.sha256),
        target: { ...target, registered_fields: selected.fields }, change: { ...change, fields } };
      return reply.code(202).send(fileJobs.enqueue(binding.owner_id, binding.conversation_id,
        String(base.artifact_id), operation, String(body.call_id || '')));
    }
    if (String(args.operation) === 'calc.fill_records') {
      const target = args.target as Record<string, unknown> | undefined;
      const selected = templates.resolve(String(target?.template_id || ''), String(target?.template_version || ''),
        String(target?.template_sha256 || ''));
      if (selected.format !== 'xlsx') throw new Error('UNSUPPORTED_FORMAT_OPERATION');
      const change = templates.validateRecords(selected, args.change);
      const base = artifacts.registerTemplateInstance({ ownerId: binding.owner_id,
        conversationId: binding.conversation_id, callId: String(body.call_id || ''),
        templateId: selected.template_id, templateVersion: selected.version,
        templateSha256: selected.sha256, format: selected.format, sourcePath: selected.path });
      const operation = { ...args, base_version: Number(base.version), base_sha256: String(base.sha256), change };
      return reply.code(202).send(fileJobs.enqueue(binding.owner_id, binding.conversation_id,
        String(base.artifact_id), operation, String(body.call_id || '')));
    }
    return reply.code(202).send(fileJobs.enqueue(binding.owner_id, binding.conversation_id,
      String(args.artifact_ref || ''), args, String(body.call_id || '')));
  });

  app.post('/internal/v1/crawl-batches/bind', async (request, reply) => {
    const expected = String(config.internalChannelToken ?? '');
    if (expected.length < 16 || request.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
    }
    const body = request.body as Record<string, unknown>;
    const binding = { batch_id: String(body.batch_id ?? ''), run_id: String(body.run_id ?? ''),
      owner_id: String(body.owner_id ?? ''), conversation_id: String(body.conversation_id ?? ''),
      requested_count: Number(body.requested_count),
      ...(body.generation === undefined ? {} : { generation: Number(body.generation) }) };
    return reply.code(201).send(crawlBatches.bind(binding));
  });

  app.post('/internal/v1/crawl-batches/events', async (request, reply) => {
    const expected = String(config.internalChannelToken ?? '');
    if (expected.length < 16 || request.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
    }
    const body = request.body as Record<string, unknown>;
    return reply.code(202).send(crawlBatches.ingest(String(body.owner_id ?? ''), body.event as any));
  });

  registerDiscoveryPolicyRoutes(app,{policies:new DiscoveryPolicies(db,{onChange:(owner,receipt,event)=>persistentTasks.synchronizeDiscoveryPolicy(owner,receipt.policy_id,event)}),actor,role:(owner,id)=>workbench.getAgent(owner,id),atomic:atomicCommand});
  registerDiscoveryHistoryRoutes(app,{history:new DiscoveryHistory(db),actor,role:(owner,id)=>workbench.getAgent(owner,id)});
  registerNativeSearchSourceRoutes(app,{db,actor,client:config.nativeSearchSourceClient,snapshotRoot:join(dirname(resolve(config.databasePath)),'.jot-downloads')});
  registerTerminalInventoryRoutes(app,{db,actor,client:config.terminalInventoryClient});
  registerTerminalControlRoutes(app,{db,actor,client:config.terminalControlClient});
  registerTerminalReceiptRoutes(app,{db,actor,client:config.terminalControlClient});
  registerTerminalStreamRoutes(app,{db,actor,client:config.terminalStreamClient});
  registerConversationGoalRoutes(app,{db,conversations,actor,client:config.conversationGoalClient,resumeAdmission:{enabled:config.conversationGoalResumeEnabled===true,controls:new ConversationGoalControls(db,events,runs),atomic:atomicCommand}});
  if(config.skillCatalogClient){
    const catalog=new SkillCatalogService(db,workbench,config.skillCatalogClient);
    registerSkillCatalogRoutes(app,catalog,actor,config.internalChannelToken);
    registerNativeCommandQueryRoutes(app,{db,catalog,client:config.skillCatalogClient,actor,token:config.internalChannelToken});
    registerNativePlanModeRoutes(app,{db,catalog,client:config.skillCatalogClient,actor,token:config.internalChannelToken});
  }
  app.get('/v1/capabilities', async (request, reply) => {
    const ownerId = actor(request as any);
    const cancelled=new AbortController();const abort=()=>{if(!reply.raw.writableEnded)cancelled.abort();};
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    const browserClient=config.conversationGoalClient;
    const browserHost=typeof browserClient?.observeBrowserDriver==='function'?{observeBrowserDriver:browserClient.observeBrowserDriver.bind(browserClient)}:undefined;
    let voice,models,modes,attachmentSteeringReady,browserActionReadiness;
    try{[voice,models,modes,attachmentSteeringReady,browserActionReadiness]=await Promise.all([voiceTranscriptions.capability(),readHostModelCatalog(config.modelCatalogClient,cancelled.signal),conversationModes.capability(cancelled.signal),readAttachmentSteeringReadiness(config.ordinaryAttachmentSteeringEnabled===true,config.ordinaryAttachmentSteeringClient,cancelled.signal),observeBrowserActionReadiness(db,ownerId,config.workspaces,browserHost,cancelled.signal)]);}
    finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort);}
    if (config.csrfToken && request.headers['sec-fetch-site'] !== 'cross-site') {
      reply.header('x-csrf-token', config.csrfToken).header('cache-control', 'no-store');
      reply.header('x-workbench-draft-scope', createHmac('sha256', config.csrfToken).update(`workbench-draft/v1/${ownerId}`).digest('hex'));
    }
    return {
      api_version: '1.0', event_schema_version: '1.0', adapter_version: '0.1.0',
      artifact_archive:archiveStatus(),
      upload_recovery:{protocol:1,status:true},
      ...(messageReferenceSnapshotsInstalled(db)&&commandReferenceSnapshotsInstalled(db)?{reference_snapshots:{protocol:1,request:true,renderers:['pdf','xlsx','docx','pptx',...(officePrintReferencesReady?['office-pdf']:[])],...(officePrintReferencesReady?{office_print_views:[1]}:{}),docx_text_views:[1,2],xlsx_cell_views:[1,2],region_renderers:['pdf','docx','pptx','xlsx',...(officePrintReferencesReady?['office-pdf']:[])]}}:{}),
      git_workbench:gitWorkbench.capability(ownerId,config.nativeGitClient!==undefined,['commit','branch','initialization','reinitialization'].includes(gitCommitExecutionSchema(db)),['branch','initialization','reinitialization'].includes(gitCommitExecutionSchema(db)),['initialization','reinitialization'].includes(gitCommitExecutionSchema(db)),gitCommitExecutionSchema(db)==='reinitialization'),
      capabilities: { search: true, fetch: true, browser_interaction: false, file_read: true,
        file_edit: true, command_execution: true, questions: true, approvals: true,
        artifact_download: true, resume_checkpoint: true },
      models, limits: { max_upload_bytes: 104857600, max_active_runs_per_conversation: 1,
        max_concurrent_sessions: 5,
        replay_retention_hours: 168, idempotency_retention_hours: 24 },
       voice,conversation_modes:modes,conversation_forks:{protocol:1,available:config.conversationForkSourceClient!==undefined},
      conversation_commands:{protocol:1,ordinary_steer:{configured:config.ordinarySteeringEnabled===true,delivery:'original',attachments:attachmentSteeringReady}},
      workbench: { enabled: true,
        plugin_profiles:config.pluginProfileClient!==undefined,
        host_settings_read:config.hostAdmin?.enabled===true&&!!config.hostAdmin.client,
        ...(config.hostAdmin?.enabled&&config.hostAdmin.client?{host_readiness_namespaces:config.hostAdmin.namespaces??[]}:{}),
        host_readiness:config.hostAdmin?.enabled===true&&typeof config.hostAdmin.client?.readHostReadiness==='function',
        host_settings_write:config.hostAdmin?.enabled===true&&config.hostAdmin.writeEnabled===true&&!!config.hostAdmin.client,
        ...(config.hostAdmin?.writeEnabled&&config.hostAdmin.writeNamespace?{host_settings_write_namespace:config.hostAdmin.writeNamespace}:{}),
        agent_roles: true, independent_teams: true, agent_messages: true, mcp_servers: true,
        shared_workspace: true, workspace_file_history: true, workspace_file_range: true, memory_scopes: ['project', 'private'], memory_lifecycle: true, memory_import: true, memory_restore: true, memory_consolidation: true, memory_retrieval_traces: true, memory_capture:true, memory_retrieval: 'local_keyword',task_readiness:true,task_prd:true,task_unlimited_runs:true,task_run_limit_protocol:1,model_budget:budgetPolicy!==undefined,
        task_reply_policy:true,task_reply_execution:false,task_create_delivery:true,task_notifications:true,channel_bindings:!!config.internalChannelToken||!!config.emailBindingSend||!!config.webPushVapid,email_bindings:!!config.emailBindingSend,wecom_bindings:!!config.internalChannelToken,matrix_bindings:!!config.internalChannelToken&&config.matrixOwnerBindingEnabled===true,webpush_bindings:!!config.webPushVapid,task_notification_events:['changed','completed','failed','needs_confirmation'],
        ...(budgetPolicy?{task_model_budget_limits:budgetPolicy.budgetSettings().limits.task_total}:{}),
        collaboration_modes: [{ id: 'single', enabled: true }, { id: 'independent_team', enabled: true },
          { id: 'subagents', enabled: false, reason: 'HOST_ADAPTER_NOT_READY' },
          { id: 'team', enabled: false, reason: 'DSH_EXPERIMENTAL_TEAM_NOT_READY' },
          { id: 'handoff', enabled: false, reason: 'HOST_ADAPTER_NOT_READY' }],
        task_triggers: ['once', 'interval', 'page_change', 'daily', 'weekly', 'cron', 'delay','conversation_message','conversation_result'], notification_channels: ['in_app'],
        task_schedule_limits: { default_interval_seconds: 300, min_interval_seconds: 60, max_interval_seconds: 31536000,
          dst_gap: 'next_valid_time', dst_fold: 'first_only', missed_triggers: 'coalesce', misfire_policies: ['coalesce','skip','catch_up'] },
        allowed_tools: WORKBENCH_TOOL_IDS, execution_ready: config.workbenchExecutionReady === true, browser_action_readiness: browserActionReadiness },
      ...(config.workspaces.length?{workspace_selection:workbench.getWorkspacePreference(ownerId)}:{}),
      workspaces: config.workspaces.map(workspace_id => ({ workspace_id, title: workspace_id, can_read: true, can_write: true, owner_id: ownerId }))
        .map(({ owner_id: _ignored, ...workspace }) => workspace),
    };
  });
  registerGitRoutes(app,gitWorkbench,actor);
  registerGitReviewRoutes(app,{intents:gitReviewIntents,actor,atomic:atomicCommand});
  registerGitBranchReviewRoutes(app,{intents:gitBranchIntents,actor,atomic:atomicCommand});
  registerGitInitializationReviewRoutes(app,{intents:gitInitializationIntents,actor,atomic:atomicCommand});
  const gitCheckoutIntents=new GitCheckoutIntents(db,projects,gitWorkbench,value=>contracts.validateComponent('GitCheckoutReviewWitness',value).valid);
  registerGitCheckoutReviewRoutes(app,{intents:gitCheckoutIntents,actor,atomic:atomicCommand});
  const gitIndexExecutions=new GitIndexExecutions(db,projects,gitWorkbench,gitReviewIntents);
  registerGitExecutionHistoryRoutes(app,gitIndexExecutions,actor,atomicCommand);
  registerIndexDispatchRoutes(app,{executions:gitIndexExecutions,client:config.nativeGitClient,actor});
  // These constructors observe the original database only. Publication schema
  // readiness still requires the explicit maintenance upgrade, never a request.
  const workPublicationIntents=config.gitRepositories?.length?new WorkPublicationIntents(db,gitWorkbench):undefined;
  const workPublicationExecutions=workPublicationIntents?new WorkPublicationExecutions(db,gitWorkbench,workPublicationIntents):undefined;
  registerPublicationReviewRoutes(app,{intents:workPublicationIntents,sources:new FinalizedWorkSources(db),actor,atomic:atomicCommand});
  registerPublicationExecutionRoutes(app,{executions:workPublicationExecutions,actor,atomic:atomicCommand});
  registerPublicationDispatchRoutes(app,{executions:workPublicationExecutions,client:config.nativeGitClient,actor});
  registerGitWorkspaceSource(app,gitIndexExecutions,config.internalChannelToken,db,workPublicationExecutions);
  app.get('/v1/workspaces/selection', async request => workbench.getWorkspacePreference(actor(request as any)));
  app.post('/v1/workspaces/selection', async request => atomicCommand(request,200,()=>workbench.selectWorkspace(actor(request as any),request.body as Record<string,unknown>)));
  app.get('/v1/projects', async request => projects.list(actor(request as any)));
  app.get('/v1/projects/lifecycle', async request => projects.lifecycle(actor(request as any)));
  app.post('/v1/projects/:projectId/lifecycle', async request => atomicCommand(request,200,()=>{
    const {projectId}=request.params as {projectId:string};
    const input=request.body as {action:'archive'|'restore'|'delete';expected_version:number};
    return projects[input.action](projectId,actor(request as any),input);
  }));
  app.post('/v1/projects', async (request, reply) =>
    reply.code(201).send(atomicCommand(request,201,()=>projects.create(actor(request as any), request.body as Record<string, unknown>))));
  app.patch('/v1/projects/:projectId', async request =>
    atomicCommand(request,200,()=>projects.update((request.params as { projectId: string }).projectId, actor(request as any), request.body as Record<string, unknown>)));

  app.get('/v1/conversations', async request => {
    const query = request.query as { limit?: string; project_id?: string; state?: string;cursor?:string };
    const options: { limit: number; project_id?: string; state?: string;cursor?:string } = { limit: Number(query.limit ?? 50) };
    if (query.project_id !== undefined) options.project_id = query.project_id;
    if (query.state !== undefined) options.state = query.state;
    if (query.cursor !== undefined) options.cursor = query.cursor;
    return conversations.list(actor(request as any), options);
  });

  app.post('/v1/conversations', async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    if (!config.workspaces.includes(String(input.workspace_id))) return reply.code(403).send({ error: { code: 'WORKSPACE_FORBIDDEN' } });
    const commit=await conversationModes.prepareCreate(actor(request as any),input);
    return reply.code(201).send(atomicCommand(request,201,commit));
  });
  app.get('/v1/conversations/:conversationId', async request =>
    conversations.get((request.params as { conversationId: string }).conversationId, actor(request as any)));
  app.patch('/v1/conversations/:conversationId', async request => {
    const id=(request.params as {conversationId:string}).conversationId,owner=actor(request as any),input=request.body as Record<string,unknown>;
    if(input.mode===undefined)return conversations.update(id,owner,input);
    const commit=await conversationModes.prepareUpdate(id,owner,input);return atomicCommand(request,200,commit);
  });
  app.get('/v1/conversations/:conversationId/tool-result-search', async (request,reply) => {
    const {conversationId}=request.params as {conversationId:string},owner=actor(request as any);
    const abort=new AbortController(),disconnected=()=>abort.abort();
    request.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(request.raw.aborted||reply.raw.destroyed)disconnected();
    try{
      const candidates:import('./events/activity-tool-result.ts').NativeSearchCandidate[]=[];
      let base:ReturnType<typeof searchActivityToolResults>;
      db.exec('BEGIN');
      try{
        conversations.get(conversationId,owner);
        base=searchActivityToolResults(db,owner,conversationId,request.query as Record<string,unknown>,workbench,candidates);
        db.exec('COMMIT');
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]);
      const value=await searchNativeActivitySources(db,owner,base,candidates,config.nativeSearchSourceClient,signal);
      signal.throwIfAborted();conversations.get(conversationId,owner);
      return reply.header('cache-control','private, no-store').send(value);
    }catch(error){
      if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))
        return reply.code(503).send({error:{code:'ACTIVITY_TOOL_RESULT_SOURCE_SEARCH_UNAVAILABLE'}});
      throw error;
    }finally{request.raw.off('aborted',disconnected);reply.raw.off('close',disconnected);}
  });
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/file', async (request,reply) => {
    const {conversationId,activityId}=request.params as {conversationId:string;activityId:string},owner=actor(request as any);
    db.exec('BEGIN');
    try{
      conversations.get(conversationId,owner);
      const value=readActivityToolResultFile(db,owner,conversationId,activityId,request.query as Record<string,unknown>,workbench);
      db.exec('COMMIT');return reply.header('cache-control','private, no-store').send(value);
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  });
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/file/bytes', async (request,reply) => {
    const {conversationId,activityId}=request.params as {conversationId:string;activityId:string},owner=actor(request as any);
    db.exec('BEGIN');
    try{
      conversations.get(conversationId,owner);
      const value=readActivityToolResultFileBytes(db,owner,conversationId,activityId,request.query as Record<string,unknown>,workbench);
      db.exec('COMMIT');return reply.header('cache-control','private, no-store').send(value);
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  });
  let documentPreviewBusy=false;
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/file/document',async(request,reply)=>{
    const {conversationId,activityId}=request.params as {conversationId:string;activityId:string},owner=actor(request as any);
    const input=parseActivityFileDownloadQuery(request.query as Record<string,unknown>);
    if(input.framed)throw Error('invalid_activity_tool_result_query');
    conversations.get(conversationId,owner);
    if(documentPreviewBusy)return reply.code(429).header('retry-after','1').send({error:{code:'DOCUMENT_PREVIEW_BUSY'}});
    documentPreviewBusy=true;
    const controller=new AbortController(),abort=()=>controller.abort();
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    if(request.raw.aborted||reply.raw.destroyed)abort();
    try{
      const value=await readActivityFileDocument(db,workbench,owner,conversationId,activityId,input,
        join(dirname(resolve(config.databasePath)),'.jot-document-previews'),controller.signal);
      conversations.get(conversationId,owner);
      return reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').send(value);
    }finally{request.raw.off('aborted',abort);reply.raw.off('close',abort);documentPreviewBusy=false;}
  });
  const officePrintRoot=join(dirname(resolve(config.databasePath)),'.jot-office-print-'+createHash('sha256').update(resolve(config.databasePath)).digest('hex').slice(0,16));
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/file/print',async(request,reply)=>{
    const {conversationId,activityId}=request.params as {conversationId:string;activityId:string},owner=actor(request as any);
    const {input,expected}=parseOfficePrintQuery(request.query as Record<string,unknown>);
    conversations.get(conversationId,owner);
    if(input.size>OFFICE_PRINT_SOURCE_MAX_BYTES)throw Error('DOCUMENT_PREVIEW_TOO_LARGE');
    if(!officePrintReferencesReady)throw Error('office_print_reference_unproven');
    if(documentPreviewBusy)return reply.code(429).header('retry-after','1').send({error:{code:'DOCUMENT_PREVIEW_BUSY'}});
    documentPreviewBusy=true;
    const controller=new AbortController(),abort=()=>controller.abort();
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    if(request.raw.aborted||reply.raw.destroyed)abort();
    try{
      let binaryPath:string|undefined;
      if(!expected){
        const renderer=await officePreviewStatus.read(false,controller.signal);
        if(!renderer.libreOffice.available)throw Error('office_preview_binary_unavailable');
        binaryPath=renderer.libreOffice.binaryPath;
      }
      const value=await readActivityFileOfficePdf(db,workbench,owner,conversationId,activityId,input,
        officePrintRoot,controller.signal,expected,binaryPath);
      conversations.get(conversationId,owner);
      const proof=signOfficePrintProof(config.internalChannelToken,owner,{conversationId,runId:input.runId,activityId,resultSha:input.resultSha,
        file:{path:input.path,version:input.version,sha256:input.fileSha,size:input.size}},
        {sha256:value.pdf.sha256,size:value.pdf.size,pageCount:value.pdf.page_count});
      return reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff')
        .header('x-jot-preview-proof',proof)
        .header('x-activity-file-sha256',value.sha256).header('x-activity-file-size',String(value.size))
        .header('x-activity-file-version',String(value.version)).header('x-activity-tool-result-sha256',value.result_sha256)
        .header('x-jot-preview-protocol','1').header('x-jot-preview-renderer','libreoffice')
        .header('x-jot-preview-media-type','application/pdf').header('x-jot-preview-sha256',value.pdf.sha256)
        .header('x-jot-preview-size',String(value.pdf.size)).header('x-jot-preview-pages',String(value.pdf.page_count))
        .header('x-jot-execution-authorized','false').header('content-length',String(value.pdf.size))
        .header('content-disposition','attachment; filename="office-preview.pdf"').type('application/octet-stream').send(value.pdf.bytes);
    }finally{request.raw.off('aborted',abort);reply.raw.off('close',abort);documentPreviewBusy=false;}
  });
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result/file/download', async (request,reply) => {
    const {conversationId,activityId}=request.params as {conversationId:string;activityId:string},owner=actor(request as any);
    const input=parseActivityFileDownloadQuery(request.query as Record<string,unknown>);
    conversations.get(conversationId,owner);
    const controller=new AbortController(),store=createPinnedByteStore(join(dirname(resolve(config.databasePath)),'.jot-downloads'));
    let responseStream:Readable|undefined;
    const abort=()=>{controller.abort();responseStream?.destroy();};
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    if(request.raw.aborted||reply.raw.destroyed)abort();
    let cleanupPromise:Promise<void>|undefined;
    const cleanup=()=>cleanupPromise??=(async()=>{request.raw.off('aborted',abort);reply.raw.off('close',abort);await store.dispose();})();
    try{
      const writer=await store.begin(input.fileSha,input.size,controller.signal);
      controller.signal.throwIfAborted();
      db.exec('BEGIN');
      let file:ReturnType<typeof readActivityToolResultFileDownload>;
      try{
        file=readActivityToolResultFileDownload(db,owner,conversationId,activityId,input,workbench,writer.appendSync);
        db.exec('COMMIT');
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      await writer.seal();controller.signal.throwIfAborted();
      async function* content(){
        try{
          let offset=0;
          for await(const bytes of writer.source.stream(controller.signal)){
            if(input.framed)yield JSON.stringify({offset_bytes:offset,content_base64:bytes.toString('base64'),chunk_sha256:createHash('sha256').update(bytes).digest('hex')})+'\n';
            else yield bytes;
            offset+=bytes.length;
          }
          if(input.framed)yield JSON.stringify({complete:true,size_bytes:file.size,sha256:file.sha256})+'\n';
        }finally{await cleanup();}
      }
      const stream=Readable.from(content());responseStream=stream;
      stream.once('close',()=>{void cleanup().catch(error=>app.log.error({err:error},'Original file download cleanup failed'));});
      reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff')
        .header('x-activity-file-sha256',file.sha256).header('x-activity-file-size',String(file.size))
        .header('x-activity-file-version',String(file.version)).header('x-activity-tool-result-sha256',file.result_sha256);
      if(input.framed)reply.type('application/x-ndjson');
      else{
        const originalName=file.path.split('/').at(-1)!,name=originalName.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,255)||'listed-file';
        const encodedName=encodeURIComponent(Buffer.from(originalName,'utf8').toString('utf8')).replace(/['()*]/g,value=>'%'+value.charCodeAt(0).toString(16).toUpperCase());
        reply.type('application/octet-stream').header('content-length',String(file.size)).header('content-disposition',`attachment; filename="${name}"; filename*=UTF-8''${encodedName}`);
      }
      return reply.send(stream);
    }catch(error){await cleanup();throw error;}
  });
  app.get('/v1/conversations/:conversationId/activities/:activityId/tool-result', async (request,reply) => {
    const {conversationId,activityId}=request.params as {conversationId:string;activityId:string},owner=actor(request as any);
    db.exec('BEGIN');
    try{
      conversations.get(conversationId,owner);
      const value=readActivityToolResult(db,owner,conversationId,activityId,request.query as Record<string,unknown>,workbench);
      db.exec('COMMIT');return reply.header('cache-control','private, no-store').send(value);
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  });
  app.get('/v1/conversations/:conversationId/activities', async (request,reply) => {
    const id=(request.params as {conversationId:string}).conversationId,owner=actor(request as any);
    db.exec('BEGIN');
    try{
      conversations.get(id,owner);
      const value=readActivityHistory(db,id,request.query as {as_of_seq?:unknown;before_seq?:unknown;limit?:unknown;run_id?:unknown});
      db.exec('COMMIT');return reply.header('cache-control','no-store').send(value);
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  });
  app.get('/v1/conversations/:conversationId/messages', async request => {
    const query = request.query as { limit?: string;cursor?:string };
    return conversations.messages((request.params as { conversationId: string }).conversationId,
      actor(request as any), Number(query.limit ?? 50),query.cursor);
  });
  app.post('/v1/conversations/:conversationId/messages', async (request, reply) => {
    const id = (request.params as { conversationId: string }).conversationId;
    const owner = actor(request as any);
    const agent = workbench.agentForConversation(owner, id);
    if (agent && agent.conversation_id !== id) throw new Error('task_conversation_read_only');
    const recoveryAbort=new AbortController(),cancelRecovery=()=>{if(!reply.raw.writableEnded)recoveryAbort.abort();};
    request.raw.once('aborted',cancelRecovery);reply.raw.once('close',cancelRecovery);
    let ordinary:Awaited<ReturnType<typeof conversationModes.prepareEnqueue>>|undefined;
    try{ordinary=agent?undefined:await conversationModes.prepareEnqueue(id,owner,request.body as Record<string,unknown>,recoveryAbort.signal);}
    finally{request.raw.removeListener('aborted',cancelRecovery);reply.raw.removeListener('close',cancelRecovery);}
    const result = atomicCommand(request,202, () => {
      const current=workbench.agentForConversation(owner,id);
      if(current?.agent_id!==agent?.agent_id)throw Error('conversation_mode_scope_invalid');
      if(ordinary)return ordinary();
      const run = runs.enqueue(id, owner, request.body as Record<string, unknown>);
      if (agent) workbench.bindRun(owner, agent.agent_id, String(run.run_id), 'chat');
      return run;
    });
    return reply.code(202).send(result);
  });
  app.get('/v1/runs/:runId', async request => runs.get((request.params as { runId: string }).runId, actor(request as any)));
  app.get('/v1/runs/:runId/diagnostics', async request => {
    const runId=(request.params as {runId:string}).runId;
    runs.get(runId,actor(request as any));
    const diagnostics=readRunRuntimeDiagnostics(db,runId);
    if(!diagnostics)throw Error('run_not_found');
    return diagnostics;
  });
  app.post('/v1/runs/:runId/steer', async (request, reply) => {
    const runId = (request.params as {runId: string}).runId;
    const owner = actor(request as any); runs.get(runId, owner);
    const requested=request.body as Record<string,unknown>;
    if(Array.isArray(requested.attachments)&&requested.attachments.length&&!(await readAttachmentSteeringReadiness(config.ordinaryAttachmentSteeringEnabled===true,config.ordinaryAttachmentSteeringClient)))throw Error('ordinary_attachment_steering_unavailable');
    return reply.code(202).send(atomicCommand(request,202, () => {
      workbench.assertRunActive(runId); persistentTasks.assertRunActive(runId);
      let input=request.body as Record<string,unknown>;
      let referenceSnapshots:ReferenceSnapshotInput|undefined;
      if(Object.hasOwn(input,'reference_snapshots')){
        if(!messageReferenceSnapshotsInstalled(db))throw Error('content_reference_storage_unavailable');
        const prepared=prepareReferenceSteeringText(input.text,input.attachments??[],input.reference_snapshots);
        assertReferenceSnapshotImages(db,owner,String(runs.get(runId,owner).conversation_id),prepared.referenceSnapshots.items,config.internalChannelToken);
        referenceSnapshots=prepared.referenceSnapshots;
        const {reference_snapshots,...original}=input;
        input={...original,text:prepared.text};
      }
      if(input.delivery!=='original'){
        const receipt=commands.steer(runId,owner,input,String(request.headers['idempotency-key']||''));
        if(referenceSnapshots)captureRunCommandReferenceSnapshots(db,runId,owner,receipt.command_id,referenceSnapshots.items);
        return receipt;
      }
      if(config.ordinarySteeringEnabled!==true)throw Error('ordinary_steering_unavailable');
      // Native source proofs retain their original exact text payload. Delivery
      // metadata remains in the HTTP request hash and never grants execution.
      const source={text:input.text,client_message_id:input.client_message_id,expected_run_version:input.expected_run_version};
      const attachmentManifest=Array.isArray(input.attachments)&&input.attachments.length?new AttachmentResolver(db,config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads')).pinForMessage(owner,String(runs.get(runId,owner).conversation_id),input.attachments as string[],`steer-source:${runId}:${input.client_message_id}`):undefined;
      const receipt=commands.steer(runId,owner,{...source,...(attachmentManifest?{content_protocol:1,attachment_manifest:attachmentManifest}:{})},String(request.headers['idempotency-key']||''));
      if(referenceSnapshots)captureRunCommandReferenceSnapshots(db,runId,owner,receipt.command_id,referenceSnapshots.items);
      const binding=db.prepare('SELECT session_id FROM ga_run_native_sessions WHERE run_id=?').get(runId);
      const lease=db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(runId);
      if(typeof binding?.session_id!=='string'||!lease)throw Error('ordinary_steering_scope_unconfirmed');
      try{reserveOrdinarySteeringCustody(db,runId,binding.session_id,receipt.command_id,{owner:lease.owner,generation:lease.generation});}
      catch(error){if(['ordinary_input_binding_rejected','ordinary_steering_binding_rejected','workbench_execution_lease_revoked'].includes((error as Error).message))throw Error('ordinary_steering_scope_unconfirmed');throw error;}
      return receipt;
    }));
  });
  app.post('/v1/runs/:runId/cancel', async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const ownerId = actor(request as any);
    const input = request.body as Record<string, unknown>;
    const receipt=atomicCommand(request,202,()=>{
      const accepted=commands.cancel(runId,ownerId,input,String(request.headers['idempotency-key']||''));
      // This is the existing durable outbox side effect, not a direct C request.
      try{crawlBatches.cancel(ownerId,runId,String(input.reason??'USER_CANCELLED'));}catch{}
      return accepted;
    });
    return reply.code(202).send(receipt);
  });
  app.post('/v1/runs/:runId/resume', async (request, reply) => {
    const runId = (request.params as {runId: string}).runId, owner = actor(request as any);
    return reply.code(202).send(withImmediateTransaction(db, () => {
      runs.get(runId, owner); workbench.contextForRun(runId);
      const result = commands.resume(runId, owner, request.body as Record<string, unknown>, String(request.headers['idempotency-key'] || ''));
      workbench.inheritCheckpointRun(owner, runId, result.run_id);
      return result;
    }));
  });
  app.get('/v1/runs/:runId/artifacts', async request =>
    artifacts.listForRun((request.params as { runId: string }).runId, actor(request as any)));
  const emotionAdvisor = new EmotionAdvisor(config.emotion?.env,config.emotion?.transport);
  app.get('/v1/conversations/:conversationId/emotion', async (request, reply) => {
    if(request.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:{code:'ORIGIN_FORBIDDEN'}});
    const cid=(request.params as {conversationId:string}).conversationId;
    const owner=actor(request as any);
    const input=request.query as {run_id?:string;interaction?:string;click_count?:string;scroll_direction?:string};
    conversations.get(cid,owner);
    let interaction:{kind:string;click_count:number;scroll_direction:string}|undefined;
    if(input.interaction){
      interaction={kind:input.interaction,click_count:Number(input.click_count??0),scroll_direction:input.scroll_direction??'none'};
      if(!['click','scroll','idle'].includes(interaction.kind)||!Number.isInteger(interaction.click_count)||interaction.click_count<0||interaction.click_count>99||!['up','down','none'].includes(interaction.scroll_direction))return reply.code(400).send({error:{code:'INVALID_INTERACTION'}});
    }
    const run=input.run_id?runs.get(input.run_id,owner):undefined;
    if(run&&run.conversation_id!==cid)return reply.code(404).send({error:{code:'RUN_NOT_FOUND'}});
    if(!run&&!interaction)return reply.code(400).send({error:{code:'RUN_REQUIRED'}});
    const snapshot=buildSnapshot(db,cid,owner);
    const event=interaction?'interaction':taskEmotionEvent(run!,snapshot.activities,snapshot.messages.some((m:any)=>m.run_id===run!.run_id&&m.role==='assistant'&&m.status==='streaming'));
    const accountingRunId=String(run?.run_id??'');
    const roleConversation=workbench.agentForConversation(owner,cid);
    const budgetScoped=run&&(roleConversation||db.prepare('SELECT 1 FROM wb_run_bindings WHERE run_id=? AND owner_id=?').get(accountingRunId,owner)
      ||(modelBudgets&&db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE run_id=? AND owner_id=?').get(accountingRunId,owner)));
    if((!run&&roleConversation)||(budgetScoped&&!modelBudgets))
      return {status:'abstain',reason_code:'ACCOUNTING_UNAVAILABLE',run_id:run?.run_id??'',conversation_id:cid,event};
    const accounting:EmotionAccounting|undefined=budgetScoped&&modelBudgets?{
      ledger:modelBudgets,owner,runId:accountingRunId,routes:config.emotion?.accountingRoutes??emotionAccountingRoutesFromPolicy(config.modelBudgetPolicy?.routes??config.modelBudgetRoutes??[]),
      ...createAuxiliaryRunGuard(db,workbench,persistentTasks,owner,accountingRunId),
    }:undefined;
    const userMessage=run?snapshot.messages.filter((m:any)=>m.run_id===run.run_id&&m.role==='user').at(-1) as any:undefined;
    const userText=(userMessage?.blocks??[]).map((b:any)=>typeof b.text==='string'?b.text:'').join(' ');
    const signal=userEmotionSignal(userText);
    const suggestion=await emotionAdvisor.select(owner+'|'+cid+'|'+(run?.run_id??''),event,signal,userText,interaction,accounting);
    return {...suggestion as Record<string,unknown>,run_id:run?.run_id??'',conversation_id:cid,event};
  });
  app.get('/v1/conversations/:conversationId/snapshot', async request =>
    buildSnapshot(db, (request.params as { conversationId: string }).conversationId, actor(request as any)));
  app.get('/v1/conversations/:conversationId/interaction-history/:interactionId', async (request,reply) => {
    const {conversationId,interactionId}=request.params as {conversationId:string;interactionId:string};
    reply.header('cache-control','private, no-store');
    return interactions.historyRecord(conversationId,actor(request as any),interactionId,request.query as Record<string,unknown>);
  });
  app.get('/v1/conversations/:conversationId/interaction-search', async (request,reply) => {
    reply.header('cache-control','private, no-store');
    return interactions.searchHistory((request.params as {conversationId:string}).conversationId,actor(request as any),request.query as Record<string,unknown>);
  });
  app.get('/v1/conversations/:conversationId/interaction-history', async (request,reply) => {
    reply.header('cache-control','no-store');
    return interactions.history((request.params as {conversationId:string}).conversationId,actor(request as any),request.query as {cursor?:unknown;run_id?:unknown;limit?:unknown});
  });
  app.get('/v1/conversations/:conversationId/interactions', async request => {
    const query = request.query as { status?: string };
    return interactions.list((request.params as { conversationId: string }).conversationId, actor(request as any), query.status ?? 'pending');
  });
  app.post('/v1/interactions/:interactionId/response', async (request, reply) => reply.code(202).send(interactions.respond(
    (request.params as { interactionId: string }).interactionId, actor(request as any), request.body as Record<string, unknown>,
    String(request.headers['idempotency-key'] || ''),
  )));
  const reviewOutputs=new TaskReviewOutputs(db);let reviewReadBusy=false;
  const reviewRead=(request:any,reply:any,content:boolean)=>{
    reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').header('referrer-policy','no-referrer');
    if(Object.keys(request.query??{}).length)throw new Error('invalid_task_review_output_query');
    if(reviewReadBusy)return reply.code(429).send({error:{code:'TASK_REVIEW_OUTPUT_BUSY'}});
    reviewReadBusy=true;let released=false;const deadline=setTimeout(()=>reply.raw.destroy(),30000);deadline.unref();
    const release=()=>{if(!released){released=true;clearTimeout(deadline);reviewReadBusy=false;}};
    reply.raw.once('finish',release);reply.raw.once('close',release);
    try{
      const params=request.params as {interactionId:string;outputIndex?:string},owner=actor(request);
      if(!content)return reply.send(reviewOutputs.list(owner,params.interactionId));
      const value=reviewOutputs.content(owner,params.interactionId,params.outputIndex!);
      const filename=value.file_name.split(/[\\/]/).at(-1)!.replace(/[^A-Za-z0-9._-]/g,'_')||'review-output';
      return reply.header('content-type','application/octet-stream').header('content-disposition',`attachment; filename="${filename}"`).send(Readable.from([value.content]));
    }catch(error){release();throw error;}
  };
  app.get('/v1/interactions/:interactionId/outputs',(request,reply)=>reviewRead(request,reply,false));
  app.get('/v1/interactions/:interactionId/outputs/:outputIndex',(request,reply)=>reviewRead(request,reply,true));
  app.post('/v1/interactions/:interactionId/decision', async (request, reply) => reply.code(202).send(interactions.decide(
    (request.params as { interactionId: string }).interactionId, actor(request as any), request.body as Record<string, unknown>,
    String(request.headers['idempotency-key'] || ''),
  )));
  app.post('/v1/conversations/:conversationId/upload-batches',async(request,reply)=>reply.code(201).send(atomicCommand(request,201,()=>artifacts.initUploadBatch(
    (request.params as {conversationId:string}).conversationId,actor(request as any),request.body as Record<string,unknown>,
  ))));
  app.delete('/v1/upload-batches/:batchId',async(request,reply)=>{
    const batchId=String((request.params as Record<string,unknown>).batchId??''),owner=actor(request as any);
    artifacts.assertUploadBatchCancellationLive(batchId,owner);
    const result=atomicCommand(request,204,()=>artifacts.cancelUploadBatch(batchId,owner));
    if(reply.sent)return result;
    artifacts.finishCancelledBatch(batchId,owner);
    return reply.code(204).send();
  });
  app.post('/v1/conversations/:conversationId/uploads', async (request, reply) => reply.code(201).send(atomicCommand(request,201,()=>artifacts.initUpload(
    (request.params as { conversationId: string }).conversationId, actor(request as any), request.body as Record<string, unknown>,
  ))));
  app.put('/v1/uploads/:uploadId/content', { bodyLimit: 104857600 }, async (request, reply) => {
    await artifacts.writeContent((request.params as { uploadId: string }).uploadId, actor(request as any), request.body as AsyncIterable<Uint8Array>,()=>atomicCommand(request,204,()=>undefined));
    return reply.code(204).send();
  });
  app.post('/v1/uploads/:uploadId/complete', async (request, reply) => {
    const uploadId=(request.params as {uploadId:string}).uploadId,owner=actor(request as any);
    artifacts.assertUploadReceiptLive(uploadId,owner);
    return reply.code(201).send(atomicCommand(request,201,()=>artifacts.complete(uploadId,owner,request.body as Record<string,unknown>)));
  });
  app.get('/v1/uploads/:uploadId',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    return artifacts.uploadStatus((request.params as {uploadId:string}).uploadId,actor(request as any));
  });
  app.delete('/v1/uploads/:uploadId', async (request, reply) => {
    const uploadId=String((request.params as Record<string,unknown>).uploadId??''),owner=actor(request as any);
    artifacts.assertUploadCancellationLive(uploadId,owner);
    const result=atomicCommand(request,204,()=>artifacts.cancelUpload(uploadId,owner));
    if(reply.sent)return result;
    artifacts.finishCancelledUpload(uploadId,owner);
    return reply.code(204).send();
  });
  app.post('/v1/artifacts/:artifactId/file-operations', async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    return reply.code(202).send(fileJobs.enqueue(actor(request as any), String(input.conversation_id || ''),
      (request.params as { artifactId: string }).artifactId, input, String(request.headers['idempotency-key'] || '')));
  });
  app.get('/v1/file-jobs/:jobId', async request =>
    fileJobs.get(actor(request as any), (request.params as { jobId: string }).jobId));
  app.get('/v1/artifacts/:artifactId', async request => {
    const query = request.query as { version?: string };
    return artifacts.get((request.params as { artifactId: string }).artifactId, actor(request as any), query.version ? Number(query.version) : undefined);
  });
  app.get('/v1/conversations/:conversationId/artifacts', async (request,reply) => {
    reply.header('cache-control','private, no-store');
    return artifacts.history((request.params as {conversationId:string}).conversationId,actor(request as any),request.query as {cursor?:unknown;run_id?:unknown;limit?:unknown});
  });
  app.get('/v1/artifacts/:artifactId/text', async (request,reply) => {
    const controller=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)controller.abort();};
    request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
    reply.header('cache-control','private, no-store');
    try{return await artifacts.textPage((request.params as {artifactId:string}).artifactId,actor(request as any),request.query as Record<string,unknown>,controller.signal);}
    finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel);}
  });
  app.get('/v1/conversations/:conversationId/artifact-search', async (request,reply) => {
    const controller=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)controller.abort();};
    request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
    reply.header('cache-control','private, no-store');
    try{return await artifacts.searchTextHistory((request.params as {conversationId:string}).conversationId,actor(request as any),request.query as Record<string,unknown>,controller.signal);}
    finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel);}
  });
  app.get('/v1/artifacts/:artifactId/versions', async (request, reply) => {
    reply.header('cache-control','private, no-store');
    return artifacts.versions((request.params as {artifactId:string}).artifactId, actor(request as any), request.query as {limit?:unknown;before_version?:unknown});
  });
  app.get('/v1/artifacts/:artifactId/backup-status', async (request, reply) => {
    reply.header('cache-control','private, no-store');
    const status=artifacts.backupStatus((request.params as {artifactId:string}).artifactId,actor(request as any),request.query as {version?:unknown;sha256?:unknown;part_index?:unknown;restore_protocol?:unknown});
    return status.restore_protocol===3?{...status,executor:archiveStatus()}:status;
  });
  app.get('/v1/artifacts/:artifactId/commands/:commandKey',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const query=request.query as Record<string,unknown>;
    if(Object.keys(query).sort().join(',')!=='body,path'||typeof query.path!=='string'||typeof query.body!=='string'||query.body.length>4096)throw Error('artifact_command_request_invalid');
    let body:unknown;try{body=JSON.parse(query.body);}catch{throw Error('artifact_command_request_invalid');}
    const params=request.params as {artifactId:string;commandKey:string};
    return artifactCommands.disposition(actor(request as any),params.artifactId,params.commandKey,{path:query.path,body});
  });
  app.post('/v1/artifacts/:artifactId/commands/:commandKey/close',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const params=request.params as {artifactId:string;commandKey:string};
    if(String(request.headers['idempotency-key']??'')!==params.commandKey)throw Error('artifact_command_request_invalid');
    return artifactCommands.disposition(actor(request as any),params.artifactId,params.commandKey,request.body,true);
  });
  app.post('/v1/artifacts/:artifactId/archive',async(request,reply)=>reply.code(202).send(atomicCommand(request,202,()=>artifacts.requestArchive(
    (request.params as {artifactId:string}).artifactId,actor(request as any),request.body as Record<string,unknown>))));
  app.post('/v1/artifacts/:artifactId/restore', async (request, reply) => {
    const input = request.body ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['expected_version','restore_version','restore_sha256','part_index'].includes(key))) throw new Error('invalid_artifact_restore');
    const body=input as {expected_version?:number;restore_version?:unknown;restore_sha256?:unknown;part_index?:unknown};
    const selected=Object.hasOwn(body,'restore_version')||Object.hasOwn(body,'restore_sha256')||Object.hasOwn(body,'part_index');
    return reply.code(202).send(atomicCommand(request,202,()=>artifacts.requestRestore(
      (request.params as {artifactId:string}).artifactId,actor(request as any),body.expected_version,
      selected?{version:body.restore_version,sha256:body.restore_sha256,...(body.part_index!==undefined?{part_index:body.part_index}:{})}:undefined)));
  });
  app.get('/v1/artifacts/:artifactId/preview', async request => {
    const query = request.query as { version?: string };
    return artifacts.preview((request.params as { artifactId: string }).artifactId, actor(request as any), query.version ? Number(query.version) : undefined);
  });
  app.get('/v1/artifacts/:artifactId/edited-diff', async (request,reply) => reply.header('cache-control','private, no-store').send(
    artifacts.editedDocumentDiff((request.params as {artifactId:string}).artifactId,actor(request as any),request.query as Record<string,unknown>)));
  app.get('/v1/artifacts/:artifactId/diff', async request => {
    const query = request.query as { from_version: string; to_version: string };
    return artifacts.diff((request.params as { artifactId: string }).artifactId, actor(request as any), Number(query.from_version), Number(query.to_version));
  });
  const sendArtifactDownload=(reply:any,row:Record<string,unknown>)=>{
    const meta=JSON.parse(String(row.metadata_json));
    const asciiName=String(meta.file_name).replace(/[^A-Za-z0-9._-]/g,'_');
    return reply.header('content-type',String(row.mime_type)).header('x-content-type-options','nosniff')
      .header('content-disposition',`attachment; filename="${asciiName}"`).send(row.verified_content instanceof Buffer?row.verified_content:createReadStream(String(row.server_path)));
  };
  app.get('/v1/artifacts/:artifactId/parts',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const query=request.query as {version?:string};
    return artifacts.parts((request.params as {artifactId:string}).artifactId,actor(request as any),query.version===undefined?1:Number(query.version));
  });
  app.get('/v1/artifacts/:artifactId/parts/:partIndex',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const params=request.params as {artifactId:string;partIndex:string},query=request.query as {version?:string};
    return artifacts.part(params.artifactId,actor(request as any),Number(params.partIndex),query.version===undefined?1:Number(query.version));
  });
  app.get('/v1/artifacts/:artifactId/parts/:partIndex/download',async(request,reply)=>{
    const params=request.params as {artifactId:string;partIndex:string},query=request.query as {version?:string};
    return sendArtifactDownload(reply,artifacts.downloadPart(params.artifactId,actor(request as any),Number(params.partIndex),query.version===undefined?1:Number(query.version)));
  });
  app.get('/v1/artifacts/:artifactId/download', async (request, reply) => {
    const query = request.query as { version?: string };
    const row = artifacts.download((request.params as { artifactId: string }).artifactId, actor(request as any), query.version ? Number(query.version) : undefined);
    return sendArtifactDownload(reply,row);
  });
  app.get('/v1/sources/:sourceId', async request =>
    sources.get((request.params as { sourceId: string }).sourceId, actor(request as any)));
  app.get('/v1/crawl-batches/:batchId', async request =>
    crawlBatches.get(actor(request as any), (request.params as { batchId: string }).batchId));
  app.post('/v1/conversations/:conversationId/voice/transcriptions',
    { bodyLimit: VOICE_MAX_BYTES + 16_384 }, async (request, reply) => {
      if (!voiceTranscriptions.isEnabled()) throw new Error('voice_provider_unavailable');
      const ownerId = actor(request as any);
      const conversationId = (request.params as { conversationId: string }).conversationId;
      // Confirm ownership before consuming the upload or creating a job.
      conversations.get(conversationId, ownerId);
      if (!(request as any).isMultipart?.()) throw new Error('voice_multipart_required');
      const catalog = await voiceTranscriptions.catalog(AbortSignal.timeout(5_000));
      if (!catalog) throw new Error('voice_provider_unavailable');
      let clientRequestId = '';
      let language = '';
      let audio: Buffer | undefined;
      for await (const part of (request as any).parts({
        limits: { fileSize: VOICE_MAX_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 256 },
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio' || audio || part.mimetype !== 'audio/wav') throw new Error('voice_audio_invalid');
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > VOICE_MAX_BYTES) throw new Error('voice_audio_too_large');
            chunks.push(Buffer.from(chunk));
          }
          if (part.file.truncated) throw new Error('voice_audio_too_large');
          audio = Buffer.concat(chunks, size);
        } else if (part.fieldname === 'client_request_id') clientRequestId = String(part.value ?? '');
        else if (part.fieldname === 'language') language = String(part.value ?? '');
        else throw new Error('voice_multipart_invalid');
      }
      if (!audio) throw new Error('voice_audio_empty');
      if (audio.length > Math.min(VOICE_MAX_BYTES, catalog.maxAudioBytes)) throw new Error('voice_audio_too_large');
      validateVoiceWave(audio, catalog.maxDurationSeconds);
      const selected = catalog.providers.find(provider => provider.id === catalog.selection.providerId);
      if (!selected || !['ready', 'standby'].includes(selected.preparation.phase)) throw new Error('voice_provider_not_ready');
      if (!selected.languages.includes(language || catalog.selection.language)) throw new Error('voice_language_unsupported');
      return reply.code(202).send(voiceTranscriptions.enqueue({ ownerId, conversationId, clientRequestId,
        audio, ...(language ? { language } : {}), catalog }));
    });
  app.get('/v1/conversations/:conversationId/voice/transcriptions/:transcriptionId', async request => {
    const params = request.params as { conversationId: string; transcriptionId: string };
    return voiceTranscriptions.get(actor(request as any), params.conversationId, params.transcriptionId);
  });
  app.delete('/v1/conversations/:conversationId/voice/transcriptions/:transcriptionId', async request => {
    const params = request.params as { conversationId: string; transcriptionId: string };
    return voiceTranscriptions.cancel(actor(request as any), params.conversationId, params.transcriptionId);
  });
  app.get('/v1/conversations/:conversationId/events', async (request, reply) => {
    const id = (request.params as { conversationId: string }).conversationId;
    conversations.get(id, actor(request as any));
    const query = request.query as { after?: string; follow?: string };
    const after = Number(request.headers['last-event-id'] ?? query.after ?? 0);
    try {
      const replay = events.replay(id, after, 1000);
      const body = replay.map(event => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
      if (query.follow === '0') return reply.header('content-type', 'text/event-stream; charset=utf-8').header('cache-control', 'no-store').send(body);
      const stream = new PassThrough();
      let stopped=false;
      let cursor = replay.length ? Number(replay.at(-1)?.seq) : after;
      if (body) stream.write(body);
      const flush = () => {
        if(stopped||stream.destroyed||stream.writableNeedDrain)return;
        try{
          for (const event of events.replay(id, cursor, 1000)) {
            const writable=stream.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = Number(event.seq);
            if(!writable)break;
          }
        }catch(error){app.log.error(error);cleanup();}
      };
      const unsubscribe = events.subscribe(id, flush);
      // Worker and BFF are separate processes. The local EventEmitter is only a
      // latency hint; cursor polling is the authoritative cross-process wakeup.
      const replayPoll = setInterval(flush, 1_000);
      const heartbeat = setInterval(() => {if(!stopped&&!stream.destroyed)stream.write(': heartbeat\n\n');}, 15_000);
      const cleanup = ():void => {
        if(stopped)return;stopped=true;
        clearInterval(replayPoll);clearInterval(heartbeat);unsubscribe();eventStreamClosers.delete(cleanup);stream.destroy();
      };
      eventStreamClosers.add(cleanup);
      reply.raw.once('close', cleanup);
      stream.once('close', cleanup);
      stream.on('drain',flush);
      return reply.header('content-type', 'text/event-stream; charset=utf-8').header('cache-control', 'no-store')
        .header('connection', 'keep-alive').send(stream);
    } catch (error) {
      if (error instanceof FutureCursorError) return reply.code(409).send({ error: { code: error.message } });
      if (error instanceof ExpiredCursorError) return reply.code(410).send({ error: { code: error.message } });
      throw error;
    }
  });
  app.addHook('onClose', async () => voiceTranscriptions.close());
  return { app, db, events, projects, conversations, runs, commands, interactions, artifacts, sources, fileJobs, crawlBatches,
    voiceTranscriptions, workbench, persistentTasks, taskPrd, modelBudgets,nativeWorkResolver:nativeWork?.resolver,nativeWorkInspections:nativeWork?.inspections };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { await app.close(); } catch (failure) { cleanupErrors.push(failure); }
    try { if (db.isOpen) db.close(); } catch (failure) { cleanupErrors.push(failure); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'server_initialization_cleanup_failed');
    throw error;
  }
}
