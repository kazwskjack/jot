export interface StoredMessageContent {
  blocks: Array<Record<string, unknown>>;
  attachments: string[];
}

export function encodeInputContent(messageId: string, input: unknown): StoredMessageContent {
  const items = Array.isArray(input) ? input as Array<Record<string, unknown>> : [];
  const blocks: Array<Record<string, unknown>> = [];
  const attachments: string[] = [];
  for (const [index, item] of items.entries()) {
    if (item.type === 'text') blocks.push({ block_id: `${messageId}:${index}`, kind: 'text', text: String(item.text ?? '') });
    else if (item.type === 'file') attachments.push(String(item.artifact_id ?? ''));
  }
  return { blocks, attachments };
}

export function decodeStoredContent(value: unknown): StoredMessageContent {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const row = parsed as Record<string, unknown>;
    return { blocks: Array.isArray(row.blocks) ? row.blocks as Array<Record<string, unknown>> : [],
      attachments: Array.isArray(row.attachments) ? row.attachments.map(String) : [] };
  }
  const legacy = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  return { blocks: legacy.map((item, index) => item.kind ? item : ({
    block_id: `legacy-block:${index}`, kind: String(item.type ?? 'text'), text: String(item.text ?? ''),
  })), attachments: [] };
}
