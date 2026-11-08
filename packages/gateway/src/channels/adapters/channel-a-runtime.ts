import type { FastifyInstance, FastifyRequest } from 'fastify';
import {createHash} from 'node:crypto';
import { verifyApiServerEvent, type ApiServerVerificationOptions } from './api-server.ts';
import { verifyBlueBubblesWebhook } from './bluebubbles.ts';
import { verifyCliEnvelope } from './cli.ts';
import { verifyDingTalkCallback, type DingTalkVerificationOptions } from './dingtalk.ts';
import { verifyDiscordInteraction, type DiscordVerificationOptions } from './discord.ts';
import { verifyEmailRelayEvent, type EmailRelayOptions } from './email.ts';
import { verifyFeishuCallback, type FeishuVerificationOptions } from './feishu.ts';
import { verifyHomeAssistantWebhook, type HomeAssistantBinding } from './homeassistant.ts';
import { verifyMattermostOutgoingWebhook } from './mattermost.ts';
import { isMatrixAdapter, type MatrixAdapterClient } from './matrix.ts';
import {canonicalJson} from '../../db/canonical-json.ts';
import {isTerminalChannelMatrixRefusal,validateChannelMatrixTerminalRefusal,
 type ChannelAttachmentForwardInputV2,type ChannelAttachmentForwardPort,type ChannelRuntimeResponse,
 validateChannelIntakeReceipt,type ChannelIntakeReceipt,type ChannelMatrixPollResult,type ChannelMatrixTerminalRefusal} from '../runtime-contracts.ts';
import {validateChannelAConfiguration} from './channel-a-configuration.ts';
export {validateChannelAConfiguration} from './channel-a-configuration.ts';

declare module 'fastify' {
  // Metadata only. This module does not change any host authentication hook.
  interface FastifyContextConfig { channelAIngress?: boolean }
}

export const channelANames = Object.freeze(['api-server', 'bluebubbles', 'cli', 'dingtalk', 'discord',
  'email', 'feishu', 'homeassistant', 'matrix', 'mattermost'] as const);
export type ChannelAName = typeof channelANames[number];
type WithoutClock<T> = Omit<T, 'nowSeconds'>;
export type ChannelAVerificationConfig = Partial<{
  'api-server': WithoutClock<ApiServerVerificationOptions>;
  bluebubbles: { secret: string; serverId?: string };
  cli: { token: string };
  dingtalk: WithoutClock<DingTalkVerificationOptions>;
  discord: WithoutClock<DiscordVerificationOptions>;
  email: WithoutClock<EmailRelayOptions>;
  feishu: WithoutClock<FeishuVerificationOptions>;
  homeassistant: { webhookId: string; binding: HomeAssistantBinding };
  matrix: { client: MatrixAdapterClient };
  mattermost: { token: string };
}>;
export type ChannelAIntakeMessage = Readonly<{
  channel: ChannelAName; principal: string; thread_id: string; message_id: string;
  text: string; attachments: readonly unknown[];
}>;
export type ChannelAIntakeResponse = { statusCode: number; body: Record<string, unknown> };
export type ChannelARuntimeOptions = {
  channels: ChannelAVerificationConfig;
  forward(message: ChannelAIntakeMessage, signal: AbortSignal): Promise<ChannelAIntakeResponse>;
  attachmentForward?: ChannelAttachmentForwardPort;
  lookupMatrixTerminalRefusal?:(providerMessageId:string,sourceSha256:string)=>ChannelMatrixTerminalRefusal|null;
  nowSeconds?: () => number;
};
type VerifiedEvent = { channel: string; principal: string; providerThreadId: string; providerMessageId: string;
  text: string; attachments: readonly unknown[]; authenticated: true };
type Snapshot = { epoch: number; signal: AbortSignal };
type Verification = { event?: VerifiedEvent; acknowledgement?: Record<string, unknown>; ignored?: boolean };

function codeOf(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,95}$/i.test(value) ? value.toUpperCase() : 'CHANNEL_INGRESS_FAILED';
}
function inputHeaders(request: FastifyRequest): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) throw Error('channel_ingress_headers_invalid');
    result[key] = value;
  }
  return result;
}
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Error('channel_ingress_stopped'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('channel_ingress_stopped'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function responseCode(response: ChannelAIntakeResponse): string {
  const error = response.body.error;
  const code = error && typeof error === 'object' ? (error as Record<string, unknown>).code : '';
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : 'CHANNEL_INTAKE_REJECTED';
}
function matrixSourceSha256(event:VerifiedEvent):string{
 return createHash('sha256').update(canonicalJson({channel:'matrix',principal:event.principal,
  thread_id:event.providerThreadId,message_id:event.providerMessageId,text:event.text,attachments:event.attachments})).digest('hex');
}

export class ChannelARuntime {
  private state: 'stopped' | 'started' | 'uninstalled' = 'stopped';
  private epoch = 0;
  private lifetime = new AbortController();
  readonly channels: ChannelAVerificationConfig;
  private readonly forward: ChannelARuntimeOptions['forward'];
  private readonly attachmentForward?: ChannelARuntimeOptions['attachmentForward'];
  private readonly lookupMatrixTerminalRefusal?:ChannelARuntimeOptions['lookupMatrixTerminalRefusal'];
  private readonly now: () => number;
  constructor(options: ChannelARuntimeOptions) {
    if (!options || !options.channels || typeof options.channels !== 'object' || Array.isArray(options.channels)
      || Object.keys(options.channels).some(name => !(channelANames as readonly string[]).includes(name))
      || Object.values(options.channels).some(value => !value || typeof value !== 'object')
      || typeof options.forward !== 'function') throw Error('channel_ingress_config_invalid');
    this.channels = validateChannelAConfiguration(options.channels);
    this.forward = options.forward;
    this.attachmentForward = options.attachmentForward;
    this.lookupMatrixTerminalRefusal=options.lookupMatrixTerminalRefusal;
    this.now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }
  start(): void {
    if (this.state === 'uninstalled') throw Error('channel_ingress_uninstalled');
    if (this.state === 'started') return;
    this.lifetime = new AbortController(); this.epoch += 1; this.state = 'started';
  }
  async stop(): Promise<void> {
    if (this.state === 'uninstalled') return;
    this.state = 'stopped'; this.epoch += 1; this.lifetime.abort();
  }
  async uninstall(): Promise<void> {
    this.state = 'uninstalled'; this.epoch += 1; this.lifetime.abort();
  }
  snapshot(): Snapshot {
    if (this.state !== 'started') throw Error(`channel_ingress_${this.state}`);
    return { epoch: this.epoch, signal: this.lifetime.signal };
  }
  private assertCurrent(snapshot: Snapshot): void {
    if (this.state !== 'started' || snapshot.epoch !== this.epoch || snapshot.signal.aborted) throw Error('channel_ingress_stopped');
  }
  private async forwardMatrixAttachments(event: VerifiedEvent, snapshot: Snapshot): Promise<ChannelRuntimeResponse> {
    const client = this.channels.matrix?.client;
    if (event.channel !== 'matrix' || !isMatrixAdapter(client) || !this.attachmentForward) {
      return { statusCode: 503, body: { error: { code: 'CHANNEL_ATTACHMENT_STAGING_MISSING' } } };
    }
    const attachments: ChannelAttachmentForwardInputV2['attachments'][number][] = [];
    const ids = new Set<string>();
    let total = 0;
    for (const raw of event.attachments) {
      this.assertCurrent(snapshot);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('matrix_attachment_invalid');
      const value = raw as Record<string, unknown>;
      const keys = Object.keys(value).sort().join(',');
      if (!(keys === 'fileName,mediaType,providerFileId' || keys === 'fileName,mediaType,providerFileId,sizeBytes')
        || typeof value.providerFileId !== 'string' || typeof value.fileName !== 'string'
        || typeof value.mediaType !== 'string'
        || value.sizeBytes !== undefined && (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 1
          || Number(value.sizeBytes) > 100 * 1024 * 1024)) throw Error('matrix_attachment_invalid');
      const providerFileId = value.providerFileId, fileName = value.fileName;
      if (ids.has(providerFileId)) throw Error('matrix_attachment_invalid');
      ids.add(providerFileId);
      const downloaded = await raceAbort(client.downloadAttachment(providerFileId, fileName, snapshot.signal), snapshot.signal);
      this.assertCurrent(snapshot);
      if (!(downloaded.bytes instanceof Uint8Array) || downloaded.bytes.byteLength < 1
        || downloaded.bytes.byteLength > 100 * 1024 * 1024 || typeof downloaded.mediaType !== 'string'
        || /[\u0000-\u001f\u007f]/u.test(downloaded.mediaType)
        || value.sizeBytes !== undefined && Number(value.sizeBytes) !== downloaded.bytes.byteLength) {
        throw Error('matrix_attachment_size_mismatch');
      }
      total += downloaded.bytes.byteLength;
      if (total > 200 * 1024 * 1024) throw Error('matrix_attachment_too_large');
      const mediaType = value.mediaType.toLowerCase();
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) throw Error('matrix_attachment_invalid');
      attachments.push(Object.freeze({ provider_file_id: providerFileId, file_name: fileName,
        media_type: mediaType, ...(value.sizeBytes === undefined ? {} : { size_bytes: Number(value.sizeBytes) }),
        bytes: new Uint8Array(downloaded.bytes) }));
    }
    const input: ChannelAttachmentForwardInputV2 = Object.freeze({ channel: 'matrix', principal: event.principal,
      thread_id: event.providerThreadId, message_id: event.providerMessageId, text: event.text, authenticated: true,
      attachments: Object.freeze(attachments) });
    return this.attachmentForward(input, snapshot.signal);
  }
  private async deliver(event: VerifiedEvent, channel: ChannelAName, snapshot: Snapshot): Promise<ChannelAIntakeResponse> {
    this.assertCurrent(snapshot);
    if (event.authenticated !== true || event.channel !== channel) throw Error('channel_ingress_event_invalid');
    const message = Object.freeze({ channel, principal: event.principal, thread_id: event.providerThreadId,
      message_id: event.providerMessageId, text: event.text, attachments: Object.freeze([...event.attachments]) });
    const result = await raceAbort(Promise.resolve().then((): Promise<ChannelRuntimeResponse> => {
      this.assertCurrent(snapshot);
      if (event.attachments.length) {
        if (channel !== 'matrix') return Promise.resolve({ statusCode: 422,
          body: { error: { code: 'CHANNEL_ATTACHMENT_STAGING_MISSING' } } });
        return this.forwardMatrixAttachments(event, snapshot);
      }
      return this.forward(message, snapshot.signal);
    }), snapshot.signal);
    this.assertCurrent(snapshot);
    if (!result || !Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode > 599
      || !result.body || typeof result.body !== 'object' || Array.isArray(result.body)) throw Error('channel_intake_receipt_invalid');
    if (result.statusCode < 300 && result.body.accepted !== true && result.body.status !== 'verified') throw Error('channel_intake_receipt_invalid');
    return result;
  }
  private verify(channel: Exclude<ChannelAName, 'matrix'>, body: Buffer, headers: Record<string, string | undefined>,
    query: URLSearchParams, credential: string): Verification {
    const nowSeconds = this.now();
    switch (channel) {
      case 'api-server': return { event: verifyApiServerEvent(body, headers, { ...this.channels['api-server']!, nowSeconds }) };
      case 'bluebubbles': {
        const options = this.channels.bluebubbles!;
        const result = verifyBlueBubblesWebhook(credential, options.secret, body, options);
        return result.kind === 'ignored' ? { ignored: true } : { event: result.event };
      }
      case 'cli': return { event: verifyCliEnvelope(body, (headers.authorization ?? '').replace(/^Bearer /, ''), this.channels.cli!.token) };
      case 'dingtalk': {
        const result = verifyDingTalkCallback(body, query, { ...this.channels.dingtalk!, nowSeconds });
        return { ...(result.event ? { event: result.event } : {}), acknowledgement: { ...result.acknowledgement } };
      }
      case 'discord': {
        const result = verifyDiscordInteraction(body, headers, { ...this.channels.discord!, nowSeconds });
        return 'kind' in result ? { acknowledgement: { type: 1 } }
          : { event: result, acknowledgement: { type: 4, data: { content: 'Request accepted.', flags: 64 } } };
      }
      case 'email': return { event: verifyEmailRelayEvent(body, headers, { ...this.channels.email!, nowSeconds }) };
      case 'feishu': {
        const result = verifyFeishuCallback(body, headers, { ...this.channels.feishu!, nowSeconds });
        return 'kind' in result ? { acknowledgement: { challenge: result.challenge } }
          : { event: result, acknowledgement: { code: 0 } };
      }
      case 'homeassistant': {
        const options = this.channels.homeassistant!;
        let payload: unknown; try { payload = JSON.parse(body.toString('utf8')); } catch { throw Error('homeassistant_event_invalid'); }
        return { event: verifyHomeAssistantWebhook(credential, options.webhookId, payload, options.binding) };
      }
      case 'mattermost': return { event: verifyMattermostOutgoingWebhook(body, headers, this.channels.mattermost!.token), acknowledgement: {} };
    }
  }
  async handle(channel: Exclude<ChannelAName, 'matrix'>, request: FastifyRequest): Promise<ChannelAIntakeResponse> {
    const snapshot = this.snapshot();
    if (!this.channels[channel] || !Buffer.isBuffer(request.body)) throw Error('channel_ingress_event_invalid');
    const credential = String((request.params as { credential?: string }).credential ?? '');
    const result = this.verify(channel, request.body, inputHeaders(request), new URL(request.raw.url ?? '/', 'http://channel.invalid').searchParams, credential);
    if (result.ignored) return { statusCode: 200, body: { ignored: true } };
    if (!result.event) return { statusCode: 200, body: result.acknowledgement ?? {} };
    const accepted = await this.deliver(result.event, channel, snapshot);
    if (accepted.statusCode >= 300) return { statusCode: accepted.statusCode >= 400 ? accepted.statusCode : 502,
      body: { error: { code: responseCode(accepted) } } };
    return result.acknowledgement ? { statusCode: 200, body: result.acknowledgement } : accepted;
  }
  async pollMatrix(since?: string): Promise<ChannelMatrixPollResult> {
    const snapshot = this.snapshot(),client = this.channels.matrix?.client;
    if (!client || typeof client.syncOnce !== 'function') throw Error('channel_ingress_matrix_unconfigured');
    const batch = await raceAbort(client.syncOnce(since, snapshot.signal), snapshot.signal);
    this.assertCurrent(snapshot);
    const receipts: ChannelIntakeReceipt[] = [];
    const terminalRefusals:ChannelMatrixTerminalRefusal[]=[];
    for (const event of batch.events) {
      const sourceSha256=matrixSourceSha256(event);
      const stored=this.lookupMatrixTerminalRefusal?.(event.providerMessageId,sourceSha256);
      if(stored!==undefined&&stored!==null){
        const refusal=validateChannelMatrixTerminalRefusal(stored);
        if(refusal.provider_message_id!==event.providerMessageId||refusal.source_sha256!==sourceSha256)throw Error('matrix_refusal_source_conflict');
        terminalRefusals.push(refusal);
        continue;
      }
      if(event.text.startsWith('/jot-bind')){
        if(!isMatrixAdapter(client)||typeof client.verifyPrivatePairRoom!=='function')throw Error('matrix_binding_verifier_unavailable');
        const privatePair=await raceAbort(client.verifyPrivatePairRoom(event.providerThreadId,event.principal,snapshot.signal),snapshot.signal);
        if(!privatePair){
          terminalRefusals.push(validateChannelMatrixTerminalRefusal({provider_message_id:event.providerMessageId,
            source_sha256:sourceSha256,status_code:403,error_code:'CHANNEL_BINDING_PRIVATE_ROOM_REQUIRED'}));
          continue;
        }
      }
      const response = await this.deliver(event, 'matrix', snapshot);
      if (response.statusCode >= 300) {
        const errorCode=responseCode(response);
        if(isTerminalChannelMatrixRefusal(response.statusCode,errorCode)){
          terminalRefusals.push(validateChannelMatrixTerminalRefusal({provider_message_id:event.providerMessageId,
            source_sha256:sourceSha256,status_code:response.statusCode,error_code:errorCode}));
          continue;
        }
        throw Error(errorCode);
      }
      receipts.push(validateChannelIntakeReceipt(response.body));
    }
    // The existing host owns durable cursor recovery; never advance it on a partial failure.
    return { nextBatch: batch.nextBatch, receipts,...(terminalRefusals.length?{terminalRefusals}:{}) };
  }
}

/** Register on the existing host. Does not listen, schedule, enqueue, or change owner middleware. */
export function registerChannelARoutes(app: FastifyInstance, options: ChannelARuntimeOptions): ChannelARuntime {
  const runtime = new ChannelARuntime(options);
  app.register(async scoped => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    scoped.addHook('onClose', async () => runtime.uninstall());
    for (const channel of channelANames) {
      if (channel === 'matrix' || !runtime.channels[channel]) continue;
      const pathCredential = channel === 'bluebubbles' || channel === 'homeassistant';
      scoped.post(`/internal/v1/channel-a/${channel}${pathCredential ? '/:credential' : ''}`, {
        config: { channelAIngress: true }, logLevel: 'silent', bodyLimit: channel === 'cli' ? 32 * 1024 * 1024 : 256 * 1024,
      }, async (request, reply) => {
        try { const result = await runtime.handle(channel, request); return reply.code(result.statusCode).send(result.body); }
        catch (error) {
          const code = codeOf(error),status = code === 'CHANNEL_INGRESS_UNINSTALLED' ? 410
            : code === 'CHANNEL_INGRESS_STOPPED' || code.includes('CONFIG_INVALID') ? 503
            : /UNAUTHORIZED|SIGNATURE|TIMESTAMP/.test(code) ? 401 : code.includes('NETWORK') ? 502 : 422;
          return reply.code(status).send({ error: { code } });
        }
      });
    }
  });
  return runtime;
}
