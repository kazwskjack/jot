import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { ArtifactService } from '../artifacts/service.ts';
import type { ChannelIntakeService } from './intake.ts';
import { createTwilioSmsWebhookAdapter, twilioSmsLimits, type TwilioSmsTransport,
  type TwilioRequestValidator, validateTwilioRequestSignature } from './sms.ts';

const MAX_CALLBACK_BYTES = 1024 * 1024;
type SmsIntake = Pick<ChannelIntakeService,
  'accept' | 'reserveAttachmentBatchV2' | 'writeAttachmentBatchPartV2' | 'acceptAttachmentBatchV2'>;
type SmsMedia = { provider_file_id: string; file_name: string; media_type: string; media_url: string };

export interface TwilioSmsRouteOptions {
  accountSid: string;
  authToken: string;
  webhookUrl: string;
  apiKeySid:string;
  apiKeySecret:string;
  validateRequest?: TwilioRequestValidator;
  intake: SmsIntake;
  artifacts: ArtifactService;
  mediaTransport?: TwilioSmsTransport;
}

export function isTwilioSmsWebhookRequest(request:{method:string;routeOptions:{url?:string|undefined}}):boolean{
  return request.method==='POST'&&request.routeOptions.url==='/hooks/v1/channels/sms';
}

/** Register the signed Twilio callback on the app that owns Jot's existing channel intake. */
export function registerTwilioSmsRoutes(app: FastifyInstance, options: TwilioSmsRouteOptions): void {
  if (!options.intake || !options.artifacts || !options.intake.reserveAttachmentBatchV2
    || !options.intake.writeAttachmentBatchPartV2 || !options.intake.acceptAttachmentBatchV2
    || !options.intake.accept) throw new Error('sms_route_configuration_invalid');
  const transport = options.mediaTransport ?? fetch;
  const adapter = createTwilioSmsWebhookAdapter({
    accountSid: options.accountSid,
    authToken: options.authToken,
    webhookUrl: options.webhookUrl,
    validateRequest: options.validateRequest ?? ((token, signature, url, params) =>
      validateTwilioRequestSignature(token, signature, url, params)),
    intake: {
      accept(input) {
        const attachments = Array.isArray(input.attachments) ? input.attachments as SmsMedia[] : [];
        return attachments.length
          ? acceptTwilioMedia(input, attachments, options.intake, options.artifacts, transport, options.accountSid, options.apiKeySid, options.apiKeySecret)
          : options.intake.accept(input);
      },
    },
  });

  app.register(async scoped => {
    scoped.addContentTypeParser('application/x-www-form-urlencoded', {
      parseAs: 'buffer', bodyLimit: MAX_CALLBACK_BYTES,
    }, (_request, body, done) => done(null, body));
    scoped.post('/hooks/v1/channels/sms', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        const response = await adapter.handle({headers: request.headers, body: request.body as Uint8Array});
        return reply.code(response.status).type(response.contentType).send(response.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const statusCode = Number((error as {statusCode?: unknown})?.statusCode);
        const status = statusCode >= 400 && statusCode < 500 ? statusCode
          : ['sms_signature_invalid', 'sms_account_sid_mismatch'].includes(message) ? 403
          : ['sms_callback_body_invalid', 'sms_content_type_invalid', 'sms_form_invalid', 'sms_media_invalid',
            'sms_media_count_invalid', 'sms_message_sid_invalid', 'sms_from_invalid', 'sms_to_invalid', 'sms_body_invalid']
            .includes(message) ? 400
          : message === 'sms_media_too_large' ? 413
          : message === 'sms_media_type_mismatch' ? 422
          : 503;
        return reply.code(status).send({error:{code:status===403?'SMS_SIGNATURE_INVALID':
          status===400?'SMS_REQUEST_INVALID':status===409?'SMS_EVENT_CONFLICT':
            status===413?'SMS_MEDIA_TOO_LARGE':status===422?'SMS_MEDIA_INVALID':'SMS_INTAKE_UNAVAILABLE'}});
      }
    });
  });
}

async function acceptTwilioMedia(
  input: Record<string, unknown>, media: SmsMedia[], intake: SmsIntake, artifacts: ArtifactService,
  transport: TwilioSmsTransport, accountSid: string, apiKeySid:string, apiKeySecret:string,
) {
  if (media.length > twilioSmsLimits.maxMedia) throw new Error('sms_media_count_invalid');
  const event = {channel:'sms', principal:String(input.principal), thread_id:String(input.thread_id),
    message_id:String(input.message_id)};
  const prepared: Array<{media: SmsMedia; bytes: Buffer}> = [];
  let totalBytes = 0;
  for (const item of media) {
    const url = checkedMediaUrl(item.media_url, accountSid, event.message_id);
    const response = await transport(url, {
      method:'GET', redirect:'error',
      headers:{Authorization:`Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`, 'utf8').toString('base64')}`},
      signal:AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('sms_media_unavailable');
    const responseType = String(response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (responseType !== item.media_type) throw new Error('sms_media_type_mismatch');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > twilioSmsLimits.maxMediaBytes) {
      throw new Error('sms_media_too_large');
    }
    const bytes = await readBoundedMedia(response, twilioSmsLimits.maxMediaBytes);
    totalBytes += bytes.length;
    if (totalBytes > twilioSmsLimits.maxAggregateMediaBytes) throw new Error('sms_media_too_large');
    prepared.push({media:item,bytes});
  }

  const source = {
    protocol:2,
    event,
    text:typeof input.text === 'string' ? input.text.trim() : '',
    attachments:prepared.map(({media:item,bytes},index)=>({index,provider_file_id:item.provider_file_id,
      file_name:item.file_name,media_type:item.media_type,size_bytes:bytes.length,
      sha256:createSha256(bytes)})),
  };
  const stage = intake.reserveAttachmentBatchV2(source, artifacts);
  if (stage.state !== 'finalized') {
    for (let index = 0; index < prepared.length; index += 1) {
      const {bytes} = prepared[index]!;
      const write = async function*(){yield bytes;};
      await intake.writeAttachmentBatchPartV2(stage.source.owner_id,stage.source.channel_binding_id,
        stage.stage_key,index,write(),artifacts);
    }
  }
  return intake.acceptAttachmentBatchV2(stage.source.owner_id,stage.source.channel_binding_id,
    stage.stage_key,artifacts);
}

async function readBoundedMedia(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('sms_media_unavailable');
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('sms_media_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('sms_media_unavailable');
  return Buffer.concat(chunks,size);
}

function checkedMediaUrl(value: string, accountSid: string, messageSid: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('sms_media_invalid'); }
  const path = `/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/ME[0-9a-fA-F]{32}`;
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.port || url.username
    || url.password || url.search || url.hash || !new RegExp(`^${path}$`).test(url.pathname)) {
    throw new Error('sms_media_invalid');
  }
  return url;
}

function createSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
