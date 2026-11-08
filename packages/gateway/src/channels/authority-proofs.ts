import {requireMattermostBindingThread} from './mattermost-thread-scope.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactService } from '../artifacts/service.ts';
import type { ChannelDeliveryService } from './delivery.ts';
import { canonicalJson } from '../db/canonical-json.ts';

type Row = Record<string, any>;
type Attachment = { provider_file_id: string; file_name: string; media_type: string; size_bytes?: number };
type ManifestPart = { part_index: number; display_name: string; sha256: string; size_bytes: number; mime_type: string };
type ArtifactPin = {
  kind: 'artifact'; schema_version: 1; owner_id: string; conversation_id: string; artifact_id: string;
  version: number; sha256: string; size_bytes: number; manifest_sha256: string; manifest: ManifestPart[];
};

const SHA256 = /^[a-f0-9]{64}$/;
const CHANNEL = /^[a-z][a-z0-9_-]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PROVIDER_OPAQUE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const PIN_KEYS = ['kind', 'schema_version', 'owner_id', 'conversation_id', 'artifact_id', 'version',
  'sha256', 'size_bytes', 'manifest_sha256', 'manifest'].sort().join(',');
const MANIFEST_KEYS = ['part_index', 'display_name', 'sha256', 'size_bytes', 'mime_type'].sort().join(',');

function fail(code: string): never { throw new Error(code); }
function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function hasExactKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected;
}
function requireTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) fail('channel_authority_transaction_required');
}

/** Resolve only an exactly-one verified binding for a provider identity. */
export function readVerifiedChannelBinding(db: DatabaseSync, channel: string, principal: string) {
  requireTransaction(db);
  if (typeof channel !== 'string' || !CHANNEL.test(channel)
    || typeof principal !== 'string' || !PROVIDER_OPAQUE_ID.test(principal) || principal !== principal.trim()) {
    fail('channel_authority_binding_invalid');
  }
  const rows = db.prepare(`SELECT channel_binding_id,owner_id,channel,principal,version
    FROM ga_owner_channel_bindings WHERE channel=? AND principal=? AND status='verified'
    ORDER BY channel_binding_id`).all(channel, principal) as Row[];
  if (rows.length !== 1) fail(rows.length ? 'channel_authority_binding_ambiguous' : 'channel_authority_binding_missing');
  const row = rows[0]!;
  if (typeof row.channel_binding_id !== 'string' || !row.channel_binding_id
    || typeof row.owner_id !== 'string' || !row.owner_id
    || row.channel !== channel || row.principal !== principal
    || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) {
    fail('channel_authority_binding_invalid');
  }
  return Object.freeze({ channel_binding_id: String(row.channel_binding_id), owner_id: String(row.owner_id),
    channel, principal, version: Number(row.version) });
}

/** Matrix intake is confined to the immutable room proved during enrollment. */
export function requireVerifiedChannelThread(db: DatabaseSync, binding: ReturnType<typeof readVerifiedChannelBinding>, threadId: string): void {
  requireTransaction(db);
  if(binding.channel==='mattermost'){requireMattermostBindingThread(db,binding,threadId);return;}
  if (binding.channel !== 'matrix') return;
  const room = db.prepare(`SELECT 1 FROM ga_owner_matrix_binding_rooms
    WHERE channel_binding_id=? AND owner_id=? AND principal=? AND room_id=?`)
    .get(binding.channel_binding_id, binding.owner_id, binding.principal, threadId);
  if (!threadId || !room) fail('channel_authority_binding_invalid');
}
function normalizeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > 10) fail('channel_cached_event_identity_invalid');
  return value.map(raw => {
    if (!isObject(raw)) fail('channel_cached_event_identity_invalid');
    const keys = Object.keys(raw).sort().join(',');
    if (keys !== 'file_name,media_type,provider_file_id'
      && keys !== 'file_name,media_type,provider_file_id,size_bytes') fail('channel_cached_event_identity_invalid');
    const { provider_file_id: fileId, file_name: fileName, media_type: mediaType, size_bytes: size } = raw;
    if (typeof fileId !== 'string' || !OPAQUE_ID.test(fileId) || fileId !== fileId.trim()
      || typeof fileName !== 'string' || !fileName || fileName.length > 255 || CONTROL.test(fileName)
      || /[\\/]/.test(fileName) || typeof mediaType !== 'string' || !mediaType || mediaType.length > 200
      || CONTROL.test(mediaType) || (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > 104857600))) {
      fail('channel_cached_event_identity_invalid');
    }
    return { provider_file_id: fileId, file_name: fileName, media_type: mediaType,
      ...(size === undefined ? {} : { size_bytes: Number(size) }) };
  });
}

/** Prove an immutable cached provider event and every Jot link before replay. */
export function proveCachedChannelEvent(db: DatabaseSync, input: {
  channel: string; principal: string; threadId: string; messageId: string; text: string; attachments: unknown;
}) {
  requireTransaction(db);
  if (!input || typeof input.channel !== 'string' || !CHANNEL.test(input.channel)
    || typeof input.principal !== 'string' || !PROVIDER_OPAQUE_ID.test(input.principal)
    || input.principal !== input.principal.trim() || typeof input.threadId !== 'string'
    || (input.threadId !== '' && !PROVIDER_OPAQUE_ID.test(input.threadId)) || input.threadId !== input.threadId.trim()
    || typeof input.messageId !== 'string' || !PROVIDER_OPAQUE_ID.test(input.messageId) || input.messageId !== input.messageId.trim()
    || typeof input.text !== 'string' || !input.text.trim() || input.text !== input.text.trim() || input.text.length > 4000) {
    fail('channel_cached_event_identity_invalid');
  }
  const attachments = normalizeAttachments(input.attachments);
  if (attachments.length) fail('channel_attachment_staging_missing');
  const binding = readVerifiedChannelBinding(db, input.channel, input.principal);
  requireVerifiedChannelThread(db, binding, input.threadId);
  const expectedHash = digest(JSON.stringify({ channel: input.channel, principal: input.principal,
    threadId: input.threadId, messageId: input.messageId, text: input.text, attachments }));
  const event = db.prepare(`SELECT channel,principal,provider_thread_id,provider_message_id,
    conversation_id,message_id,run_id,attachments_json,event_sha256,channel_binding_id,binding_version
    FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=?
      AND provider_message_id=?`).get(input.channel, input.principal, input.threadId, input.messageId) as Row | undefined;
  if (!event || event.event_sha256 !== expectedHash || event.attachments_json !== JSON.stringify(attachments)) {
    fail('channel_cached_event_source_mismatch');
  }
  if (event.channel_binding_id !== binding.channel_binding_id || Number(event.binding_version) !== binding.version) {
    fail('channel_cached_event_binding_mismatch');
  }

  if (input.threadId) {
    const thread = db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads
      WHERE channel=? AND principal=? AND provider_thread_id=?`).get(input.channel, input.principal, input.threadId) as Row | undefined;
    if (!thread || thread.conversation_id !== event.conversation_id
      || thread.channel_binding_id !== binding.channel_binding_id || Number(thread.binding_version) !== binding.version) {
      fail('channel_cached_thread_mismatch');
    }
  } else {
    const root = db.prepare(`SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_bindings
      WHERE channel=? AND principal=?`).get(input.channel, input.principal) as Row | undefined;
    if (!root || root.conversation_id !== event.conversation_id
      || root.channel_binding_id !== binding.channel_binding_id || Number(root.binding_version) !== binding.version) {
      fail('channel_cached_thread_mismatch');
    }
  }

  const linked = db.prepare(`SELECT c.owner_id,r.id AS run_id,r.conversation_id AS run_conversation_id,
      r.input_message_id,m.id AS message_id,m.run_id AS message_run_id,
      m.conversation_id AS message_conversation_id,m.role,m.status,m.content_json
    FROM ga_conversations c
    JOIN ga_runs r ON r.id=? AND r.conversation_id=c.id AND r.input_message_id=?
    JOIN ga_messages m ON m.id=? AND m.run_id=r.id AND m.conversation_id=c.id
      AND m.role='user' AND m.status='complete'
    WHERE c.id=?`).get(event.run_id, event.message_id, event.message_id, event.conversation_id) as Row | undefined;
  if (!linked || linked.run_id !== event.run_id || linked.run_conversation_id !== event.conversation_id
    || linked.input_message_id !== event.message_id || linked.message_id !== event.message_id
    || linked.message_run_id !== event.run_id || linked.message_conversation_id !== event.conversation_id) {
    fail('channel_cached_event_link_mismatch');
  }
  if (linked.owner_id !== binding.owner_id) fail('channel_authority_owner_mismatch');
  let messageContent: unknown;
  try { messageContent = JSON.parse(String(linked.content_json)); }
  catch { fail('channel_cached_event_message_mismatch'); }
  if (!isObject(messageContent) || !hasExactKeys(messageContent, 'attachments,blocks')
    || !Array.isArray(messageContent.attachments) || messageContent.attachments.length !== 0
    || !Array.isArray(messageContent.blocks) || messageContent.blocks.length !== 1) {
    fail('channel_cached_event_message_mismatch');
  }
  const textBlock = messageContent.blocks[0];
  if (!isObject(textBlock) || !hasExactKeys(textBlock, 'block_id,kind,text')
    || textBlock.block_id !== `${event.message_id}:0` || textBlock.kind !== 'text' || textBlock.text !== input.text) {
    fail('channel_cached_event_message_mismatch');
  }
  return Object.freeze({ ...binding, conversation_id: String(event.conversation_id),
    message_id: String(event.message_id), run_id: String(event.run_id), provider_thread_id: input.threadId,
    provider_message_id: input.messageId, event_sha256: expectedHash });
}

function parseArtifactPin(value: unknown): ArtifactPin {
  if (!isObject(value) || !hasExactKeys(value, PIN_KEYS) || value.kind !== 'artifact'
    || value.schema_version !== 1 || typeof value.owner_id !== 'string' || !value.owner_id
    || typeof value.conversation_id !== 'string' || !value.conversation_id
    || typeof value.artifact_id !== 'string' || !value.artifact_id
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.size_bytes) || Number(value.size_bytes) < 1 || Number(value.size_bytes) > 104857600
    || typeof value.manifest_sha256 !== 'string' || !SHA256.test(value.manifest_sha256)
    || !Array.isArray(value.manifest) || !value.manifest.length || value.manifest.length > 50) {
    fail('channel_delivery_artifact_pin_invalid');
  }
  const manifest = value.manifest.map((raw: unknown, index: number): ManifestPart => {
    if (!isObject(raw) || !hasExactKeys(raw, MANIFEST_KEYS) || raw.part_index !== index + 1
      || typeof raw.display_name !== 'string' || !raw.display_name || raw.display_name.length > 255
      || CONTROL.test(raw.display_name) || /[\\/]/.test(raw.display_name)
      || typeof raw.mime_type !== 'string' || !raw.mime_type || raw.mime_type.length > 200 || CONTROL.test(raw.mime_type)
      || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)
      || !Number.isSafeInteger(raw.size_bytes) || Number(raw.size_bytes) < 1 || Number(raw.size_bytes) > 104857600) {
      fail('channel_delivery_artifact_pin_invalid');
    }
    return { part_index: Number(raw.part_index), display_name: raw.display_name,
      sha256: raw.sha256, size_bytes: Number(raw.size_bytes), mime_type: raw.mime_type };
  });
  const total = manifest.reduce((sum, part) => sum + part.size_bytes, 0);
  if (total !== value.size_bytes || total > 104857600 || digest(canonicalJson(manifest)) !== value.manifest_sha256) {
    fail('channel_delivery_artifact_pin_invalid');
  }
  return { kind: 'artifact', schema_version: 1, owner_id: value.owner_id,
    conversation_id: value.conversation_id, artifact_id: value.artifact_id, version: Number(value.version),
    sha256: value.sha256, size_bytes: Number(value.size_bytes), manifest_sha256: value.manifest_sha256, manifest };
}

function expectedPinnedEffectId(effect: Row, pin: ArtifactPin): string {
  const identity = JSON.stringify(['artifact-pin-v1', effect.run_id, effect.message_id,
    effect.destination, effect.recipient, effect.artifact_ref, digest(canonicalJson(pin))]);
  return `delivery-${digest(identity).slice(0, 32)}`;
}

function copyPart(part: ManifestPart, content: Buffer) {
  return Object.freeze({ ...part, content: Buffer.from(content) });
}

/** Verify a sending file effect against a content-addressed exact-version pin. */
export function provePinnedChannelArtifact(db: DatabaseSync, delivery: ChannelDeliveryService,
  artifacts: ArtifactService, effectId: string) {
  return provePinnedChannelArtifactAtStatus(db, delivery, artifacts, effectId, 'sending');
}

/** Prove the immutable pin before the caller advances its claim generation. */
export function provePendingPinnedChannelArtifact(db: DatabaseSync, delivery: ChannelDeliveryService,
  artifacts: ArtifactService, effectId: string) {
  return provePinnedChannelArtifactAtStatus(db, delivery, artifacts, effectId, 'pending');
}

function provePinnedChannelArtifactAtStatus(db: DatabaseSync, delivery: ChannelDeliveryService,
  artifacts: ArtifactService, effectId: string, expectedStatus: 'pending' | 'sending') {
  requireTransaction(db);
  if (!delivery?.usesDatabase(db) || !artifacts?.usesDatabase(db)) fail('channel_authority_database_mismatch');
  if (typeof effectId !== 'string' || !/^delivery-[a-f0-9]{32}$/.test(effectId)) fail('channel_delivery_source_mismatch');
  const effect = db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(effectId) as Row | undefined;
  if (!effect || effect.status !== expectedStatus || effect.effect_id !== effectId) fail('channel_delivery_artifact_authority_missing');
  if (effect.destination !== 'wecom' && effect.destination !== 'mattermost') fail('channel_delivery_artifact_unsupported');
  if (expectedStatus === 'sending' && (!Number.isSafeInteger(Number(effect.generation))
    || Number(effect.file_claim_protocol_generation) !== Number(effect.generation))) {
    fail('channel_delivery_artifact_claim_unverified');
  }
  if (typeof effect.payload_json !== 'string') fail('channel_delivery_artifact_authority_missing');
  let parsed: unknown;
  try { parsed = JSON.parse(effect.payload_json); } catch { fail('channel_delivery_artifact_pin_invalid'); }
  const pin = parseArtifactPin(parsed);
  if (effect.artifact_ref !== pin.artifact_id || effectId !== expectedPinnedEffectId(effect, pin)) {
    fail('channel_delivery_source_mismatch');
  }
  const binding = readVerifiedChannelBinding(db, String(effect.destination), String(effect.recipient));
  if (binding.owner_id !== pin.owner_id) fail('channel_authority_owner_mismatch');
  const linked = db.prepare(`SELECT r.id AS run_id,r.conversation_id,c.owner_id,m.id AS message_id,
      m.conversation_id AS message_conversation_id,m.run_id AS message_run_id,m.role,m.status,m.content_json
    FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN ga_messages m ON m.id=? AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant' AND m.status='complete'
    WHERE r.id=?`).get(effect.message_id, effect.run_id) as Row | undefined;
  if (!linked || linked.owner_id !== pin.owner_id || linked.conversation_id !== pin.conversation_id
    || linked.message_id !== effect.message_id || linked.message_conversation_id !== pin.conversation_id
    || linked.message_run_id !== effect.run_id) fail('channel_delivery_source_mismatch');
  let messageContent:unknown;
  try{messageContent=JSON.parse(String(linked.content_json));}catch{fail('channel_delivery_attachment_membership_mismatch');}
  if(!isObject(messageContent)||!Array.isArray(messageContent.attachments)
    ||!messageContent.attachments.includes(pin.artifact_id))fail('channel_delivery_attachment_membership_mismatch');
  const association = db.prepare(`SELECT 1 FROM ga_run_artifacts
    WHERE run_id=? AND artifact_id=? AND version=?`).get(effect.run_id, pin.artifact_id, pin.version);
  const artifact = db.prepare('SELECT owner_id,conversation_id,kind FROM ga_artifacts WHERE id=?').get(pin.artifact_id) as Row | undefined;
  if (!association || !artifact || artifact.owner_id !== pin.owner_id || artifact.conversation_id !== pin.conversation_id
    || !['task_output_file', 'generated_document_group'].includes(String(artifact.kind))) {
    fail('channel_delivery_artifact_authority_missing');
  }

  let parts: ReturnType<typeof copyPart>[];
  if (artifact.kind === 'task_output_file') {
    if (pin.manifest.length !== 1) fail('channel_delivery_artifact_pin_invalid');
    let verified: Row;
    try { verified = artifacts.download(pin.artifact_id, pin.owner_id, pin.version) as Row; }
    catch { fail('channel_artifact_content_mismatch'); }
    const part = pin.manifest[0]!;
    let metadata: Row;
    try { metadata = JSON.parse(String(verified.metadata_json)); } catch { fail('channel_artifact_content_mismatch'); }
    const content = verified.verified_content;
    if (!(content instanceof Buffer) || Number(verified.version) !== pin.version
      || Number(verified.size_bytes) !== pin.size_bytes || verified.sha256 !== pin.sha256
      || Number(content.length) !== pin.size_bytes || digest(content) !== pin.sha256
      || part.sha256 !== pin.sha256 || part.size_bytes !== pin.size_bytes
      || part.mime_type !== verified.mime_type
      || part.display_name !== (metadata.file_name ?? metadata.filename ?? metadata.display_name)) {
      fail('channel_artifact_content_mismatch');
    }
    parts = [copyPart(part, content)];
  } else {
    let group: Row;
    try { group = artifacts.readProducedGroup(pin.owner_id, String(effect.run_id), pin.artifact_id, pin.version) as Row; }
    catch { fail('channel_artifact_content_mismatch'); }
    if (group.artifact_id !== pin.artifact_id || Number(group.version) !== pin.version
      || group.run_id !== effect.run_id || group.conversation_id !== pin.conversation_id
      || group.sha256 !== pin.sha256 || Number(group.size_bytes) !== pin.size_bytes
      || !Array.isArray(group.parts) || group.parts.length !== pin.manifest.length) {
      fail('channel_artifact_content_mismatch');
    }
    parts = group.parts.map((source: Row, index: number) => {
      const pinned = pin.manifest[index]!;
      const content = source.content;
      if (!(content instanceof Buffer) || Number(source.part_index) !== pinned.part_index
        || source.display_name !== pinned.display_name || source.sha256 !== pinned.sha256
        || Number(source.size_bytes) !== pinned.size_bytes || source.mime_type !== pinned.mime_type
        || content.length !== pinned.size_bytes || digest(content) !== pinned.sha256) {
        fail('channel_artifact_content_mismatch');
      }
      return copyPart(pinned, content);
    });
  }
  return Object.freeze({ effect_id: effectId, generation: Number(effect.generation),
    channel_binding_id: binding.channel_binding_id, binding_version: binding.version,
    owner_id: pin.owner_id, conversation_id: pin.conversation_id, artifact_id: pin.artifact_id,
    version: pin.version, sha256: pin.sha256, size_bytes: pin.size_bytes,
    manifest_sha256: pin.manifest_sha256, parts: Object.freeze(parts) });
}
