/** Shared native output interpretation for live delivery and historical recovery.
 * Extraction is not ownership, file integrity, completion or publication authority. */
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function assistantText(event: Record<string, unknown>): string {
  if (event.type !== 'assistant/message') return ''
  const data = row(event.data); const message = row(data?.message)
  if (!Array.isArray(message?.content)) return ''
  return message.content.map(value => {
    const block = row(value)
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }).join('').trim()
}

export function assistantBlocks(event: Record<string, unknown>): Array<{ kind: 'text' | 'reasoning'; text: string }> {
  if (event.type !== 'assistant/message') return []
  const data = row(event.data); const message = row(data?.message)
  if (!Array.isArray(message?.content)) return []
  return message.content.flatMap(value => {
    const block = row(value)
    if ((block?.type !== 'text' && block?.type !== 'reasoning') || typeof block.text !== 'string' || !block.text) return []
    return [{ kind: block.type, text: block.text }]
  })
}

export function collectArtifactRefs(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) return
    try { collectArtifactRefs(JSON.parse(text), output) } catch { /* Tool prose is not a structured artifact declaration. */ }
    return
  }
  if (Array.isArray(value)) { for (const item of value) collectArtifactRefs(item, output); return }
  const valueRow = row(value)
  if (!valueRow) return
  const completedJob = valueRow.status === 'completed'
    && Number.isInteger(Number(valueRow.output_version)) && Number(valueRow.output_version) > 0
  const immutableReceipt = Number.isInteger(Number(valueRow.version)) && Number(valueRow.version) > 0
    && typeof valueRow.sha256 === 'string' && typeof valueRow.media_type === 'string'
    && Number.isFinite(Number(valueRow.size_bytes)) && Number(valueRow.size_bytes) >= 0
  if ((completedJob || immutableReceipt) && typeof valueRow.artifact_ref === 'string'
    && /^artifact-[A-Za-z0-9-]+$/.test(valueRow.artifact_ref)) {
    output.add(valueRow.artifact_ref)
  }
  for (const child of Object.values(valueRow)) collectArtifactRefs(child, output)
}

export function presentedFiles(event: Record<string, unknown>): Array<{ path: string; description?: string }> {
  if (event.type !== 'deliverables/presented') return []
  const data = row(event.data)
  if (!Array.isArray(data?.files)) return []
  return data.files.flatMap(value => {
    const file = row(value)
    if (!file || typeof file.path !== 'string' || !file.path.trim()) return []
    return [{ path: file.path, ...(typeof file.description === 'string' && file.description.trim()
      ? { description: file.description } : {}) }]
  })
}

