import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HarnessCoordinator } from './coordinator.ts';
import { decodeStoredContent } from '../messages/content.ts';
import type { RuntimeContextInput } from './runtime-events.ts';
import type { JotProjection } from './session-event-projector.ts';
import type { AttachmentResolver, ResolvedAttachment } from '../artifacts/resolver.ts';

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
}

export interface DshRunner {
  run(input: { enabled: true; taskRequestId: string; message: string; sessionRef: string;
    deferCompletionProbe: true; attachments?: ResolvedAttachment[]; universeSessionRef?: string;
    onReady?: () => void;
    onArtifactRef?: (artifactRef: string) => Promise<void> | void;
    onProjection?: (projection: JotProjection) => Promise<void> | void;
    onWebOperationCursor?: (toolCallId: string) => number;
    onWebOperationSnapshot?: (toolCallId: string, snapshot: Record<string, unknown>) => number }): Promise<DshRunResult>;
}

export interface RuntimeContextStager {
  stageContext(input: RuntimeContextInput): Promise<Record<string, unknown>>;
}

export interface ChannelTextDelivery {
  enqueueText(input: { runId: string; messageId: string; destination: 'wecom';
    recipient: string; text: string }): Record<string, unknown> | null;
}

export class HarnessWorker {
  private readonly readyRuns = new Set<string>();
  isReady(runId: string) { return this.readyRuns.has(runId); }
  private readonly db: DatabaseSync;
  private readonly coordinator: HarnessCoordinator;
  private readonly runner: DshRunner;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly contextStager: RuntimeContextStager | undefined;
  private readonly sessionResolver: ((conversationId: string) => string) | undefined;
  private readonly attachmentResolver: Pick<AttachmentResolver,
    'resolveForMessage' | 'resolveOutputs' | 'releaseLease'> | undefined;
  private readonly channelDelivery: ChannelTextDelivery | undefined;

  constructor(db: DatabaseSync, coordinator: HarnessCoordinator, runner: DshRunner,
    options: { workerId: string; leaseMs: number; contextStager?: RuntimeContextStager;
      sessionResolver?: (conversationId: string) => string;
      attachmentResolver?: Pick<AttachmentResolver, 'resolveForMessage' | 'resolveOutputs' | 'releaseLease'>;
      channelDelivery?: ChannelTextDelivery }) {
    this.db = db; this.coordinator = coordinator; this.runner = runner;
    this.workerId = options.workerId; this.leaseMs = options.leaseMs;
    this.contextStager = options.contextStager;
    this.sessionResolver = options.sessionResolver;
    this.attachmentResolver = options.attachmentResolver;
    this.channelDelivery = options.channelDelivery;
  }

  async processNext(): Promise<{ run_id: string; runtime_status: string } | null> {
    const lease = this.coordinator.claimNext(this.workerId, this.leaseMs);
    if (!lease) return null;
    const controllerSessionRef = this.sessionResolver?.(lease.conversation_id)
      ?? `session-${createHash('sha256').update(lease.run_id).digest('hex').slice(0, 32)}`;
    const runtimeSessionRef = `runtime-session-${createHash('sha256').update(lease.run_id).digest('hex').slice(0, 32)}`;
    this.coordinator.bindSession(lease, runtimeSessionRef);
    const input = this.messageInput(lease.run_id);
    const message = input.text;
    const attachments = input.attachmentIds.length
      ? this.attachmentResolver?.resolveForMessage(input.ownerId, lease.conversation_id,
        input.attachmentIds, lease.run_id) ?? (() => { throw new Error('attachment_resolver_unavailable'); })()
      : [];
    if (this.contextStager) {
      try {
        await this.contextStager.stageContext({ taskRequestId: lease.run_id, conversationId: lease.conversation_id,
          messageId: lease.input_message_id, message, sessionRef: runtimeSessionRef, controllerSessionRef,
          receivedAt: input.receivedAt });
      } catch { /* Runtime is an execution ledger, never a conversation admission gate. */ }
    }
    this.coordinator.start(lease);
    const renewal = setInterval(() => this.coordinator.renew(lease, this.leaseMs), Math.max(100, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    let result: DshRunResult;
    try {
      const recordObservedArtifact = async (artifactRef: string) => {
        if (!this.attachmentResolver) return;
        const outputLeaseId = `${lease.run_id}:observed:${artifactRef}`;
        let resolved: ResolvedAttachment[] = [];
        try {
          resolved = this.attachmentResolver.resolveOutputs(input.ownerId, lease.conversation_id,
            [artifactRef], [], outputLeaseId);
          for (const item of resolved) this.coordinator.recordArtifact(lease, item);
        } finally {
          if (resolved.length) this.attachmentResolver.releaseLease(outputLeaseId);
        }
      };
      result = await this.runner.run({ enabled: true, taskRequestId: lease.run_id, message, attachments,
        sessionRef: controllerSessionRef, universeSessionRef: controllerSessionRef, deferCompletionProbe: true,
        onReady: () => this.readyRuns.add(lease.run_id),
        onArtifactRef: recordObservedArtifact,
        onProjection: projection => this.coordinator.recordProjection(lease, projection),
        onWebOperationCursor: toolCallId => this.coordinator.webOperationCursor(lease, runtimeSessionRef, toolCallId),
        onWebOperationSnapshot: (toolCallId, snapshot) =>
          this.coordinator.recordWebOperationSnapshot(lease, runtimeSessionRef, toolCallId, snapshot) });
    } catch (error) {
      if (this.cancelling(lease.run_id)) return { run_id: lease.run_id, runtime_status: 'cancel_requested' };
      const reasonCode = typeof error === 'object' && error !== null
        && 'reasonCode' in error && typeof error.reasonCode === 'string'
        && /^DSH_(IMAGE_[A-Z0-9_]+|IMAGES_TOO_LARGE|TOO_MANY_IMAGES|MODEL_UNAVAILABLE|SESSION_NOT_FOUND|PROMPT_REJECTED)$/.test(error.reasonCode)
        ? error.reasonCode : 'DSH_NO_RUNTIME_OUTCOME';
      this.coordinator.interruptWithoutRuntime(lease, reasonCode);
      return { run_id: lease.run_id, runtime_status: 'harness_failed' };
    } finally {
      this.readyRuns.delete(lease.run_id);
      clearInterval(renewal);
      if(this.cancelling(lease.run_id))this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(lease.run_id,lease.owner,lease.generation);
      if (attachments.length) this.attachmentResolver?.releaseLease(lease.run_id);
    }
    const finalText = result.final_text?.trim();
    if(this.cancelling(lease.run_id))return {run_id:lease.run_id,runtime_status:'cancel_requested'};
    if (!finalText) {
      this.coordinator.interruptWithoutRuntime(lease, result.reason_code);
      return { run_id: lease.run_id, runtime_status: result.runtime_status };
    }
    const outputLeaseId = `${lease.run_id}:outputs`;
    let outputAttachments: ResolvedAttachment[] = [];
    try {
      const artifactRefs = result.output_artifact_refs ?? [];
      const presentedFiles = result.presented_files ?? [];
      if (artifactRefs.length || presentedFiles.length) {
        if (!this.attachmentResolver) throw new Error('output_attachment_resolver_unavailable');
        outputAttachments = this.attachmentResolver.resolveOutputs(input.ownerId, lease.conversation_id,
          artifactRefs, presentedFiles, outputLeaseId);
        for (const item of outputAttachments) this.coordinator.recordArtifact(lease, item);
      }
      this.coordinator.recordCandidate(lease, finalText);
      this.coordinator.setCandidateStatus(lease, 'verified', []);
      const assistant = this.coordinator.recordAssistant(lease, finalText, result.final_blocks,
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
    } catch {
      this.coordinator.interruptWithoutRuntime(lease);
      return { run_id: lease.run_id, runtime_status: 'output_attachment_invalid' };
    } finally {
      if (outputAttachments.length) this.attachmentResolver?.releaseLease(outputLeaseId);
    }
    return { run_id: lease.run_id, runtime_status: result.tool_marker ? 'runtime_observed' : 'not_required' };
  }

  private cancelling(runId:string){const row=this.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(runId) as {status:string}|undefined;return row?.status==='cancelling'||row?.status==='cancelled';}

  private messageInput(runId: string): { text: string; attachmentIds: string[]; ownerId: string; receivedAt: number } {
    const row = this.db.prepare(`SELECT m.content_json,m.created_at,c.owner_id FROM ga_runs r
      JOIN ga_messages m ON m.id=r.input_message_id JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?`)
      .get(runId) as { content_json: string; created_at: string; owner_id: string } | undefined;
    if (!row) throw new Error('run_input_missing');
    const content = decodeStoredContent(row.content_json); const blocks = content.blocks;
    const text = blocks.filter(block => block.kind === 'text').map(block => String(block.text ?? '')).join('\n').trim();
    const attachmentIds = content.attachments.filter(Boolean);
    if (!text && !attachmentIds.length) throw new Error('run_input_empty');
    const receivedAt = Math.floor(Date.parse(row.created_at) / 1000);
    if (!Number.isInteger(receivedAt) || receivedAt <= 0) throw new Error('run_input_created_at_invalid');
    return { text, attachmentIds, ownerId: row.owner_id, receivedAt };
  }
}
