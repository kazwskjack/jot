import type { FastifyPluginAsync } from 'fastify';
import { createSlackWebhookAdapter } from './slack.ts';

const MAX_SLACK_CALLBACK_BYTES = 1024 * 1024;

export interface SlackWebhookRouteOptions {
  adapter?: ReturnType<typeof createSlackWebhookAdapter> | undefined;
}

/** Keep Slack's raw JSON bytes intact until its request signature is verified. */
export const slackWebhookRoutes: FastifyPluginAsync<SlackWebhookRouteOptions> = async (app, options) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.post('/hooks/v1/channels/slack', { bodyLimit: MAX_SLACK_CALLBACK_BYTES }, async (request, reply) => {
    if (!options.adapter) return reply.code(503).send({ error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE' } });
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return reply.code(415).send({ error: { code: 'CHANNEL_EVENT_CONTENT_TYPE_INVALID' } });
    }
    try {
      const result = await options.adapter.handle({
        headers: request.headers as Record<string, string | undefined>,
        body: Buffer.isBuffer(request.body) ? request.body : new Uint8Array(),
      });
      return reply.code(result.status).send(result.body);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_error';
      const mapped: Record<string, { status: number; code: string }> = {
        slack_new_session_busy: { status: 409, code: 'CHANNEL_SESSION_BUSY' },
        slack_interaction_reply_invalid: { status: 422, code: 'CHANNEL_INTERACTION_REPLY_INVALID' },
        slack_interaction_reply_unavailable: { status: 503, code: 'CHANNEL_INTERACTION_UNAVAILABLE' },
        slack_interaction_event_conflict: { status: 409, code: 'CHANNEL_INTERACTION_EVENT_CONFLICT' },
        slack_interaction_not_found: { status: 404, code: 'CHANNEL_INTERACTION_NOT_FOUND' },
        slack_interaction_request_corrupt: { status: 409, code: 'CHANNEL_INTERACTION_STATE_CONFLICT' },
        slack_interaction_receipt_corrupt: { status: 409, code: 'CHANNEL_INTERACTION_STATE_CONFLICT' },
        slack_interaction_question_unsupported: { status: 422, code: 'CHANNEL_INTERACTION_ANSWER_INVALID' },
        interaction_answer_invalid: { status: 422, code: 'CHANNEL_INTERACTION_ANSWER_INVALID' },
        slack_signature_invalid: { status: 401, code: 'CHANNEL_SIGNATURE_INVALID' },
        slack_workspace_mismatch: { status: 401, code: 'CHANNEL_SIGNATURE_INVALID' },
        slack_app_id_invalid: { status: 401, code: 'CHANNEL_SIGNATURE_INVALID' },
        slack_callback_body_invalid: { status: 400, code: 'CHANNEL_EVENT_INVALID' },
        slack_callback_json_invalid: { status: 400, code: 'CHANNEL_EVENT_INVALID' },
        slack_callback_payload_invalid: { status: 400, code: 'CHANNEL_EVENT_INVALID' },
        slack_callback_type_invalid: { status: 400, code: 'CHANNEL_EVENT_INVALID' },
        slack_challenge_invalid: { status: 400, code: 'CHANNEL_EVENT_INVALID' },
        slack_event_invalid: { status: 400, code: 'CHANNEL_EVENT_INVALID' },
        slack_attachment_intake_unavailable: { status: 503, code: 'CHANNEL_ATTACHMENT_UNAVAILABLE' },
        channel_owner_binding_required: { status: 403, code: 'CHANNEL_OWNER_BINDING_REQUIRED' },
        channel_owner_binding_mismatch: { status: 403, code: 'CHANNEL_OWNER_BINDING_MISMATCH' },
        slack_file_metadata_invalid: { status: 422, code: 'CHANNEL_ATTACHMENT_INVALID' },
        slack_file_origin_invalid: { status: 422, code: 'CHANNEL_ATTACHMENT_ORIGIN_INVALID' },
        slack_file_version_conflict: { status: 409, code: 'CHANNEL_ATTACHMENT_VERSION_CONFLICT' },
        slack_file_lookup_failed: { status: 502, code: 'CHANNEL_ATTACHMENT_PROVIDER_FAILED' },
        slack_file_lookup_invalid: { status: 502, code: 'CHANNEL_ATTACHMENT_PROVIDER_INVALID' },
        slack_file_download_failed: { status: 502, code: 'CHANNEL_ATTACHMENT_PROVIDER_FAILED' },
        slack_file_size_invalid: { status: 422, code: 'CHANNEL_ATTACHMENT_SIZE_INVALID' },
        slack_file_media_mismatch: { status: 422, code: 'CHANNEL_ATTACHMENT_MEDIA_INVALID' },
        slack_file_pin_invalid: { status: 422, code: 'CHANNEL_ATTACHMENT_PIN_INVALID' },
        channel_attachment_authority_mismatch: { status: 403, code: 'CHANNEL_ATTACHMENT_SCOPE_UNAVAILABLE' },
        channel_attachment_context_not_ready: { status: 409, code: 'CHANNEL_ATTACHMENT_CONTEXT_CHANGED' },
        channel_attachment_context_changed: { status: 409, code: 'CHANNEL_ATTACHMENT_CONTEXT_CHANGED' },
        channel_attachment_batch_incomplete: { status: 409, code: 'CHANNEL_ATTACHMENT_BATCH_INCOMPLETE' },
        channel_attachment_stage_expired: { status: 410, code: 'CHANNEL_ATTACHMENT_STAGE_EXPIRED' },
        channel_attachment_stage_unavailable: { status: 409, code: 'CHANNEL_ATTACHMENT_STAGE_UNAVAILABLE' },
        channel_attachment_stage_unproven: { status: 409, code: 'CHANNEL_ATTACHMENT_STAGE_UNAVAILABLE' },
        channel_attachment_receipt_unproven: { status: 409, code: 'CHANNEL_ATTACHMENT_RECEIPT_UNAVAILABLE' },
        channel_attachment_manifest_invalid: { status: 422, code: 'CHANNEL_ATTACHMENT_MANIFEST_INVALID' },
        channel_attachment_stage_invalid: { status: 422, code: 'CHANNEL_ATTACHMENT_STAGE_INVALID' },
        upload_sha256_mismatch: { status: 422, code: 'CHANNEL_ATTACHMENT_HASH_MISMATCH' },
        upload_size_mismatch: { status: 422, code: 'CHANNEL_ATTACHMENT_SIZE_MISMATCH' },
        channel_attachment_media_mismatch: { status: 422, code: 'CHANNEL_ATTACHMENT_MEDIA_INVALID' },
        inbound_attachment_scope_conflict: { status: 409, code: 'CHANNEL_ATTACHMENT_VERSION_CONFLICT' },
        slack_event_id_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        slack_team_id_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        slack_channel_id_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        slack_user_id_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        slack_message_timestamp_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        slack_thread_timestamp_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        channel_message_invalid: { status: 422, code: 'CHANNEL_EVENT_INVALID' },
        channel_message_identity_conflict: { status: 409, code: 'CHANNEL_EVENT_IDENTITY_CONFLICT' },
        channel_adapter_unavailable: { status: 503, code: 'CHANNEL_ADAPTER_UNAVAILABLE' },
        channel_signature_invalid: { status: 401, code: 'CHANNEL_SIGNATURE_INVALID' },
        channel_binding_proof_invalid: { status: 422, code: 'CHANNEL_BINDING_PROOF_INVALID' },
        channel_principal_already_bound: { status: 409, code: 'CHANNEL_PRINCIPAL_ALREADY_BOUND' },
      };
      const response = mapped[code];
      if (response) return reply.code(response.status).send({ error: { code: response.code } });
      throw error;
    }
  });
};
