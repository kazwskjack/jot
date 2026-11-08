import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import type { ChannelDeliveryService } from './delivery.ts';
import type { ChannelIntakeService } from './intake.ts';
import type { OwnerChannelBindings } from './owner-bindings.ts';
import { readVerifiedChannelBinding } from './authority-proofs.ts';
import type { WeixinVersionedFingerprint } from './weixin-context-protector.ts';

const CHANNEL = 'weixin';
const OPAQUE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const MESSAGE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const REMOTE_RECEIPT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WeixinPollUpdate {
  senderId: string;
  messageId: string | number;
  text?: string;
  isDirect: boolean;
  contextToken?: string | null;
  contextExpiresAt?: number | null;
}

export type WeixinPollCursorSnapshot = {
  value: string | null;
  generation: number;
};

export interface WeixinContextProtector {
  seal(value: string, aad: string): {
    ciphertext: string;
    keyId: string;
    fingerprint: WeixinVersionedFingerprint;
  };
  open(value: { ciphertext: string; keyId: string }, aad: string): string;
  fingerprint(value: string, aad: string): WeixinVersionedFingerprint;
  verifyFingerprint(value: string, aad: string, expected: WeixinVersionedFingerprint): boolean;
}

export interface WeixinProtocolPort {
  sendText(input: { accountId: string; recipientId: string; text: string; contextToken: string }):
    Promise<{ ret: number; remoteMessageId?: unknown }>;
}

type Dependencies = {
  db: DatabaseSync;
  intake: ChannelIntakeService;
  bindings: OwnerChannelBindings;
  delivery: ChannelDeliveryService;
  protector: WeixinContextProtector;
  api: WeixinProtocolPort;
  now?: () => number;
};

type VerifiedBinding = {
  owner_id: string;
  channel_binding_id: string;
  channel: string;
  principal: string;
  version: number;
};

type ContextRow = Record<string, unknown> & {
  principal: string;
  provider_thread_id: string;
  provider_message_id: string;
  provider_account_id: string;
  provider_user_id: string;
  owner_id: string;
  channel_binding_id: string;
  binding_version: number;
  state: string;
  context_ciphertext: string | null;
  context_key_id: string | null;
  context_fingerprint: string | null;
  context_fingerprint_key_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
};

function accountIdValid(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && value === value.trim();
}

function messageId(value: string | number): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('weixin_message_identity_invalid');
  }
  const result = String(value);
  if (!MESSAGE_ID.test(result) || result !== result.trim()) throw new Error('weixin_message_identity_invalid');
  return result;
}

function principalFor(accountId: string, senderId: string): string {
  if (!OPAQUE_ID.test(senderId) || senderId !== senderId.trim()) throw new Error('weixin_message_identity_invalid');
  const principal = JSON.stringify([accountId, senderId]);
  if (!OPAQUE_ID.test(principal)) throw new Error('weixin_message_identity_invalid');
  return principal;
}

function eventKey(principal: string, providerMessageId: string) {
  return { channel: CHANNEL, principal, provider_thread_id: '', provider_message_id: providerMessageId };
}

function contextAad(key: ReturnType<typeof eventKey>, accountId: string, senderId: string,
  ownerId: string, bindingId: string, bindingVersion: number): string {
  return JSON.stringify([key.channel, key.principal, key.provider_thread_id, key.provider_message_id,
    accountId, senderId, ownerId, bindingId, bindingVersion]);
}

function cursorAad(accountId: string, generation: number): string {
  return JSON.stringify(['weixin-poll-cursor-v1', CHANNEL, accountId, generation]);
}

function safeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindingError(error: unknown): boolean {
  const message = safeReason(error);
  return message === 'channel_owner_binding_required' || message === 'channel_binding_not_found'
    || message === 'channel_binding_not_verified' || message === 'channel_authority_binding_missing';
}

function validVersionedFingerprint(value: unknown): value is WeixinVersionedFingerprint {
  if (!value || typeof value !== 'object') return false;
  const fingerprint = value as Partial<WeixinVersionedFingerprint>;
  return typeof fingerprint.value === 'string' && HEX_SHA256.test(fingerprint.value)
    && typeof fingerprint.keyId === 'string' && KEY_ID.test(fingerprint.keyId);
}

function sameFingerprint(left: WeixinVersionedFingerprint, right: WeixinVersionedFingerprint): boolean {
  return left.value === right.value && left.keyId === right.keyId;
}

function ownerConflict(error: unknown): boolean {
  return ['channel_message_owner_conflict', 'channel_binding_owner_conflict', 'channel_thread_owner_conflict',
    'channel_authority_owner_mismatch', 'channel_cached_event_binding_mismatch', 'channel_cached_thread_mismatch']
    .includes(safeReason(error));
}

export function createWeixinIlinkAdapter(deps: Dependencies) {
  const { db, intake, bindings, delivery, protector, api } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  if (!intake.usesDatabase(db) || !bindings.usesDatabase(db) || !delivery.usesDatabase(db)) {
    throw new Error('weixin_database_mismatch');
  }
  if (!protector || typeof protector.seal !== 'function' || typeof protector.open !== 'function'
    || typeof protector.fingerprint !== 'function' || typeof protector.verifyFingerprint !== 'function') {
    throw new Error('weixin_context_protector_required');
  }
  if (!api || typeof api.sendText !== 'function') throw new Error('weixin_protocol_port_required');

  function readCursorState(accountId: string) {
    const row = db.prepare(`SELECT cursor_ciphertext,cursor_key_id,generation FROM ga_channel_poll_cursors
      WHERE channel=? AND provider_account_id=?`).get(CHANNEL, accountId) as
      { cursor_ciphertext: string; cursor_key_id: string; generation: number } | undefined;
    if (!row) return { snapshot: { value: null, generation: 0 } as WeixinPollCursorSnapshot, row: null };
    const generation = Number(row.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('weixin_cursor_invalid');
    const cursor = protector.open({ ciphertext: row.cursor_ciphertext, keyId: row.cursor_key_id },
      cursorAad(accountId, generation));
    return { snapshot: { value: cursor, generation }, row };
  }

  function loadCursor(accountId: string): WeixinPollCursorSnapshot {
    return readCursorState(accountId).snapshot;
  }

  function saveContext(input: { key: ReturnType<typeof eventKey>; accountId: string; senderId: string;
    token: string | null; expiresAt: number | null; binding: VerifiedBinding }): void {
    const { key, accountId, senderId, token, expiresAt, binding } = input;
    const aad = contextAad(key, accountId, senderId, binding.owner_id,
      binding.channel_binding_id, binding.version);
    const currentTime = now();
    const state = token === null ? 'missing'
      : expiresAt === null ? 'expiry_unknown'
        : expiresAt <= currentTime ? 'expired' : 'available';
    const storedExpiresAt = token === null ? null : expiresAt;
    const existing = db.prepare(`SELECT * FROM ga_channel_reply_contexts WHERE channel=? AND principal=?
      AND provider_thread_id=? AND provider_message_id=?`).get(key.channel, key.principal,
      key.provider_thread_id, key.provider_message_id) as ContextRow | undefined;
    const timestamp = new Date(currentTime * 1000).toISOString();
    if (existing) {
      if (existing.provider_account_id !== accountId || existing.provider_user_id !== senderId
        || existing.owner_id !== binding.owner_id || existing.channel_binding_id !== binding.channel_binding_id
        || Number(existing.binding_version) !== binding.version || existing.expires_at !== storedExpiresAt) {
        throw new Error('weixin_reply_context_conflict');
      }
      if (existing.state === 'available' || existing.state === 'expiry_unknown') {
        if ((state !== 'available' && state !== 'expiry_unknown' && state !== 'expired') || token === null
          || !existing.context_ciphertext || !existing.context_key_id
          || !existing.context_fingerprint || !existing.context_fingerprint_key_id) {
          throw new Error('weixin_reply_context_conflict');
        }
        const expectedFingerprint = { value: existing.context_fingerprint,
          keyId: existing.context_fingerprint_key_id };
        const originalToken = protector.open({ ciphertext: existing.context_ciphertext,
          keyId: existing.context_key_id }, aad);
        if (originalToken !== token || !protector.verifyFingerprint(token, aad, expectedFingerprint)) {
          throw new Error('weixin_reply_context_conflict');
        }
      } else if (existing.state !== state) {
        throw new Error('weixin_reply_context_conflict');
      }
      if (existing.state === 'available' && state === 'expired') {
        db.prepare(`UPDATE ga_channel_reply_contexts SET state='expired',context_ciphertext=NULL,
          context_key_id=NULL,context_fingerprint=NULL,context_fingerprint_key_id=NULL,updated_at=?
          WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?
          AND state='available'`).run(timestamp,key.channel,key.principal,key.provider_thread_id,
          key.provider_message_id);
      } else if (existing.state === 'expired') {
        db.prepare(`UPDATE ga_channel_reply_contexts SET context_ciphertext=NULL,context_key_id=NULL,
          context_fingerprint=NULL,context_fingerprint_key_id=NULL,updated_at=? WHERE channel=?
          AND principal=? AND provider_thread_id=? AND provider_message_id=? AND state='expired'`)
          .run(timestamp,key.channel,key.principal,key.provider_thread_id,key.provider_message_id);
      }
      return;
    }
    const shouldSeal = token !== null && (state === 'available' || state === 'expiry_unknown');
    const fingerprint = shouldSeal ? protector.fingerprint(token, aad) : null;
    if (fingerprint !== null && !validVersionedFingerprint(fingerprint)) {
      throw new Error('weixin_context_fingerprint_invalid');
    }
    const sealed = shouldSeal ? protector.seal(token, aad) : null;
    if (sealed && (!KEY_ID.test(sealed.keyId) || typeof sealed.ciphertext !== 'string'
      || !sealed.ciphertext || !validVersionedFingerprint(sealed.fingerprint)
      || !fingerprint || !sameFingerprint(sealed.fingerprint, fingerprint))) {
      throw new Error('weixin_context_seal_invalid');
    }
    db.prepare(`INSERT INTO ga_channel_reply_contexts(
      channel,principal,provider_thread_id,provider_message_id,provider_account_id,provider_user_id,
      owner_id,channel_binding_id,binding_version,state,context_ciphertext,context_key_id,
      context_fingerprint,context_fingerprint_key_id,expires_at,created_at,updated_at,revoked_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(key.channel,key.principal,key.provider_thread_id,
      key.provider_message_id,accountId,senderId,binding.owner_id,binding.channel_binding_id,binding.version,
      state,sealed?.ciphertext ?? null,sealed?.keyId ?? null,fingerprint?.value ?? null,
      fingerprint?.keyId ?? null,storedExpiresAt,timestamp,timestamp);
  }

  function acceptPollBatch(input: { accountId: string; expectedCursor: string | null;
    expectedGeneration: number; nextCursor: string;
    updates: readonly WeixinPollUpdate[] }) {
    if (!accountIdValid(input.accountId) || typeof input.nextCursor !== 'string'
      || input.nextCursor.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.nextCursor)
      || (input.expectedCursor !== null && (typeof input.expectedCursor !== 'string'
        || input.expectedCursor.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.expectedCursor)))
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || !Array.isArray(input.updates) || input.updates.length > 500) {
      throw new Error('weixin_poll_batch_invalid');
    }
    return withImmediateTransaction(db, () => {
      const currentState = readCursorState(input.accountId);
      const current = currentState.snapshot;
      if (current.value !== input.expectedCursor || current.generation !== input.expectedGeneration) {
        throw new Error('weixin_cursor_conflict');
      }
      const generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('weixin_cursor_conflict');
      const sealedCursor = protector.seal(input.nextCursor, cursorAad(input.accountId, generation));
      if (!KEY_ID.test(sealedCursor.keyId) || typeof sealedCursor.ciphertext !== 'string'
        || !sealedCursor.ciphertext || !validVersionedFingerprint(sealedCursor.fingerprint)) {
        throw new Error('weixin_cursor_seal_invalid');
      }
      const timestamp = new Date(now() * 1000).toISOString();
      const cursorWrite = currentState.row
        ? db.prepare(`UPDATE ga_channel_poll_cursors SET cursor_ciphertext=?,cursor_key_id=?,generation=?,updated_at=?
          WHERE channel=? AND provider_account_id=? AND generation=? AND cursor_ciphertext=? AND cursor_key_id=?`)
          .run(sealedCursor.ciphertext,sealedCursor.keyId,generation,timestamp,CHANNEL,input.accountId,
            current.generation,currentState.row.cursor_ciphertext,currentState.row.cursor_key_id)
        : db.prepare(`INSERT INTO ga_channel_poll_cursors(channel,provider_account_id,cursor_ciphertext,
          cursor_key_id,generation,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel,provider_account_id)
          DO NOTHING`).run(CHANNEL,input.accountId,sealedCursor.ciphertext,sealedCursor.keyId,generation,timestamp);
      if (Number(cursorWrite.changes) !== 1) throw new Error('weixin_cursor_conflict');

      const items: Array<Record<string, unknown>> = [];
      for (const update of input.updates) {
        if (!update || typeof update !== 'object' || typeof update.isDirect !== 'boolean') {
          throw new Error('weixin_update_invalid');
        }
        const id = messageId(update.messageId);
        const principal = principalFor(input.accountId, update.senderId);
        if (!update.isDirect || typeof update.text !== 'string' || !update.text.trim()) {
          items.push({ status: 'ignored_unsupported', provider_message_id: id });
          continue;
        }
        if (update.contextToken !== undefined && update.contextToken !== null
          && (typeof update.contextToken !== 'string' || !update.contextToken || update.contextToken.length > 8192)) {
          throw new Error('weixin_context_token_invalid');
        }
        const expiresAt = update.contextExpiresAt === undefined || update.contextExpiresAt === null
          ? null : update.contextExpiresAt;
        if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
          throw new Error('weixin_context_expiry_invalid');
        }
        const key = eventKey(principal, id);
        const normalized = { channel: CHANNEL, principal, thread_id: '', message_id: id, text: update.text };
        if (update.text.trim().startsWith('/jot-bind')) {
          items.push({ status: 'ignored_unsupported', provider_message_id: id });
          continue;
        }
        const prior = db.prepare(`SELECT 1 FROM ga_channel_message_events WHERE channel=? AND principal=?
          AND provider_thread_id=? AND provider_message_id=?`).get(key.channel,key.principal,
          key.provider_thread_id,key.provider_message_id);
        let accepted: Record<string, any>;
        let binding: VerifiedBinding;
        try {
          accepted = intake.accept(normalized) as Record<string, any>;
          binding = readVerifiedChannelBinding(db, CHANNEL, principal);
        } catch (error) {
          if (bindingError(error)) {
            items.push({ status: 'rejected_unbound', provider_message_id: id });
            continue;
          }
          if (ownerConflict(error)) {
            items.push({ status: 'rejected_owner_conflict', provider_message_id: id });
            continue;
          }
          throw error;
        }
        if (binding.channel !== CHANNEL || binding.principal !== principal) {
          throw new Error('weixin_verified_owner_result_invalid');
        }
        saveContext({ key, accountId: input.accountId, senderId: update.senderId,
          token: update.contextToken ?? null, expiresAt, binding });
        items.push({ status: prior ? 'replayed' : 'accepted', provider_message_id: id,
          message_id: accepted.message_id, run_id: accepted.run_id, conversation_id: accepted.conversation_id });
      }
      return { items, nextCursor: input.nextCursor, generation };
    });
  }

  function getCursor(accountId: string): WeixinPollCursorSnapshot {
    if (!accountIdValid(accountId)) throw new Error('weixin_account_id_invalid');
    return loadCursor(accountId);
  }

  function contextBlocked(_effectId: string, _generation: number, reason: string) {
    return { kind: 'blocked' as const, reason };
  }

  async function sendReply(input: { accountId: string; senderId: string; messageId: string | number;
    effectId: string; generation: number; text: string }) {
    if (!accountIdValid(input.accountId) || !OPAQUE_ID.test(input.senderId) || !input.effectId
      || !Number.isSafeInteger(input.generation) || input.generation < 1 || typeof input.text !== 'string'
      || !input.text.trim() || input.text.length > 4000) throw new Error('weixin_reply_invalid');
    const id = messageId(input.messageId);
    const principal = principalFor(input.accountId,input.senderId);
    const effect = delivery.get(input.effectId);
    if (effect.destination !== CHANNEL || effect.recipient !== principal || effect.status !== 'sending'
      || Number(effect.generation) !== input.generation) throw new Error('delivery_lease_lost');
    if (!delivery.authorizeSend(input.effectId,input.generation)) {
      return { kind: 'blocked' as const, reason: 'JOT_DELIVERY_AUTHORITY_REVOKED' };
    }
    const key = eventKey(principal,id);
    const context = withImmediateTransaction(db, () => {
      const row = db.prepare(`SELECT x.*,e.run_id AS event_run_id,c.owner_id AS event_owner_id
        FROM ga_channel_reply_contexts x
        JOIN ga_channel_message_events e ON e.channel=x.channel AND e.principal=x.principal
          AND e.provider_thread_id=x.provider_thread_id AND e.provider_message_id=x.provider_message_id
        JOIN ga_conversations c ON c.id=e.conversation_id
        WHERE x.channel=? AND x.principal=? AND x.provider_thread_id=? AND x.provider_message_id=?`)
        .get(key.channel,key.principal,key.provider_thread_id,key.provider_message_id) as
        (ContextRow & { event_run_id: string; event_owner_id: string }) | undefined;
      if (!row) return { blocked: 'WEIXIN_CONTEXT_MISSING' as const };
      if (row.provider_account_id !== input.accountId || row.provider_user_id !== input.senderId
        || row.owner_id !== row.event_owner_id || row.event_run_id !== effect.run_id) {
        return { blocked: 'WEIXIN_OWNER_CONFLICT' as const };
      }
      if (row.state === 'missing') return { blocked: 'WEIXIN_CONTEXT_MISSING' as const };
      if (row.state === 'expiry_unknown') return { blocked: 'WEIXIN_CONTEXT_EXPIRY_UNKNOWN' as const };
      if (row.state === 'expired' || (row.expires_at !== null && row.expires_at <= now())) {
        db.prepare(`UPDATE ga_channel_reply_contexts SET state='expired',context_ciphertext=NULL,
          context_key_id=NULL,context_fingerprint=NULL,context_fingerprint_key_id=NULL,updated_at=?
          WHERE channel=? AND principal=? AND provider_thread_id=?
          AND provider_message_id=? AND state IN ('available','expired')`).run(new Date(now()*1000).toISOString(),
          key.channel,key.principal,key.provider_thread_id,key.provider_message_id);
        return { blocked: 'WEIXIN_CONTEXT_EXPIRED' as const };
      }
      if (row.state === 'revoked') {
        db.prepare(`UPDATE ga_channel_reply_contexts SET context_ciphertext=NULL,context_key_id=NULL,
          context_fingerprint=NULL,context_fingerprint_key_id=NULL,updated_at=? WHERE channel=?
          AND principal=? AND provider_thread_id=? AND provider_message_id=? AND state='revoked'`)
          .run(new Date(now()*1000).toISOString(),key.channel,key.principal,key.provider_thread_id,
            key.provider_message_id);
        return { blocked: 'WEIXIN_OWNER_BINDING_REVOKED' as const };
      }
      let binding: Record<string, unknown>;
      try { binding = bindings.resolve(row.owner_id,row.channel_binding_id); }
      catch (error) {
        if (!bindingError(error)) throw error;
        db.prepare(`UPDATE ga_channel_reply_contexts SET state='revoked',context_ciphertext=NULL,
          context_key_id=NULL,context_fingerprint=NULL,context_fingerprint_key_id=NULL,
          revoked_at=?,updated_at=? WHERE channel=? AND principal=?
          AND provider_thread_id=? AND provider_message_id=?`).run(now(),new Date(now()*1000).toISOString(),
          key.channel,key.principal,key.provider_thread_id,key.provider_message_id);
        return { blocked: 'WEIXIN_OWNER_BINDING_REVOKED' as const };
      }
      if (binding.channel !== CHANNEL || binding.principal !== principal
        || Number(binding.version) !== Number(row.binding_version)) {
        db.prepare(`UPDATE ga_channel_reply_contexts SET state='revoked',context_ciphertext=NULL,
          context_key_id=NULL,context_fingerprint=NULL,context_fingerprint_key_id=NULL,
          revoked_at=?,updated_at=? WHERE channel=? AND principal=?
          AND provider_thread_id=? AND provider_message_id=?`).run(now(),new Date(now()*1000).toISOString(),
          key.channel,key.principal,key.provider_thread_id,key.provider_message_id);
        return { blocked: 'WEIXIN_OWNER_BINDING_REVOKED' as const };
      }
      if (row.state !== 'available' || !row.context_ciphertext || !row.context_key_id
        || !row.context_fingerprint || !row.context_fingerprint_key_id
        || typeof row.expires_at !== 'number') return { blocked: 'WEIXIN_CONTEXT_MISSING' as const };
      const aad = contextAad(key,input.accountId,input.senderId,row.owner_id,row.channel_binding_id,
        Number(row.binding_version));
      try {
        const token = protector.open({ ciphertext: row.context_ciphertext, keyId: row.context_key_id },aad);
        const expectedFingerprint = { value: row.context_fingerprint,
          keyId: row.context_fingerprint_key_id };
        if (!token || !protector.verifyFingerprint(token,aad,expectedFingerprint)) {
          return { blocked: 'WEIXIN_CONTEXT_INVALID' as const };
        }
        return { token };
      } catch {
        return { blocked: 'WEIXIN_CONTEXT_INVALID' as const };
      }
    });
    if ('blocked' in context) return contextBlocked(input.effectId,input.generation,context.blocked);
    if (!delivery.authorizeSend(input.effectId,input.generation)) {
      return { kind: 'blocked' as const, reason: 'JOT_DELIVERY_AUTHORITY_REVOKED' };
    }
    let result: { ret: number; remoteMessageId?: unknown };
    try {
      result = await api.sendText({ accountId: input.accountId, recipientId: input.senderId,
        text: input.text.trim(), contextToken: context.token });
    } catch {
      delivery.recordProviderUnknown(input.effectId,input.generation);
      return { kind: 'outcome_unknown' as const };
    }
    if (!result || result.ret !== 0 || typeof result.remoteMessageId !== 'string'
      || !REMOTE_RECEIPT.test(result.remoteMessageId) || result.remoteMessageId !== result.remoteMessageId.trim()) {
      delivery.recordProviderUnknown(input.effectId,input.generation);
      return { kind: 'outcome_unknown' as const };
    }
    delivery.recordProviderSent(input.effectId,input.generation,{ provider_message_id: result.remoteMessageId });
    return { kind: 'sent' as const, provider_message_id: result.remoteMessageId };
  }

  return { acceptPollBatch, getCursor, sendReply };
}
