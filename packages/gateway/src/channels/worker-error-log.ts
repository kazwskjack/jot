const SAFE_DELIVERY_ERROR_CODES = new Set([
  'delivery_channel_not_configured',
  'delivery_text_invalid',
  'delivery_artifact_parts_invalid',
  'delivery_artifact_not_found',
  'delivery_runtime_binding_missing',
  'delivery_lease_lost',
  'provider_receipt_invalid',
  'provider_part_receipt_invalid',
  'provider_part_order_invalid',
  'delivery_receipt_not_ready',
  'RUNTIME_RECEIPT_REJECTED',
]);

function safeCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : '';
  return SAFE_DELIVERY_ERROR_CODES.has(candidate)
    ? candidate.toUpperCase()
    : 'DELIVERY_WORKER_ERROR';
}

export function writeChannelWorkerError(error: unknown, write: (line: string) => unknown): void {
  write(JSON.stringify({ level: 'error', code: safeCode(error) }) + '\n');
}