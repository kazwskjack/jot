import {validateOrdinaryCompletion,type OrdinaryCompletionProof} from './ordinary-completion.ts';
import {runtimeSessionRefForRun} from './run-session-identity.ts';
import {inspectOrdinarySteeringBinding} from '../conversations/ordinary-steering-binding.ts';
import {assertExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';
import {isDeepStrictEqual} from 'node:util';
import {inspectOrdinaryInputBinding} from '../conversations/ordinary-input-binding.ts';
import { createHash } from 'node:crypto';
import {taskWaitSupplement} from '../persistent-tasks/task-wait.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { HarnessCoordinator } from './coordinator.ts';
import { decodeStoredContent } from '../messages/content.ts';
import type { RuntimeContextInput } from './runtime-events.ts';
import type { JotProjection } from './session-event-projector.ts';
import type { AttachmentResolver, ResolvedAttachment } from '../artifacts/resolver.ts';
import { withImmediateTransaction } from '../db/database.ts';
import type {SessionCheckpoint} from './session-checkpoints.ts';
import {ConversationGoalControls,validateGoalControlRejection} from '../conversations/goal-controls.ts';
import {isAbsolute} from 'node:path';

/** Host-only result from the admitted work journal; never a browser/model field. */
export type TrustedWorkRunWorkspace=Readonly<{kind:'isolated_work';runId:string;originalRunId:string;ownerId:string;conversationId:string;taskId:string;occurrenceId:string;sessionRef:string;cwd:string;objective:string}>;
export interface WorkRunWorkspaceResolver {resolve(runId:string,executionLease:ExecutionLease):TrustedWorkRunWorkspace|null|Promise<TrustedWorkRunWorkspace|null>}
const trustedWorkWorkspaces=new WeakMap<object,Readonly<{executionLease:ExecutionLease;prompt:string}>>();
/** Process-local custody prevents path strings or serialized objects claiming authority. */
export function assertTrustedWorkWorkspace(input:DshRunInput):TrustedWorkRunWorkspace|undefined {
  const workspace=input.trustedWorkWorkspace;
  const custody=workspace&&trustedWorkWorkspaces.get(workspace);
  if(input.requiresWorkWorkspace===undefined&&workspace===undefined)return undefined;
  if(input.requiresWorkWorkspace!==true||!workspace||!trustedWorkWorkspaces.has(workspace)
    ||workspace.runId!==input.taskRequestId||workspace.sessionRef!==input.sessionRef
    ||custody?.prompt!==input.message||input.workbenchRunId!==workspace.runId
    ||!isDeepStrictEqual(custody?.executionLease,input.workbenchExecutionLease))
    throw Error('work_workspace_binding_invalid');
  return workspace;
}

export interface DshRunResult {
  observed: boolean;
  completed: boolean;
  reason_code: string;
  runtime_status: string;
  runtime_run_id?: string;
  runtime_revision?: number;
  final_text?: string;
  final_blocks?: Array<{ kind: 'text' | 'reasoning'; text: string }>;
  output_artifact_refs?: string[];
  presented_files?: Array<{ path: string; description?: string }>;
  tool_marker?: boolean;
  task_stop?: {goal_id:string;goal_revision:number;phase:'paused'|'blocked'|'complete';turn_end_seq:number};
  task_candidate?: {text:string;blocks?:Array<{kind:'text'|'reasoning';text:string}>};
}

export interface DshRunInput { enabled: true; taskRequestId: string; message: string; sessionRef: string;
    requiresWorkWorkspace?:true;
    trustedWorkWorkspace?:TrustedWorkRunWorkspace;
    deferCompletionProbe: true; attachments?: ResolvedAttachment[]; universeSessionRef?: string;
    originalAdmission?:Readonly<{executionLease:Readonly<{owner:string;generation:number}>}>;
    workbenchRunId?: string;
    workbenchExecutionLease?:Readonly<{owner:string;generation:number}>;
    workbenchBudgetEnforced?:boolean;
    checkpointTask?:boolean;
    onCheckpoint?:(receipt:SessionCheckpoint)=>Promise<void>|void;
    ordinaryCompletion?:Readonly<{executionLease:ExecutionLease;commands:()=>string[];publish:(candidate:DshRunResult,proof:OrdinaryCompletionProof,signal:AbortSignal)=>Promise<boolean>}>;
    onReady?: () => void;
    onArtifactRef?: (artifactRef: string) => Promise<void> | void;
    onProjection?: (projection: JotProjection) => Promise<void> | void;
    onWebOperationCursor?: (toolCallId: string) => number;
    onWebOperationSnapshot?: (toolCallId: string, snapshot: Record<string, unknown>) => number }
export interface DshRunner {
  readonly ordinaryCompletionProtocol?:1;
  run(input:DshRunInput):Promise<DshRunResult>;
  recoverInput?(input:DshRunInput & {originalInput:Readonly<{inputMessageId:string;executionLease:Readonly<{owner:string;generation:number}>}>}):Promise<DshRunResult>;
  resumeGoal?(input:DshRunInput & {goalControl:Readonly<{controlId:string;ref:Readonly<{id:string;revision:number}>;executionLease:Readonly<{owner:string;generation:number}>}>}):Promise<DshRunResult>;
}

export interface RuntimeContextStager {
  stageContext(input: RuntimeContextInput): Promise<Record<string, unknown>>;
}

export interface ChannelTextDelivery {
  enqueueText(input: { runId: string; messageId: string; destination: 'wecom';
    recipient: string; text: string }): Record<string, unknown> | null;
}

export class HarnessWorker {
  private readonly readyRuns = new Map<string,Readonly<{sessionRef:string;ordinary:boolean;executionLease:ExecutionLease}>>();
  readyExecutionFor(runId:string){const ready=this.readyRuns.get(runId);if(!ready)return undefined;try{assertExecutionLease(this.db,runId,ready.executionLease);return ready;}catch{return undefined;}}
  isReady(runId: string) { return this.readyExecutionFor(runId)!==undefined; }
  private readonly db: DatabaseSync;
  private readonly coordinator: HarnessCoordinator;
  private readonly runner: DshRunner;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly ordinaryInputRecoveryEnabled:boolean;
  private readonly ordinarySteeringEnabled:boolean;
  private readonly contextStager: RuntimeContextStager | undefined;
  private readonly sessionResolver: ((conversationId: string) => string) | undefined;
  private readonly attachmentResolver: Pick<AttachmentResolver,
    'resolveForMessage' | 'resolveOutputs' | 'releaseLease'> | undefined;
  private readonly channelDelivery: ChannelTextDelivery | undefined;
  private readonly executionGuard: { assertRunActive(runId: string): void; contextForRun(runId: string): unknown } | undefined;
  private readonly workRunWorkspaceResolver:WorkRunWorkspaceResolver|undefined;

  constructor(db: DatabaseSync, coordinator: HarnessCoordinator, runner: DshRunner,
    options: { workerId: string; leaseMs: number; ordinaryInputRecoveryEnabled?:boolean;ordinarySteeringEnabled?:boolean; contextStager?: RuntimeContextStager;
      sessionResolver?: (conversationId: string) => string;
      attachmentResolver?: Pick<AttachmentResolver, 'resolveForMessage' | 'resolveOutputs' | 'releaseLease'>;
      channelDelivery?: ChannelTextDelivery;
      workRunWorkspaceResolver?:WorkRunWorkspaceResolver;
      executionGuard?: { assertRunActive(runId: string): void; contextForRun(runId: string): unknown } }) {
    this.db = db; this.coordinator = coordinator; this.runner = runner;
    this.workerId = options.workerId; this.leaseMs = options.leaseMs;
    if(options.ordinaryInputRecoveryEnabled!==undefined&&typeof options.ordinaryInputRecoveryEnabled!=='boolean')throw Error('ordinary_input_recovery_config_invalid');
    this.ordinaryInputRecoveryEnabled=options.ordinaryInputRecoveryEnabled===true;
    if(options.ordinarySteeringEnabled!==undefined&&typeof options.ordinarySteeringEnabled!=='boolean'||options.ordinarySteeringEnabled===true&&!this.ordinaryInputRecoveryEnabled)throw Error('ordinary_completion_config_invalid');this.ordinarySteeringEnabled=options.ordinarySteeringEnabled===true;
    this.contextStager = options.contextStager;
    this.sessionResolver = options.sessionResolver;
    this.attachmentResolver = options.attachmentResolver;
    this.channelDelivery = options.channelDelivery;
    this.executionGuard = options.executionGuard;
    this.workRunWorkspaceResolver=options.workRunWorkspaceResolver;
  }

  async processNext(): Promise<{ run_id: string; runtime_status: string } | null> {
    const lease = this.coordinator.claimNext(this.workerId, this.leaseMs);
    if (!lease) return null;
    const goalControl=this.db.prepare('SELECT control_id,owner_id,session_id,goal_id,goal_revision FROM ga_conversation_goal_controls WHERE run_id=?').get(lease.run_id) as {control_id:string;owner_id:string;session_id:string;goal_id:string;goal_revision:number}|undefined;
    // Mixed-version rollout must never fall through to replaying the original
    // human message or attachments when a continuation runner is unavailable.
    if(goalControl&&!this.runner.resumeGoal){
      this.coordinator.interruptWithoutRuntime(lease,'GOAL_CONTINUATION_UNAVAILABLE');
      return {run_id:lease.run_id,runtime_status:'goal_continuation_unavailable'};
    }
    let workbenchContext: unknown;
    try {
      this.executionGuard?.assertRunActive(lease.run_id);
      workbenchContext = this.executionGuard?.contextForRun(lease.run_id);
    } catch {
      if (!this.cancelling(lease.run_id)) this.coordinator.interruptWithoutRuntime(lease, 'WORKBENCH_EXECUTION_REVOKED');
      return { run_id: lease.run_id, runtime_status: 'workbench_revoked' };
    }
    const backgroundTask=!!(workbenchContext && typeof workbenchContext==='object'
      && 'kind' in workbenchContext && workbenchContext.kind==='task');
    const workLineage=()=>this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_run_occurrences'").get()
      ?this.db.prepare(`SELECT o.run_id,o.root_run_id,o.task_id,o.occurrence_id,o.conversation_id,t.owner_id,r.continuation_of,r.checkpoint_id
        FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id JOIN ga_runs r ON r.id=o.run_id
        WHERE o.run_id=? AND o.trigger_key LIKE 'discovery-work:%'`).get(lease.run_id):undefined;
    const initialWorkLineage=workLineage();
    const workMarker=(context:unknown)=>context&&typeof context==='object'&&'work_binding' in context?context.work_binding:undefined;
    const requiresWorkWorkspace=!!initialWorkLineage||workMarker(workbenchContext)!==undefined;
    if(requiresWorkWorkspace&&(!initialWorkLineage||!this.workRunWorkspaceResolver||!backgroundTask)){
      this.coordinator.interruptWithoutRuntime(lease,'WORK_WORKSPACE_BINDING_UNAVAILABLE');
      return{run_id:lease.run_id,runtime_status:'work_workspace_unavailable'};
    }
    const hasWorkbenchBinding=!!(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_run_bindings'").get()&&this.db.prepare('SELECT 1 FROM wb_run_bindings WHERE run_id=?').get(lease.run_id));
    const ordinaryDelivery=this.ordinarySteeringEnabled&&!!lease.input_message_id&&!goalControl&&!workbenchContext&&!hasWorkbenchBinding;
    if(ordinaryDelivery&&this.runner.ordinaryCompletionProtocol!==1){this.coordinator.interruptWithoutRuntime(lease,'ORDINARY_COMPLETION_UNAVAILABLE');return{run_id:lease.run_id,runtime_status:'ordinary_completion_unavailable'};}
    const originalRecovery=this.ordinaryInputRecoveryEnabled&&lease.generation>1&&!goalControl&&!workbenchContext&&!hasWorkbenchBinding;
    const originalSession=originalRecovery?this.db.prepare('SELECT b.session_id FROM ga_harness_session_bindings b JOIN ga_conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id WHERE c.id=? AND c.archived_at IS NULL').get(lease.conversation_id):undefined;
    if(originalRecovery&&(!this.runner.recoverInput||!lease.input_message_id||typeof originalSession?.session_id!=='string')){
      this.coordinator.interruptWithoutRuntime(lease,'ORIGINAL_INPUT_RECOVERY_UNAVAILABLE');return{run_id:lease.run_id,runtime_status:'original_input_recovery_unavailable'};
    }
    const controllerSessionRef = (originalSession?.session_id as string|undefined) ?? goalControl?.session_id ?? this.sessionResolver?.(lease.conversation_id)
      ?? `session-${createHash('sha256').update(lease.run_id).digest('hex').slice(0, 32)}`;
    const runtimeSessionRef = runtimeSessionRefForRun(lease.run_id);
    this.coordinator.bindSession(lease, runtimeSessionRef);
    const input = goalControl?{text:'',attachmentIds:[],ownerId:goalControl.owner_id,receivedAt:0}:this.messageInput(lease.run_id);
    let message = originalRecovery?'':input.text;
    const attachments = !originalRecovery&&input.attachmentIds.length
      ? this.attachmentResolver?.resolveForMessage(input.ownerId, lease.conversation_id,
        input.attachmentIds, lease.run_id) ?? (() => { throw new Error('attachment_resolver_unavailable'); })()
      : [];
    if (this.contextStager&&!goalControl&&!originalRecovery) {
      if(!lease.input_message_id)throw Error('run_input_missing');
      try {
        await this.contextStager.stageContext({ taskRequestId: lease.run_id, conversationId: lease.conversation_id,
          messageId: lease.input_message_id, message, sessionRef: runtimeSessionRef, controllerSessionRef,
          receivedAt: input.receivedAt });
      } catch { /* Runtime is an execution ledger, never a conversation admission gate. */ }
    }
    this.coordinator.start(lease);
    const renewal = setInterval(() => this.coordinator.renew(lease, this.leaseMs), Math.max(100, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    let originalAuthority:ReturnType<typeof inspectOrdinaryInputBinding>|undefined;
    const assertGoalApplied=()=>{
      if(originalRecovery||ordinaryDelivery){const binding=inspectOrdinaryInputBinding(this.db,lease.run_id,controllerSessionRef,{owner:lease.owner,generation:lease.generation});if(binding.input_message_id!==lease.input_message_id||originalAuthority&&!isDeepStrictEqual(binding,originalAuthority))throw Error('ordinary_input_binding_rejected');originalAuthority??=binding;}
      if(!goalControl)return;
      const row=ConversationGoalControls.assertExecution(this.db,goalControl.control_id,{owner:lease.owner,generation:lease.generation});
      if(row.state!=='applied')throw Error('goal_control_receipt_required');
    };
    let published=false,publishedRuntime='not_required';
    const commandIds=()=>{assertGoalApplied();this.executionGuard?.assertRunActive(lease.run_id);assertExecutionLease(this.db,lease.run_id,{owner:lease.owner,generation:lease.generation});return (this.db.prepare("SELECT id FROM ga_run_commands WHERE run_id=? AND kind='steer' AND status IN ('pending','applied') ORDER BY created_at,rowid").all(lease.run_id) as {id:string}[]).map(row=>{inspectOrdinarySteeringBinding(this.db,lease.run_id,controllerSessionRef,row.id,{owner:lease.owner,generation:lease.generation});return row.id;});};
    const completionFence=(candidate:DshRunResult,proof?:OrdinaryCompletionProof)=>{
      if(!ordinaryDelivery)return true;
      const ids=commandIds();if(!proof||!isDeepStrictEqual(ids,proof.command_ids))return false;
      const validated=validateOrdinaryCompletion(proof,controllerSessionRef,{run_id:lease.run_id,execution_lease:{owner:lease.owner,generation:lease.generation}},ids);
      if(validated.status!=='complete'||!candidate.completed||!candidate.final_text?.trim()||validated.input_sha256!==originalAuthority!.input_sha256||validated.answer_sha256!==createHash('sha256').update(candidate.final_text.trim()).digest('hex'))throw Error('ordinary_completion_proof_invalid');
      return !this.db.prepare("SELECT 1 FROM ga_run_commands WHERE run_id=? AND kind='steer' AND status='pending'").get(lease.run_id);
    };
    const publishOrdinary=async(candidate:DshRunResult,proof?:OrdinaryCompletionProof)=>{
      if(published)throw Error('ordinary_completion_already_published');if(!completionFence(candidate,proof))return false;
      const finalText=candidate.final_text?.trim();if(!finalText)throw Error('ordinary_completion_empty');
      const outputLeaseId=`${lease.run_id}:outputs`;let outputAttachments:ResolvedAttachment[]=[];
      try{
        const artifactRefs=candidate.output_artifact_refs??[],presentedFiles=candidate.presented_files??[];
        if(artifactRefs.length||presentedFiles.length){if(!this.attachmentResolver)throw Error('output_attachment_resolver_unavailable');outputAttachments=this.attachmentResolver.resolveOutputs(input.ownerId,lease.conversation_id,artifactRefs,presentedFiles,outputLeaseId);}
      const committed=withImmediateTransaction(this.db, () => {
        // Recheck inside the same transaction as publication, after resolving
        // outputs. Deletion and completion cannot race across DB processes.
        this.executionGuard?.assertRunActive(lease.run_id);
        assertGoalApplied();if(!completionFence(candidate,proof))return false;
        for (const item of outputAttachments) this.coordinator.recordArtifact(lease, item);
        this.coordinator.recordCandidate(lease, finalText);
        this.coordinator.setCandidateStatus(lease, 'verified', []);
        const assistant = this.coordinator.recordAssistant(lease, finalText, candidate.final_blocks,
          outputAttachments.map(item => item.artifactId));
        this.coordinator.finalizePublication(lease, 'succeeded', null);
        if (this.channelDelivery) {
        const binding = this.db.prepare(`SELECT principal FROM ga_channel_bindings
          WHERE channel='wecom' AND conversation_id=?`).get(lease.conversation_id) as
          { principal?: string } | undefined;
        if (binding?.principal) {
          try {
            this.channelDelivery.enqueueText({ runId: lease.run_id, messageId: String(assistant.message_id),
              destination: 'wecom', recipient: binding.principal, text: finalText });
          } catch (error) {
            process.stderr.write(`${JSON.stringify({ level: 'error', code: 'channel_delivery_enqueue_failed',
              detail: String(error instanceof Error ? error.message : error).slice(0, 96) })}\n`);
          }
        }
        }

        return true;
      });
      if(committed&&ordinaryDelivery){published=true;publishedRuntime=candidate.tool_marker?'runtime_observed':'not_required';clearInterval(renewal);}
      return committed;
      }finally{if(outputAttachments.length)this.attachmentResolver?.releaseLease(outputLeaseId);}
    };
    let result: DshRunResult;
    try {
      let trustedWorkWorkspace:TrustedWorkRunWorkspace|undefined;
      if(requiresWorkWorkspace){
        const resolved=await this.workRunWorkspaceResolver!.resolve(lease.run_id,Object.freeze({owner:lease.owner,generation:lease.generation}));
        this.executionGuard?.assertRunActive(lease.run_id);
        assertExecutionLease(this.db,lease.run_id,{owner:lease.owner,generation:lease.generation});
        const current=workLineage(),marker=workMarker(this.executionGuard?.contextForRun(lease.run_id));
        const saved=this.db.prepare(`SELECT b.session_id,c.owner_id FROM ga_harness_session_bindings b
          JOIN ga_conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id
          WHERE c.id=? AND c.archived_at IS NULL`).get(lease.conversation_id);
        if(!current||!isDeepStrictEqual(current,initialWorkLineage)||!resolved||resolved.kind!=='isolated_work'
          ||!marker||typeof marker!=='object'||!('kind' in marker)||marker.kind!=='isolated_work'
          ||!('original_run_id' in marker)||marker.original_run_id!==current.root_run_id
          ||!('occurrence_id' in marker)||marker.occurrence_id!==current.occurrence_id
          ||resolved.runId!==lease.run_id||resolved.originalRunId!==current.root_run_id
          ||resolved.ownerId!==input.ownerId||resolved.ownerId!==current.owner_id||saved?.owner_id!==resolved.ownerId
          ||resolved.conversationId!==lease.conversation_id||current.conversation_id!==lease.conversation_id
          ||resolved.taskId!==current.task_id||resolved.occurrenceId!==current.occurrence_id
          ||(current.root_run_id===lease.run_id?current.continuation_of!==null:!current.continuation_of||!current.checkpoint_id)
          ||resolved.sessionRef!==controllerSessionRef||saved?.session_id!==controllerSessionRef
          ||typeof resolved.cwd!=='string'||!isAbsolute(resolved.cwd)||resolved.cwd.includes('\0')
          ||typeof resolved.objective!=='string'||!resolved.objective.trim()||goalControl||originalRecovery||attachments.length)
          throw Error('work_workspace_binding_invalid');
        trustedWorkWorkspace=Object.freeze({...resolved});
        // Continuations retain the original recovery instructions and the
        // checkpoint-bound owner reply. The Goal objective remains frozen.
        if(current.root_run_id===lease.run_id)message=trustedWorkWorkspace.objective;
        trustedWorkWorkspaces.set(trustedWorkWorkspace,Object.freeze({executionLease:Object.freeze({owner:lease.owner,generation:lease.generation}),prompt:message}));
      }
      const recordObservedArtifact = async (artifactRef: string) => {
        assertGoalApplied();
        this.executionGuard?.assertRunActive(lease.run_id);
        if (!this.attachmentResolver) return;
        const outputLeaseId = `${lease.run_id}:observed:${artifactRef}`;
        let resolved: ResolvedAttachment[] = [];
        try {
          resolved = this.attachmentResolver.resolveOutputs(input.ownerId, lease.conversation_id,
            [artifactRef], [], outputLeaseId);
          withImmediateTransaction(this.db, () => {
            assertGoalApplied();
            this.executionGuard?.assertRunActive(lease.run_id);
            for (const item of resolved) this.coordinator.recordArtifact(lease, item);
          });
        } finally {
          if (resolved.length) this.attachmentResolver.releaseLease(outputLeaseId);
        }
      };
      const runInput:DshRunInput={ enabled: true, taskRequestId: lease.run_id, message, attachments,
        ...(trustedWorkWorkspace?{requiresWorkWorkspace:true as const,trustedWorkWorkspace}:{}),
        ...(this.ordinaryInputRecoveryEnabled&&lease.generation===1&&lease.input_message_id&&!goalControl&&!workbenchContext&&!hasWorkbenchBinding?{originalAdmission:Object.freeze({executionLease:Object.freeze({owner:lease.owner,generation:lease.generation})})}:{}),
        ...(workbenchContext ? { workbenchRunId: lease.run_id,workbenchExecutionLease:Object.freeze({owner:lease.owner,generation:lease.generation}),workbenchBudgetEnforced:!!(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_bindings'").get()&&this.db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(input.ownerId,lease.run_id)) } : {}),
        ...(backgroundTask
          ?{checkpointTask:true,onCheckpoint:(receipt:SessionCheckpoint)=>{this.executionGuard?.assertRunActive(lease.run_id);this.coordinator.recordCheckpoint(lease,controllerSessionRef,receipt);}}:{}),
        sessionRef: controllerSessionRef, universeSessionRef: controllerSessionRef, deferCompletionProbe: true,
        ...(ordinaryDelivery?{ordinaryCompletion:Object.freeze({executionLease:Object.freeze({owner:lease.owner,generation:lease.generation}),commands:commandIds,publish:async(candidate:DshRunResult,proof:OrdinaryCompletionProof,signal:AbortSignal)=>{signal.throwIfAborted();return publishOrdinary(candidate,proof);}})}:{}),
        onReady: () => {assertGoalApplied();const executionLease=Object.freeze({owner:lease.owner,generation:lease.generation});assertExecutionLease(this.db,lease.run_id,executionLease);this.readyRuns.set(lease.run_id,Object.freeze({sessionRef:controllerSessionRef,ordinary:!!lease.input_message_id&&!goalControl&&!workbenchContext&&!hasWorkbenchBinding,executionLease}));},
        onArtifactRef: recordObservedArtifact,
        onProjection: projection => { assertGoalApplied();this.executionGuard?.assertRunActive(lease.run_id); this.coordinator.recordProjection(lease, projection); },
        onWebOperationCursor: toolCallId => this.coordinator.webOperationCursor(lease, runtimeSessionRef, toolCallId),
        onWebOperationSnapshot: (toolCallId, snapshot) => {
          assertGoalApplied();
          this.executionGuard?.assertRunActive(lease.run_id);
          return this.coordinator.recordWebOperationSnapshot(lease, runtimeSessionRef, toolCallId, snapshot);
        } };
      if(goalControl){
        const executionLease=Object.freeze({owner:lease.owner,generation:lease.generation});
        ConversationGoalControls.assertExecution(this.db,goalControl.control_id,executionLease);
        result=await this.runner.resumeGoal!({...runInput,goalControl:Object.freeze({controlId:goalControl.control_id,ref:Object.freeze({id:goalControl.goal_id,revision:goalControl.goal_revision}),executionLease})});
        assertGoalApplied();
      }else if(originalRecovery){assertGoalApplied();result=await this.runner.recoverInput!({...runInput,originalInput:Object.freeze({inputMessageId:lease.input_message_id!,executionLease:Object.freeze({owner:lease.owner,generation:lease.generation})})});if(!published)assertGoalApplied();}else result=await this.runner.run(runInput);
    } catch (error) {
      if(published)return{run_id:lease.run_id,runtime_status:publishedRuntime};
      if (this.cancelling(lease.run_id)) return { run_id: lease.run_id, runtime_status: 'cancel_requested' };
      let reasonCode = typeof error === 'object' && error !== null
        && 'reasonCode' in error && typeof error.reasonCode === 'string'
        && /^DSH_(IMAGE_[A-Z0-9_]+|IMAGES_TOO_LARGE|TOO_MANY_IMAGES|MODEL_UNAVAILABLE|SESSION_NOT_FOUND|PROMPT_REJECTED)$/.test(error.reasonCode)
        ? error.reasonCode : 'DSH_NO_RUNTIME_OUTCOME';
      if(goalControl){
        try{const row=ConversationGoalControls.assertExecution(this.db,goalControl.control_id,{owner:lease.owner,generation:lease.generation});if(row.state==='rejected')reasonCode=validateGoalControlRejection(JSON.parse(row.receipt_json!)).reason_code;}catch{}
      }
      this.coordinator.interruptWithoutRuntime(lease, reasonCode);
      return { run_id: lease.run_id, runtime_status: 'harness_failed' };
    } finally {
      this.readyRuns.delete(lease.run_id);
      clearInterval(renewal);
      if(this.cancelling(lease.run_id))this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(lease.run_id,lease.owner,lease.generation);
      if (attachments.length) this.attachmentResolver?.releaseLease(lease.run_id);
    }
    if(published)return{run_id:lease.run_id,runtime_status:publishedRuntime};
    const finalText = result.final_text?.trim();
    const stoppedCandidate=result.task_candidate??(finalText?{text:finalText,...(result.final_blocks?{blocks:result.final_blocks}:{})}:undefined);
    if(this.cancelling(lease.run_id))return {run_id:lease.run_id,runtime_status:'cancel_requested'};
    try { this.executionGuard?.assertRunActive(lease.run_id); }
    catch { this.coordinator.interruptWithoutRuntime(lease, 'WORKBENCH_EXECUTION_REVOKED'); return {run_id:lease.run_id,runtime_status:'workbench_revoked'}; }
    // Legacy Runtime completion is not a gate on ordinary chat publication.
    // A background task's native/Runner completed label is not business
    // acceptance. Keep it unpublished until the acceptance controller can
    // validate a certificate and consume one occurrence finalization key.
    if (!finalText || backgroundTask) {
      if(backgroundTask&&result.task_stop){
        if(['SESSION_GOAL_USAGE_UNKNOWN','SESSION_GOAL_USAGE_PENDING'].includes(result.reason_code))this.coordinator.interruptWithoutRuntime(lease,'OUTCOME_UNKNOWN');
        else {
          try{this.coordinator.waitForTask(lease,result.task_stop,result.reason_code,stoppedCandidate?{...stoppedCandidate,
            ...(result.output_artifact_refs?{artifact_refs:result.output_artifact_refs}:{}),
            ...(result.presented_files?{presented_files:result.presented_files}:{}),}:undefined);}
          catch(error){
            if(this.cancelling(lease.run_id))return {run_id:lease.run_id,runtime_status:'cancel_requested'};
            const reason=error instanceof Error&&error.message==='budget_usage_unknown'?'OUTCOME_UNKNOWN':'WORKBENCH_WAIT_UNCONFIRMED';
            this.coordinator.interruptWithoutRuntime(lease,reason);
          }
        }
      }else {
        if(backgroundTask&&finalText){
          withImmediateTransaction(this.db,()=>{
            this.executionGuard?.assertRunActive(lease.run_id);
            this.coordinator.recordCandidate(lease,finalText);
            this.coordinator.interruptWithoutRuntime(lease,'TASK_BUSINESS_REVIEW_REQUIRED');
          });
        }else this.coordinator.interruptWithoutRuntime(lease,result.reason_code);
      }
      return { run_id: lease.run_id, runtime_status: result.runtime_status };
    }
    if(ordinaryDelivery){this.coordinator.interruptWithoutRuntime(lease,'ORDINARY_COMPLETION_UNCONFIRMED');return{run_id:lease.run_id,runtime_status:'ordinary_completion_unconfirmed'};}
    try{await publishOrdinary(result);return{run_id:lease.run_id,runtime_status:result.tool_marker?'runtime_observed':'not_required'};}
    catch{this.coordinator.interruptWithoutRuntime(lease);return{run_id:lease.run_id,runtime_status:'output_attachment_invalid'};}
  }

  private cancelling(runId:string){const row=this.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(runId) as {status:string}|undefined;return row?.status==='cancelling'||row?.status==='cancelled';}

  private messageInput(runId: string): { text: string; attachmentIds: string[]; ownerId: string; receivedAt: number } {
    const row = this.db.prepare(`SELECT m.content_json,m.created_at,c.owner_id,r.continuation_of,r.checkpoint_id FROM ga_runs r
      JOIN ga_messages m ON m.id=r.input_message_id JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?`)
      .get(runId) as { content_json: string; created_at: string; owner_id: string;continuation_of:string|null;checkpoint_id:string|null } | undefined;
    if (!row) throw new Error('run_input_missing');
    const content = decodeStoredContent(row.content_json); const blocks = content.blocks;
    const text = blocks.filter(block => block.kind === 'text').map(block => String(block.text ?? '')).join('\n').trim();
    const attachmentIds = content.attachments.filter(Boolean);
    if (!text && !attachmentIds.length) throw new Error('run_input_empty');
    const receivedAt = Math.floor(Date.parse(row.created_at) / 1000);
    if (!Number.isInteger(receivedAt) || receivedAt <= 0) throw new Error('run_input_created_at_invalid');
    if(row.continuation_of && row.checkpoint_id)return {text:'继续当前已授权任务，从持久 Session 和任务账本的最后确认点恢复。先核对已有回执、文件版本、依赖与剩余预算，再完成未确认的步骤。不要重新发送或重复执行原始请求；结果未知的点击、提交、发送先核对，无法核对则等待人工处理。保持原目标与权限范围。'+taskWaitSupplement(this.db,runId),attachmentIds:[],ownerId:row.owner_id,receivedAt};
    return { text, attachmentIds, ownerId: row.owner_id, receivedAt };
  }
}
