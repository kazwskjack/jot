import {publicNativeToolResult,publicNativeToolCall,sessionToolCallId,type PublicNativeToolResult,type PublicNativeToolCall} from './native-tool-result.js'
import {createHash} from 'node:crypto'
import {
  safeWebOperationCounts, safeWebOperationId, safeWebOperationItems, safeWebOperationUrl,
  safeWebOperationKind, safeWebOperationStatus, webOperationPresentation,
} from './web-operation-presentation.ts'

export {sessionToolCallId} from './native-tool-result.js'

export interface JotProjection {
  type: 'assistant.delta' | 'assistant.settled' | 'activity.upsert'
  payload: Record<string, unknown>
}

export interface ProjectionContext {
  runId: string
  sessionRef?: string
  attemptId: string
  messageId: string
  blockId: string
  deltaIndex: number
  at: string
  /** Background task text is provisional until the business review publishes it. */
  deferCompletion?: boolean
  knownTools?: Map<string, ToolPresentation>
  /** Supplied only by a paired, opt-in consumer using accepted execution policy. */
  compaction?: {mode: 'chat'|'work'; states: Map<string,{activityId:string;startedAt:string;ended:boolean}>}
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
  if (tool.kind === 'search') return { query_count: 0, source_ids: [] }
  if (tool.kind === 'browse') return { operation: 'fetch', source_ids: [] }
  if (tool.kind === 'file_edit') return { display_path: '工作区文件', operation: 'edit', change_status: 'staging' }
  if (tool.kind === 'file_read') return { display_path: '工作区文件' }
  if (tool.kind === 'command') return { display_command: '执行工作区操作' }
  return { child_run_id: runId }
}

/** Rehydrate only the prior public call presentation after a replay restart. */
export function projectNativeToolEvent(event: Record<string, unknown>, context: ProjectionContext,
  priorCall?: Record<string, unknown>, publicResult?: PublicNativeToolResult, publicCall?: PublicNativeToolCall): JotProjection | null {
  const data = record(event.data)
  if (!data || !['tool/call', 'tool/result'].includes(String(event.type))) return null
  const callId = safeId(sessionToolCallId(data), '')
  const detail = record(priorCall?.detail)
  const knownTools = new Map<string, ToolPresentation>()
  if (callId && detail && typeof priorCall?.started_at === 'string') {
    const tool = presentation(detail.tool_name)
    if (tool.kind !== priorCall.kind) throw Error('native_activity_call_source_invalid')
    tool.publicDetail = { ...detail }
    tool.startedAt = priorCall.started_at
    knownTools.set(callId, tool)
  }
  return toolActivity(data, { ...context, knownTools }, event.type === 'tool/result', publicResult, publicCall)
}

function toolActivity(data: Record<string, unknown>, context: ProjectionContext, completed: boolean, publicResult?: PublicNativeToolResult, publicCall?: PublicNativeToolCall): JotProjection | null {
  const rawCallId = sessionToolCallId(data)
  const callId = safeId(rawCallId, '')
  if (!callId) return null
  const known = context.knownTools?.get(callId)
  const tool = known ?? presentation(data.name ?? data.toolName ?? data.tool)
  if (!known) {
    const detail = detailFor(tool, context.runId)
    const name = data.name ?? data.toolName ?? data.tool
    if (typeof name === 'string' && name) detail.tool_name = name
    const observed = publicCall ?? publicNativeToolCall(data)
    if (tool.kind === 'subagent' && name === 'jot_workspace' && observed.delegates
      && typeof rawCallId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(rawCallId)
      && context.sessionRef) {
      // Match the native dispatcher before public activity IDs are normalized.
      detail.native_request_id = 'delegate-' + createHash('sha256')
        .update(JSON.stringify([context.runId, context.sessionRef, rawCallId])).digest('hex')
    }
    if (tool.kind === 'search') detail.query_count = observed.query_count
    if (observed.urls.length) { detail.urls = observed.urls; detail.url = observed.urls[0] }
    if (observed.requested_action_types.length) detail.requested_action_types = observed.requested_action_types
    if (observed.action) detail.action = observed.action
    tool.publicDetail = detail
    tool.startedAt = context.at
  }
  if (!completed) context.knownTools?.set(callId, tool)
  const result = completed ? (publicResult ?? publicNativeToolResult(data, tool.kind === 'browse')) : null
  const failed = result?.failed === true
  if (completed && tool.kind === 'browse') {
    if (failed) {
      const evidence = result?.evidence
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
      const evidence = result?.evidence
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
    message_id: messageId, run_id: context.runId, role: 'assistant', status: context.deferCompletion ? 'streaming' : 'complete', blocks,
    created_at: context.at,
  } } }
}

function nativeCompaction(type: string, data: Record<string,unknown>, context: ProjectionContext): JotProjection|null {
  const scope=context.compaction, id=data.compactionId
  if(scope?.mode!=='work'||!(scope.states instanceof Map)||typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id)||!Number.isFinite(Date.parse(context.at)))return null
  const prior=scope.states.get(id)
  if(type==='compaction/start'){
    if(prior)return null
    const value={activityId:'compaction-'+createHash('sha256').update(JSON.stringify([context.runId,id])).digest('hex'),startedAt:context.at,ended:false}
    scope.states.set(id,value)
    return {type:'activity.upsert',payload:{activity_id:value.activityId,run_id:context.runId,attempt_id:context.attemptId,kind:'compaction',status:'running',title:'正在压缩上下文',started_at:value.startedAt,detail:{compaction_id:id,phase:'start'}}}
  }
  if(!prior||prior.ended||data.error!==undefined&&typeof data.error!=='string')return null
  prior.ended=true
  const failed=data.error!==undefined
  return {type:'activity.upsert',payload:{activity_id:prior.activityId,run_id:context.runId,attempt_id:context.attemptId,kind:'compaction',status:failed?'failed':'succeeded',title:failed?'上下文整理失败':'上下文已整理',started_at:prior.startedAt,ended_at:context.at,detail:{compaction_id:id,phase:'end'}}}
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
  if(event.type==='compaction/start'||event.type==='compaction/end')return nativeCompaction(event.type,data,context)
  if (event.type === 'tool/call') return toolActivity(data, context, false)
  if (event.type === 'tool/result') return toolActivity(data, context, true)
  if (event.type === 'assistant/message') return settledAssistant(data, context)
  return null
}
