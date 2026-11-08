import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactService } from '../artifacts/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import { requireFileDeliveryContext, requireTextDeliveryContext, type FileDeliveryEffectContext, type DeliveryEffectContext } from './delivery-effect-context.ts';
import { slackFiles, slackFileIdentity, downloadSlackFiles, type SlackDownloadedFile } from './slack-attachments.ts';
import {decodeSlackArtifactRef,MAX_SLACK_ARTIFACT_BYTES} from './slack-artifact-ref.ts';

const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_OUTBOUND_FILE_BYTES = MAX_SLACK_ARTIFACT_BYTES;
const SLACK_API_BASE = 'https://slack.com/api/';
const SLACK_UPLOAD_HOST = 'files.slack.com';

export type SlackWebhookHeaders = Headers | Record<string, string | undefined>;

export interface SlackChannelIntake {
  accept(input: Record<string, unknown>, options: { providerSignatureVerified: boolean }): unknown;
  acceptSlackAttachmentsV2?(input: Record<string, unknown>, options: { providerSignatureVerified: true },
    materialize: (scope: { ownerId: string }) => Promise<ReadonlyArray<SlackDownloadedFile>>,
    artifacts: ArtifactService): Promise<unknown>;
}

export interface SlackWebhookConfig {
  signingSecret: string;
  teamId: string;
  intake: SlackChannelIntake;
  appId?: string;
  botUserId?: string;
  attachmentBotToken?: string;
  artifacts?: ArtifactService;
  transport?: SlackTransport;
  handleInteractionReply?(input:{teamId:string;channelId:string;principal:string;providerThreadId:string;eventId:string;text:string}):unknown;
}

export interface SlackWebhookRequest {
  headers: SlackWebhookHeaders;
  body: Uint8Array;
}

export interface SlackWebhookResponse {
  status: number;
  body: Record<string, unknown>;
  intake_result?: unknown;
  ignored?: true;
}

export type SlackTransport = (url: URL, init: RequestInit) => Promise<Response>;

interface SlackReplyContext {
  recipient: string;
  teamId: string;
  channelId: string;
  threadTs: string;
}

/**
 * Verify Slack's v0 HMAC against the exact raw request bytes and a five-minute timestamp window.
 */
export function verifySlackWebhookSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  body: Uint8Array;
  nowMs?: number;
}): boolean {
  if (typeof input.secret !== 'string' || !input.secret || Buffer.byteLength(input.secret, 'utf8') > 4096
    || /[\r\n]/.test(input.secret) || typeof input.timestamp !== 'string'
    || !/^\d{1,12}$/.test(input.timestamp) || typeof input.signature !== 'string'
    || !/^v0=[a-fA-F0-9]{64}$/.test(input.signature) || !(input.body instanceof Uint8Array)
    || input.body.byteLength < 1 || input.body.byteLength > MAX_CALLBACK_BYTES) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  const timestampMs = Number(input.timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_SECONDS * 1000) {
    return false;
  }
  try {
    const expected = createHmac('sha256', input.secret)
      .update('v0:' + input.timestamp + ':')
      .update(Buffer.from(input.body))
      .digest();
    const actual = Buffer.from(input.signature.slice(3), 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Process signed Slack Events API callbacks using the existing Jot intake contract.
 * This module owns no identity, conversation, event, or outbox tables.
 */
export function createSlackWebhookAdapter(config: SlackWebhookConfig) {
  if (!config || typeof config.signingSecret !== 'string' || !config.signingSecret
    || Buffer.byteLength(config.signingSecret, 'utf8') > 4096 || /[\r\n]/.test(config.signingSecret)
    || !config.intake || typeof config.intake.accept !== 'function'
    || !slackId(config.teamId)
    || (config.appId !== undefined && !slackId(config.appId))
    || (config.botUserId !== undefined && !slackId(config.botUserId))
    || (config.handleInteractionReply !== undefined && config.botUserId === undefined)) {
    throw new Error('slack_config_invalid');
  }

  return {
    async handle(request: SlackWebhookRequest): Promise<SlackWebhookResponse> {
      if (!request || !(request.body instanceof Uint8Array) || request.body.byteLength < 1
        || request.body.byteLength > MAX_CALLBACK_BYTES) throw new Error('slack_callback_body_invalid');
      const timestamp = header(request.headers, 'x-slack-request-timestamp');
      const signature = header(request.headers, 'x-slack-signature');
      if (!verifySlackWebhookSignature({ secret: config.signingSecret, timestamp, signature, body: request.body })) {
        throw new Error('slack_signature_invalid');
      }
      const payload = parsePayload(request.body);
      if (payload.type === 'url_verification') {
        if (typeof payload.challenge !== 'string' || !payload.challenge || payload.challenge.length > 512
          || /[\u0000-\u001f\u007f]/.test(payload.challenge)) throw new Error('slack_challenge_invalid');
        return { status: 200, body: { challenge: payload.challenge } };
      }
      if (payload.type !== 'event_callback') throw new Error('slack_callback_type_invalid');

      const teamId = checkedSlackId(payload.team_id, 'slack_team_id_invalid');
      if (teamId !== config.teamId) throw new Error('slack_workspace_mismatch');
      if (config.appId !== undefined && payload.api_app_id !== config.appId) {
        throw new Error('slack_app_id_invalid');
      }
      const eventId = checkedEventId(payload.event_id);
      const event = object(payload.event);
      if (!event) throw new Error('slack_event_invalid');
      if (event.type !== 'message') return { status: 200, body: { ok: true }, ignored: true };
      if ((event.subtype !== undefined && event.subtype !== 'file_share') || event.bot_id !== undefined
        || (config.botUserId !== undefined && event.user === config.botUserId)) {
        return { status: 200, body: { ok: true }, ignored: true };
      }

      const channelId = checkedSlackId(event.channel, 'slack_channel_id_invalid');
      const userId = checkedSlackId(event.user, 'slack_user_id_invalid');
      const messageTs = checkedSlackTimestamp(event.ts, 'slack_message_timestamp_invalid');
      const threadTs = event.thread_ts === undefined ? messageTs
        : checkedSlackTimestamp(event.thread_ts, 'slack_thread_timestamp_invalid');
      const text = typeof event.text === 'string' ? event.text.trim() : '';
      const files = slackFiles(event.files, userId);
      if ((!text && !files.length) || text.length > 4000) return { status: 200, body: { ok: true }, ignored: true };
      const mention = config.botUserId ? `<@${config.botUserId}>` : '';
      const interactionText = mention && text.startsWith(mention) && /\s/.test(text[mention.length] ?? '')
        ? text.slice(mention.length).trimStart() : '';
      if(/^\/(?:approve|deny|answer)(?:\s|$)/.test(interactionText)){
        if(files.length||!config.handleInteractionReply)throw new Error('slack_interaction_reply_unavailable');
        const principal='slack:'+teamId+':'+userId;
        const providerThreadId=channelId+':'+threadTs;
        return {status:200,body:{ok:true},intake_result:config.handleInteractionReply({teamId,channelId,principal,
          providerThreadId,eventId,text:interactionText})};
      }

      const normalized = {
        channel: 'slack',
        principal: 'slack:' + teamId + ':' + userId,
        thread_id: /^\/jot-bind [A-Za-z0-9_-]{43}$/.test(text) ? '' : channelId + ':' + threadTs,
        message_id: eventId,
        text,
        ...(files.length ? { attachments: files.map(f => ({ provider_file_id: slackFileIdentity(f),
          file_name: f.name, media_type: f.mimetype, size_bytes: f.size })) } : {}),
      };
      let intakeResult: unknown;
      if (files.length) {
        if (!config.attachmentBotToken || !config.artifacts || !config.intake.acceptSlackAttachmentsV2) throw Error('slack_attachment_intake_unavailable');
        intakeResult = await config.intake.acceptSlackAttachmentsV2(normalized, { providerSignatureVerified: true }, () =>
          downloadSlackFiles({ files, teamId, botToken: config.attachmentBotToken!,
            ...(config.transport ? { transport: config.transport } : {}) }), config.artifacts);
      } else intakeResult = config.intake.accept(normalized, { providerSignatureVerified: true });
      return { status: 200, body: { ok: true }, intake_result: intakeResult };
    },
  };
}

/**
 * Send replies through chat.postMessage only when an existing intake event and outbox row
 * supply the authenticated workspace, channel, and parent thread.
 */
export function createSlackDeliveryProvider(
  config: { botToken: string; teamId: string; timeoutMs?: number },
  db: DatabaseSync,
  transport: SlackTransport = fetch,
) {
  const botToken = validCredential(config?.botToken, 'slack_config_invalid');
  const teamId = checkedSlackId(config?.teamId, 'slack_config_invalid');
  if (!botToken.startsWith('xoxb-')) throw new Error('slack_config_invalid');
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) {
    throw new Error('slack_config_invalid');
  }

  const sendWithKey = async (text: string, recipient: string, effectId: string) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value || value.length > 4000 || typeof effectId !== 'string' || !effectId
      || effectId.length > 512 || /[\u0000-\u001f\u007f]/.test(effectId)) {
      throw new Error('slack_message_invalid');
    }
    const context = resolveSlackReplyContext(db, effectId);
    if (!context || context.recipient !== recipient || context.teamId !== teamId) {
      throw new Error('slack_reply_context_missing');
    }
    const response = await transport(new URL('chat.postMessage', SLACK_API_BASE), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + botToken,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: context.channelId,
        thread_ts: context.threadTs,
        text: value,
        reply_broadcast: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return {};
    const result = await responseObject(response);
    if (result.ok !== true || result.channel !== context.channelId || typeof result.ts !== 'string'
      || !SLACK_TIMESTAMP.test(result.ts)) return {};
    return { provider_message_id: context.channelId + ':' + result.ts };
  };

  const sendFileWithKey = async (path: string, recipient: string, displayName: string, verified:FileDeliveryEffectContext,
    beforePost?:()=>Promise<boolean>) => {
    if (typeof path !== 'string' || !path || path.includes('\0')
      || typeof displayName !== 'string' || !displayName || displayName.length > 255
      || /[\\/\u0000-\u001f\u007f]/.test(displayName)) {
      throw new Error('delivery_preflight_SLACK_FILE_INVALID');
    }
    const context = resolveSlackReplyContext(db, verified.effectId);
    const pin = resolveSlackArtifactPin(db, verified.effectId);
    const part=verified.filePart;
    if (!context || !pin || context.recipient !== recipient || context.teamId !== teamId
      || pin.recipient !== recipient || part.artifactId!==pin.artifactId||part.version!==pin.version
      ||part.manifestSha256!==pin.manifestSha256||part.partIndex!==1||part.partSha256!==pin.sha256
      ||part.partSizeBytes!==pin.sizeBytes||displayName !== pin.displayName||displayName!==part.displayName) {
      throw new Error('delivery_preflight_SLACK_REPLY_CONTEXT_MISSING');
    }

    let info: Awaited<ReturnType<typeof stat>>;
    let bytes: Buffer;
    try {
      info = await stat(path);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_OUTBOUND_FILE_BYTES) {
        throw new Error('invalid_size');
      }
      bytes = await readFile(path);
    } catch {
      throw new Error('delivery_preflight_SLACK_FILE_UNAVAILABLE');
    }
    const digest=createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== info.size || bytes.length !== pin.sizeBytes || bytes.length !== part.partSizeBytes || bytes.length < 1
      || bytes.length > MAX_OUTBOUND_FILE_BYTES
      || digest !== pin.sha256 || digest!==part.partSha256) {
      throw new Error('delivery_preflight_SLACK_FILE_CHANGED');
    }

    let ticketResponse: Response;
    try {
      ticketResponse = await transport(new URL('files.getUploadURLExternal', SLACK_API_BASE), {
        method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer ' + botToken, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ filename: displayName, length: bytes.length }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new Error('slack_network_failure'); }
    if (!ticketResponse.ok) return {};
    const ticket = await responseObject(ticketResponse);
    const fileId = typeof ticket.file_id === 'string' && /^F[A-Za-z0-9]{1,80}$/.test(ticket.file_id)
      ? ticket.file_id : undefined;
    const uploadUrl = slackUploadUrl(ticket.upload_url);
    if (ticket.ok !== true || !fileId || !uploadUrl) {
      throw new Error('delivery_preflight_SLACK_UPLOAD_TICKET_INVALID');
    }

    if(beforePost&&!await beforePost())throw new Error('slack_delivery_authorization_revoked');

    let uploadResponse: Response;
    try {
      uploadResponse = await postSlackUpload(uploadUrl, bytes, timeoutMs, transport);
    } catch { throw new Error('slack_network_failure'); }
    if (!uploadResponse.ok) return {};
    try { await uploadResponse.body?.cancel(); } catch { /* response is not needed after HTTP success */ }

    if(beforePost&&!await beforePost())throw new Error('slack_delivery_authorization_revoked');

    let completeResponse: Response;
    try {
      completeResponse = await transport(new URL('files.completeUploadExternal', SLACK_API_BASE), {
        method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer ' + botToken, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ files: [{ id: fileId, title: displayName }],
          channel_id: context.channelId, thread_ts: context.threadTs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new Error('slack_network_failure'); }
    if (!completeResponse.ok) return {};
    const completed = await responseObject(completeResponse);
    const completedFiles = Array.isArray(completed.files) ? completed.files : [];
    if (completed.ok !== true || !completedFiles.some(file => object(file)?.id === fileId)) return {};
    return { provider_message_id: `slack-file:${context.channelId}:${fileId}`, provider_file_id: fileId,
      artifact_sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length };
  };

  return {
    async send(text: string, recipient: string, context?: DeliveryEffectContext): Promise<Record<string, unknown>> {
      const verified = requireTextDeliveryContext(context);
      return sendWithKey(text, recipient, verified.effectId);
    },
    sendWithKey,
    async sendFile(path: string, recipient: string, displayName: string, context?: FileDeliveryEffectContext,
      beforePost?:()=>Promise<boolean>): Promise<Record<string, unknown>> {
      const verified = requireFileDeliveryContext(context);
      return sendFileWithKey(path, recipient, displayName, verified,beforePost);
    },
    sendFileWithKey,
  };
}

/** Correlate a Slack outbox effect with the original verified event without another store. */
export function resolveSlackReplyContext(db: DatabaseSync, effectId: string): SlackReplyContext | undefined {
  const rows = db.prepare(`SELECT e.run_id,e.recipient,v.provider_thread_id,v.conversation_id,c.owner_id,
      r.conversation_id AS run_conversation_id
    FROM ga_channel_deliveries e
    JOIN ga_runs r ON r.id=e.run_id
    JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN ga_messages m ON m.id=e.message_id AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant'
    JOIN ga_channel_message_events v ON v.channel='slack' AND v.run_id=r.id AND v.principal=e.recipient
      AND v.conversation_id=c.id AND v.message_id=r.input_message_id
    JOIN ga_channel_threads t ON t.channel='slack' AND t.principal=e.recipient
      AND t.provider_thread_id=v.provider_thread_id AND t.conversation_id=c.id
      AND t.channel_binding_id=v.channel_binding_id AND t.binding_version=v.binding_version
    JOIN ga_owner_channel_bindings b ON b.channel_binding_id=v.channel_binding_id
      AND b.version=v.binding_version AND b.channel='slack' AND b.principal=e.recipient
      AND b.owner_id=c.owner_id AND b.status='verified'
    WHERE e.effect_id=? AND e.destination='slack'`)
    .all(effectId) as Array<Record<string, unknown>>;
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (typeof row.recipient !== 'string' || typeof row.provider_thread_id !== 'string'
    || typeof row.conversation_id !== 'string' || row.run_conversation_id !== row.conversation_id
    || typeof row.owner_id !== 'string' || !row.owner_id) return undefined;
  const principal = parseSlackPrincipal(row.recipient);
  const thread = parseSlackThread(row.provider_thread_id);
  if (!principal || !thread) return undefined;
  return { recipient: row.recipient, teamId: principal.teamId,
    channelId: thread.channelId, threadTs: thread.threadTs };
}

function resolveSlackArtifactPin(db:DatabaseSync,effectId:string):
  {recipient:string;path:string;displayName:string;sha256:string;sizeBytes:number;artifactId:string;version:number;manifestSha256:string}|undefined {
  const effect=db.prepare("SELECT artifact_ref FROM ga_channel_deliveries WHERE effect_id=? AND destination='slack'")
    .get(effectId) as {artifact_ref?:unknown}|undefined;
  if(typeof effect?.artifact_ref!=='string')return undefined;
  const pin=decodeSlackArtifactRef(effect.artifact_ref);if(!pin)return undefined;
  const rows=db.prepare(`SELECT e.recipient,e.payload_json,c.id AS conversation_id,c.owner_id,v.server_path,pin.sha256,pin.size_bytes,pin.display_name,
      a.id AS artifact_id,v.version FROM ga_channel_deliveries e
    JOIN ga_runs r ON r.id=e.run_id
    JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN ga_messages m ON m.id=e.message_id AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant'
    JOIN ga_run_artifacts ra ON ra.run_id=r.id AND ra.artifact_id=? AND ra.version=?
    JOIN ga_artifacts a ON a.id=ra.artifact_id AND a.conversation_id=c.id AND a.owner_id=c.owner_id
    JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=ra.version
    JOIN ga_channel_message_events source ON source.channel='slack' AND source.run_id=r.id
      AND source.conversation_id=c.id AND source.message_id=r.input_message_id AND source.principal=e.recipient
    JOIN ga_owner_channel_bindings binding ON binding.channel='slack' AND binding.principal=e.recipient
      AND binding.owner_id=c.owner_id AND binding.status='verified'
    JOIN ga_slack_artifact_delivery_pins pin ON pin.effect_id=e.effect_id AND pin.owner_id=c.owner_id
      AND pin.conversation_id=c.id AND pin.source_run_id=r.id AND pin.source_message_id=r.input_message_id
      AND pin.recipient=e.recipient AND pin.channel_binding_id=binding.channel_binding_id
      AND pin.channel_binding_id=source.channel_binding_id AND pin.binding_version=source.binding_version
      AND pin.binding_version=binding.version AND pin.artifact_id=a.id AND pin.artifact_version=v.version
      AND pin.server_path=v.server_path AND pin.sha256=v.sha256 AND pin.size_bytes=v.size_bytes
      AND pin.display_name=json_extract(v.metadata_json,'$.file_name')
    WHERE e.effect_id=? AND e.destination='slack' AND e.artifact_ref=?
      AND EXISTS(SELECT 1 FROM json_each(json_extract(m.content_json,'$.attachments')) attached WHERE attached.value=a.id)
      AND json_extract(v.metadata_json,'$.status')='ready'
      AND NOT EXISTS(SELECT 1 FROM ga_artifact_parts p WHERE p.artifact_id=a.id)`)
    .all(pin.artifactId,pin.version,effectId,effect.artifact_ref) as Array<Record<string,unknown>>;
  if(rows.length!==1)return undefined;
  const row=rows[0]!;
  const displayName=row.display_name;
  const sizeBytes=Number(row.size_bytes);
  let payload:Record<string,any>;
  try{payload=JSON.parse(String(row.payload_json));}catch{return undefined;}
  const manifest=payload?.manifest,part=Array.isArray(manifest)?manifest[0]:undefined;
  if(typeof row.recipient!=='string'||typeof row.server_path!=='string'||typeof displayName!=='string'
    ||!displayName.trim()||displayName.length>255||/[\\/\u0000-\u001f\u007f]/.test(displayName)
    ||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)
    ||!Number.isSafeInteger(sizeBytes)||sizeBytes<1||sizeBytes>MAX_OUTBOUND_FILE_BYTES
    ||payload?.kind!=='artifact'||payload.schema_version!==1||payload.artifact_id!==pin.artifactId
    ||Number(payload.version)!==pin.version||payload.owner_id!==row.owner_id||payload.conversation_id!==row.conversation_id
    ||!Array.isArray(manifest)||manifest.length!==1||payload.manifest_sha256!==createHash('sha256').update(canonicalJson(manifest)).digest('hex')
    ||!part||part.part_index!==1||part.display_name!==displayName||part.sha256!==row.sha256
    ||Number(part.size_bytes)!==sizeBytes||typeof part.mime_type!=='string')return undefined;
  return {recipient:row.recipient,path:row.server_path,displayName,sha256:row.sha256,sizeBytes,
    artifactId:pin.artifactId,version:pin.version,manifestSha256:String(payload.manifest_sha256)};
}

const SLACK_ID = /^[A-Za-z0-9._-]{1,80}$/;
const SLACK_TIMESTAMP = /^\d{10,20}\.\d{1,10}$/;

function parseSlackPrincipal(value: string): { teamId: string; userId: string } | undefined {
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'slack' || !slackId(parts[1]) || !slackId(parts[2])) return undefined;
  return { teamId: parts[1]!, userId: parts[2]! };
}

function parseSlackThread(value: string): { channelId: string; threadTs: string } | undefined {
  const delimiter = value.indexOf(':');
  if (delimiter < 1 || delimiter !== value.lastIndexOf(':')) return undefined;
  const channelId = value.slice(0, delimiter);
  const threadTs = value.slice(delimiter + 1);
  if (!slackId(channelId) || !SLACK_TIMESTAMP.test(threadTs)) return undefined;
  return { channelId, threadTs };
}

function slackId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_ID.test(value);
}

function checkedSlackId(value: unknown, error: string): string {
  if (!slackId(value)) throw new Error(error);
  return value;
}

function checkedSlackTimestamp(value: unknown, error: string): string {
  if (typeof value !== 'string' || !SLACK_TIMESTAMP.test(value)) throw new Error(error);
  return value;
}

function checkedEventId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('slack_event_id_invalid');
  return value;
}

function validCredential(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value)) throw new Error(error);
  return value;
}

function header(headers: SlackWebhookHeaders, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

function parsePayload(bytes: Uint8Array): Record<string, unknown> {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('slack_callback_json_invalid'); }
  const row = object(payload);
  if (!row) throw new Error('slack_callback_payload_invalid');
  return row;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await response.text(); } catch { return {}; }
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return object(parsed) ?? {};
  } catch { return {}; }
}

function slackUploadUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === SLACK_UPLOAD_HOST && !url.port
      && !url.username && !url.password && !url.hash && url.pathname.startsWith('/upload/v1/') ? url : undefined;
  } catch { return undefined; }
}

async function postSlackUpload(url: URL, bytes: Buffer, timeoutMs: number,
  transport: SlackTransport): Promise<Response> {
  let target = url;
  const body = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await transport(target, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/octet-stream' }, body,
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 307 && response.status !== 308) return response;
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch { /* discard redirect body */ }
    if (!location || redirects === 3) return response;
    const next = slackUploadUrl(new URL(location, target).toString());
    if (!next) return response;
    target = next;
  }
  throw new Error('slack_network_failure');
}
