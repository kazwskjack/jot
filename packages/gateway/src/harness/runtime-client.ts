const statuses = new Set([
  'accepted', 'running', 'succeeded', 'partial', 'rejected', 'failed', 'blocked',
  'cancelled', 'outcome_unknown', 'completion_ineligible', 'completion_eligible',
]);
const failureClasses = new Set([
  'goal_contract', 'authorization', 'validation', 'identity', 'upstream', 'rate_limit',
  'authentication', 'evidence', 'artifact', 'delivery', 'completion', 'internal',
]);
const transience = new Set(['deterministic', 'temporary', 'external_action_required', 'unknown']);

export class RuntimeProtocolError extends Error {
  constructor() { super('runtime_outcome_invalid'); }
}

export class RuntimeTransportError extends Error {
  readonly reason_code: string;
  readonly failure_class: 'rate_limit' | 'upstream';
  readonly transience = 'temporary' as const;
  readonly retry_after_ms?: number;
  constructor(reasonCode: string, failureClass: 'rate_limit' | 'upstream', retryAfterMs?: number) {
    super(reasonCode.toLowerCase());
    this.reason_code = reasonCode; this.failure_class = failureClass;
    if (retryAfterMs !== undefined) this.retry_after_ms = retryAfterMs;
  }
}

export interface HarnessLeafRequest {
  tool: string;
  arguments: Record<string, unknown>;
  execution: { call_id: string; session_ref: string };
}

export interface RuntimeOutcomeValue extends Record<string, unknown> {
  ok: boolean;
  status: string;
  reason_code: string | null;
  failure_class: string | null;
  transience: string;
  session_ref: string;
  run_id: string;
  call_id: string;
  goal_revision: number;
  runtime_revision: number;
  progress: { satisfied: number; total: number; missing_requirement_ids: string[] };
}

function validate(value: unknown): RuntimeOutcomeValue {
  if (!value || typeof value !== 'object') throw new RuntimeProtocolError();
  const row = value as Record<string, unknown>;
  if (typeof row.ok !== 'boolean' || !statuses.has(String(row.status))
    || !transience.has(String(row.transience)) || typeof row.session_ref !== 'string'
    || typeof row.run_id !== 'string' || typeof row.call_id !== 'string'
    || !Number.isInteger(row.goal_revision) || !Number.isInteger(row.runtime_revision)
    || !row.progress || typeof row.progress !== 'object') throw new RuntimeProtocolError();
  if (row.failure_class !== null && !failureClasses.has(String(row.failure_class))) throw new RuntimeProtocolError();
  return row as unknown as RuntimeOutcomeValue;
}

export class UniverseRuntimeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async invokeLeaf(request: HarnessLeafRequest, signal?: AbortSignal): Promise<RuntimeOutcomeValue> {
    const init: RequestInit = {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify(request),
    };
    if (signal) init.signal = signal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v2/harness/leaf`, init);
    } catch {
      throw new RuntimeTransportError('RUNTIME_TRANSPORT_UNAVAILABLE', 'upstream');
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, Math.round(seconds * 1000)) : undefined;
      throw new RuntimeTransportError('RUNTIME_RATE_LIMITED', 'rate_limit', delay);
    }
    if (response.status >= 500) throw new RuntimeTransportError('RUNTIME_TRANSPORT_UNAVAILABLE', 'upstream');
    if (!response.ok) throw new RuntimeProtocolError();
    return validate(await response.json());
  }
}
