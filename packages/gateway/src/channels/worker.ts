import { createHash } from 'node:crypto';
import type { ChannelDeliveryService } from './delivery.ts';

interface DeliveryProvider {
  sendFile(path: string, recipient: string, displayName: string):
    Promise<Record<string, unknown> & { provider_message_id?: unknown }>;
  send(text: string, recipient: string):
    Promise<Record<string, unknown> & { provider_message_id?: unknown }>;
}

interface DeliveryRuntime {
  registerDeliveryReceipt(runtimeRunId: string, clientRunId: string, receiptRef: string,
    recipientRef: string, status: 'delivered'): Promise<Record<string, unknown>>;
}

interface DeliveryResolvers {
  resolveArtifact(artifactRef: string): { path: string; displayName: string };
  resolveArtifacts?(artifactRef: string): Array<{ path: string; displayName: string }>;
  cleanupArtifact?(artifactRef: string): void | Promise<void>;
  resolveRuntime(clientRunId: string): { runtimeRunId: string; clientRunId: string };
}

export class ChannelDeliveryWorker {
  private readonly store: ChannelDeliveryService;
  private readonly provider: DeliveryProvider;
  private readonly runtime: DeliveryRuntime;
  private readonly resolvers: DeliveryResolvers;
  private readonly owner: string;
  constructor(store: ChannelDeliveryService, provider: DeliveryProvider,
    runtime: DeliveryRuntime, resolvers: DeliveryResolvers,
    owner = 'general-agent-delivery-j') {
    this.store = store; this.provider = provider; this.runtime = runtime;
    this.resolvers = resolvers; this.owner = owner;
  }

  async processNext(): Promise<boolean> {
    const item = this.store.claim(this.owner, 90);
    if (!item) return false;
    let receipt = item.provider_receipt as Record<string, unknown> | null;
    if (item.phase === 'send') {
      const payload = item.payload_json ? JSON.parse(String(item.payload_json)) as Record<string, unknown> : null;
      if (payload?.kind === 'text') {
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) throw new Error('delivery_text_invalid');
        let sent: Record<string, unknown> & { provider_message_id?: unknown };
        try {
          sent = await this.provider.send(text, String(item.recipient));
        } catch (error) {
          if (/timeout|abort|socket|network/i.test(String(error instanceof Error ? error.message : error))) {
            this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
            return true;
          }
          throw error;
        }
        if (typeof sent.provider_message_id === 'string' && sent.provider_message_id) {
          receipt = sent;
        } else if (sent.ok === true) {
          // The deployed legacy WeCom adapter reports errcode=0 as {ok:true}
          // but has no msgid for application text. The API has already accepted
          // the message, so persist a deterministic local receipt rather than
          // incorrectly converting a confirmed send into outcome_unknown.
          receipt = { ...sent,
            provider_message_id: `wecom-text:${String(item.effect_id)}:${String(item.generation)}` };
        } else {
          this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
          return true;
        }
      } else {
        const artifacts = this.resolvers.resolveArtifacts
          ? this.resolvers.resolveArtifacts(String(item.artifact_ref))
          : [this.resolvers.resolveArtifact(String(item.artifact_ref))];
        if (!artifacts.length || artifacts.length > 50) throw new Error('delivery_artifact_parts_invalid');
        const providerIds: string[] = [];
        for (let index = 0; index < artifacts.length; index += 1) {
          const artifact = artifacts[index]!;
          let partReceipt: Record<string, unknown>;
          try {
            partReceipt = await this.provider.sendFile(
              artifact.path, String(item.recipient), artifact.displayName
            );
          } catch (error) {
            if (/timeout|abort|socket|network/i.test(String(error instanceof Error ? error.message : error))) {
              this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
              return true;
            }
            throw error;
          }
          if (typeof partReceipt.provider_message_id !== 'string' || !partReceipt.provider_message_id) {
            this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
            return true;
          }
          providerIds.push(partReceipt.provider_message_id);
          this.store.recordProviderPart(String(item.effect_id), Number(item.generation),
            index + 1, artifacts.length, partReceipt);
        }
        receipt = { provider_message_id: `group:${createHash('sha256')
          .update(providerIds.join('\0')).digest('hex').slice(0, 32)}`,
          receipts: providerIds.map((provider_message_id, index) => ({
            part_index: index + 1, provider_message_id,
          })), total: artifacts.length };
      }
      this.store.recordProviderSent(String(item.effect_id), Number(item.generation), receipt);
    }
    try {
      if (!receipt || typeof receipt.provider_message_id !== 'string') {
        throw new Error('provider_receipt_invalid');
      }
      const payload = item.payload_json ? JSON.parse(String(item.payload_json)) as Record<string, unknown> : null;
      if (payload?.kind !== 'text') {
        const binding = this.resolvers.resolveRuntime(String(item.run_id));
        const runtimeReceipt = await this.runtime.registerDeliveryReceipt(
          binding.runtimeRunId, binding.clientRunId,
          `wecom:${receipt.provider_message_id}`, String(item.recipient), 'delivered');
        if (runtimeReceipt.ok !== true) throw new Error('RUNTIME_RECEIPT_REJECTED');
      }
      if (payload?.kind !== 'text' && this.resolvers.cleanupArtifact) {
        await this.resolvers.cleanupArtifact(String(item.artifact_ref));
      }
      this.store.recordDelivered(String(item.effect_id));
    } catch {
      this.store.recordReceiptFailure(String(item.effect_id), 'RUNTIME_RECEIPT_UNAVAILABLE');
    }
    return true;
  }
}
