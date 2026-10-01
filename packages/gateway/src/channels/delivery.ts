import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';

export interface ExternalDeliveryInput {
  runId: string;
  messageId: string;
  destination: string;
  recipient: string;
  artifactRef: string | null;
  text?: string | null;
}

export class ChannelDeliveryService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync,
    now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
  }

  enqueueExternal(input: ExternalDeliveryInput): Record<string, unknown> | null {
    if (input.destination === 'current_chat') return null;
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!['wecom'].includes(input.destination) || !input.recipient.trim()
      || (!input.artifactRef && !text) || (input.artifactRef && text)) {
      throw new Error('external_delivery_invalid');
    }
    const identity = JSON.stringify([input.runId, input.messageId, input.destination,
      input.recipient, input.artifactRef, text || null]);
    const effectId = `delivery-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    const now = new Date(this.now() * 1000).toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO ga_channel_deliveries(
      effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?, 'pending',?,?)`).run(effectId, input.runId, input.messageId,
      input.destination, input.recipient, input.artifactRef,
      text ? JSON.stringify({ kind: 'text', text }) : null, now, now);
    return this.get(effectId);
  }

  enqueueProjected(input: { request_id: string; run_id: string; client_run_id: string;
    artifact_ref: string; recipient_ref: string }): Record<string, any> {
    if (!/^delivery:[0-9a-z._:-]{1,128}$/i.test(input.request_id)
      || !input.client_run_id.trim() || !input.artifact_ref.trim() || !input.recipient_ref.trim()) {
      throw new Error('projected_delivery_invalid');
    }
    const now = new Date(this.now() * 1000).toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO ga_channel_deliveries(
      effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(input.request_id, input.client_run_id,
      input.request_id, 'wecom', input.recipient_ref, input.artifact_ref, null, now, now);
    return this.get(input.request_id);
  }

  claim(owner: string, leaseSeconds: number): Record<string, any> | null {
    if (!owner || leaseSeconds < 1) throw new Error('delivery_lease_invalid');
    return withImmediateTransaction(this.db, () => {
      const current = this.now();
      this.db.prepare(`UPDATE ga_channel_deliveries SET status='outcome_unknown',
        last_reason_code='PROVIDER_SEND_STATE_AMBIGUOUS',lease_owner=NULL,
        lease_expires_at=NULL,updated_at=? WHERE status='sending' AND lease_expires_at<=?`)
        .run(new Date(current * 1000).toISOString(), current);
      const row = this.db.prepare(`SELECT * FROM ga_channel_deliveries
        WHERE status IN ('pending','receipt_pending')
          AND (lease_owner IS NULL OR lease_expires_at<=?)
        ORDER BY created_at,effect_id LIMIT 1`).get(current) as Record<string, any> | undefined;
      if (!row) return null;
      const generation = Number(row.generation) + 1;
      const nextStatus = row.status === 'pending' ? 'sending' : 'receipt_pending';
      this.db.prepare(`UPDATE ga_channel_deliveries SET status=?,lease_owner=?,generation=?,
        lease_expires_at=?,updated_at=? WHERE effect_id=?`).run(nextStatus, owner,
        generation, current + leaseSeconds, new Date(current * 1000).toISOString(), row.effect_id);
      return { ...row, status: nextStatus, generation,
        phase: row.status === 'receipt_pending' ? 'receipt_only' : 'send',
        provider_receipt: row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) : null };
    });
  }

  recordProviderSent(effectId: string, generation: number, receipt: Record<string, unknown>): void {
    if (!receipt.provider_message_id) throw new Error('provider_receipt_invalid');
    const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='receipt_pending',
      provider_receipt_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE effect_id=? AND generation=? AND status='sending'`).run(JSON.stringify(receipt),
        new Date(this.now() * 1000).toISOString(), effectId, generation).changes;
    if (changed !== 1) throw new Error('delivery_lease_lost');
  }

  recordProviderPart(effectId: string, generation: number, partIndex: number,
    total: number, receipt: Record<string, unknown>): void {
    if (!Number.isInteger(partIndex) || partIndex < 1 || !Number.isInteger(total)
      || total < partIndex || typeof receipt.provider_message_id !== 'string'
      || !receipt.provider_message_id) throw new Error('provider_part_receipt_invalid');
    const row = this.db.prepare(`SELECT provider_receipt_json FROM ga_channel_deliveries
      WHERE effect_id=? AND generation=? AND status='sending'`).get(effectId, generation) as
      { provider_receipt_json?: string } | undefined;
    if (!row) throw new Error('delivery_lease_lost');
    const previous = row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) : null;
    const receipts = Array.isArray(previous?.receipts) ? previous.receipts : [];
    if (receipts.length + 1 !== partIndex) throw new Error('provider_part_order_invalid');
    receipts.push({ part_index: partIndex, provider_message_id: receipt.provider_message_id });
    this.db.prepare(`UPDATE ga_channel_deliveries SET provider_receipt_json=?,updated_at=?
      WHERE effect_id=? AND generation=? AND status='sending'`).run(
        JSON.stringify({ total, receipts }), new Date(this.now() * 1000).toISOString(),
        effectId, generation);
  }

  recordReceiptFailure(effectId: string, reasonCode: string): void {
    this.db.prepare(`UPDATE ga_channel_deliveries SET status='receipt_pending',last_reason_code=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND provider_receipt_json IS NOT NULL`)
      .run(reasonCode, new Date(this.now() * 1000).toISOString(), effectId);
  }

  recordProviderUnknown(effectId: string, generation: number): void {
    const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='outcome_unknown',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE effect_id=? AND generation=? AND status='sending'`).run(
        new Date(this.now() * 1000).toISOString(), effectId, generation).changes;
    if (changed !== 1) throw new Error('delivery_lease_lost');
  }

  recordDelivered(effectId: string): void {
    const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='delivered',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE effect_id=? AND status='receipt_pending' AND provider_receipt_json IS NOT NULL`)
      .run(new Date(this.now() * 1000).toISOString(), effectId).changes;
    if (changed !== 1) throw new Error('delivery_receipt_not_ready');
  }

  get(effectId: string): Record<string, any> {
    const row = this.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?')
      .get(effectId) as Record<string, any> | undefined;
    if (!row) throw new Error('delivery_not_found');
    return row;
  }

  enqueueText(input: { runId: string; messageId: string; destination: 'wecom';
    recipient: string; text: string }): Record<string, unknown> | null {
    return this.enqueueExternal({ ...input, artifactRef: null, text: input.text });
  }
}
