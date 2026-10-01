import {
  safeWebOperationCounts, safeWebOperationId, safeWebOperationItems, safeWebOperationUrl,
  safeWebOperationKind, safeWebOperationStatus, webOperationPresentation,
} from './web-operation-presentation.ts'

export interface JotProjection {
  type: 'assistant.delta' | 'assistant.settled' | 'activity.upsert'
  payload: Record<string, unknown>
}

export interface ProjectionContext {
  runId: string
  attemptId: string
  messageId: string
  blockId: string
  deltaIndex: number
  at: string
  knownTools?: Map<string, ToolPresentation>
}

interface ToolPresentation {
  publicDetail?: Record<string, unknown>
  publicStatus?: 'running' | 'waiting' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown'
  publicTitle?: string
  startedAt?: string
  kind: 'search' | 'browse' | 'file_read' | 'file_edit' | 'command' | 'subagent'
  runningTitle: string
  completedTitle: string
  failedTitle: string
}

const BROWSE_ACTION_TYPES = new Set(['click', 'expand', 'next_page', 'scroll', 'wait', 'fill'])
const SAFE_TOOL_ACTION_LABELS = new Set([
  ...BROWSE_ACTION_TYPES, 'browse', 'execute', 'fetch', 'interact', 'navigate', 'open', 'read', 'search', 'web_operation',
])
const BROWSE_VERIFICATION_STATUSES = new Set([
  'ACTION_NO_EFFECT', 'ACTION_ROLE_DISALLOWED', 'ACTION_UNAVAILABLE', 'AMBIGUOUS_FRAME',
  'AMBIGUOUS_TARGET', 'AUTH_REQUIRED', 'BLOCKED', 'BOUND', 'BUSINESS_LOOP',
  'BUSINESS_REJECTED', 'BUSINESS_SUCCESS', 'CAPTCHA_REQUIRED', 'CONSTRAINT_MISMATCH',
  'DISABLED', 'FIELD_VALUE_MISMATCH', 'HUMAN_REQUIRED', 'INTERACTABLE', 'INVISIBLE',
  'LOGIN_REQUIRED', 'NO_EFFECT', 'NON_INTERACTABLE', 'PLANNER_SHADOW_NOT_EXECUTED',
  'PROVIDER_INVALID_RESPONSE', 'RECOVERED', 'REQUIRED_FIELD_MISSING', 'RESULT_NOT_FOUND',
  'RESULT_UNCERTAIN', 'SELECTED', 'SETTLED', 'STALE_BINDING', 'STATE_UNCERTAIN',
  'STABLE', 'TIMEOUT', 'WRONG_ENTITY', 'WRONG_PAGE_TYPE', 'WRONG_SURFACE',
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeId(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9_:\-]/g, '-').slice(0, 128)
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : fallback
}

function presentation(nameValue: unknown): ToolPresentation {
  const name = String(nameValue ?? '').toLowerCase()
  if (/(search|research|query)/.test(name)) return {
    kind: 'search', runningTitle: '正在搜索资料', completedTitle: '资料搜索完成', failedTitle: '资料搜索失败',
  }
  if (/(read|fetch|browse|scrape|crawl|web|url|navigate|click)/.test(name)) return {
    kind: 'browse', runningTitle: '正在读取网页', completedTitle: '网页读取完成', failedTitle: '网页读取失败',
  }
  if (/(write|edit|patch|create.*file)/.test(name)) return {
    kind: 'file_edit', runningTitle: '正在整理文件', completedTitle: '文件整理完成', failedTitle: '文件整理失败',
  }
  if (/(file|document|artifact)/.test(name)) return {
    kind: 'file_read', runningTitle: '正在读取文件', completedTitle: '文件读取完成', failedTitle: '文件读取失败',
  }
  if (/(shell|exec|command|terminal)/.test(name)) return {
    kind: 'command', runningTitle: '正在执行操作', completedTitle: '操作执行完成', failedTitle: '操作执行失败',
  }
  return { kind: 'subagent', runningTitle: '正在处理任务', completedTitle: '任务处理完成', failedTitle: '任务处理失败' }
}

function detailFor(tool: ToolPresentation, runId: string): Record<string, unknown> {
  if (tool.kind === 'search') return { queries: [], source_ids: [] }
  if (tool.kind === 'browse') return { operation: 'fetch', source_ids: [] }
  if (tool.kind === 'file_edit') return { display_path: '工作区文件', operation: 'edit', change_status: 'staging' }
  if (tool.kind === 'file_read') return { display_path: '工作区文件' }
  if (tool.kind === 'command') return { display_command: '执行工作区操作' }
  return { child_run_id: runId }
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 1_000_000) return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try { return JSON.parse(trimmed) } catch { return value }
}

function browseResultEvidence(data: Record<string, unknown>, resultBlock: Record<string, unknown> | undefined) {
  const roots: unknown[] = [data.result, data.structuredContent, resultBlock?.result, resultBlock?.content]
  const capabilityResults: Array<{ outcome?: unknown; data?: unknown }> = []
  const seen = new Set<object>()
  let visited = 0
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8 || visited++ > 2048) return
    const value = parsedJson(candidate)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const object = record(value)
    if (!object || seen.has(object)) return
    seen.add(object)
    if (object.event_type === 'capability_result' && object.capability === 'browse') {
      capabilityResults.push({ outcome: object.outcome, data: object.data })
      return
    }
    if (Array.isArray(object.interaction_trace)) {
      capabilityResults.push({ outcome: object.outcome, data: object })
    }
    for (const key of ['events', 'payload', 'data', 'result', 'structuredContent', 'content']) {
      if (key in object) visit(object[key], depth + 1)
    }
    if (object.type === 'text' && typeof object.text === 'string') visit(object.text, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  if (!capabilityResults.length) return null

  const lastResult = capabilityResults[capabilityResults.length - 1]
  const finalData = record(lastResult?.data)
  const trace = (Array.isArray(finalData?.interaction_trace)
    ? finalData.interaction_trace.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : []).slice(-12)
  const lastOutcome = lastResult?.outcome
  const outcome = lastOutcome === 'success' || lastOutcome === 'pause' || lastOutcome === 'failure'
    ? lastOutcome : 'unknown'
  const actionTypes = [...new Set(trace.flatMap(row => {
    const type = record(row.action)?.type
    return typeof type === 'string' && BROWSE_ACTION_TYPES.has(type.toLowerCase()) ? [type.toLowerCase()] : []
  }))]
  const verificationStatuses = [...new Set(trace.map(row => {
    const status = record(row.verification)?.status
    return typeof status === 'string' && BROWSE_VERIFICATION_STATUSES.has(status) ? status : 'UNKNOWN'
  }))]
  const verifiedActionTypes = [...new Set(trace.flatMap(row => {
    const type = record(row.action)?.type
    return record(row.verification)?.status === 'BUSINESS_SUCCESS'
      && typeof type === 'string' && BROWSE_ACTION_TYPES.has(type.toLowerCase()) ? [type.toLowerCase()] : []
  }))]
  return {
    browse_outcome: outcome,
    action_trace_count: trace.length,
    ...(actionTypes.length ? { traced_action_types: actionTypes } : {}),
    ...(verificationStatuses.length ? { verification_statuses: verificationStatuses } : {}),
    verified_action_types: verifiedActionTypes,
  }
}

function structuredToolFailure(data: Record<string, unknown>, resultBlock: Record<string, unknown> | undefined): boolean {
  const values: unknown[] = [data.result, data.structuredContent]
  if (Array.isArray(resultBlock?.content)) values.push(...resultBlock.content)
  return values.some(value => {
    const block = record(value)
    const result = record(parsedJson(block?.type === 'text' ? block.text : value))
    return result?.ok === false
  })
}

function toolActivity(data: Record<string, unknown>, context: ProjectionContext, completed: boolean): JotProjection | null {
  const message = record(data.message)
  const source = record(message?.source)
  const resultBlock = Array.isArray(message?.content)
    ? message.content.map(record).find(block => block?.type === 'tool-result') : undefined
  const callId = safeId(data.callId ?? (source?.kind === 'tool' ? source.callId : undefined)
    ?? resultBlock?.toolCallId ?? data.id, '')
  if (!callId) return null
  const known = context.knownTools?.get(callId)
  const tool = known ?? presentation(data.name ?? data.toolName)
  if (!known) {
    const detail = detailFor(tool, context.runId)
    const name = data.name ?? data.toolName
    if (typeof name === 'string' && name) detail.tool_name = name
    let args: Record<string, unknown> | null = null
    try { args = record(typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments) } catch {}
    if (tool.kind === 'search') {
      const inputs = record(args?.inputs)
      const queries = [args?.query, inputs?.query,
        ...(Array.isArray(args?.queries) ? args.queries : []),
        ...(Array.isArray(inputs?.queries) ? inputs.queries : [])]
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map(value => value.trim().slice(0, 2000))
      detail.queries = [...new Set(queries)].slice(0, 50)
    }
    const urls: string[] = []
    const add = (value: unknown) => {
      const url = safeWebOperationUrl(value)
      if (url && !urls.includes(url)) urls.push(url)
    }
    const visit = (value: unknown, depth: number) => {
      if (depth > 4) return
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
      const obj = record(value); if (!obj) return
      add(obj.url)
      if (Array.isArray(obj.urls)) obj.urls.forEach(add)
      // Only inspect known argument containers, never serialize arbitrary arguments/results.
      for (const key of ['input', 'inputs', 'params', 'arguments', 'actions', 'open', 'navigate']) visit(obj[key], depth + 1)
    }
    visit(args, 0)
    if (urls.length) { detail.urls = urls; detail.url = urls[0] }
    const nestedInputs = record(args?.inputs)
    const actionLists = [args?.actions, nestedInputs?.actions].filter(Array.isArray) as unknown[][]
    const requestedActionTypes = [...new Set(actionLists.flatMap(actions => actions.flatMap(value => {
      const action = record(value)
      return typeof action?.type === 'string' && BROWSE_ACTION_TYPES.has(action.type.toLowerCase())
        ? [action.type.toLowerCase()] : []
    })))].slice(0, 12)
    if (requestedActionTypes.length) detail.requested_action_types = requestedActionTypes
    const rawAction = args?.action ?? args?.operation
    if (typeof rawAction === 'string' && SAFE_TOOL_ACTION_LABELS.has(rawAction.toLowerCase())) {
      detail.action = rawAction.toLowerCase()
    }
    tool.publicDetail = detail
    tool.startedAt = context.at
  }
  if (!completed) context.knownTools?.set(callId, tool)
  const failed = completed && Boolean(data.error || resultBlock?.isError
    || structuredToolFailure(data, resultBlock ?? undefined))
  if (completed && tool.kind === 'browse') {
    if (failed) {
      const evidence = browseResultEvidence(data, resultBlock ?? undefined)
      if (evidence || tool.publicDetail?.tool_name === 'universe_browse') {
        tool.publicDetail = {
          ...(tool.publicDetail ?? detailFor(tool, context.runId)),
          browse_outcome: 'failure', action_trace_count: 0,
          verification_statuses: ['UNKNOWN'], verified_action_types: [],
        }
      }
      tool.publicStatus = 'failed'
      tool.publicTitle = tool.failedTitle
    } else {
      const evidence = browseResultEvidence(data, resultBlock ?? undefined)
      if (evidence) {
      tool.publicDetail = { ...(tool.publicDetail ?? detailFor(tool, context.runId)), ...evidence }
      if (evidence.browse_outcome === 'failure') {
        tool.publicStatus = 'failed'
        tool.publicTitle = tool.failedTitle
      } else if (evidence.browse_outcome === 'pause') {
        tool.publicStatus = 'partial'
      } else if (evidence.browse_outcome === 'unknown') {
        tool.publicStatus = 'unknown'
        tool.publicTitle = '网页结果待核实'
      }
      } else if (tool.publicDetail?.tool_name === 'universe_browse') {
        tool.publicDetail = {
          ...(tool.publicDetail ?? detailFor(tool, context.runId)),
          browse_outcome: 'unknown', action_trace_count: 0,
          verification_statuses: ['UNKNOWN'], verified_action_types: [],
        }
        tool.publicStatus = 'unknown'
        tool.publicTitle = '网页结果待核实'
      }
    }
  }
  const defaultStatus = completed ? (failed ? 'failed' : 'succeeded') : 'running'
  const status = completed && tool.publicStatus ? tool.publicStatus : defaultStatus
  const defaultTitle = completed ? (failed ? tool.failedTitle : tool.completedTitle) : tool.runningTitle
  return { type: 'activity.upsert', payload: {
    activity_id: callId,
    run_id: context.runId,
    tool_call_id: callId,
    attempt_id: context.attemptId,
    status,
    title: tool.publicTitle ?? defaultTitle,
    started_at: tool.startedAt ?? context.at,
    ...(completed ? { ended_at: context.at } : {}),
    kind: tool.kind,
    detail: tool.publicDetail ?? detailFor(tool, context.runId),
  } }
}

export function projectWebOperationSnapshot(callId: string, toolName: string,
  snapshotValue: Record<string, unknown>, context: ProjectionContext): JotProjection | null {
  const snapshot = record(snapshotValue)
  const operationId = safeWebOperationId(snapshot?.operation_id)
  const operationKind = safeWebOperationKind(snapshot?.kind)
  const operationStatus = safeWebOperationStatus(snapshot?.status)
  const operationPresentation = webOperationPresentation(operationKind, operationStatus)
  const revision = Number(snapshot?.revision)
  const rows = Array.isArray(snapshot?.items) ? snapshot.items : null
  if (!snapshot || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(callId)
    || !operationId || !Number.isSafeInteger(revision) || revision < 1 || !rows) return null
  const eventCursorValue = Number(snapshot.event_cursor ?? 0)
  const eventCursor = Number.isSafeInteger(eventCursorValue) && eventCursorValue >= 0 ? eventCursorValue : 0
  const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(operationStatus)
  const status: ToolPresentation['publicStatus'] = operationStatus === 'partial' ? 'partial'
    : operationStatus === 'succeeded' ? 'succeeded'
      : operationStatus === 'failed' ? 'failed'
        : operationStatus === 'cancelled' ? 'cancelled'
          : operationStatus === 'waiting_confirmation' ? 'waiting'
            : operationStatus === 'unknown' || operationStatus === 'needs_reconciliation' ? 'unknown' : 'running'
  const title = operationPresentation.title
  const items = safeWebOperationItems(rows, operationKind, operationPresentation.itemActionLabel)
  const urls = [...new Set(items.map(item => item.url).filter((value): value is string => typeof value === 'string' && Boolean(value)))]
  const counts = safeWebOperationCounts(snapshot.counts)
  const acceptedCountValue = Number(snapshot.accepted_count ?? items.length)
  const acceptedCount = Number.isSafeInteger(acceptedCountValue) && acceptedCountValue >= 0 ? acceptedCountValue : items.length
  const normalizedToolName = operationKind === 'unknown' ? 'universe_web_batch' : `universe_${operationKind}`
  const detail = { tool_name: normalizedToolName, action: operationPresentation.action,
    operation: operationPresentation.operation, operation_kind: operationKind || 'unknown',
    operation_id: operationId, operation_status: operationStatus, revision,
    event_cursor: eventCursor, accepted_count: acceptedCount,
    counts, urls, ...(urls[0] ? { url: urls[0] } : {}), source_ids: [], items }
  const tool = context.knownTools?.get(callId) ?? presentation(toolName)
  tool.publicDetail = detail
  tool.publicStatus = status
  tool.publicTitle = title
  tool.startedAt ??= context.at
  context.knownTools?.set(callId, tool)
  return { type: 'activity.upsert', payload: {
    activity_id: callId, run_id: context.runId, tool_call_id: callId,
    attempt_id: context.attemptId, status, title, started_at: tool.startedAt,
    ...(terminal ? { ended_at: context.at } : {}), kind: 'browse', detail,
  } }
}

function settledAssistant(data: Record<string, unknown>, context: ProjectionContext): JotProjection | null {
  const message = record(data.message)
  if (!message || !Array.isArray(message.content)) return null
  const messageId = safeId(message.id, context.messageId)
  const blocks = message.content.flatMap((value, index) => {
    const block = record(value)
    if ((block?.type !== 'text' && block?.type !== 'reasoning') || typeof block.text !== 'string' || !block.text) return []
    return [{ block_id: `${messageId}:${index}`, kind: block.type, text: block.text,
      exposure: block.type === 'reasoning' ? 'provider' : 'public' }]
  })
  if (!blocks.length) return null
  return { type: 'assistant.settled', payload: { attempt_id: context.attemptId, message: {
    message_id: messageId, run_id: context.runId, role: 'assistant', status: 'complete', blocks,
    created_at: context.at,
  } } }
}

export function projectSessionFrame(frameValue: unknown, context: ProjectionContext): JotProjection | null {
  const frame = record(frameValue)
  if (!frame) return null
  if (frame.type === 'assistant-stream') {
    const live = record(frame.frame)
    const chunk = record(live?.chunk)
    if (live?.type === 'end' && record(live.outcome)?.kind === 'abandoned') return {
      type: 'assistant.settled', payload: { attempt_id: context.attemptId, message: {
        message_id: context.messageId, run_id: context.runId, role: 'assistant', status: 'failed', blocks: [],
        created_at: context.at,
      } },
    }
    if (live?.type !== 'chunk') return null
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') return {
      type: 'assistant.delta', payload: { message_id: context.messageId, block_id: context.blockId,
        kind: 'text', attempt_id: context.attemptId, delta_index: context.deltaIndex, text: chunk.text },
    }
    if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') return {
      type: 'assistant.delta', payload: { message_id: context.messageId, block_id: context.blockId,
        kind: 'reasoning', attempt_id: context.attemptId, delta_index: context.deltaIndex, text: chunk.text },
    }
    return null
  }
  if (frame.type !== 'event') return null
  const event = record(frame.event)
  const data = record(event?.data)
  if (!event || !data) return null
  if (event.type === 'tool/call') return toolActivity(data, context, false)
  if (event.type === 'tool/result') return toolActivity(data, context, true)
  if (event.type === 'assistant/message') return settledAssistant(data, context)
  return null
}
