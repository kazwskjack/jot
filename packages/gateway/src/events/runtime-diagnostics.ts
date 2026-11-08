import type { DatabaseSync } from 'node:sqlite';
import {readRecordedRuntimeReadiness,type RecordedRuntimeReadiness} from './runtime-readiness-observations.ts';

type RunRow = { id: string; conversation_id: string; status: string; created_at: string; updated_at: string };
type EventRow = {
  type: string; created_at: string; run_status: unknown; attempt_id: unknown; assistant_kind: unknown;
  preparation_phase: unknown; preparation_duration_ms: unknown; preparation_outcome: unknown; preparation_offset_ms: unknown;
};
type AttemptRow = {
  attempt_id: string; route_json: string; state: string; usage_json: string | null;
  actual_nano_usd: string | null; reason: string | null; created_at: string;
};
type BudgetEventRow = { attempt_id: string; state: string; created_at: string };
type JsonRecord = Record<string, unknown>;
type UsageField = 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'total_tokens' | 'reasoning_tokens';
type RuntimeUsage = Partial<Record<UsageField, string>>;

export interface RuntimePreparationPhase {
  phase: string;
  duration_ms: number;
  outcome: string;
  offset_ms: number | null;
}

export interface RuntimeAttemptDiagnostics {
  attempt_id: string;
  state: string;
  provider: string | null;
  model: string | null;
  retry_index: number | null;
  ttft_ms: number | null;
  generation_ms: number | null;
  usage: RuntimeUsage | null;
  usage_status: 'available' | 'partial' | 'not_metered' | 'unknown';
  cost: { nano_usd: string; basis: 'configured_rates' } | null;
  unknown: boolean;
  unknown_reason: string | null;
  manual_intervention_required: boolean;
  missing: string[];
}

export interface RuntimeRunDiagnostics {
  schema_version: 1;
  run_id: string;
  status: string;
  queue_ms: number | null;
  runtime_readiness: RecordedRuntimeReadiness | null;
  preparation: { phases: RuntimePreparationPhase[]; total_ms: number | null; outcome: string | null };
  attempts: RuntimeAttemptDiagnostics[];
  retry_count: number;
  manual_intervention_required: boolean;
  partial: boolean;
  missing: string[];
}

const EVENT_LIMIT = 10_000;
const ATTEMPT_LIMIT = 1_000;
const PREPARATION_PHASES = new Set([
  'session_confirm', 'opening_snapshot', 'attachments', 'prompt_submit', 'input_recovery', 'goal_resume', 'preparation_total',
]);
const USAGE_FIELDS = [
  ['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['cacheReadTokens', 'cache_read_tokens'],
  ['cacheWriteTokens', 'cache_write_tokens'], ['totalTokens', 'total_tokens'], ['reasoningTokens', 'reasoning_tokens'],
] as const;

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function object(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function safeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function elapsedMs(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return Math.round((end - start) * 1000) / 1000;
}

function safeNonNegativeInteger(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,40}$/.test(value)) return value;
  return null;
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

function readUsage(value: string | null): {
  usage: RuntimeUsage | null;
  status: 'available' | 'partial' | 'not_metered' | 'unknown';
  missing: string[];
} {
  if (!value || value.length > 4096) return { usage: null, status: 'unknown', missing: ['usage_unavailable'] };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { usage: null, status: 'unknown', missing: ['usage_unavailable'] }; }
  const row = object(parsed);
  if (!row) return { usage: null, status: 'unknown', missing: ['usage_unavailable'] };
  if (row.unit === 'dispatched_call' || row.token_usage === 'not_metered') return { usage: null, status: 'not_metered', missing: [] };
  const usage: RuntimeUsage = {};
  for (const [source, target] of USAGE_FIELDS) {
    const amount = safeNonNegativeInteger(row[source]);
    if (amount !== null) usage[target] = amount;
  }
  if (!Object.keys(usage).length) return { usage: null, status: 'unknown', missing: ['usage_unavailable'] };
  const requiredUsage: UsageField[] = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens'];
  const missing = requiredUsage.filter(field => usage[field] === undefined).map(field => `usage_${field}_unavailable`);
  return { usage, status: missing.length ? 'partial' : 'available', missing };
}

function safeRouteName(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value) ? value : null;
}

function preparationProjection(events: EventRow[], missing: string[]): RuntimeRunDiagnostics['preparation'] {
  const rows: RuntimePreparationPhase[] = [];
  for (const event of events) {
    if (event.type !== 'runtime.preparation_timing') continue;
    const phase = event.preparation_phase;
    const duration = event.preparation_duration_ms;
    const outcome = event.preparation_outcome;
    if (typeof phase !== 'string' || !PREPARATION_PHASES.has(phase)
      || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 604_800_000
      || !['succeeded', 'failed', 'cancelled'].includes(String(outcome))) {
      missing.push('preparation_record_invalid');
      continue;
    }
    const rawOffset = event.preparation_offset_ms;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0
      ? Math.round(rawOffset * 1000) / 1000 : null;
    rows.push({ phase, duration_ms: Math.round(duration * 1000) / 1000, outcome: String(outcome), offset_ms: offset });
  }
  if (!rows.length) {
    missing.push('preparation_timing_unavailable');
    return { phases: [], total_ms: null, outcome: null as string | null };
  }
  const total = [...rows].reverse().find(row => row.phase === 'preparation_total');
  if (!total) missing.push('preparation_total_unavailable');
  return { phases: rows, total_ms: total?.duration_ms ?? null, outcome: total?.outcome ?? null };
}

/**
 * Read-only run/attempt diagnostics. The caller must authorize the run owner before
 * returning this projection. It deliberately omits prompt, answer, and raw error data.
 */
export function readRunRuntimeDiagnostics(db: DatabaseSync, runId: string): RuntimeRunDiagnostics | null {
  if (typeof runId !== 'string' || !runId.trim() || runId.length > 256) throw new Error('runtime_diagnostics_run_id_invalid');
  const run = db.prepare('SELECT id,conversation_id,status,created_at,updated_at FROM ga_runs WHERE id=?')
    .get(runId) as RunRow | undefined;
  if (!run) return null;

  const missing: string[] = [];
  const eventRows = db.prepare(`SELECT type,created_at,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.status') END AS run_status,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.attempt_id') END AS attempt_id,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.kind') END AS assistant_kind,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.phase') END AS preparation_phase,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.duration_ms') END AS preparation_duration_ms,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.outcome') END AS preparation_outcome,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.offset_ms') END AS preparation_offset_ms
    FROM ga_events
    WHERE run_id=? AND type IN ('run.state','assistant.delta','assistant.settled','runtime.preparation_timing')
    ORDER BY seq LIMIT ?`).all(runId, EVENT_LIMIT + 1) as EventRow[];
  const eventsTruncated = eventRows.length > EVENT_LIMIT;
  if (eventsTruncated) missing.push('event_limit_exceeded');
  const events = eventRows.slice(0, EVENT_LIMIT);

  const stateEvents = events.filter(event => event.type === 'run.state');
  const startingEvent = stateEvents.find(event => {
    return event.run_status === 'starting' || event.run_status === 'running';
  });
  const queueMs = startingEvent ? elapsedMs(safeTimestamp(run.created_at), safeTimestamp(startingEvent.created_at)) : null;
  if (queueMs === null) missing.push('queue_time_unavailable');

  const preparation = preparationProjection(events, missing);
  const attemptsTableExists = tableExists(db, 'wb_model_budget_attempts');
  const attempts = attemptsTableExists
    ? db.prepare(`SELECT attempt_id,route_json,state,usage_json,actual_nano_usd,reason,created_at
      FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id<>'queue-admission'
      ORDER BY created_at,attempt_id LIMIT ?`).all(runId, ATTEMPT_LIMIT + 1) as AttemptRow[]
    : [];
  const attemptsTruncated = attempts.length > ATTEMPT_LIMIT;
  if (attemptsTruncated) missing.push('attempt_limit_exceeded');

  const budgetEventsTableExists = tableExists(db, 'wb_model_budget_events');
  const budgetEvents = budgetEventsTableExists
    ? db.prepare(`SELECT attempt_id,state,created_at FROM wb_model_budget_events
      WHERE run_id=? AND attempt_id<>'queue-admission' ORDER BY created_at,rowid LIMIT ?`).all(runId, EVENT_LIMIT + 1) as BudgetEventRow[]
    : [];
  if (!budgetEventsTableExists) missing.push('budget_events_unavailable');
  if (budgetEvents.length > EVENT_LIMIT) missing.push('budget_event_limit_exceeded');

  const assistantByAttempt = new Map<string, { firstTextAt: number | null; settledAt: number | null }>();
  for (const event of events) {
    if (event.type !== 'assistant.delta' && event.type !== 'assistant.settled') continue;
    const attemptId = event.attempt_id;
    if (typeof attemptId !== 'string' || !attemptId || attemptId.length > 256) continue;
    const value = assistantByAttempt.get(attemptId) ?? { firstTextAt: null, settledAt: null };
    const at = safeTimestamp(event.created_at);
    if (event.type === 'assistant.delta' && event.assistant_kind === 'text' && value.firstTextAt === null) value.firstTextAt = at;
    if (event.type === 'assistant.settled' && at !== null) value.settledAt = Math.max(value.settledAt ?? at, at);
    assistantByAttempt.set(attemptId, value);
  }

  const budgetByAttempt = new Map<string, { dispatchedAt: number | null }>();
  for (const event of budgetEvents.slice(0, EVENT_LIMIT)) {
    const value = budgetByAttempt.get(event.attempt_id) ?? { dispatchedAt: null };
    const at = safeTimestamp(event.created_at);
    if (event.state === 'in_flight' && at !== null) value.dispatchedAt = value.dispatchedAt === null ? at : Math.min(value.dispatchedAt, at);
    budgetByAttempt.set(event.attempt_id, value);
  }

  const orderedAttempts = attempts.slice(0, ATTEMPT_LIMIT);
  const dispatched = orderedAttempts
    .filter(attempt => budgetByAttempt.get(attempt.attempt_id)?.dispatchedAt !== null && budgetByAttempt.get(attempt.attempt_id)?.dispatchedAt !== undefined)
    .sort((a, b) => budgetByAttempt.get(a.attempt_id)!.dispatchedAt! - budgetByAttempt.get(b.attempt_id)!.dispatchedAt!);
  const retryIndex = new Map(dispatched.map((attempt, index) => [attempt.attempt_id, index]));
  const projectedAttempts = orderedAttempts.map(attempt => {
    const localMissing: string[] = [];
    let route: JsonRecord | null = null;
    try { route = object(JSON.parse(attempt.route_json)); } catch {}
    const provider = safeRouteName(route?.provider);
    const model = safeRouteName(route?.model);
    const budget = budgetByAttempt.get(attempt.attempt_id) ?? { dispatchedAt: null };
    const assistant = assistantByAttempt.get(attempt.attempt_id) ?? { firstTextAt: null, settledAt: null };
    const ttftMs = elapsedMs(budget.dispatchedAt, assistant.firstTextAt);
    const generationMs = elapsedMs(budget.dispatchedAt, assistant.settledAt);
    if (budget.dispatchedAt === null) localMissing.push('attempt_dispatch_time_unavailable');
    if (ttftMs === null) localMissing.push('time_to_first_text_unavailable');
    if (generationMs === null) localMissing.push('generation_time_unavailable');
    const usageResult = readUsage(attempt.usage_json);
    localMissing.push(...usageResult.missing);
    const nanoUsd = safeNonNegativeInteger(attempt.actual_nano_usd);
    const cost = nanoUsd === null ? null : { nano_usd: nanoUsd, basis: 'configured_rates' as const };
    if (cost === null) localMissing.push('cost_unavailable');
    if (!provider || !model) localMissing.push('model_route_unavailable');
    const unconfirmedTerminalAttempt = attempt.state === 'in_flight'
      && ['interrupted', 'cancelled', 'failed', 'succeeded'].includes(run.status);
    const unknown = attempt.state === 'unknown' || unconfirmedTerminalAttempt;
    const reason = unknown ? safeCode(attempt.reason) ?? (attempt.reason ? 'unknown_reason_redacted' : null) : null;
    return {
      attempt_id: attempt.attempt_id,
      state: attempt.state,
      provider,
      model,
      retry_index: retryIndex.get(attempt.attempt_id) ?? null,
      ttft_ms: ttftMs,
      generation_ms: generationMs,
      usage: usageResult.usage,
      usage_status: usageResult.status,
      cost,
      unknown,
      unknown_reason: unconfirmedTerminalAttempt ? 'model_outcome_unconfirmed' : reason,
      manual_intervention_required: unknown,
      missing: localMissing,
    };
  });

  if (!orderedAttempts.length) missing.push('model_attempts_unavailable');
  return {
    schema_version: 1 as const,
    run_id: run.id,
    status: run.status,
    queue_ms: queueMs,
    runtime_readiness: readRecordedRuntimeReadiness(db,runId),
    preparation,
    attempts: projectedAttempts,
    retry_count: Math.max(0, dispatched.length - 1),
    manual_intervention_required: projectedAttempts.some(attempt => attempt.manual_intervention_required),
    partial: eventsTruncated || attemptsTruncated || budgetEvents.length > EVENT_LIMIT,
    missing: [...new Set(missing)],
  };
}
