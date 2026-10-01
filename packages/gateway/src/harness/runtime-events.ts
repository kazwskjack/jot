import { createHmac } from 'node:crypto';

export interface RuntimeEventPage {
  ok: true;
  run_id: string;
  head_revision: number;
  events: Array<Record<string, unknown> & { revision: number; status: string }>;
}

export interface RuntimeContextInput {
  taskRequestId: string;
  conversationId: string;
  messageId: string;
  sessionRef: string;
  controllerSessionRef?: string;
  message: string;
  receivedAt: number;
}

export interface RuntimeBinding {
  ok: true;
  session_ref: string;
  client_run_id: string;
  runtime_run_id: string;
  runtime_owner: string;
  fence_epoch: number;
}

export interface CompletionSnapshot {
  ok: boolean;
  session_ref: string | null;
  run_id: string | null;
  runtime_revision: number;
  goal_revision: number;
  status: string;
  reason_code: string | null;
  progress: { satisfied: number; total: number; missing_requirement_ids: string[] };
}

export interface DeliveryRequest {
  request_id: string; run_id: string; client_run_id: string; requirement_id: string;
  artifact_ref: string; recipient_ref: string; status: string; created_at: string;
}

export interface ArtifactRequest {
  request_id: string; run_id: string; client_run_id: string; requirement_id: string;
  result_refs: string[]; source_results: Array<Record<string, unknown>>;
  format: string; template: string; status: string; artifact_ref: string | null;
  created_at: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export class RuntimeEventClient {
  private readonly baseUrl: string;
  private readonly secret: Buffer;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, secret: Uint8Array, fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.secret = Buffer.from(secret);
    while (this.secret.length && (this.secret.at(-1) === 0x0a || this.secret.at(-1) === 0x0d)) {
      this.secret = this.secret.subarray(0, -1);
    }
    this.fetchImpl = fetchImpl;
    if (this.secret.length < 16) throw new Error('runtime_event_secret_invalid');
  }

  async events(runId: string, afterRevision: number, limit = 100): Promise<RuntimeEventPage> {
    if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error('runtime_run_id_invalid');
    if (!Number.isInteger(afterRevision) || afterRevision < 0) throw new Error('after_revision_invalid');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit_invalid');
    const path = `/v2/runs/${runId}/events`;
    const payload = `{"after_revision":${afterRevision},"limit":${limit}}`;
    const signature = createHmac('sha256', this.secret).update(`${path}\n${payload}`, 'utf8').digest('hex');
    const response = await this.fetchImpl(`${this.baseUrl}${path}?after_revision=${afterRevision}&limit=${limit}`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `HMAC-SHA256 ${signature}` },
    });
    if (!response.ok) throw new Error(`runtime_events_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || value.run_id !== runId || !Number.isInteger(value.head_revision) || !Array.isArray(value.events)) {
      throw new Error('runtime_event_page_invalid');
    }
    let previous = afterRevision;
    for (const event of value.events as Array<Record<string, unknown>>) {
      if (!Number.isInteger(event.revision) || Number(event.revision) <= previous || typeof event.status !== 'string') {
        throw new Error('runtime_event_page_invalid');
      }
      previous = Number(event.revision);
    }
    return value as unknown as RuntimeEventPage;
  }

  private async signedGet(path: string, payload: string, query = ''): Promise<Response> {
    const signature = createHmac('sha256', this.secret).update(`${path}\n${payload}`, 'utf8').digest('hex');
    return await this.fetchImpl(`${this.baseUrl}${path}${query}`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `HMAC-SHA256 ${signature}` },
    });
  }

  async registerAnswer(runtimeRunId: string, expectedClientRunId: string, text: string,
    minimumKeyPoints = 0): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{32}$/.test(runtimeRunId)) throw new Error('runtime_run_id_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(expectedClientRunId)) throw new Error('runtime_client_run_id_invalid');
    if (!text.trim()) throw new Error('runtime_answer_text_invalid');
    const path = `/v2/harness/runs/${runtimeRunId}/answer`;
    const body = { expected_client_run_id: expectedClientRunId, text,
      minimum_key_points: minimumKeyPoints };
    const payload = canonicalJson(body);
    const signature = createHmac('sha256', this.secret).update(`${path}\n${payload}`, 'utf8').digest('hex');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}` }, body: payload,
    });
    if (!response.ok) throw new Error(`runtime_answer_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.ok !== 'boolean' || typeof value.status !== 'string') {
      throw new Error('runtime_answer_response_invalid');
    }
    return value;
  }

  async registerDeliveryReceipt(runtimeRunId: string, expectedClientRunId: string,
    receiptRef: string, recipientRef: string, status: 'accepted' | 'delivered'):
    Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{32}$/.test(runtimeRunId)) throw new Error('runtime_run_id_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(expectedClientRunId)) {
      throw new Error('runtime_client_run_id_invalid');
    }
    if (!receiptRef.trim() || !['accepted', 'delivered'].includes(status)) {
      throw new Error('runtime_delivery_receipt_invalid');
    }
    const path = `/v2/harness/runs/${runtimeRunId}/delivery-receipt`;
    const body = { expected_client_run_id: expectedClientRunId, receipt_ref: receiptRef,
      recipient_ref: recipientRef, status };
    const payload = canonicalJson(body);
    const signature = createHmac('sha256', this.secret).update(`${path}\n${payload}`, 'utf8').digest('hex');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}` }, body: payload,
    });
    if (!response.ok) throw new Error(`runtime_delivery_receipt_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.ok !== 'boolean' || typeof value.status !== 'string') {
      throw new Error('runtime_delivery_receipt_response_invalid');
    }
    return value;
  }

  async deliveryRequests(runtimeRunId: string, expectedClientRunId: string): Promise<DeliveryRequest[]> {
    if (!/^[0-9a-f]{32}$/.test(runtimeRunId)) throw new Error('runtime_run_id_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(expectedClientRunId)) {
      throw new Error('runtime_client_run_id_invalid');
    }
    const path = `/v2/harness/runs/${runtimeRunId}/delivery-requests`;
    const payload = canonicalJson({ expected_client_run_id: expectedClientRunId });
    const response = await this.signedGet(path, payload,
      `?expected_client_run_id=${encodeURIComponent(expectedClientRunId)}`);
    if (!response.ok) throw new Error(`runtime_delivery_requests_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || value.run_id !== runtimeRunId || !Array.isArray(value.requests)) {
      throw new Error('runtime_delivery_requests_invalid');
    }
    for (const item of value.requests as Array<Record<string, unknown>>) {
      if (typeof item.request_id !== 'string' || item.run_id !== runtimeRunId
        || item.client_run_id !== expectedClientRunId || typeof item.artifact_ref !== 'string'
        || typeof item.recipient_ref !== 'string' || item.status !== 'requested') {
        throw new Error('runtime_delivery_requests_invalid');
      }
    }
    return value.requests as DeliveryRequest[];
  }

  async artifactRequests(runtimeRunId: string, expectedClientRunId: string): Promise<ArtifactRequest[]> {
    if (!/^[0-9a-f]{32}$/.test(runtimeRunId)) throw new Error('runtime_run_id_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(expectedClientRunId)) {
      throw new Error('runtime_client_run_id_invalid');
    }
    const path = `/v2/harness/runs/${runtimeRunId}/artifact-requests`;
    const payload = canonicalJson({ expected_client_run_id: expectedClientRunId });
    const response = await this.signedGet(path, payload,
      `?expected_client_run_id=${encodeURIComponent(expectedClientRunId)}`);
    if (!response.ok) throw new Error(`runtime_artifact_requests_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || value.run_id !== runtimeRunId || !Array.isArray(value.requests)) {
      throw new Error('runtime_artifact_requests_invalid');
    }
    for (const item of value.requests as Array<Record<string, unknown>>) {
      if (typeof item.request_id !== 'string' || item.run_id !== runtimeRunId
        || item.client_run_id !== expectedClientRunId || typeof item.requirement_id !== 'string'
        || !Array.isArray(item.result_refs) || !Array.isArray(item.source_results)
        || !['docx', 'md', 'pdf'].includes(String(item.format))
        || typeof item.template !== 'string' || !['requested', 'verified'].includes(String(item.status))) {
        throw new Error('runtime_artifact_requests_invalid');
      }
    }
    return value.requests as ArtifactRequest[];
  }

  async registerArtifactReceipt(runtimeRunId: string, expectedClientRunId: string,
    receipt: { request_id: string; artifact_ref: string; size_bytes: number;
      sha256: string; render_status: 'passed' | 'verified' }): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{32}$/.test(runtimeRunId)) throw new Error('runtime_run_id_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(expectedClientRunId)) {
      throw new Error('runtime_client_run_id_invalid');
    }
    if (!/^artifact-request:[0-9a-z._:-]{1,128}$/i.test(receipt.request_id)
      || !receipt.artifact_ref.trim() || !Number.isInteger(receipt.size_bytes)
      || receipt.size_bytes < 1 || !/^[0-9a-f]{64}$/.test(receipt.sha256)
      || !['passed', 'verified'].includes(receipt.render_status)) {
      throw new Error('runtime_artifact_receipt_invalid');
    }
    const path = `/v2/harness/runs/${runtimeRunId}/artifact-receipt`;
    const body = { expected_client_run_id: expectedClientRunId, ...receipt };
    const payload = canonicalJson(body);
    const signature = createHmac('sha256', this.secret).update(`${path}\n${payload}`, 'utf8').digest('hex');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${signature}` }, body: payload,
    });
    if (!response.ok) throw new Error(`runtime_artifact_receipt_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || value.status !== 'artifact_verified'
      || value.artifact_ref !== receipt.artifact_ref) {
      throw new Error('runtime_artifact_receipt_response_invalid');
    }
    return value;
  }

  async binding(sessionRef: string, expectedClientRunId: string): Promise<RuntimeBinding> {
    const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if (!identity.test(sessionRef)) throw new Error('runtime_session_ref_invalid');
    if (!identity.test(expectedClientRunId)) throw new Error('runtime_client_run_id_invalid');
    const path = `/v2/harness/sessions/${encodeURIComponent(sessionRef)}/binding`;
    const payload = canonicalJson({ expected_client_run_id: expectedClientRunId });
    const response = await this.signedGet(
      path, payload, `?expected_client_run_id=${encodeURIComponent(expectedClientRunId)}`
    );
    if (!response.ok) throw new Error(`runtime_binding_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || value.session_ref !== sessionRef
      || value.client_run_id !== expectedClientRunId
      || typeof value.runtime_run_id !== 'string' || !/^[0-9a-f]{32}$/.test(value.runtime_run_id)
      || typeof value.runtime_owner !== 'string' || !Number.isInteger(value.fence_epoch)) {
      throw new Error('runtime_binding_invalid');
    }
    return value as unknown as RuntimeBinding;
  }

  async completion(runtimeRunId: string): Promise<CompletionSnapshot> {
    if (!/^[0-9a-f]{32}$/.test(runtimeRunId)) throw new Error('runtime_run_id_invalid');
    const path = `/v2/harness/runs/${runtimeRunId}/completion`;
    const response = await this.signedGet(path, '{}');
    if (!response.ok) throw new Error(`runtime_completion_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    const progress = value.progress as Record<string, unknown> | undefined;
    const validStatus = new Set(['accepted', 'running', 'succeeded', 'partial', 'rejected',
      'failed', 'blocked', 'cancelled', 'outcome_unknown', 'completion_ineligible',
      'completion_eligible']);
    if (typeof value.ok !== 'boolean' || !validStatus.has(String(value.status))
      || (value.run_id !== null && value.run_id !== runtimeRunId)
      || (value.session_ref !== null && typeof value.session_ref !== 'string')
      || !Number.isInteger(value.runtime_revision) || Number(value.runtime_revision) < 0
      || !Number.isInteger(value.goal_revision) || Number(value.goal_revision) < 0
      || (value.reason_code !== null && typeof value.reason_code !== 'string')
      || !progress || !Number.isInteger(progress.satisfied) || !Number.isInteger(progress.total)
      || !Array.isArray(progress.missing_requirement_ids)) {
      throw new Error('runtime_completion_snapshot_invalid');
    }
    return value as unknown as CompletionSnapshot;
  }

  async bindContext(input: RuntimeContextInput): Promise<Record<string, unknown>> {
    const envelope = this.contextIntakeEnvelope(input);
    const response = await this.fetchImpl(`${this.baseUrl}${envelope.path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: envelope.authorization },
      body: envelope.payload,
    });
    if (!response.ok) throw new Error(`runtime_intake_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.enabled === true && value.ok === false && value.error === 'IDEMPOTENCY_CONFLICT') {
      const existing = await this.binding(input.sessionRef, input.taskRequestId);
      return { enabled: true, ingress_state: 'HARNESS_ENQUEUED', durable: true,
        recovered_from_binding: true, runtime_run_id: existing.runtime_run_id };
    }
    if (value.enabled !== true || value.ingress_state !== 'HARNESS_ENQUEUED' || value.durable !== true) {
      throw new Error('runtime_intake_receipt_invalid');
    }
    return value;
  }

  async stageContext(input: RuntimeContextInput, bridgeBaseUrl: string): Promise<Record<string, unknown>> {
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(bridgeBaseUrl)) {
      throw new Error('runtime_context_bridge_invalid');
    }
    const intake = this.contextIntakeEnvelope(input);
    const payload = canonicalJson({ controller_session_ref: input.controllerSessionRef ?? input.sessionRef,
      session_ref: input.sessionRef, client_run_id: input.taskRequestId,
      intake });
    const response = await this.fetchImpl(`${bridgeBaseUrl}/v2/harness/context`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: payload,
    });
    if (!response.ok) throw new Error(`runtime_context_stage_http_${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.ok !== true || value.staged !== true) throw new Error('runtime_context_stage_invalid');
    return value;
  }

  private contextIntakeEnvelope(input: RuntimeContextInput): {
    path: string; payload: string; authorization: string;
  } {
    const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if (![input.taskRequestId, input.conversationId, input.messageId, input.sessionRef].every(value => identity.test(value))) {
      throw new Error('runtime_intake_identity_invalid');
    }
    const message = String(input.message ?? '');
    if (!message.trim()) throw new Error('runtime_intake_message_invalid');
    const path = '/v2/harness/intake';
    const body = {
      request_id: input.taskRequestId,
      message_id: input.messageId,
      idempotency_key: `ga-${input.taskRequestId}`,
      principal: 'general-agent-web',
      tenant: 'jot',
      session_ref: input.sessionRef,
      raw_messages: [{ role: 'user', content: message }],
      attachment_refs: [],
      received_at: Number.isInteger(input.receivedAt) && input.receivedAt > 0
        ? input.receivedAt : (() => { throw new Error('runtime_intake_received_at_invalid'); })(),
      timezone: 'Asia/Hong_Kong',
      context_revision: 0,
    };
    const payload = canonicalJson(body);
    const signature = createHmac('sha256', this.secret).update(`${path}\n${payload}`, 'utf8').digest('hex');
    return { path, payload, authorization: `HMAC-SHA256 ${signature}` };
  }
}
