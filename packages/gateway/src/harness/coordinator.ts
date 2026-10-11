import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import type { EventStore } from '../events/event-store.ts';
import type { RunRepository } from '../runs/repository.ts';
import type { JotProjection } from './session-event-projector.ts';
import type { ResolvedAttachment } from '../artifacts/resolver.ts';
import {recordSessionCheckpoint} from './session-checkpoints.ts';
import {requestTaskWaitInteraction} from '../persistent-tasks/task-wait.ts';
import {freezeTaskCompletionCandidate,type TaskCompletionCandidate} from '../persistent-tasks/completion-candidates.ts';
import {finalizeReviewedTask} from '../persistent-tasks/finalization.ts';
import {
  safeWebOperationCounts, safeWebOperationId, safeWebOperationItems,
  safeWebOperationKind, safeWebOperationStatus, webOperationPresentation,
} from './web-operation-presentation.ts';

export interface RunLease {
  run_id: string;
  conversation_id: string;
  input_message_id: string;
  owner: string;
  generation: number;
  expires_at: number;
}

export class FenceRejectedError extends Error {
  constructor() { super('worker_fence_rejected'); }
}

export interface BackgroundRunOptions {
  maxBackgroundRuns: number;
  allowBackgroundRuns: boolean;
}

export class HarnessCoordinator {
  private readonly db: DatabaseSync;
  private readonly runs: RunRepository;
  private readonly events: EventStore;
  private readonly now: () => number;
  private readonly backgroundOptions: BackgroundRunOptions;

  constructor(db: DatabaseSync, runs: RunRepository, events: EventStore, now: () => number = Date.now,
    options: BackgroundRunOptions = { maxBackgroundRuns: 1, allowBackgroundRuns: true }) {
    this.db = db; this.runs = runs; this.events = events; this.now = now;
    if (!Number.isSafeInteger(options.maxBackgroundRuns) || options.maxBackgroundRuns < 0 || typeof options.allowBackgroundRuns !== 'boolean') throw new Error('invalid_background_run_options');
    this.backgroundOptions = options;
  }

  claimNext(workerId: string, leaseMs: number): RunLease | null {
    const now = this.now();
    return withImmediateTransaction(this.db, () => {
      const hasBindings=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_run_bindings'").get());
      const hasTaskPriority=hasBindings && Number((this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('wb_task_occurrences','wb_persistent_tasks')").get() as {n:number}).n)===2;
      const joins=hasBindings ? `JOIN ga_conversations c ON c.id=r.conversation_id LEFT JOIN wb_run_bindings b ON b.run_id=r.id
        ${hasTaskPriority ? 'LEFT JOIN wb_task_run_occurrences o ON o.run_id=r.id LEFT JOIN wb_persistent_tasks t ON t.task_id=o.task_id' : ''}` : '';
      const activeBackground=`SELECT count(*) FROM ga_runs ar JOIN ga_worker_leases al ON al.resource_id=ar.id
        JOIN wb_run_bindings ab ON ab.run_id=ar.id JOIN ga_conversations ac ON ac.id=ar.conversation_id
        WHERE ab.kind IN ('task','internal_mailbox') AND ar.status IN ('starting','running','waiting_user','waiting_approval','cancelling') AND CAST(al.expires_at AS INTEGER)>?`;
      const admission=!hasBindings ? '' : !this.backgroundOptions.allowBackgroundRuns ? 'AND b.run_id IS NULL' :
        `AND (b.kind IS NULL OR b.kind NOT IN ('task','internal_mailbox') OR
          ((${activeBackground})<? AND (${activeBackground} AND ac.owner_id=c.owner_id)<?))`;
      const order=hasBindings ? `CASE WHEN b.kind IN ('task','internal_mailbox') THEN 1 ELSE 0 END,
        ${hasTaskPriority ? 'COALESCE(t.priority,50)' : 'CAST(50 AS INTEGER)'} DESC,` : '';
      const parameters:Array<number>=[now];
      if(hasBindings && this.backgroundOptions.allowBackgroundRuns)parameters.push(now,this.backgroundOptions.maxBackgroundRuns,now,this.backgroundOptions.maxBackgroundRuns);
      const row = this.db.prepare(
        `SELECT r.id,r.conversation_id,r.input_message_id,r.status,l.generation
         FROM ga_runs r LEFT JOIN ga_worker_leases l ON l.resource_id=r.id
         ${joins}
         WHERE ((r.status='queued' AND NOT EXISTS (
           SELECT 1 FROM ga_runs active WHERE active.conversation_id=r.conversation_id
           AND active.id<>r.id AND active.status IN ('starting','running','waiting_user','waiting_approval','cancelling')
         )) OR (r.status IN ('starting','running') AND (l.resource_id IS NULL OR CAST(l.expires_at AS INTEGER)<=?)))
         ${admission}
         ORDER BY ${order} CASE r.status WHEN 'queued' THEN 0 ELSE 1 END,r.created_at,r.id LIMIT 1`,
      ).get(...parameters) as Record<string, unknown> | undefined;
      if (!row) return null;
      const runId = String(row.id);
      const conversationId = String(row.conversation_id);
      const inputMessageId = String(row.input_message_id);
      const generation = Number(row.generation || 0) + 1;
      const expiresAt = now + Math.max(100, leaseMs);
      this.db.prepare(
        `INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,
         expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
      ).run(runId, workerId, generation, String(expiresAt), new Date(now).toISOString());
      if (row.status === 'queued') {
        this.db.prepare("UPDATE ga_runs SET status='starting',version=version+1,updated_at=? WHERE id=?")
          .run(new Date(now).toISOString(), runId);
        const run = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(runId) as Record<string, unknown>;
        this.events.append(conversationId, runId, 'run.state', this.runValue(run));
      }
      return { run_id: runId, conversation_id: conversationId, input_message_id: inputMessageId,
        owner: workerId, generation, expires_at: expiresAt };
    });
  }

  start(lease: RunLease): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const row = this.db.prepare('SELECT status,conversation_id FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string, unknown>;
      if (row.status === 'starting') {
        this.db.prepare("UPDATE ga_runs SET status='running',version=version+1,updated_at=? WHERE id=?")
          .run(new Date(this.now()).toISOString(), lease.run_id);
        const run = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string, unknown>;
        this.events.append(String(row.conversation_id), lease.run_id, 'run.state', this.runValue(run));
      }
    });
  }

  recordCheckpoint(lease:RunLease,sessionRef:string,receipt:unknown):string {
    return withImmediateTransaction(this.db,()=>{
      this.assertLease(lease);
      const checkpointId=recordSessionCheckpoint(this.db,lease.run_id,lease.conversation_id,sessionRef,receipt);
      const run=this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string,unknown>;
      this.events.append(lease.conversation_id,lease.run_id,'run.state',{...this.runValue(run),checkpoint_id:checkpointId});
      return checkpointId;
    });
  }

  applyRuntimeOutcome(lease: RunLease, outcome: { status: string; runtime_revision: number; reason_code: string | null }) {
    return this.runs.applyRuntimeOutcome(lease.run_id, outcome, () => this.assertLease(lease));
  }

  recordAssistant(lease: RunLease, text: string, blocks?: Array<{ kind: 'text' | 'reasoning'; text: string }>,
    attachmentIds: string[] = []) {
    return withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      return this.runs.appendAssistant(lease.run_id, text, blocks, attachmentIds);
    });
  }

  recordProjection(lease: RunLease, projection: JotProjection): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      this.events.append(lease.conversation_id, lease.run_id, projection.type, projection.payload);
    });
  }

  webOperationCursor(lease: RunLease, sessionRef: string, toolCallId: string): number {
    this.assertLease(lease);
    const binding = this.db.prepare('SELECT harness_session_ref FROM ga_runtime_bindings WHERE run_id=?')
      .get(lease.run_id) as { harness_session_ref?: string } | undefined;
    if (!binding || binding.harness_session_ref !== sessionRef) throw new Error('web_operation_session_binding_mismatch');
    const row = this.db.prepare(`SELECT last_revision FROM ga_web_operation_cursors
      WHERE run_id=? AND tool_call_id=? AND session_ref=?`).get(lease.run_id, toolCallId, sessionRef) as
      { last_revision: number } | undefined;
    return Number(row?.last_revision ?? 0);
  }

  recordWebOperationSnapshot(lease: RunLease, sessionRef: string, toolCallId: string,
    value: Record<string, unknown>): number {
    return withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const binding = this.db.prepare('SELECT harness_session_ref FROM ga_runtime_bindings WHERE run_id=?')
        .get(lease.run_id) as { harness_session_ref?: string } | undefined;
      if (!binding || binding.harness_session_ref !== sessionRef) throw new Error('web_operation_session_binding_mismatch');
      const operationId = safeWebOperationId(value.operation_id);
      const operationKind = safeWebOperationKind(value.kind);
      const operationStatus = safeWebOperationStatus(value.status);
      const operationPresentation = webOperationPresentation(operationKind, operationStatus);
      const revisionValue = value.revision;
      const eventCursorValue = value.event_cursor;
      const rows = Array.isArray(value.items) ? value.items : null;
      const sourceEvents = Array.isArray(value.events) ? value.events : null;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(toolCallId)
        || !operationId
          || typeof revisionValue !== 'number' || !Number.isSafeInteger(revisionValue) || revisionValue < 1
          || typeof eventCursorValue !== 'number' || !Number.isSafeInteger(eventCursorValue)
          || eventCursorValue < 0 || eventCursorValue > revisionValue
        || !rows || rows.length > 100 || !sourceEvents) throw new Error('web_operation_snapshot_invalid');
      const revision = revisionValue;
      const eventCursor = eventCursorValue;
      if (rows.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('web_operation_item_invalid');
      }
      const existing = this.db.prepare(`SELECT operation_id,last_revision,started_at,session_ref
        FROM ga_web_operation_cursors WHERE run_id=? AND tool_call_id=?`).get(lease.run_id, toolCallId) as
        { operation_id: string; last_revision: number; started_at: string; session_ref: string } | undefined;
      if (existing && (existing.operation_id !== operationId || existing.session_ref !== sessionRef)) {
        throw new Error('web_operation_binding_conflict');
      }
      const lastRevision = Number(existing?.last_revision ?? 0);
      let observedCursor = 0;
      let expectedRevision: number | null = null;
      let firstEventRevision: number | null = null;
      for (const event of sourceEvents) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('web_operation_event_invalid');
        const eventRevisionValue = (event as Record<string, unknown>).revision;
        if (typeof eventRevisionValue !== 'number' || !Number.isSafeInteger(eventRevisionValue)
          || eventRevisionValue < 1 || eventRevisionValue > revision
          || (expectedRevision !== null && eventRevisionValue !== expectedRevision)) {
          throw new Error('web_operation_event_invalid');
        }
        const eventRevision: number = eventRevisionValue;
        if (firstEventRevision === null) firstEventRevision = eventRevision;
        expectedRevision = eventRevision + 1;
        observedCursor = Math.max(observedCursor, eventRevision);
      }
      if (sourceEvents.length && firstEventRevision !== 1 && firstEventRevision !== lastRevision + 1) {
        throw new Error('web_operation_event_cursor_mismatch');
      }
      const cursorMatchesEvents = sourceEvents.length
        ? observedCursor === eventCursor
        : eventCursor === lastRevision;
      if (!cursorMatchesEvents) throw new Error('web_operation_event_cursor_mismatch');
      if (eventCursor <= lastRevision) return lastRevision;

      const counts = safeWebOperationCounts(value.counts);
      const items = safeWebOperationItems(rows, operationKind, operationPresentation.itemActionLabel);
      const urls = [...new Set(items.map(item => item.url).filter(Boolean))];
      const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(operationStatus);
      const activityStatus = operationStatus === 'partial' ? 'partial'
        : operationStatus === 'succeeded' ? 'succeeded'
          : operationStatus === 'failed' ? 'failed'
            : operationStatus === 'cancelled' ? 'cancelled'
              : operationStatus === 'waiting_confirmation' ? 'waiting'
                : operationStatus === 'unknown' || operationStatus === 'needs_reconciliation' ? 'unknown' : 'running';
      const title = operationPresentation.title;
      const now = new Date(this.now()).toISOString();
      const startedAt = existing?.started_at ?? now;
      const activity = {
        activity_id: toolCallId, run_id: lease.run_id, tool_call_id: toolCallId,
        status: activityStatus, title, started_at: startedAt,
        ...(terminal ? { ended_at: now } : {}), kind: 'browse',
        detail: {
          tool_name: operationKind === 'unknown' ? 'universe_web_batch' : `universe_${operationKind}`,
          action: operationPresentation.action, operation: operationPresentation.operation,
          operation_kind: operationKind || 'unknown',
          request_id: toolCallId, generation: lease.generation,
          operation_id: operationId, operation_status: operationStatus,
          revision, event_cursor: eventCursor,
          accepted_count: Number.isSafeInteger(Number(value.accepted_count)) && Number(value.accepted_count) >= 0
            ? Number(value.accepted_count) : items.length,
          counts, urls, ...(urls[0] ? { url: urls[0] } : {}), source_ids: [], items,
        },
      };
      this.events.append(lease.conversation_id, lease.run_id, 'activity.upsert', activity);
      this.db.prepare(`INSERT INTO ga_web_operation_cursors
        (run_id,tool_call_id,session_ref,operation_id,last_revision,started_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,tool_call_id) DO UPDATE SET
        last_revision=excluded.last_revision,updated_at=excluded.updated_at`)
        .run(lease.run_id, toolCallId, sessionRef, operationId, eventCursor, startedAt, now);
      return eventCursor;
    });
  }

  recordArtifact(lease: RunLease, artifact: ResolvedAttachment): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const version = Number(artifact.version);
      if (!Number.isInteger(version) || version < 1) throw new Error('artifact_version_invalid');
      const now = new Date(this.now()).toISOString();
      const changed = this.db.prepare(`INSERT OR IGNORE INTO ga_run_artifacts(run_id,artifact_id,version,created_at)
        VALUES(?,?,?,?)`).run(lease.run_id, artifact.artifactId, version, now).changes;
      if (!changed) return;
      this.events.append(lease.conversation_id, lease.run_id, 'run.artifact', {
        run_id: lease.run_id, conversation_id: lease.conversation_id,
        artifact_id: artifact.artifactId, version, file_name: artifact.displayName,
        media_type: artifact.mediaType, size_bytes: artifact.sizeBytes, sha256: artifact.sha256,
        status: 'ready', download_url: `/v1/artifacts/${artifact.artifactId}/download?version=${version}`,
        created_at:now,
      });
    });
  }

  recordCandidate(lease: RunLease, text: string): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      this.runs.saveCandidate(lease.run_id, text);
    });
  }

  setCandidateStatus(lease: RunLease, status: 'verified' | 'partial' | 'failed' | 'outcome_unknown', evidenceRefs: string[]): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      this.runs.setCandidateStatus(lease.run_id, status, evidenceRefs);
    });
  }

  finalizePublication(lease: RunLease, status: 'succeeded' | 'partial' | 'failed' | 'interrupted' | 'running', reasonCode: string | null): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      this.runs.finalizePublication(lease.run_id, status, reasonCode);
      if(status!=='running')this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?')
        .run(lease.run_id,lease.owner,lease.generation);
    });
  }

  /** Stopped tasks have no execution lease. Their owned certificate and
   * confirmed native completion provide the stronger finalization boundary. */
  finalizeReviewedTask(owner:string,runId:string,intentId:string){
    return withImmediateTransaction(this.db,()=>finalizeReviewedTask(this.db,this.runs,owner,runId,intentId));
  }

  bindSession(lease: RunLease, sessionRef: string): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const now = new Date(this.now()).toISOString();
      this.db.prepare(`INSERT INTO ga_runtime_bindings(run_id,harness_session_ref,runtime_owner,fence_epoch,created_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET runtime_owner=excluded.runtime_owner,
        fence_epoch=excluded.fence_epoch,updated_at=excluded.updated_at
        WHERE ga_runtime_bindings.harness_session_ref=excluded.harness_session_ref`)
        .run(lease.run_id, sessionRef, lease.owner, lease.generation, now, now);
    });
  }

  renew(lease: RunLease, leaseMs: number): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const now = this.now();
      this.db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=?')
        .run(String(now + Math.max(100, leaseMs)), new Date(now).toISOString(), lease.run_id, lease.owner, lease.generation);
    });
  }

  bindRuntimeRevision(lease: RunLease, runtimeRunId: string, revision: number): void {
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const product = this.db.prepare('SELECT runtime_run_id FROM ga_runs WHERE id=?').get(lease.run_id) as { runtime_run_id: string | null } | undefined;
      if (!product) throw new Error('run_not_found');
      if (product.runtime_run_id && product.runtime_run_id !== runtimeRunId) throw new Error('RUNTIME_BINDING_CONFLICT');
      this.db.prepare('UPDATE ga_runs SET runtime_run_id=? WHERE id=? AND (runtime_run_id IS NULL OR runtime_run_id=?)')
        .run(runtimeRunId, lease.run_id, runtimeRunId);
      this.db.prepare(`UPDATE ga_runtime_bindings SET runtime_run_id=?,last_runtime_revision=?,updated_at=?
        WHERE run_id=? AND last_runtime_revision<=?`)
        .run(runtimeRunId, revision, new Date(this.now()).toISOString(), lease.run_id, revision);
    });
  }

  interruptWithoutRuntime(lease: RunLease, reasonCode = 'DSH_NO_RUNTIME_OUTCOME'): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)) reasonCode = 'SESSION_INTERRUPTED';
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const now = new Date(this.now()).toISOString();
      const row = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string, unknown>;
      this.db.prepare("UPDATE ga_runs SET status='interrupted',reason_code=?,version=version+1,updated_at=? WHERE id=?")
        .run(reasonCode, now, lease.run_id);
      const updated = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string, unknown>;
      this.events.append(lease.conversation_id, lease.run_id, 'run.state', this.runValue(updated));
      this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?')
        .run(lease.run_id, lease.owner, lease.generation);
    });
  }

  /** A waiting state retains its occurrence and safe checkpoint but owns no
   * worker lease. Only the authenticated resume command can create its child. */
  waitForTask(lease:RunLease,stop:{goal_id:string;goal_revision:number;phase:string;turn_end_seq:number},reasonCode:string,candidate?:TaskCompletionCandidate):void {
    const userReasons=['SESSION_GOAL_WAITING_USER','SESSION_GOAL_PAUSED','SESSION_GOAL_BLOCKED','SESSION_GOAL_DISARMED',
      'SESSION_GOAL_ROUND_LIMIT','SESSION_GOAL_BUDGET_EXHAUSTED','SESSION_GOAL_BUDGET_UNCONFIGURED','SESSION_GOAL_STREAM_ENDED'];
    const reviewReasons=['SESSION_GOAL_WAITING_APPROVAL','SESSION_GOAL_REVIEW_REQUIRED'];
    if(!stop||typeof stop!=='object'||Object.keys(stop).length!==4||typeof stop.goal_id!=='string'
      ||!Number.isSafeInteger(stop.goal_revision)||stop.goal_revision<1||!Number.isSafeInteger(stop.turn_end_seq)||stop.turn_end_seq<0
      ||!['paused','blocked','complete'].includes(stop.phase)||![...userReasons,...reviewReasons].includes(reasonCode))throw new Error('task_wait_invalid');
    withImmediateTransaction(this.db,()=>{
      this.assertLease(lease);
      const proof=this.db.prepare(`SELECT o.occurrence_id,o.task_id FROM ga_runs r
        JOIN ga_conversations c ON c.id=r.conversation_id
        JOIN ga_session_checkpoints cp ON cp.checkpoint_id=r.checkpoint_id AND cp.run_id=r.id AND cp.conversation_id=c.id
        JOIN ga_harness_session_bindings s ON s.conversation_id=c.id AND s.owner_id=c.owner_id AND s.session_id=cp.session_ref
        JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='task'
        JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id AND a.status='active' AND a.capability_epoch=b.epoch
        JOIN wb_task_current_occurrences o ON o.run_id=r.id
        JOIN wb_persistent_tasks t ON t.task_id=o.task_id AND t.owner_id=c.owner_id AND t.generation=o.generation
        JOIN wb_native_goal_bindings g ON g.run_id=o.root_run_id AND g.occurrence_id=o.occurrence_id
          AND g.goal_id=cp.goal_id AND g.goal_revision=cp.goal_revision
        WHERE r.id=? AND r.status='running' AND t.status IN ('active','budget_exhausted')
          AND cp.goal_id=? AND cp.goal_revision=? AND cp.turn_end_seq=?`)
        .get(lease.run_id,stop.goal_id,stop.goal_revision,stop.turn_end_seq) as {occurrence_id:string;task_id:string}|undefined;
      if(!proof)throw new Error('task_wait_unconfirmed');
      if(this.db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN wb_task_run_occurrences o ON o.run_id=a.run_id
        WHERE o.occurrence_id=? AND a.state IN ('unknown','in_flight') LIMIT 1`).get(proof.occurrence_id))throw new Error('budget_usage_unknown');
      const status=stop.phase==='complete'||reviewReasons.includes(reasonCode)?'waiting_approval':'waiting_user';
      const now=new Date(this.now()).toISOString();
      this.db.prepare('UPDATE ga_runs SET status=?,reason_code=?,version=version+1,updated_at=? WHERE id=?').run(status,reasonCode,now,lease.run_id);
      this.db.prepare('UPDATE wb_task_occurrences SET status=?,business_state=?,updated_at=? WHERE occurrence_id=?').run(status,status,now,proof.occurrence_id);
      this.db.prepare('UPDATE wb_persistent_tasks SET projection_pending=1 WHERE task_id=?').run(proof.task_id);
      const updated=this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string,unknown>;
      this.events.append(lease.conversation_id,lease.run_id,'run.state',this.runValue(updated));
      if(candidate)freezeTaskCompletionCandidate(this.db,lease.run_id,candidate);
      requestTaskWaitInteraction(this.db,this.events,lease.run_id);
      this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(lease.run_id,lease.owner,lease.generation);
    });
  }

  requeueBeforeExecution(lease: RunLease, reasonCode: string): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)) throw new Error('reason_code_invalid');
    withImmediateTransaction(this.db, () => {
      this.assertLease(lease);
      const now = new Date(this.now()).toISOString();
      this.db.prepare("UPDATE ga_runs SET status='queued',reason_code=?,version=version+1,updated_at=? WHERE id=?")
        .run(reasonCode, now, lease.run_id);
      const updated = this.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(lease.run_id) as Record<string, unknown>;
      this.events.append(lease.conversation_id, lease.run_id, 'run.state', this.runValue(updated));
      this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?')
        .run(lease.run_id, lease.owner, lease.generation);
    });
  }

  private assertLease(lease: RunLease): void {
    const row = this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?')
      .get(lease.run_id) as Record<string, unknown> | undefined;
    if (!row || row.owner !== lease.owner || Number(row.generation) !== lease.generation || Number(row.expires_at) <= this.now()) {
      throw new FenceRejectedError();
    }
  }

  private runValue(row: Record<string, unknown>) {
    return { run_id: row.id, conversation_id: row.conversation_id, input_message_id: row.input_message_id,
      status: row.status, version: Number(row.version), created_at: row.created_at, updated_at: row.updated_at };
  }
}
