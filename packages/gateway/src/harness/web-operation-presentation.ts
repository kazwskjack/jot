type OperationKind = 'read_page' | 'browse' | 'execute'

const operationKinds = new Set<OperationKind>(['read_page', 'browse', 'execute'])
const operationStatuses = new Set([
  'accepted', 'running', 'succeeded', 'partial', 'failed', 'cancelled',
  'needs_reconciliation', 'unknown', 'waiting_confirmation', 'cancelling',
])
const itemStatuses = new Set([
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'waiting', 'blocked',
  'unknown', 'needs_reconciliation',
])
const itemIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const operationIdPattern = /^web-[0-9a-f]{32}$/
const reasonCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/
const resultRefPattern = /^(?:[0-9a-f]{32}|(?:browse|execute)-child-[0-9a-f]{40})$/

type WebOperationPresentation = {
  action: string
  operation: string
  title: string
  itemActionLabel?: string
}

const operationLabels: Record<OperationKind, { action: string; operation: string; label: string; itemActionLabel: string }> = {
  read_page: { action: 'read', operation: 'fetch', label: '网页读取', itemActionLabel: '读取页面' },
  browse: { action: 'browse', operation: 'interact', label: '网页交互', itemActionLabel: '页面交互' },
  execute: { action: 'execute', operation: 'execute', label: '网页操作', itemActionLabel: '网页操作' },
}

const statusTitles: Record<string, string> = {
  partial: '部分完成',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  cancelling: '正在取消',
  waiting_confirmation: '等待确认',
  unknown: '状态未知',
  needs_reconciliation: '需要核对',
}

export function webOperationPresentation(kindValue: unknown, statusValue: unknown): WebOperationPresentation {
  const kind = typeof kindValue === 'string' && Object.hasOwn(operationLabels, kindValue)
    ? kindValue as OperationKind : null
  const operation = kind ? operationLabels[kind] : null
  const status = typeof statusValue === 'string' ? statusValue : ''
  const suffix = statusTitles[status]
  const title = operation
    ? suffix ? `${operation.label}${suffix}`
      : kind === 'read_page' ? '正在读取网页'
        : kind === 'browse' ? '正在进行网页交互'
          : '正在执行网页操作'
    : suffix ? `网页任务${suffix}` : '正在处理网页任务'
  return operation
    ? { action: operation.action, operation: operation.operation, title, itemActionLabel: operation.itemActionLabel }
    : { action: 'web_operation', operation: 'web_operation', title }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function safeWebOperationId(value: unknown): string | null {
  return typeof value === 'string' && operationIdPattern.test(value) ? value : null
}

export function safeWebOperationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || [...value].length > 8192) return null
  try {
    const parsed = new URL(value)
    const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1]
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !authority || authority.includes('@')
      || parsed.username !== '' || parsed.password !== '') return null
    return value
  } catch {
    return null
  }
}

export function safeWebOperationKind(value: unknown): OperationKind | 'unknown' {
  return typeof value === 'string' && operationKinds.has(value as OperationKind) ? value as OperationKind : 'unknown'
}

export function safeWebOperationStatus(value: unknown): string {
  return typeof value === 'string' && operationStatuses.has(value) ? value : 'unknown'
}

export function safeWebOperationCounts(value: unknown): Record<string, number> {
  const counts = objectRecord(value)
  if (!counts) return {}
  return Object.fromEntries(Object.entries(counts)
    .filter(([key, count]) => itemStatuses.has(key) && Number.isSafeInteger(Number(count)) && Number(count) >= 0)
    .map(([key, count]) => [key, Number(count)]))
}

export function safeWebOperationItems(value: unknown, kind: string, itemActionLabel?: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap((itemValue, index) => {
    const item = objectRecord(itemValue)
    if (!item) return []
    const inputs = objectRecord(item.inputs)
    const url = kind === 'read_page' || kind === 'browse' ? safeWebOperationUrl(inputs?.url) : null
    const rawId = item.item_id
    const itemId = typeof rawId === 'string' && itemIdPattern.test(rawId) ? rawId : `item-${index}`
    const rawPosition = Number(item.position)
    const position = Number.isSafeInteger(rawPosition) && rawPosition >= 0 ? rawPosition : index
    const rawStatus = item.status
    const status = typeof rawStatus === 'string' && itemStatuses.has(rawStatus) ? rawStatus : 'unknown'
    const rawAttempt = Number(item.attempt)
    const attempt = Number.isSafeInteger(rawAttempt) && rawAttempt >= 0 && rawAttempt <= 1_000_000 ? rawAttempt : undefined
    const rawReason = item.reason_code
    const reasonCode = typeof rawReason === 'string' && reasonCodePattern.test(rawReason) ? rawReason : undefined
    const rawResultRef = item.result_ref
    const resultRef = typeof rawResultRef === 'string' && resultRefPattern.test(rawResultRef) ? rawResultRef : undefined
    return [{ item_id: itemId, position, ...(url ? { url } : {}), status,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(reasonCode ? { reason_code: reasonCode } : {}),
      ...(resultRef ? { result_ref: resultRef } : {}),
      ...(itemActionLabel ? { action_label: itemActionLabel } : {}) }]
  })
}
