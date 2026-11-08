import { createHash } from 'node:crypto';
import { channelAttachmentManifestDigestV2, normalizeChannelAttachmentManifestV2 } from './attachment-manifest-v2.ts';
import { channelStageRequestDigestV2 } from './attachment-stage-v2.ts';
import {normalizeChannelStageRequestV2} from './attachment-stage-v2.ts';
import {mattermostTextIdentity} from './mattermost-thread-scope.ts';
import {mattermostOwnerAccount} from './mattermost-owner-proof.ts';
import type { ChannelAttachmentForwardInputV2, ChannelAttachmentForwardPort, ChannelHostWritePortOptions,
  ChannelRuntimeResponse,ChannelAttachmentRequestDeclarationV2 } from './runtime-contracts.ts';

const PREFIX = '/internal/v2/channel/attachment-batches';
const MAX_PART_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
type Row = Record<string, unknown>;
type PreparedPart = { index: number; provider_file_id: string; file_name: string; media_type: string;
  size_bytes: number; sha256: string; bytes: Uint8Array };
type Prepared = { request: { protocol: 2; event: { channel: 'matrix'|'mattermost'; principal: string; thread_id: string; message_id: string };
  text: string; attachments: Array<Omit<PreparedPart, 'bytes'>> }; parts: PreparedPart[] };
type Stage = { state: 'staging' | 'staged'; stage_key: string; manifest_sha256: string; parts: Array<{ index: number;
  provider_file_id: string; file_name: string; media_type: string; size_bytes: number; sha256: string }> };
type Lookup = { kind: 'admitted'; response: ChannelRuntimeResponse } | { kind: 'not_observed' }
  | { kind: 'stage'; stage: Stage } | { kind: 'unproven' } | { kind: 'unknown' };
type HttpResult = { kind: 'response'; status: number; value: unknown } | { kind: 'unknown' } | { kind: 'cancelled' };

const record = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Row, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const fail = (code: string, statusCode = 422): ChannelRuntimeResponse => ({ statusCode, body: { error: { code } } });
const unknown = (): ChannelRuntimeResponse => fail('CHANNEL_ATTACHMENT_ADMISSION_UNKNOWN', 503);

function prepare(input: ChannelAttachmentForwardInputV2): Prepared {
  if (!record(input) || !exact(input, ['channel', 'principal', 'thread_id', 'message_id', 'text', 'attachments', 'authenticated'])
    || !['matrix','mattermost'].includes(input.channel) || input.authenticated !== true || !opaque(input.principal) || !opaque(input.thread_id)
    || !opaque(input.message_id) || typeof input.text !== 'string' || input.text !== input.text.trim() || input.text.length > 4000
    || !Array.isArray(input.attachments) || input.attachments.length < 1 || input.attachments.length > 10) {
    throw Error('channel_attachment_stage_invalid');
  }
  if(input.channel==='mattermost'){
    const account=mattermostTextIdentity(input.principal,input.thread_id);mattermostOwnerAccount(account);
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.message_id)||input.text.startsWith('/jot-bind'))throw Error('channel_attachment_stage_invalid');
  }
  const seen = new Set<string>();
  const parts: PreparedPart[] = [];
  let total = 0;
  for (let index = 0; index < input.attachments.length; index += 1) {
    const value: unknown = input.attachments[index];
    if (!record(value) || !(exact(value, ['provider_file_id', 'file_name', 'media_type', 'bytes'])
      || exact(value, ['provider_file_id', 'file_name', 'media_type', 'size_bytes', 'bytes']))) {
      throw Error('channel_attachment_stage_invalid');
    }
    const providerFileId = value.provider_file_id;
    const fileName = value.file_name;
    const mediaType = value.media_type;
    const bytes = value.bytes;
    const declaredSize = value.size_bytes;
    if (!opaque(providerFileId) || input.channel==='mattermost'&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerFileId) || seen.has(providerFileId) || typeof fileName !== 'string' || !fileName
      || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(fileName)
      || typeof mediaType !== 'string' || mediaType !== mediaType.toLowerCase()
      || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
      || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_PART_BYTES
      || declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize !== bytes.byteLength)) {
      throw Error('channel_attachment_stage_invalid');
    }
    seen.add(providerFileId);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw Error('channel_attachment_stage_invalid');
    const sizeBytes = bytes.byteLength;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    parts.push({ index, provider_file_id: providerFileId, file_name: fileName, media_type: mediaType,
      size_bytes: sizeBytes, sha256, bytes });
  }
  const { channel, principal, thread_id, message_id, text } = input;
  return { request: { protocol: 2, event: { channel, principal, thread_id, message_id }, text,
    attachments: parts.map(({ bytes: _bytes, ...part }) => part) }, parts };
}
/** Metadata-only validation for original request lookup; never manufactures bytes. */
export function normalizeChannelAttachmentRequestDeclarationV2(input:unknown):ChannelAttachmentRequestDeclarationV2{
  const source=normalizeChannelStageRequestV2(input,{owner_id:'declaration-validation',channel_binding_id:'declaration-validation',binding_version:1,conversation_id:'declaration-validation'});
  if(!['matrix','mattermost'].includes(source.event.channel)||!opaque(source.event.principal)||!opaque(source.event.thread_id)||!opaque(source.event.message_id))throw Error('channel_attachment_stage_invalid');
  if(source.event.channel==='mattermost'){
    const account=mattermostTextIdentity(source.event.principal,source.event.thread_id);mattermostOwnerAccount(account);
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.event.message_id)||source.text.startsWith('/jot-bind'))throw Error('channel_attachment_stage_invalid');
  }
  const attachments=source.attachments.map(({index,provider_file_id,file_name,media_type,size_bytes,sha256})=>{
    if(media_type!==media_type.toLowerCase()||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(media_type)||source.event.channel==='mattermost'&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider_file_id))throw Error('channel_attachment_stage_invalid');
    return{index,provider_file_id,file_name,media_type,size_bytes,sha256};
  });
  return {protocol:2,event:{...source.event,channel:source.event.channel as 'matrix'|'mattermost'},text:source.text,attachments};
}
export type ChannelAttachmentForwardWithLookupV2=ChannelAttachmentForwardPort&Readonly<{
 lookupOriginalRequest(declaration:ChannelAttachmentRequestDeclarationV2,signal?:AbortSignal):Promise<ChannelRuntimeResponse>;
}>;

function acceptedReceipt(value: unknown): ChannelRuntimeResponse | null {
  if (!record(value) || !exact(value, ['protocol', 'state', 'event_sha256', 'manifest_sha256', 'receipt'])
    || value.protocol !== 2 || value.state !== 'admitted' || typeof value.event_sha256 !== 'string' || !SHA256.test(value.event_sha256)
    || typeof value.manifest_sha256 !== 'string' || !SHA256.test(value.manifest_sha256) || !record(value.receipt)) return null;
  const receipt = value.receipt;
  if (!exact(receipt, ['accepted', 'message_id', 'run_id', 'conversation_id']) || receipt.accepted !== true
    || !['message_id', 'run_id', 'conversation_id'].every(key => typeof receipt[key] === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(String(receipt[key])))) return null;
  return { statusCode: 202, body: receipt };
}

function parseStage(value: unknown, prepared: Prepared): Stage | null {
  if (!record(value) || !exact(value, ['protocol', 'state', 'stage_key', 'request_sha256', 'manifest_sha256', 'source', 'parts', 'expires_at'])
    || value.protocol !== 2 || !['staging', 'staged'].includes(String(value.state))
    || typeof value.stage_key !== 'string' || !/^channel-stage-[a-f0-9]{64}$/.test(value.stage_key)
    || typeof value.request_sha256 !== 'string' || !SHA256.test(value.request_sha256)
    || typeof value.manifest_sha256 !== 'string' || !SHA256.test(value.manifest_sha256)
    || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))
    || Date.parse(value.expires_at) <= Date.now() || !record(value.source) || !Array.isArray(value.parts)) return null;
  const source = value.source;
  if (!exact(source, ['protocol', 'owner_id', 'channel_binding_id', 'binding_version', 'conversation_id', 'event', 'text', 'attachments'])
    || source.protocol !== 2 || !opaque(source.owner_id) || !opaque(source.channel_binding_id)
    || !Number.isSafeInteger(source.binding_version) || Number(source.binding_version) < 1 || !opaque(source.conversation_id)
    || source.text !== prepared.request.text || !record(source.event)
    || !exact(source.event, ['channel', 'principal', 'thread_id', 'message_id'])
    || source.event.channel !== prepared.request.event.channel || source.event.principal !== prepared.request.event.principal
    || source.event.thread_id !== prepared.request.event.thread_id || source.event.message_id !== prepared.request.event.message_id
    || !Array.isArray(source.attachments) || source.attachments.length !== prepared.parts.length
    || value.parts.length !== prepared.parts.length) return null;
  const matched: Stage['parts'] = [];
  for (let index = 0; index < prepared.parts.length; index += 1) {
    const expected = prepared.parts[index]!, declaration = source.attachments[index], upload = value.parts[index];
    if (!record(declaration) || !exact(declaration, ['index', 'provider_file_id', 'artifact_id', 'version', 'sha256', 'size_bytes', 'media_type', 'file_name', 'kind'])
      || declaration.index !== index || declaration.provider_file_id !== expected.provider_file_id
      || declaration.file_name !== expected.file_name || declaration.media_type !== expected.media_type
      || declaration.size_bytes !== expected.size_bytes || declaration.sha256 !== expected.sha256
      || declaration.version !== 1 || typeof declaration.artifact_id !== 'string' || !/^artifact-[a-f0-9]{32}$/.test(declaration.artifact_id)
      || typeof declaration.kind !== 'string' || !record(upload)
      || !exact(upload, ['index', 'provider_file_id', 'artifact_id', 'version', 'sha256', 'size_bytes', 'media_type', 'file_name', 'kind', 'upload_id'])
      || upload.index !== index || upload.provider_file_id !== expected.provider_file_id || upload.file_name !== expected.file_name
      || upload.media_type !== expected.media_type || upload.size_bytes !== expected.size_bytes || upload.sha256 !== expected.sha256
      || upload.artifact_id !== declaration.artifact_id || upload.version !== 1
      || typeof upload.upload_id !== 'string' || !/^upload-channel-[a-f0-9]{32}$/.test(upload.upload_id)) return null;
    matched.push({ index, provider_file_id: expected.provider_file_id, file_name: expected.file_name,
      media_type: expected.media_type, size_bytes: expected.size_bytes, sha256: expected.sha256 });
  }
  let sourceHash: string, requestHash: string;
  try {
    const canonicalSource = normalizeChannelAttachmentManifestV2(source).source;
    sourceHash = channelAttachmentManifestDigestV2(canonicalSource);
    requestHash = channelStageRequestDigestV2(canonicalSource);
  } catch { return null; }
  if (sourceHash !== value.manifest_sha256 || requestHash !== value.request_sha256) return null;
  return { state: value.state as Stage['state'], stage_key: value.stage_key,
    manifest_sha256: value.manifest_sha256, parts: matched };
}

function parseLookup(value: unknown, prepared: Prepared): Lookup {
  if (!record(value) || value.protocol !== 2) return { kind: 'unproven' };
  if (value.state === 'admitted') {
    if (!exact(value, ['protocol', 'state', 'event_sha256', 'manifest_sha256', 'receipt'])) return { kind: 'unproven' };
    if (typeof value.event_sha256 !== 'string' || typeof value.manifest_sha256 !== 'string'
      || !SHA256.test(value.event_sha256) || value.event_sha256 !== value.manifest_sha256) return { kind: 'unproven' };
    const response = acceptedReceipt(value);
    return response ? { kind: 'admitted', response } : { kind: 'unproven' };
  }
  if (value.automatic_replay !== false) return { kind: 'unproven' };
  if (value.state === 'not_observed' && exact(value, ['protocol', 'state', 'original_admission', 'automatic_replay'])
    && value.original_admission === 'unproven') return { kind: 'not_observed' };
  if (value.state === 'unproven' && exact(value, ['protocol', 'state', 'original_admission', 'automatic_replay'])
    && value.original_admission === 'unproven') return { kind: 'unproven' };
  if (value.state === 'stage_observed' && exact(value, ['protocol', 'state', 'stage', 'automatic_replay'])) {
    const stage = parseStage(value.stage, prepared);
    return stage ? { kind: 'stage', stage } : { kind: 'unproven' };
  }
  return { kind: 'unproven' };
}

function errorResponse(status: number, value: unknown): ChannelRuntimeResponse {
  const row = record(value) && record(value.error) ? value.error : undefined;
  const code = row && typeof row.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(row.code)
    ? row.code : 'CHANNEL_ATTACHMENT_INTAKE_REJECTED';
  return fail(code, status >= 400 && status < 500 ? status : 503);
}

/** Fixed loopback transport to task 13's original durable upload batch routes. */
export function createChannelAttachmentForwardV2(options: ChannelHostWritePortOptions): ChannelAttachmentForwardWithLookupV2 {
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['url', 'token', 'fetch', 'timeoutMs'].includes(key))
    || options.fetch !== undefined && typeof options.fetch !== 'function') throw Error('channel_forward_configuration_invalid');
  let base: URL;
  try { base = new URL(options.url); } catch { throw Error('channel_forward_configuration_invalid'); }
  const timeoutMs = options.timeoutMs ?? 30000;
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || typeof options.token !== 'string' || options.token.length < 16 || /[\r\n]/.test(options.token)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('channel_forward_configuration_invalid');
  const send = options.fetch ?? fetch;
  const request = async (path: string, method: 'POST' | 'PUT', body: string | Uint8Array,
    contentType: string, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<HttpResult> => {
    if (signal?.aborted) return { kind: 'cancelled' };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs); timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const requestBody: BodyInit = typeof body === 'string' ? body : new Blob([Uint8Array.from(body)]);
      const response = await send(new URL(path, base), { method, redirect: 'error', signal: combined,
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/json', 'content-type': contentType, ...extraHeaders }, body: requestBody });
      let value: unknown;
      try { value = await response.json(); } catch { return response.status >= 400 && response.status < 500
        ? { kind: 'response', status: response.status, value: null } : { kind: 'unknown' }; }
      if (response.status >= 500) return { kind: 'unknown' };
      return { kind: 'response', status: response.status, value };
    } catch {
      return signal?.aborted ? { kind: 'cancelled' } : { kind: 'unknown' };
    } finally { clearTimeout(timer); }
  };
  const lookup = async (prepared: Prepared, signal?: AbortSignal): Promise<Lookup> => {
    const result = await request(PREFIX + '/lookup', 'POST', JSON.stringify(prepared.request), 'application/json', {}, signal);
    if (result.kind !== 'response' || result.status !== 200) return result.kind === 'cancelled' ? { kind: 'unknown' } : { kind: 'unknown' };
    return parseLookup(result.value, prepared);
  };
  const readOnlyRecovery = async (prepared: Prepared, signal?: AbortSignal): Promise<ChannelRuntimeResponse> => {
    const recovered = await lookup(prepared, signal);
    return recovered.kind === 'admitted' ? recovered.response : unknown();
  };
  const forward:ChannelAttachmentForwardPort=async (input, signal) => {
    let prepared: Prepared;
    try { prepared = prepare(input); }
    catch (error) { return fail(error instanceof Error ? error.message.toUpperCase() : 'CHANNEL_ATTACHMENT_STAGE_INVALID', 422); }
    const first = await lookup(prepared, signal);
    if (first.kind === 'admitted') return first.response;
    if (first.kind === 'unknown') return unknown();
    if (first.kind === 'unproven') return unknown();
    // A persisted stage is not an admission receipt. Keep this consumer
    // receipt-only: a separate recovery action must decide whether to resume it.
    if (first.kind === 'stage') return unknown();
    let stage: Stage;
    const reserved = await request(PREFIX, 'POST', JSON.stringify(prepared.request), 'application/json', {}, signal);
    if (reserved.kind === 'cancelled') return fail('CHANNEL_FORWARD_CANCELLED', 503);
    if (reserved.kind !== 'response') return readOnlyRecovery(prepared, signal);
    if (reserved.status !== 201) return errorResponse(reserved.status, reserved.value);
    const candidate = parseStage(reserved.value, prepared);
    if (!candidate) return readOnlyRecovery(prepared, signal);
    stage = candidate;
    if (stage.state === 'staging') {
      for (const part of prepared.parts) {
        if (signal?.aborted) return fail('CHANNEL_FORWARD_CANCELLED', 503);
        if (part.bytes.byteLength !== part.size_bytes || createHash('sha256').update(part.bytes).digest('hex') !== part.sha256) {
          return fail('CHANNEL_ATTACHMENT_SOURCE_CHANGED', 422);
        }
        const uploaded = await request(`${PREFIX}/${encodeURIComponent(stage.stage_key)}/parts/${part.index}`,
          'PUT', part.bytes, 'application/octet-stream', { 'x-channel-manifest-sha256': stage.manifest_sha256 }, signal);
        if (uploaded.kind === 'cancelled') return fail('CHANNEL_FORWARD_CANCELLED', 503);
        if (uploaded.kind !== 'response') return readOnlyRecovery(prepared, signal);
        if (uploaded.status !== 200 || !record(uploaded.value) || !exact(uploaded.value, ['protocol', 'state', 'index'])
          || uploaded.value.protocol !== 2 || uploaded.value.state !== 'part_staged' || uploaded.value.index !== part.index) {
          if (uploaded.status >= 400 && uploaded.status < 500) return errorResponse(uploaded.status, uploaded.value);
          return readOnlyRecovery(prepared, signal);
        }
      }
    }
    const admittedResult = await request(`${PREFIX}/${encodeURIComponent(stage.stage_key)}/admit`, 'POST',
      JSON.stringify({ protocol: 2, manifest_sha256: stage.manifest_sha256 }), 'application/json', {}, signal);
    if (admittedResult.kind === 'cancelled') return fail('CHANNEL_FORWARD_CANCELLED', 503);
    if (admittedResult.kind === 'response' && admittedResult.status === 202) {
      const receipt = acceptedReceipt(admittedResult.value);
      if (receipt && record(admittedResult.value) && admittedResult.value.event_sha256 === stage.manifest_sha256
        && admittedResult.value.manifest_sha256 === stage.manifest_sha256) return receipt;
    } else if (admittedResult.kind === 'response' && admittedResult.status >= 400 && admittedResult.status < 500) {
      return errorResponse(admittedResult.status, admittedResult.value);
    }
    return readOnlyRecovery(prepared, signal);
  };
  return Object.freeze(Object.assign(forward,{lookupOriginalRequest:async(input:ChannelAttachmentRequestDeclarationV2,signal?:AbortSignal)=>{
    let declaration:ChannelAttachmentRequestDeclarationV2;
    try{declaration=normalizeChannelAttachmentRequestDeclarationV2(input);}catch{return unknown();}
    const prepared:Prepared={request:{...declaration,attachments:[...declaration.attachments]},parts:declaration.attachments.map(part=>({...part,bytes:new Uint8Array(0)}))};
    return readOnlyRecovery(prepared,signal);
  }}));
}
