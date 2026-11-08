import { basename } from 'node:path';
import {createHash} from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { DeliveryProvider } from '../worker.ts';
import {requireTextDeliveryContext,requireFileDeliveryContext,type DeliveryEffectContext,type FileDeliveryEffectContext} from '../delivery-effect-context.ts';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const SAFE_ID = /^[!@$#][A-Za-z0-9._=:+/-]{1,255}$/;
const matrixAdapters = new WeakSet<object>();
type FetchLike = typeof fetch;
export type MatrixAttachment = Readonly<{ providerFileId: string; fileName: string; mediaType: string; sizeBytes?: number }>;
export type VerifiedMatrixEvent = Readonly<{ channel: 'matrix'; principal: string; providerThreadId: string;
  providerMessageId: string; text: string; attachments: readonly MatrixAttachment[]; authenticated: true }>;
export type MatrixConfig = { baseUrl: string; accessToken: string; userId?: string; timeoutMs?: number;
  maxAttachmentBytes?: number; maxSyncWaitMs?: number };
export type MatrixDeliveryContext = DeliveryEffectContext|FileDeliveryEffectContext;
function fail(code: string): never { throw new Error(code); }
function safeBase(value: unknown): URL {
  if (typeof value !== 'string') fail('matrix_config_invalid');
  let url: URL;
  try { url = new URL(value); } catch { fail('matrix_config_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('matrix_config_invalid');
  return url;
}
function mediaUri(value: string): { server: string; mediaId: string } {
  const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(value);
  if (!match || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(match[1]!) || !/^[A-Za-z0-9._=-]{1,255}$/.test(match[2]!)) {
    fail('matrix_media_uri_invalid');
  }
  return { server: match[1]!, mediaId: match[2]! };
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('matrix_response_invalid');
  return value as Record<string, unknown>;
}

export function createMatrixAdapter(config: MatrixConfig, fetchImpl: FetchLike = fetch) {
  if (!config || typeof config.accessToken !== 'string' || !config.accessToken.trim() || /[\r\n]/.test(config.accessToken)
    || (config.userId !== undefined && !SAFE_ID.test(config.userId))) fail('matrix_config_invalid');
  const base = safeBase(config.baseUrl); const timeout = config.timeoutMs ?? 15000;
  const maxAttachmentBytes = config.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  const maxSyncWaitMs = config.maxSyncWaitMs ?? 25000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000
    || !Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > MAX_ATTACHMENT_BYTES
    || !Number.isSafeInteger(maxSyncWaitMs) || maxSyncWaitMs < 0 || maxSyncWaitMs > 30000) fail('matrix_config_invalid');
  async function fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal });
      signal.throwIfAborted();
      return response;
    }
    catch { throw new Error('network_matrix_request_ambiguous'); }
    finally { clearTimeout(timer); }
  }
  let selfUserId=config.userId;
  const adapter = {
    async whoAmI(signal?:AbortSignal):Promise<string>{
      const url=new URL('/_matrix/client/v3/account/whoami',base);
      const response=await fetchWithTimeout(url,{method:'GET',headers:{authorization:`Bearer ${config.accessToken}`,accept:'application/json'},...(signal?{signal}:{})});
      if(!response.ok)fail('matrix_whoami_rejected');
      let root:Record<string,unknown>;
      try{root=jsonObject(await response.json());}catch{fail('matrix_response_invalid');}
      if(typeof root.user_id!=='string'||!SAFE_ID.test(root.user_id)||!root.user_id.startsWith('@')||!root.user_id.includes(':'))fail('matrix_response_invalid');
      selfUserId=root.user_id;
      return selfUserId;
    },
    /** Proof codes may be consumed only from a private, pairwise Matrix room.
     * Sync authenticates the sender; current room state prevents a shared
     * room from turning an owner's one-time code into a first-writer race. */
    async verifyPrivatePairRoom(roomId:string,principal:string,signal?:AbortSignal):Promise<boolean>{
      if(!selfUserId||typeof roomId!=='string'||!roomId.startsWith('!')||!SAFE_ID.test(roomId)
        ||typeof principal!=='string'||!principal.startsWith('@')||!SAFE_ID.test(principal)||principal===selfUserId)return false;
      const url=new URL(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,base);
      const response=await fetchWithTimeout(url,{method:'GET',headers:{authorization:`Bearer ${config.accessToken}`,accept:'application/json'},...(signal?{signal}:{})});
      if(!response.ok)fail('matrix_room_state_unavailable');
      let values:unknown;try{values=await response.json();}catch{fail('matrix_room_state_unavailable');}
      if(!Array.isArray(values))return false;
      const memberByUser=new Map<string,string>(),joinRules:string[]=[],historyVisibility:string[]=[];
      for(const raw of values){
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
        const event=raw as Record<string,unknown>,content=event.content&&typeof event.content==='object'&&!Array.isArray(event.content)
          ?event.content as Record<string,unknown>:undefined;
        if(event.type==='m.room.member'){
          if(typeof event.state_key!=='string'||!content||typeof content.membership!=='string'||memberByUser.has(event.state_key))return false;
          memberByUser.set(event.state_key,content.membership);
        }else if(event.type==='m.room.join_rules'&&event.state_key===''){
          if(!content||typeof content.join_rule!=='string')return false;joinRules.push(content.join_rule);
        }else if(event.type==='m.room.history_visibility'&&event.state_key===''){
          if(!content||typeof content.history_visibility!=='string')return false;historyVisibility.push(content.history_visibility);
        }
      }
      const joined=[...memberByUser].filter(([,membership])=>membership==='join').map(([user])=>user);
      return joinRules.length===1&&joinRules[0]==='invite'&&historyVisibility.length===1&&historyVisibility[0]==='joined'
        &&memberByUser.get(selfUserId)==='join'&&memberByUser.get(principal)==='join'
        &&memberByUser.size===2&&joined.length===2&&joined.includes(selfUserId)&&joined.includes(principal);
    },
    async syncOnce(since?: string, signal?: AbortSignal): Promise<{ nextBatch: string; events: VerifiedMatrixEvent[] }> {
      if (since !== undefined && (typeof since !== 'string' || !since || since.length > 1024)) fail('matrix_sync_cursor_invalid');
      const url = new URL('/_matrix/client/v3/sync', base);
      url.searchParams.set('timeout', String(maxSyncWaitMs));
      if (since !== undefined) url.searchParams.set('since', since);
      const response = await fetchWithTimeout(url, { method: 'GET', headers: { authorization: `Bearer ${config.accessToken}`, accept: 'application/json' }, ...(signal ? { signal } : {}) });
      if (!response.ok) fail('matrix_sync_rejected');
      let root: Record<string, unknown>;
      try { root = jsonObject(await response.json()); } catch { fail('matrix_response_invalid'); }
      signal?.throwIfAborted();
      if (typeof root.next_batch !== 'string' || !root.next_batch || root.next_batch.length > 1024) fail('matrix_response_invalid');
      const roomRoot = root.rooms && typeof root.rooms === 'object' && !Array.isArray(root.rooms) ? root.rooms as Record<string, unknown> : {};
      const joined = roomRoot.join && typeof roomRoot.join === 'object' && !Array.isArray(roomRoot.join) ? roomRoot.join as Record<string, unknown> : {};
      const events: VerifiedMatrixEvent[] = [];
      for (const [roomId, roomValue] of Object.entries(joined)) {
        if (!SAFE_ID.test(roomId) || !roomValue || typeof roomValue !== 'object' || Array.isArray(roomValue)) continue;
        const timeline = (roomValue as Record<string, unknown>).timeline;
        if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) continue;
        const source = (timeline as Record<string, unknown>).events;
        if (!Array.isArray(source)) continue;
        for (const item of source) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const event = item as Record<string, unknown>;
          if (event.type !== 'm.room.message' || typeof event.sender !== 'string' || !SAFE_ID.test(event.sender)
            || (selfUserId && event.sender === selfUserId) || typeof event.event_id !== 'string' || !SAFE_ID.test(event.event_id)
            || !event.content || typeof event.content !== 'object' || Array.isArray(event.content)) continue;
          const content = event.content as Record<string, unknown>;
          if (typeof content.body !== 'string' || content.body.length > 4000) continue;
          const msgtype = content.msgtype;
          const attachments: MatrixAttachment[] = [];
          if (['m.file', 'm.image', 'm.audio', 'm.video'].includes(String(msgtype))) {
            if (content.file !== undefined) fail('matrix_e2ee_attachment_unsupported');
            if (typeof content.url !== 'string') fail('matrix_attachment_invalid');
            mediaUri(content.url);
            const info = content.info && typeof content.info === 'object' && !Array.isArray(content.info)
              ? content.info as Record<string, unknown> : {};
            const name = typeof content.filename === 'string' ? content.filename : content.body;
            if (!name || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) fail('matrix_attachment_invalid');
            if (info.size !== undefined && (!Number.isSafeInteger(info.size) || Number(info.size) < 1 || Number(info.size) > maxAttachmentBytes)) {
              fail('matrix_attachment_invalid');
            }
            attachments.push(Object.freeze({ providerFileId: content.url, fileName: name,
              mediaType: typeof info.mimetype === 'string' ? info.mimetype : 'application/octet-stream',
              ...(info.size === undefined ? {} : { sizeBytes: Number(info.size) }) }));
          } else if (msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote') continue;
          const text = content.body.trim();
          if (!text && !attachments.length) continue;
          events.push(Object.freeze({ channel: 'matrix', principal: event.sender, providerThreadId: roomId,
            providerMessageId: event.event_id, text, attachments: Object.freeze(attachments), authenticated: true }));
        }
      }
      return { nextBatch: root.next_batch, events };
    },
    async downloadAttachment(mxcUri: string, fileName: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string }> {
      const media = mediaUri(mxcUri);
      if (typeof fileName !== 'string' || !fileName || fileName.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(fileName)) {
        fail('matrix_attachment_invalid');
      }
      const url = new URL(`/_matrix/client/v1/media/download/${encodeURIComponent(media.server)}/${encodeURIComponent(media.mediaId)}/${encodeURIComponent(fileName)}`, base);
      const response = await fetchWithTimeout(url, { method: 'GET', headers: { authorization: `Bearer ${config.accessToken}`, accept: '*/*' }, ...(signal ? { signal } : {}) });
      if (!response.ok || !response.body) fail('matrix_media_download_failed');
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxAttachmentBytes) fail('matrix_attachment_too_large');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          total += item.value.length; if (total > maxAttachmentBytes) { await reader.cancel(); fail('matrix_attachment_too_large'); }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { bytes, mediaType: response.headers.get('content-type') ?? 'application/octet-stream' };
    },
  };
  matrixAdapters.add(adapter);
  return adapter;
}

export type MatrixAdapterClient = ReturnType<typeof createMatrixAdapter>;

/** Configuration-source marker only; it grants no owner, inbox or send authority. */
export function isMatrixAdapter(value:unknown):value is ReturnType<typeof createMatrixAdapter>{
  return value!==null&&typeof value==='object'&&matrixAdapters.has(value);
}

export function createMatrixProvider(config: MatrixConfig, fetchImpl: FetchLike = fetch): Omit<DeliveryProvider, 'send' | 'sendFile'> & {
  send(text: string, recipient: string, context?: MatrixDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
  sendFile(path: string, recipient: string, displayName: string, context?: MatrixDeliveryContext): Promise<Record<string, unknown> & { provider_message_id: string }>;
} {
  const adapter = createMatrixAdapter(config, fetchImpl); const base = safeBase(config.baseUrl);
  const timeout = config.timeoutMs ?? 15000; const maxAttachmentBytes = config.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  async function request(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    let response: Response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal }); }
    catch { throw new Error('network_matrix_delivery_ambiguous'); }
    finally { clearTimeout(timer); }
    if (!response.ok) fail('matrix_provider_rejected');
    try { return jsonObject(await response.json()); } catch { fail('matrix_provider_receipt_unconfirmed'); }
  }
  function transaction(context:MatrixDeliveryContext|undefined,file=false): string {
    try{return(file?requireFileDeliveryContext(context):requireTextDeliveryContext(context)).idempotencyKey;}
    catch{fail('matrix_delivery_context_invalid');}
  }
  async function sendEvent(room: string, content: Record<string, unknown>, context?: MatrixDeliveryContext,file=false) {
    if (!SAFE_ID.test(room)) fail('matrix_recipient_invalid');
    const txn = transaction(context,file);
    const url = new URL(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(txn)}`, base);
    const response = await request(url, { method: 'PUT', headers: { authorization: `Bearer ${config.accessToken}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(content) });
    if (typeof response.event_id !== 'string' || !SAFE_ID.test(response.event_id)) fail('matrix_provider_receipt_unconfirmed');
    return { provider_message_id: response.event_id };
  }
  return {
    async send(text, recipient, context) {
      if (typeof text !== 'string' || !text.trim() || text.length > 120000) fail('matrix_content_invalid');
      return sendEvent(recipient, { msgtype: 'm.text', body: text }, context);
    },
    async sendFile(path, recipient, displayName, context) {
      let fixed:FileDeliveryEffectContext;
      try{fixed=requireFileDeliveryContext(context);}catch{fail('matrix_delivery_context_invalid');}
      if(!SAFE_ID.test(recipient))fail('matrix_recipient_invalid');
      if (!displayName || displayName.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(displayName)) fail('matrix_attachment_invalid');
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size < 1 || info.size > maxAttachmentBytes) fail('matrix_attachment_invalid');
      const raw = await readFile(path);
      if (raw.length !== info.size || raw.length > maxAttachmentBytes) fail('matrix_attachment_invalid');
      if(fixed.filePart.displayName!==displayName||fixed.filePart.partSizeBytes!==raw.length||createHash('sha256').update(raw).digest('hex')!==fixed.filePart.partSha256)fail('matrix_attachment_source_mismatch');
      const url = new URL('/_matrix/media/v3/upload', base); url.searchParams.set('filename', basename(displayName));
      const bytes = new Uint8Array(new ArrayBuffer(raw.length)); bytes.set(raw);
      const upload = await request(url, { method: 'POST', headers: { authorization: `Bearer ${config.accessToken}`,
        accept: 'application/json', 'content-type': 'application/octet-stream' }, body: bytes });
      if (typeof upload.content_uri !== 'string' || !upload.content_uri.startsWith('mxc://')) fail('matrix_provider_receipt_unconfirmed');
      return sendEvent(recipient, { msgtype: 'm.file', body: basename(displayName), filename: basename(displayName),
        url: upload.content_uri, info: { mimetype: 'application/octet-stream', size: raw.length } }, fixed,true);
    },
  };
}
