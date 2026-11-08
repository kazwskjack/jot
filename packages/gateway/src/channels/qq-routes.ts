import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createQQWebhookAdapter } from './qq.ts';
import type { ChannelIntakeService } from './intake.ts';
import type { QQWebhookResponse } from './qq.ts';

const MAX_CALLBACK_BYTES = 1024 * 1024;
const authenticatedRequests = new WeakSet<FastifyRequest>();
const callbackResponses = new WeakMap<FastifyRequest, QQWebhookResponse>();

export function isQQWebhookRequestAuthenticated(request: FastifyRequest): boolean {
  return authenticatedRequests.has(request);
}

export interface QQWebhookRouteOptions {
  appId: string;
  botSecret: string;
  intake: Pick<ChannelIntakeService, 'accept'>;
}

/** Register the QQ callback route with a scoped raw JSON parser. */
export function registerQQRoutes(app: FastifyInstance, options: QQWebhookRouteOptions): void {
  const adapter = createQQWebhookAdapter({
    appId: options.appId,
    botSecret: options.botSecret,
    intake: {
      accept(input) {
        return options.intake.accept(input);
      },
    },
  });

  app.register(async scoped => {
    scoped.addContentTypeParser('application/json', {
      parseAs: 'buffer',
      bodyLimit: MAX_CALLBACK_BYTES,
    }, (_request, body, done) => done(null, body));

    scoped.addHook('preValidation', async request => {
      if (!(request.body instanceof Uint8Array)) throw new Error('qq_callback_body_invalid');
      const response = await adapter.handle({
        headers: {
          'x-bot-appid': headerValue(request.headers['x-bot-appid']),
          'x-signature-timestamp': headerValue(request.headers['x-signature-timestamp']),
          'x-signature-ed25519': headerValue(request.headers['x-signature-ed25519']),
        },
        body: request.body,
      });
      callbackResponses.set(request, response);
      authenticatedRequests.add(request);
    });

    scoped.post('/hooks/v1/channels/qq', async (request, reply) => {
      const response = callbackResponses.get(request);
      if (!response || !authenticatedRequests.has(request)) throw new Error('qq_callback_authentication_missing');
      return reply.code(response.status).send(response.body);
    });
  });
}

export const registerQQWebhookRoutes = registerQQRoutes;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}
