import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { openProductDatabase } from './db/database.ts';
import { ConversationRepository } from './conversations/repository.ts';
import { ProjectRepository } from './projects/repository.ts';
import { EventStore, ExpiredCursorError, FutureCursorError } from './events/event-store.ts';
import { RunRepository } from './runs/repository.ts';
import { buildSnapshot } from './events/snapshot.ts';
import { EmotionAdvisor, taskEmotionEvent, userEmotionSignal } from './harness/emotion-advisor.ts';
import { RunCommandService } from './runs/commands.ts';
import { InteractionService } from './interactions/service.ts';
import { ArtifactService } from './artifacts/service.ts';
import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { SourceRepository } from './sources/repository.ts';
import { ContractValidator } from './contracts/validator.ts';
import { ChannelIntakeService } from './channels/intake.ts';
import { FileJobService } from './file-engine/jobs.ts';
import { TemplateCatalog, TemplateContractError } from './file-engine/templates.ts';
import { CrawlBatchService } from './crawl-batch/service.ts';
import { ChannelDeliveryService } from './channels/delivery.ts';
import { VoiceTranscriptionService } from './voice/service.ts';
import type { VoiceAdapter } from './voice/adapter-client.ts';
import { VOICE_MAX_BYTES, validateVoiceWave } from './voice/wav.ts';

function actor(request: { headers: Record<string, unknown> }) {
  const id = String(request.headers['x-user-id'] || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('unauthorized');
  return id;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
  }
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString('base64'));
  return JSON.stringify(value) ?? 'null';
}

export async function buildServer(config: {
  databasePath: string;
  workspaces: string[];
  uploadRoot?: string;
  csrfToken?: string;
  allowedOrigins?: string[];
  internalChannelToken?: string;
  templateRoot?: string;
  voiceEnabled?: boolean;
  voiceAdapter?: VoiceAdapter;
}) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: VOICE_MAX_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 256 } });
  const db = openProductDatabase(config.databasePath);
  const events = new EventStore(db);
  const projects = new ProjectRepository(db);
  const conversations = new ConversationRepository(db, projects);
  const runs = new RunRepository(db, events);
  const commands = new RunCommandService(db, events);
  const interactions = new InteractionService(db, events);
  const artifacts = new ArtifactService(db, config.uploadRoot ?? join(dirname(config.databasePath), 'general-agent-uploads'));
  const sources = new SourceRepository(db);
  const contracts = new ContractValidator();
  const channelIntake = new ChannelIntakeService(db, runs, config.workspaces[0] ?? 'jot');
  const fileJobs = new FileJobService(db);
  const templates = new TemplateCatalog(config.templateRoot ?? resolve(process.cwd(), 'file-engine/templates'));
  const channelDelivery = new ChannelDeliveryService(db);
  const crawlBatches = new CrawlBatchService(db, events, channelDelivery);
  const voiceTranscriptions = new VoiceTranscriptionService(db,
    config.voiceEnabled ? config.voiceAdapter : undefined);
  const idempotencyRequests = new WeakMap<object, { owner: string; operation: string; key: string }>();
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));

  app.addHook('preValidation', async request => {
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0];
    if (contentType === 'application/octet-stream' || contentType === 'multipart/form-data') return;
    const operationId = contracts.operationFor(request.method, request.routeOptions.url ?? request.url.split('?')[0]!);
    if (!operationId) return;
    const result = contracts.validateRequest(operationId, request.body);
    if (!result.valid) throw new Error('contract_request_invalid');
  });

  app.addHook('preHandler', async (request, reply) => {
    if (['/internal/v1/channel/messages', '/internal/v1/file-tools', '/internal/v1/crawl-batches/bind', '/internal/v1/crawl-batches/events'].includes(request.url.split('?')[0]!)) return;
    if (!config.csrfToken || request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    actor(request as any);
    const origin = String(request.headers.origin ?? '');
    if (!(config.allowedOrigins ?? []).includes(origin)) throw new Error('origin_forbidden');
    const csrf = String(request.headers['x-csrf-token'] ?? '');
    if (config.csrfToken.length < 16 || csrf !== config.csrfToken) throw new Error('csrf_invalid');
    if ((request.routeOptions.url ?? request.url).includes('/voice/transcriptions')) return;
    const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
    if (!/^[\x21-\x7E]{8,128}$/.test(idempotencyKey)) throw new Error('idempotency_key_invalid');
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
      'SELECT request_sha256,response_status,response_json FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?',
    ).get(owner, operation, idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.request_sha256 !== requestHash) throw new Error('idempotency_conflict');
      if (existing.response_status === null) throw new Error('idempotency_in_progress');
      const responseBody = existing.response_json === null ? null : JSON.parse(String(existing.response_json));
      return reply.code(Number(existing.response_status)).send(responseBody);
    }
    const now = Date.now();
    db.prepare(
      'INSERT INTO ga_idempotency(owner_id,operation,idempotency_key,request_sha256,response_status,response_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(owner, operation, idempotencyKey, requestHash, null, null, new Date(now).toISOString(), new Date(now + 86_400_000).toISOString());
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
    db.prepare(
      'UPDATE ga_idempotency SET response_status=?,response_json=? WHERE owner_id=? AND operation=? AND idempotency_key=?',
    ).run(reply.statusCode, JSON.stringify(responseValue), pending.owner, pending.operation, pending.key);
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof Error ? error.message : 'internal_error';
    if (Number((error as { statusCode?: number }).statusCode) === 413) {
      return reply.code(413).send({ error: { code: 'VOICE_AUDIO_TOO_LARGE' } });
    }
    if (error instanceof TemplateContractError) {
      return reply.code(422).send({ error: { code, details: error.details } });
    }
    if (code.endsWith('_not_found')) return reply.code(404).send({ error: { code: code.toUpperCase() } });
    if (['version_conflict', 'active_run_model_change', 'run_state_conflict', 'run_version_conflict', 'checkpoint_invalid', 'reconciliation_required', 'interaction_kind_conflict', 'interaction_state_conflict', 'interaction_version_conflict', 'interaction_expired', 'action_digest_mismatch', 'idempotency_conflict', 'idempotency_in_progress', 'voice_idempotency_conflict', 'STALE_FILE_VERSION', 'IDEMPOTENCY_CONFLICT', 'crawl_batch_owner_mismatch'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (['interaction_answer_invalid', 'interaction_decision_invalid', 'upload_size_invalid', 'upload_sha256_invalid', 'upload_filename_invalid', 'upload_size_mismatch', 'upload_sha256_mismatch', 'artifact_diff_unsupported', 'source_evidence_required', 'source_url_invalid', 'invalid_project_title', 'invalid_conversation_state', 'FILE_REQUEST_INVALID', 'TEMPLATE_CONTENT_INVALID', 'UNSUPPORTED_FORMAT_OPERATION', 'requested_count_invalid', 'event_seq_invalid', 'input_index_invalid', 'item_id_invalid', 'owner_id_invalid', 'run_id_invalid', 'batch_id_invalid', 'conversation_id_invalid', 'crawl_url_invalid'].includes(code)) return reply.code(422).send({ error: { code: code.toUpperCase() } });
    if (['upload_state_conflict'].includes(code)) return reply.code(409).send({ error: { code: code.toUpperCase() } });
    if (code === 'origin_forbidden' || code === 'csrf_invalid') return reply.code(403).send({ error: { code: code.toUpperCase() } });
    if (code === 'idempotency_key_invalid') return reply.code(400).send({ error: { code: 'IDEMPOTENCY_KEY_INVALID' } });
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
    const binding = db.prepare(`SELECT conversation_id,owner_id FROM ga_harness_session_bindings WHERE session_id=?`)
      .get(String(body.session_ref || '')) as { conversation_id?: string; owner_id?: string } | undefined;
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

  app.get('/v1/capabilities', async (request, reply) => {
    const ownerId = actor(request as any);
    const voice = await voiceTranscriptions.capability();
    if (config.csrfToken && request.headers['sec-fetch-site'] !== 'cross-site') {
      reply.header('x-csrf-token', config.csrfToken).header('cache-control', 'no-store');
    }
    return {
      api_version: '1.0', event_schema_version: '1.0', adapter_version: '0.1.0',
      capabilities: { search: true, fetch: true, browser_interaction: false, file_read: true,
        file_edit: true, command_execution: true, questions: true, approvals: true,
        artifact_download: true, resume_checkpoint: true },
      models: [], limits: { max_upload_bytes: 104857600, max_active_runs_per_conversation: 1,
        max_concurrent_sessions: 5,
        replay_retention_hours: 168, idempotency_retention_hours: 24 },
      voice,
      workspaces: config.workspaces.map(workspace_id => ({ workspace_id, title: workspace_id, can_read: true, can_write: true, owner_id: ownerId }))
        .map(({ owner_id: _ignored, ...workspace }) => workspace),
    };
  });
  app.get('/v1/projects', async request => projects.list(actor(request as any)));
  app.post('/v1/projects', async (request, reply) =>
    reply.code(201).send(projects.create(actor(request as any), request.body as Record<string, unknown>)));
  app.patch('/v1/projects/:projectId', async request =>
    projects.update((request.params as { projectId: string }).projectId, actor(request as any), request.body as Record<string, unknown>));

  app.get('/v1/conversations', async request => {
    const query = request.query as { limit?: string; project_id?: string; state?: string };
    const options: { limit: number; project_id?: string; state?: string } = { limit: Number(query.limit ?? 50) };
    if (query.project_id !== undefined) options.project_id = query.project_id;
    if (query.state !== undefined) options.state = query.state;
    return conversations.list(actor(request as any), options);
  });

  app.post('/v1/conversations', async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    if (!config.workspaces.includes(String(input.workspace_id))) return reply.code(403).send({ error: { code: 'WORKSPACE_FORBIDDEN' } });
    return reply.code(201).send(conversations.create(actor(request as any), input));
  });
  app.get('/v1/conversations/:conversationId', async request =>
    conversations.get((request.params as { conversationId: string }).conversationId, actor(request as any)));
  app.patch('/v1/conversations/:conversationId', async request =>
    conversations.update((request.params as { conversationId: string }).conversationId, actor(request as any), request.body as Record<string, unknown>));
  app.get('/v1/conversations/:conversationId/messages', async request => {
    const query = request.query as { limit?: string };
    return conversations.messages((request.params as { conversationId: string }).conversationId,
      actor(request as any), Number(query.limit ?? 50));
  });
  app.post('/v1/conversations/:conversationId/messages', async (request, reply) => {
    const id = (request.params as { conversationId: string }).conversationId;
    return reply.code(202).send(runs.enqueue(id, actor(request as any), request.body as Record<string, unknown>));
  });
  app.get('/v1/runs/:runId', async request => runs.get((request.params as { runId: string }).runId, actor(request as any)));
  app.post('/v1/runs/:runId/steer', async (request, reply) => reply.code(202).send(commands.steer(
    (request.params as { runId: string }).runId, actor(request as any), request.body as Record<string, unknown>,
    String(request.headers['idempotency-key'] || ''),
  )));
  app.post('/v1/runs/:runId/cancel', async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const ownerId = actor(request as any);
    const input = request.body as Record<string, unknown>;
    const receipt = commands.cancel(runId, ownerId, input, String(request.headers['idempotency-key'] || ''));
    // The run command remains authoritative for the product run. Batch cancel
    // is a durable side effect for C and may settle later.
    try { crawlBatches.cancel(ownerId, runId, String(input.reason ?? 'USER_CANCELLED')); } catch { /* no active batch is valid */ }
    return reply.code(202).send(receipt);
  });
  app.post('/v1/runs/:runId/resume', async (request, reply) => reply.code(202).send(commands.resume(
    (request.params as { runId: string }).runId, actor(request as any), request.body as Record<string, unknown>,
    String(request.headers['idempotency-key'] || ''),
  )));
  app.get('/v1/runs/:runId/artifacts', async request =>
    artifacts.listForRun((request.params as { runId: string }).runId, actor(request as any)));
  const emotionAdvisor = new EmotionAdvisor();
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
    const userMessage=run?snapshot.messages.filter((m:any)=>m.run_id===run.run_id&&m.role==='user').at(-1) as any:undefined;
    const userText=(userMessage?.blocks??[]).map((b:any)=>typeof b.text==='string'?b.text:'').join(' ');
    const signal=userEmotionSignal(userText);
    const suggestion=await emotionAdvisor.select(owner+'|'+cid+'|'+(run?.run_id??''),event,signal,userText,interaction);
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
  app.post('/v1/interactions/:interactionId/decision', async (request, reply) => reply.code(202).send(interactions.decide(
    (request.params as { interactionId: string }).interactionId, actor(request as any), request.body as Record<string, unknown>,
    String(request.headers['idempotency-key'] || ''),
  )));
  app.post('/v1/conversations/:conversationId/uploads', async (request, reply) => reply.code(201).send(artifacts.initUpload(
    (request.params as { conversationId: string }).conversationId, actor(request as any), request.body as Record<string, unknown>,
  )));
  app.put('/v1/uploads/:uploadId/content', { bodyLimit: 104857600 }, async (request, reply) => {
    await artifacts.writeContent((request.params as { uploadId: string }).uploadId, actor(request as any), request.body as AsyncIterable<Uint8Array>);
    return reply.code(204).send();
  });
  app.post('/v1/uploads/:uploadId/complete', async (request, reply) => reply.code(201).send(artifacts.complete(
    (request.params as { uploadId: string }).uploadId, actor(request as any), request.body as Record<string, unknown>,
  )));
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
      .header('content-disposition', `attachment; filename="${asciiName}"`).send(createReadStream(String(row.server_path)));
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
    voiceTranscriptions };
}
