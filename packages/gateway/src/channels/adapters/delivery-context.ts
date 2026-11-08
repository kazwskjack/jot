import { createHash } from 'node:crypto';

export type ProviderDeliveryContext = Readonly<{
  effectId: string;
  generation: number;
  idempotencyKey: string;
}>;

/** Stable local receipt for providers whose confirmed success has no remote message ID. */
export function localProviderReceipt(channel: string, context?: ProviderDeliveryContext, namespace?: string): string {
  if (!context || typeof context.effectId !== 'string' || !context.effectId.trim() || context.effectId.length > 512
    || !Number.isSafeInteger(context.generation) || context.generation < 1
    || typeof context.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,255}$/.test(context.idempotencyKey)) {
    throw new Error('delivery_context_required');
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)
    || (namespace !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(namespace))) {
    throw new Error('delivery_context_invalid');
  }
  const digest = createHash('sha256').update(context.effectId, 'utf8').digest('hex');
  return `${channel}:${namespace ? `${namespace}:` : ''}local:${digest}`;
}
