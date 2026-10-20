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
import {registerChatCompactionSource} from './conversations/chat-compaction-source-route.ts';
import {registerChatCompactionAttempts} from './conversations/chat-compaction-attempt-route.ts';
import type {ConversationModeClient} from './conversations/mode-policy.ts';
import {TaskReplyDrafts} from './persistent-tasks/reply-drafts.ts';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, createHmac } from 'node:crypto';
import { openProductDatabase, withImmediateTransaction } from './db/database.ts';
import {canonicalJson} from './db/canonical-json.ts';
import { ConversationRepository } from './conversations/repository.ts';
import { ProjectRepository } from './projects/repository.ts';
import {GitWorkbench,type GitRepositoryBinding} from './git/service.ts';
import {registerGitRoutes} from './git/routes.ts';
import {GitMutationIntents} from './git/intents.ts';
import {registerGitReviewRoutes} from './git/review-routes.ts';
import {GitIndexExecutions} from './git/index-executions.ts';
import {registerGitExecutionHistoryRoutes} from './git/execution-history-routes.ts';
import {registerGitWorkspaceSource} from './git/workspace-source-route.ts';
import {WorkPublicationIntents} from './persistent-tasks/work-publication-intents.ts';
import {registerPublicationReviewRoutes} from './git/publication-review-routes.ts';
import {WorkPublicationExecutions} from './persistent-tasks/work-publication-executions.ts';
import { EventStore, ExpiredCursorError, FutureCursorError } from './events/event-store.ts';
import { RunRepository } from './runs/repository.ts';
import { buildSnapshot } from './events/snapshot.ts';
import { EmotionAdvisor, taskEmotionEvent, userEmotionSignal, emotionAccountingRoutesFromPolicy, type EmotionAccounting } from './harness/emotion-advisor.ts';
import { RunCommandService } from './runs/commands.ts';
import { InteractionService } from './interactions/service.ts';
import {TaskWaitResponder} from './persistent-tasks/task-wait.ts';
import {TaskReviewOutputs} from './persistent-tasks/review-outputs.ts';
import { ArtifactService } from './artifacts/service.ts';
import { createReadStream } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { SourceRepository } from './sources/repository.ts';
import { ContractValidator } from './contracts/validator.ts';
import { ChannelIntakeService } from './channels/intake.ts';
import {OwnerChannelBindings} from './channels/owner-bindings.ts';
import {EmailChannelBindings} from './channels/email-bindings.ts';
import { FileJobService } from './file-engine/jobs.ts';
import { TemplateCatalog, TemplateContractError } from './file-engine/templates.ts';
import { CrawlBatchService } from './crawl-batch/service.ts';
import { ChannelDeliveryService } from './channels/delivery.ts';
import { VoiceTranscriptionService } from './voice/service.ts';
import type { VoiceAdapter } from './voice/adapter-client.ts';
import { VOICE_MAX_BYTES, validateVoiceWave } from './voice/wav.ts';
import { WorkbenchService } from './workbench/service.ts';
import {DiscoveryPolicies} from './always-on/discovery-policy.ts';
import {createNativeWorkRuntime} from './always-on/native-work-runtime.ts';
import {readIsolatedTaskFileVersion} from './persistent-tasks/isolated-output-source.ts';
import {registerDiscoveryPolicyRoutes} from './always-on/discovery-policy-routes.ts';
import {DiscoveryHistory} from './always-on/discovery-history.ts';
import {registerDiscoveryHistoryRoutes} from './always-on/discovery-history-routes.ts';
import {configureTaskOutputReader} from './persistent-tasks/output-content.ts';
import {configureTaskOutputDelivery} from './persistent-tasks/output-delivery.ts';
import { registerWorkbenchRoutes } from './workbench/routes.ts';
import { PersistentTaskService } from './persistent-tasks/service.ts';
import {TaskNotifications} from './persistent-tasks/notifications.ts';
import {TaskReplyPolicies} from './persistent-tasks/reply-policy.ts';
import {TaskReplyHistory} from './persistent-tasks/reply-history.ts';
import { registerPersistentTaskRoutes } from './persistent-tasks/routes.ts';
import {TaskPrdService} from './persistent-tasks/prd.ts';
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
import {AttachmentResolver} from './artifacts/resolver.ts';
import {readAttachmentSteeringReadiness,type OrdinaryAttachmentSteeringClient} from './harness/ordinary-attachment-readiness.ts';

function actor(request: { headers: Record<string, unknown> }) {
  const id = String(request.headers['x-user-id'] || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('unauthorized');
  return id;
}

export async function buildServer(config: {
  modelCatalogClient?:ModelCatalogClient;
  conversationModeClient?:ConversationModeClient;
  chatModeEnabled?:boolean;
  ordinarySteeringEnabled?:boolean;
  ordinaryInputRecoveryEnabled?:boolean;
  ordinaryAttachmentSteeringEnabled?:boolean;
  ordinaryAttachmentSteeringClient?:OrdinaryAttachmentSteeringClient;
  workAgentPreset?:string;
  databasePath: string;
  workspaces: string[];
  uploadRoot?: string;
  csrfToken?: string;
  allowedOrigins?: string[];
  internalChannelToken?: string;
  emailBindingSend?: (text:string,recipient:string)=>Promise<Record<string,unknown>>;
  templateRoot?: string;
  voiceEnabled?: boolean;
  voiceAdapter?: VoiceAdapter;
  workbenchRoot?: string;
  nativeWorkRoot?: string;
  gitRepositories?:GitRepositoryBinding[];
  gitExecutable?:string;
  workbenchExecutionReady?: boolean;
  modelBudgetRoutes?: ModelBudgetRoute[];
  modelBudgetPolicy?: ModelBudgetPolicyConfig | undefined;
  replyJudge?: ReplyJudgeClient;
  conversationGoalClient?: ConversationGoalClient;
  conversationGoalResumeEnabled?:boolean;
  /** Server-only trusted provider configuration; never populated from request bodies. */
  emotion?: {env?:NodeJS.ProcessEnv;transport?:typeof fetch;accountingRoutes?:EmotionAccounting['routes']};
}) {
  for(const value of [config.ordinarySteeringEnabled,config.ordinaryInputRecoveryEnabled,config.ordinaryAttachmentSteeringEnabled]){if(value!==undefined&&typeof value!=='boolean')throw Error('ordinary_steering_configuration_invalid');}
  if(config.ordinarySteeringEnabled===true&&config.ordinaryInputRecoveryEnabled!==true)throw Error('ordinary_steering_recovery_required');
  if(config.ordinaryAttachmentSteeringEnabled===true&&(config.ordinarySteeringEnabled!==true||config.ordinaryInputRecoveryEnabled!==true||typeof config.ordinaryAttachmentSteeringClient?.steeringAttachmentsReadiness!=='function'))throw Error('ordinary_attachment_steering_configuration_invalid');
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: VOICE_MAX_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 256 } });
  const db = openProductDatabase(config.databasePath);
  try {
  const budgetPolicy = config.modelBudgetPolicy === undefined ? undefined : new WorkbenchBudgetPolicy(db,config.modelBudgetPolicy);
  const modelBudgets = budgetPolicy?.ledger ?? (config.modelBudgetRoutes === undefined ? undefined : new ModelBudgetLedger(db,{routes: config.modelBudgetRoutes}));
  const events = new EventStore(db);
  const projects = new ProjectRepository(db);
  const gitWorkbench=new GitWorkbench(projects,config.gitRepositories??[],config.gitExecutable);
  const gitReviewIntents=new GitMutationIntents(db,projects,gitWorkbench);
  const conversations = new ConversationRepository(db, projects);
  const runs = new RunRepository(db, events,{workAgentPreset:config.workAgentPreset??'jot-general'});
  const conversationModes=new ConversationModes(db,conversations,runs,config.conversationModeClient,config.chatModeEnabled===true);
  const commands = new RunCommandService(db, events);
  const artifacts = new ArtifactService(db, config.uploadRoot ?? join(dirname(config.databasePath), 'general-agent-uploads'));
  const sources = new SourceRepository(db);
  const contracts = new ContractValidator();
  const channelIntake = new ChannelIntakeService(db, runs, config.workspaces[0] ?? 'jot');
  const ownerChannels=new OwnerChannelBindings(db,{enabled:config.internalChannelToken?['wecom']:[]});
  const emailBindings=new EmailChannelBindings(db,config.emailBindingSend?{send:config.emailBindingSend}:{});
  const fileJobs = new FileJobService(db);
  const templates = new TemplateCatalog(config.templateRoot ?? resolve(process.cwd(), 'file-engine/templates'));
  const channelDelivery = new ChannelDeliveryService(db);
  const crawlBatches = new CrawlBatchService(db, events, channelDelivery);
  const voiceTranscriptions = new VoiceTranscriptionService(db,
    config.voiceEnabled ? config.voiceAdapter : undefined);
  const workbenchRoot = config.workbenchRoot ?? join(dirname(config.databasePath), 'jot-workspaces');
  const workbench = new WorkbenchService(db, { workspaceIds: config.workspaces,
    root: workbenchRoot, allowedToolIds: WORKBENCH_TOOL_IDS, ...(budgetPolicy ? {modelBudgetPolicy: budgetPolicy} : {}) });
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
  const taskPrd=new TaskPrdService(db,workbench,persistentTasks,artifacts,{uploadRoot:config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads')});
  const taskReplyPolicies=new TaskReplyPolicies(db);
  const replyDrafts=new TaskReplyDrafts(db,events);
  const replyHistory=new TaskReplyHistory(db);
  const taskInteractionResponder={
    resolve:(row:Record<string,unknown>,owner:string,status:string,input:Record<string,unknown>,key:string)=>replyDrafts.resolve(row,owner,status,input,key)||taskWaitResponder.resolve(row,owner,status,input,key),
    recordReceipt:(row:Record<string,unknown>,input:unknown,key:string,operation:string,receipt:Record<string,unknown>)=>replyDrafts.owns(String(row.id))?replyDrafts.recordReceipt(row,input,key,operation,receipt):taskWaitResponder.recordReceipt(row,input,key,operation,receipt),
  };
  const interactions = new InteractionService(db,events,taskInteractionResponder);
  const idempotencyRequests = new WeakMap<object, { owner: string; operation: string; key: string }>();
  const isUploadRoute=(request:any)=>['/v1/conversations/:conversationId/uploads','/v1/uploads/:uploadId/content','/v1/uploads/:uploadId/complete'].includes(request.routeOptions.url);
  const isMemoryRestoreRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/workspaces/:workspaceId/memory/:memoryId/restore';
  const isMemoryConsolidationRoute=(request:any)=>request.method==='POST'&&['/v1/workspaces/:workspaceId/memory-consolidations',...['propose','apply','rollback','reject'].map(action=>`/v1/workspaces/:workspaceId/memory-consolidations/:consolidationId/${action}`)].includes(request.routeOptions.url);
  const isMemoryCaptureRoute=(request:any)=>(request.method==='PATCH'&&request.routeOptions.url==='/v1/agents/:agentId/memory-capture-policy')||(request.method==='POST'&&['/v1/agents/:agentId/memory-capture-policy/collect',...['apply','reject'].map(action=>`/v1/agents/:agentId/memory-captures/:captureId/${action}`)].includes(request.routeOptions.url));
  const isGoalResumeRoute=(request:any)=>request.method==='POST'&&request.routeOptions.url==='/v1/conversations/:conversationId/goal'&&request.body?.action==='resume';
  const isDiscoveryPolicyRoute=(request:any)=>(request.method==='PATCH'&&request.routeOptions.url==='/v1/agents/:agentId/discovery-policy')||(request.method==='POST'&&request.routeOptions.url==='/v1/agents/:agentId/discovery-policy/control');
  const isModeMutationRoute=(request:any)=>request.method==='POST'&&['/v1/conversations','/v1/conversations/:conversationId/messages'].includes(request.routeOptions.url)||request.method==='PATCH'&&request.routeOptions.url==='/v1/conversations/:conversationId'&&request.body?.mode!==undefined;
  const isRunCommandRoute=(request:any)=>request.method==='POST'&&['/v1/runs/:runId/steer','/v1/runs/:runId/cancel'].includes(request.routeOptions.url);
  const isGitReviewRoute=(request:any)=>request.method==='POST'&&['/v1/projects/:projectId/git/intents','/v1/projects/:projectId/git/intents/:intentId/control'].includes(request.routeOptions.url);
  const isPublicationReviewRoute=(request:any)=>request.method==='POST'&&['/v1/projects/:projectId/work-publications','/v1/projects/:projectId/work-publications/:intentId/control'].includes(request.routeOptions.url);
  const atomicProtocol=(request:any)=>isPublicationReviewRoute(request)?'work-publication-review-atomic-v1':isGitReviewRoute(request)?'git-review-atomic-v1':isRunCommandRoute(request)?'run-command-atomic-v1':isModeMutationRoute(request)?'conversation-mode-atomic-v1':isDiscoveryPolicyRoute(request)?'discovery-policy-atomic-v1':isGoalResumeRoute(request)?'conversation-goal-resume-atomic-v1':isUploadRoute(request)?'upload-atomic-v1':isMemoryRestoreRoute(request)?'memory-restore-atomic-v1':isMemoryConsolidationRoute(request)?'memory-consolidation-atomic-v1':isMemoryCaptureRoute(request)?'memory-capture-atomic-v1':null;
  // Receipt protocol is reserved with the original request. Legacy pending rows
  // have no proof of an atomic business boundary and must not be re-executed.
  const atomicCommand=<T>(request:any,status:number,operation:()=>T):T=>{
    const pending=idempotencyRequests.get(request),protocol=atomicProtocol(request);
    const value=withImmediateTransaction(db,()=>{
      if(pending){
        const cached=db.prepare('SELECT response_status,response_json,receipt_protocol FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?').get(pending.owner,pending.operation,pending.key) as Record<string,unknown>|undefined;
        if(!protocol||!cached||cached.receipt_protocol!==protocol)throw new Error('idempotency_in_progress');
        if(cached.response_status!==null){if(cached.response_status!==status)throw new Error('idempotency_conflict');return JSON.parse(String(cached.response_json)) as T;}
      }
      const result=operation(),operationId=contracts.operationFor(request.method,request.routeOptions.url);
      if(!operationId||!contracts.validateResponse(operationId,status,result??null).valid)throw new Error('contract_response_invalid');
      if(pending&&db.prepare('UPDATE ga_idempotency SET response_status=?,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=? AND response_status IS NULL AND receipt_protocol=?')
        .run(status,JSON.stringify(result??null),pending.owner,pending.operation,pending.key,protocol).changes!==1)throw new Error('idempotency_in_progress');
      return result;
    });
    idempotencyRequests.delete(request);return value;
  };
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));

  app.addHook('preValidation', async request => {
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0];
    if (contentType === 'application/octet-stream' || contentType === 'multipart/form-data') return;
    const operationId = contracts.operationFor(request.method, request.routeOptions.url ?? request.url.split('?')[0]!);
    if (!operationId) return;
    const result = contracts.validateRequest(operationId, request.body);
    if (!result.valid) throw new Error(operationId==='updateTaskNotifications'?'invalid_task_notification_settings':['createOwnerChannelBinding','revokeOwnerChannelBinding'].includes(operationId)?'invalid_channel_binding_request':operationId==='updateTaskModelBudget'?'budget_limit_invalid':'contract_request_invalid');
  });

  app.addHook('preHandler', async (request, reply) => {
    // This exact internal route retains its mandatory service bearer check.
    if(['/internal/v1/workbench/chat-compaction-attempt','/internal/v1/workbench/chat-compaction-checkpoint','/internal/v1/workbench/git-workspace-source','/internal/v1/workbench/native-workspace-admission','/internal/v1/workbench/native-git-database'].includes(request.url.split('?')[0]!))return;
    if (['/internal/v1/workbench/chat-compaction-source', '/internal/v1/workbench/ordinary-chat-web', '/internal/v1/workbench/ordinary-chat-context', '/internal/v1/workbench/ordinary-execution-policy', '/internal/v1/workbench/ordinary-run-history', '/internal/v1/workbench/ordinary-steering-history', '/internal/v1/workbench/ordinary-steering-binding', '/internal/v1/workbench/ordinary-input-binding', '/internal/v1/workbench/ordinary-model-policy', '/internal/v1/workbench/conversation-goal-control', '/internal/v1/channel/messages', '/internal/v1/file-tools', '/internal/v1/crawl-batches/bind', '/internal/v1/crawl-batches/events', '/internal/v1/workbench/guard', '/internal/v1/workbench/handoff', '/internal/v1/workbench/native-task-intent', '/internal/v1/workbench/native-task-intents', '/internal/v1/workbench/native-child-reservation', '/internal/v1/workbench/native-child-request', '/internal/v1/workbench/native-child-abort', '/internal/v1/workbench/native-child-published', '/internal/v1/workbench/native-child-bind', '/internal/v1/workbench/native-child-close', '/internal/v1/workbench/native-child-activate', '/internal/v1/workbench/native-child-source', '/internal/v1/workbench/native-model-recovery', '/internal/v1/workbench/tool', '/internal/v1/workbench/goal-binding', '/internal/v1/workbench/model-budget','/internal/v1/workbench/web-budget-grant','/internal/v1/workbench/web-budget-grant/close','/internal/v1/workbench/web-model-budget','/internal/v1/workbench/checkpoint','/internal/v1/workbench/task-state','/internal/v1/workbench/step-admission','/internal/v1/workbench/goal-proposal','/internal/v1/workbench/completion-intent','/internal/v1/workbench/completion-confirm','/internal/v1/workbench/completion-recovery'].includes(request.url.split('?')[0]!)) return;
    if (!config.csrfToken || request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    actor(request as any);
    const origin = String(request.headers.origin ?? '');
    if (!(config.allowedOrigins ?? []).includes(origin)) throw new Error('origin_forbidden');
    const csrf = String(request.headers['x-csrf-token'] ?? '');
    if (config.csrfToken.length < 16 || csrf !== config.csrfToken) throw new Error('csrf_invalid');
    // Only these server-registered route markers use the PRD service's own
    // immutable transaction/receipt; never persist read-only preview requests.
    const prdCommand=(request.routeOptions.config as {taskPrdCommand?:string}).taskPrdCommand;
    if(request.method==='POST'&&['preview','bind'].includes(prdCommand??''))return;
    // Preview only computes a schedule; retain authentication and CSRF without persisting requests.
    if (request.method === 'POST' && request.url.split('?')[0] === '/v1/persistent-tasks/preview') return;
    if ((request.routeOptions.url ?? request.url).includes('/voice/transcriptions')) return;
    if(isGitReviewRoute(request)||isPublicationReviewRoute(request)){
      projects.assertOwned(String((request.params as {projectId:string}).projectId),actor(request as any));
      reply.header('cache-control','private, no-store');
    }
    const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
    if (!/^[\x21-\x7E]{8,128}$/.test(idempotencyKey)) throw new Error('idempotency_key_invalid');
    // Binding codes are one-time secrets: the service deduplicates this request
    // by a hash, and a replay returns the challenge ID without redisclosing code.
    if(request.method==='POST'&&request.url.split('?')[0]==='/v1/channel-bindings')return;
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
      if (existing.response_status === null) {
        if((isGitReviewRoute(request)||isPublicationReviewRoute(request)||isRunCommandRoute(request)||isModeMutationRoute(request)||isDiscoveryPolicyRoute(request)||isGoalResumeRoute(request)||isMemoryRestoreRoute(request)||isMemoryConsolidationRoute(request)||isMemoryCaptureRoute(request))&&existing.receipt_protocol===atomicProtocol(request)){idempotencyRequests.set(request,{owner,operation,key:idempotencyKey});return;}
        if(isUploadRoute(request)&&existing.receipt_protocol==='upload-atomic-v1'){
          if(request.method==='PUT'){
            const upload=db.prepare('SELECT status,declared_size,received_size,declared_sha256,actual_sha256,writer_token,writer_lease_until FROM ga_uploads WHERE id=? AND owner_id=?').get(String((request.params as Record<string,unknown>).uploadId),owner) as Record<string,unknown>|undefined;
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
          const recovered=withImmediateTransaction(db,()=>{
            const interactionId=String((request.params as Record<string,unknown>).interactionId);
            const receipt=replyDrafts.recoverReceipt(owner,interactionId,kind,idempotencyKey,requestHash)??taskWaitResponder.recoverReceipt(owner,interactionId,kind,idempotencyKey,requestHash);
            if(!receipt)return;
            const operationId=contracts.operationFor(request.method,route!);
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
      return reply.code(Number(existing.response_status)).send(responseBody);
    }
    const now = Date.now();
    db.prepare(
      'INSERT INTO ga_idempotency(owner_id,operation,idempotency_key,request_sha256,response_status,response_json,created_at,expires_at,receipt_protocol) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(owner, operation, idempotencyKey, requestHash, null, null, new Date(now).toISOString(), new Date(now + 86_400_000).toISOString(),atomicProtocol(request));
    idempotencyRequests.set(request, { owner, operation, key: idempotencyKey });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const operationId = contracts.operationFor(request.method, request.routeOptions.url ?? request.url.split('?')[0]!);
    let responseValue: unknown = null;
    if (typeof payload === 'string' && payload.length) {
      try { responseValue = JSON.parse(payload); } catch { responseValue = payload; }
    } else if (Buffer.isBuffer(payload) && payload.length) responseValue = payload.toString('base64');
    if (operationId && reply.statusCode < 400 && !contracts.validateResponse(operationId, reply.statusCode, responseValue).valid) {
      reply.code(500).header('content-type', 'application/json; charset=utf-8');
      payload = JSON.stringify({ error: { code: 'CONTRACT_RESPONSE_INVALID' } });
      responseValue = { error: { code: 'CONTRACT_RESPONSE_INVALID' } };
    }
    const pending = idempotencyRequests.get(request);
    if (!pending) return payload;
    // An error response must not replace a recoverable reservation or another
    // writer's success. Successful upload receipts already committed atomically.
    if(atomicProtocol(request)&&reply.statusCode>=400)return payload;
    db.prepare(
      'UPDATE ga_idempotency SET response_status=?,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=?',
    ).run(reply.statusCode, JSON.stringify(responseValue), pending.owner, pending.operation, pending.key);
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof Error ? error.message : 'internal_error';
    if(code==='contract_response_invalid')return reply.code(500).send({error:{code:'CONTRACT_RESPONSE_INVALID'}});
    if(code==='chat_mode_unavailable')return reply.code(503).send({error:{code:'CHAT_MODE_UNAVAILABLE'}});
    if(code==='conversation_mode_invalid')return reply.code(400).send({error:{code:'CONVERSATION_MODE_INVALID'}});
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
    if(code==='native_task_intent_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='native_child_request_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='native_child_identity_conflict')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(['native_child_closure_invalid','native_activation_invalid','native_spawn_publication_invalid'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(['native_child_closure_pending','native_child_closure_conflict','native_child_closed','native_activation_source_pending','native_activation_source_changed','native_recovery_fence_live','native_spawn_publication_unbound'].includes(code))return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='channel_binding_unavailable')return reply.code(503).send({error:{code:code.toUpperCase()}});
    if(['channel_binding_proof_invalid','email_binding_proof_invalid','email_address_invalid'].includes(code))return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='channel_principal_already_bound'||code==='channel_binding_not_verified')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_completion_handshake_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='task_completion_handshake_conflict')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_mailbox_binding_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='task_auxiliary_pending')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_assignment_revoked')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_collaboration_exhausted')return reply.code(429).send({error:{code:code.toUpperCase()}});
    if(code==='task_reply_target_invalid')return reply.code(422).send({error:{code:code.toUpperCase()}});
    if(code==='task_reply_run_active')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if(code==='task_notification_run_active')return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code.startsWith('budget_') && code.endsWith('_invalid')) return reply.code(422).send({error:{code:code.toUpperCase()}});
    if (code === 'model_budget_exhausted') return reply.code(429).send({error:{code:'MODEL_BUDGET_EXHAUSTED'}});
    if (code === 'budget_ceiling_exceeded') return reply.code(422).send({error:{code:'BUDGET_CEILING_EXCEEDED'}});
    if (code === 'budget_limit_below_commitment') return reply.code(409).send({error:{code:'BUDGET_LIMIT_BELOW_COMMITMENT'}});
    if (['budget_route_unavailable','budget_service_unavailable'].includes(code)) return reply.code(503).send({error:{code:code.toUpperCase()}});
    if (code.startsWith('budget_') && (code.endsWith('_conflict') || ['budget_binding_missing','budget_run_inactive','budget_usage_unknown','budget_usage_pending','budget_window_closed','budget_policy_stale'].includes(code))) return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (Number((error as { statusCode?: number }).statusCode) === 413) {
      return reply.code(413).send({ error: { code: 'VOICE_AUDIO_TOO_LARGE' } });
    }
    if (error instanceof TemplateContractError) {
      return reply.code(422).send({ error: { code, details: error.details } });
    }
    if ((error as { validation?: unknown }).validation) return reply.code(422).send({ error: { code: 'INVALID_WORKBENCH_REQUEST' } });
    if (code.startsWith('invalid_') || code === 'unsupported_trigger' || code === 'idempotency_key_required') return reply.code(422).send({ error: { code: code.toUpperCase() } });
    if (['evidence_required','dependency_cycle'].includes(code)) return reply.code(422).send({error:{code:code.toUpperCase()}});
    if (['assessment_revision_conflict','observation_revision_conflict','dependency_not_completed','dependency_evidence_unverified','task_completion_evidence_required','task_acceptance_outputs_unverified'].includes(code)) return reply.code(409).send({error:{code:code.toUpperCase()}});
    if (code.endsWith('_forbidden') || code.endsWith('_path_escape') || code.endsWith('_scope_mismatch') || code.endsWith('_workspace_mismatch')) return reply.code(403).send({ error: { code: code.toUpperCase() } });
    if (code.endsWith('_revoked') || code.endsWith('_state_conflict') || ['agent_not_active', 'agent_unavailable', 'run_binding_conflict', 'memory_verification_required', 'task_not_active', 'task_budget_exhausted', 'task_active_occurrence', 'task_conversation_read_only', 'task_continuation_unsupported','task_continuation_conflict','task_checkpoint_unavailable','task_continuation_limit'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
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
    if (code.endsWith('_not_found')) return reply.code(404).send({ error: { code: code.toUpperCase() } });
    if (['reply_review_mode_conflict','reply_draft_corrupt','reply_review_state_conflict','task_wait_response_required','version_conflict', 'active_run_model_change', 'run_state_conflict', 'run_version_conflict', 'checkpoint_invalid', 'reconciliation_required', 'interaction_kind_conflict', 'interaction_state_conflict', 'interaction_version_conflict', 'interaction_expired', 'action_digest_mismatch', 'idempotency_conflict', 'idempotency_in_progress', 'voice_idempotency_conflict', 'STALE_FILE_VERSION', 'IDEMPOTENCY_CONFLICT', 'crawl_batch_owner_mismatch'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (['reply_evidence_unverified','interaction_answer_invalid', 'interaction_decision_invalid', 'upload_size_invalid', 'upload_sha256_invalid', 'upload_filename_invalid', 'upload_size_mismatch', 'upload_sha256_mismatch', 'artifact_diff_unsupported', 'source_evidence_required', 'source_url_invalid', 'invalid_project_title', 'invalid_conversation_state', 'FILE_REQUEST_INVALID', 'TEMPLATE_CONTENT_INVALID', 'UNSUPPORTED_FORMAT_OPERATION', 'requested_count_invalid', 'event_seq_invalid', 'input_index_invalid', 'item_id_invalid', 'owner_id_invalid', 'run_id_invalid', 'batch_id_invalid', 'conversation_id_invalid', 'crawl_url_invalid'].includes(code)) return reply.code(422).send({ error: { code: code.toUpperCase() } });
    if (['upload_state_conflict'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (code === 'origin_forbidden' || code === 'csrf_invalid') return reply.code(403).send({ error: { code: code.toUpperCase() } });
    if (code === 'idempotency_key_invalid') return reply.code(400).send({ error: { code: 'IDEMPOTENCY_KEY_INVALID' } });
    if(code==='ordinary_attachment_steering_unavailable')return reply.code(503).send({error:{code:'ORDINARY_ATTACHMENT_STEERING_UNAVAILABLE'}});
    if(code==='ordinary_steering_unavailable')return reply.code(503).send({error:{code:'ORDINARY_STEERING_UNAVAILABLE'}});
    if(code==='ordinary_steering_scope_unconfirmed')return reply.code(409).send({error:{code:'ORDINARY_STEERING_SCOPE_UNCONFIRMED'}});
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
  registerWorkbenchRoutes(app, workbench, actor,(request,operation)=>atomicCommand(request,200,operation));
  const taskDelegations=new TaskDelegationService(db,workbench,persistentTasks);
  const taskCollaboration=new TaskCollaborationService(db,workbench,persistentTasks,taskDelegations);
  registerPersistentTaskRoutes(app, persistentTasks, actor,taskDelegations,taskCollaboration);
  registerTaskPrdRoutes(app,taskPrd,actor);
  registerTaskBudgetRoutes(app,new TaskBudgetService(db,budgetPolicy),actor);
  registerWorkbenchExecution(app, db, workbench, persistentTasks, config.internalChannelToken, modelBudgets,taskCollaboration,config.replyJudge,nativeWork);
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

  app.post('/internal/v1/channel/messages', async (request, reply) => {
    const expected = String(config.internalChannelToken ?? '');
    if (expected.length < 16 || request.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
    }
    return reply.code(202).send(channelIntake.accept(request.body as Record<string, unknown>));
  });

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
  registerConversationGoalRoutes(app,{db,conversations,actor,client:config.conversationGoalClient,resumeAdmission:{enabled:config.conversationGoalResumeEnabled===true,controls:new ConversationGoalControls(db,events,runs),atomic:atomicCommand}});
  app.get('/v1/capabilities', async (request, reply) => {
    const ownerId = actor(request as any);
    const cancelled=new AbortController();const abort=()=>{if(!reply.raw.writableEnded)cancelled.abort();};
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    let voice,models,modes,attachmentSteeringReady;
    try{[voice,models,modes,attachmentSteeringReady]=await Promise.all([voiceTranscriptions.capability(),readHostModelCatalog(config.modelCatalogClient,cancelled.signal),conversationModes.capability(cancelled.signal),readAttachmentSteeringReadiness(config.ordinaryAttachmentSteeringEnabled===true,config.ordinaryAttachmentSteeringClient,cancelled.signal)]);}
    finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort);}
    if (config.csrfToken && request.headers['sec-fetch-site'] !== 'cross-site') {
      reply.header('x-csrf-token', config.csrfToken).header('cache-control', 'no-store');
      reply.header('x-workbench-draft-scope', createHmac('sha256', config.csrfToken).update(`workbench-draft/v1/${ownerId}`).digest('hex'));
    }
    return {
      api_version: '1.0', event_schema_version: '1.0', adapter_version: '0.1.0',
      git_workbench:gitWorkbench.capability(ownerId),
      capabilities: { search: true, fetch: true, browser_interaction: false, file_read: true,
        file_edit: true, command_execution: true, questions: true, approvals: true,
        artifact_download: true, resume_checkpoint: true },
      models, limits: { max_upload_bytes: 104857600, max_active_runs_per_conversation: 1,
        max_concurrent_sessions: 5,
        replay_retention_hours: 168, idempotency_retention_hours: 24 },
      voice,conversation_modes:modes,
      conversation_commands:{protocol:1,ordinary_steer:{configured:config.ordinarySteeringEnabled===true,delivery:'original',attachments:attachmentSteeringReady}},
      workbench: { enabled: true, agent_roles: true, independent_teams: true, agent_messages: true,
        shared_workspace: true, memory_scopes: ['project', 'private'], memory_lifecycle: true, memory_restore: true, memory_consolidation: true, memory_retrieval_traces: true, memory_capture:true, memory_retrieval: 'local_keyword',task_readiness:true,task_prd:true,task_unlimited_runs:true,task_run_limit_protocol:1,model_budget:budgetPolicy!==undefined,
        task_reply_policy:true,task_reply_execution:false,task_create_delivery:true,task_notifications:true,channel_bindings:!!config.internalChannelToken||!!config.emailBindingSend,email_bindings:!!config.emailBindingSend,wecom_bindings:!!config.internalChannelToken,task_notification_events:['changed','completed','failed','needs_confirmation'],
        ...(budgetPolicy?{task_model_budget_limits:budgetPolicy.budgetSettings().limits.task_total}:{}),
        collaboration_modes: [{ id: 'single', enabled: true }, { id: 'independent_team', enabled: true },
          { id: 'subagents', enabled: false, reason: 'HOST_ADAPTER_NOT_READY' },
          { id: 'team', enabled: false, reason: 'DSH_EXPERIMENTAL_TEAM_NOT_READY' },
          { id: 'handoff', enabled: false, reason: 'HOST_ADAPTER_NOT_READY' }],
        task_triggers: ['once', 'interval', 'page_change', 'daily', 'weekly','conversation_message','conversation_result'], notification_channels: ['in_app'],
        task_schedule_limits: { default_interval_seconds: 300, min_interval_seconds: 60, max_interval_seconds: 31536000,
          dst_gap: 'next_valid_time', dst_fold: 'first_only', missed_triggers: 'coalesce' },
        allowed_tools: WORKBENCH_TOOL_IDS, execution_ready: config.workbenchExecutionReady === true },
      workspaces: config.workspaces.map(workspace_id => ({ workspace_id, title: workspace_id, can_read: true, can_write: true, owner_id: ownerId }))
        .map(({ owner_id: _ignored, ...workspace }) => workspace),
    };
  });
  registerGitRoutes(app,gitWorkbench,actor);
  registerGitReviewRoutes(app,{intents:gitReviewIntents,actor,atomic:atomicCommand});
  const gitIndexExecutions=new GitIndexExecutions(db,projects,gitWorkbench,gitReviewIntents);
  registerGitExecutionHistoryRoutes(app,gitIndexExecutions,actor);
  // These constructors observe the original database only. Publication schema
  // readiness still requires the explicit maintenance upgrade, never a request.
  const workPublicationIntents=config.gitRepositories?.length?new WorkPublicationIntents(db,gitWorkbench):undefined;
  const workPublicationExecutions=workPublicationIntents?new WorkPublicationExecutions(db,gitWorkbench,workPublicationIntents):undefined;
  registerPublicationReviewRoutes(app,{intents:workPublicationIntents,actor,atomic:atomicCommand});
  registerGitWorkspaceSource(app,gitIndexExecutions,config.internalChannelToken,db,workPublicationExecutions);
  app.get('/v1/projects', async request => projects.list(actor(request as any)));
  app.post('/v1/projects', async (request, reply) =>
    reply.code(201).send(projects.create(actor(request as any), request.body as Record<string, unknown>)));
  app.patch('/v1/projects/:projectId', async request =>
    projects.update((request.params as { projectId: string }).projectId, actor(request as any), request.body as Record<string, unknown>));

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
  app.get('/v1/conversations/:conversationId/messages', async request => {
    const query = request.query as { limit?: string };
    return conversations.messages((request.params as { conversationId: string }).conversationId,
      actor(request as any), Number(query.limit ?? 50));
  });
  app.post('/v1/conversations/:conversationId/messages', async (request, reply) => {
    const id = (request.params as { conversationId: string }).conversationId;
    const owner = actor(request as any);
    const agent = workbench.agentForConversation(owner, id);
    if (agent && agent.conversation_id !== id) throw new Error('task_conversation_read_only');
    const ordinary=agent?undefined:await conversationModes.prepareEnqueue(id,owner,request.body as Record<string,unknown>);
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
  app.post('/v1/runs/:runId/steer', async (request, reply) => {
    const runId = (request.params as {runId: string}).runId;
    const owner = actor(request as any); runs.get(runId, owner);
    const requested=request.body as Record<string,unknown>;
    if(Array.isArray(requested.attachments)&&requested.attachments.length&&!(await readAttachmentSteeringReadiness(config.ordinaryAttachmentSteeringEnabled===true,config.ordinaryAttachmentSteeringClient)))throw Error('ordinary_attachment_steering_unavailable');
    return reply.code(202).send(atomicCommand(request,202, () => {
      workbench.assertRunActive(runId); persistentTasks.assertRunActive(runId);
      const input=request.body as Record<string,unknown>;
      if(input.delivery!=='original')return commands.steer(runId,owner,input,String(request.headers['idempotency-key']||''));
      if(config.ordinarySteeringEnabled!==true)throw Error('ordinary_steering_unavailable');
      // Native source proofs retain their original exact text payload. Delivery
      // metadata remains in the HTTP request hash and never grants execution.
      const source={text:input.text,client_message_id:input.client_message_id,expected_run_version:input.expected_run_version};
      const attachmentManifest=Array.isArray(input.attachments)&&input.attachments.length?new AttachmentResolver(db,config.uploadRoot??join(dirname(config.databasePath),'general-agent-uploads')).pinForMessage(owner,String(runs.get(runId,owner).conversation_id),input.attachments as string[],`steer-source:${runId}:${input.client_message_id}`):undefined;
      const receipt=commands.steer(runId,owner,{...source,...(attachmentManifest?{content_protocol:1,attachment_manifest:attachmentManifest}:{})},String(request.headers['idempotency-key']||''));
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
  app.post('/v1/conversations/:conversationId/uploads', async (request, reply) => reply.code(201).send(atomicCommand(request,201,()=>artifacts.initUpload(
    (request.params as { conversationId: string }).conversationId, actor(request as any), request.body as Record<string, unknown>,
  ))));
  app.put('/v1/uploads/:uploadId/content', { bodyLimit: 104857600 }, async (request, reply) => {
    await artifacts.writeContent((request.params as { uploadId: string }).uploadId, actor(request as any), request.body as AsyncIterable<Uint8Array>,()=>atomicCommand(request,204,()=>undefined));
    return reply.code(204).send();
  });
  app.post('/v1/uploads/:uploadId/complete', async (request, reply) => reply.code(201).send(atomicCommand(request,201,()=>artifacts.complete(
    (request.params as { uploadId: string }).uploadId, actor(request as any), request.body as Record<string, unknown>,
  ))));
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
  app.get('/v1/artifacts/:artifactId/backup-status', async request =>
    artifacts.backupStatus((request.params as { artifactId: string }).artifactId, actor(request as any)));
  app.post('/v1/artifacts/:artifactId/restore', async (request, reply) => reply.code(202).send(
    artifacts.requestRestore((request.params as { artifactId: string }).artifactId, actor(request as any))));
  app.get('/v1/artifacts/:artifactId/preview', async request => {
    const query = request.query as { version?: string };
    return artifacts.preview((request.params as { artifactId: string }).artifactId, actor(request as any), query.version ? Number(query.version) : undefined);
  });
  app.get('/v1/artifacts/:artifactId/diff', async request => {
    const query = request.query as { from_version: string; to_version: string };
    return artifacts.diff((request.params as { artifactId: string }).artifactId, actor(request as any), Number(query.from_version), Number(query.to_version));
  });
  app.get('/v1/artifacts/:artifactId/download', async (request, reply) => {
    const query = request.query as { version?: string };
    const row = artifacts.download((request.params as { artifactId: string }).artifactId, actor(request as any), query.version ? Number(query.version) : undefined);
    const meta = JSON.parse(String(row.metadata_json));
    const asciiName = String(meta.file_name).replace(/[^A-Za-z0-9._-]/g, '_');
    return reply.header('content-type', String(row.mime_type)).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${asciiName}"`).send(row.verified_content instanceof Buffer?row.verified_content:createReadStream(String(row.server_path)));
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
      let cursor = replay.length ? Number(replay.at(-1)?.seq) : after;
      if (body) stream.write(body);
      const flush = () => {
        for (const event of events.replay(id, cursor, 1000)) {
          stream.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = Number(event.seq);
        }
      };
      const unsubscribe = events.subscribe(id, flush);
      // Worker and BFF are separate processes. The local EventEmitter is only a
      // latency hint; cursor polling is the authoritative cross-process wakeup.
      const replayPoll = setInterval(flush, 1_000);
      const heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), 15_000);
      const cleanup = () => { clearInterval(replayPoll); clearInterval(heartbeat); unsubscribe(); };
      request.raw.once('close', cleanup);
      stream.once('close', cleanup);
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
