import {isIP} from 'node:net'

const BROWSE_ACTION_TYPES = new Set(['click', 'expand', 'next_page', 'scroll', 'wait', 'fill'])
const SAFE_TOOL_ACTION_LABELS = new Set([
  ...BROWSE_ACTION_TYPES, 'browse', 'execute', 'fetch', 'interact', 'navigate', 'open', 'read', 'search', 'web_operation',
])
const nonPublicHostSuffixes = new Set(['arpa', 'corp', 'example', 'home', 'internal', 'invalid', 'lan', 'local', 'localhost', 'onion', 'test'])
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

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parsedJson(value) {
  if (typeof value !== 'string' || value.length > 1_000_000) return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try { return JSON.parse(trimmed) } catch { return value }
}

function browseResultEvidence(data, resultBlock) {
  const roots = [data.result, data.structuredContent, resultBlock?.result, resultBlock?.content]
  const capabilityResults = []
  const seen = new Set()
  let visited = 0
  const visit = (candidate, depth) => {
    if (depth > 8 || visited++ > 2048) return
    const value = parsedJson(candidate)
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visited > 2048) break
        visit(item, depth + 1)
      }
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
  const trace = []
  if (Array.isArray(finalData?.interaction_trace)) {
    const rows = finalData.interaction_trace
    for (let index = rows.length - 1; index >= 0 && trace.length < 12; index--) {
      const row = record(rows[index])
      if (row) trace.unshift(row)
    }
  }
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

function structuredToolFailure(data, resultBlock) {
  const failed = value => {
    const block = record(value)
    const result = record(parsedJson(block?.type === 'text' ? block.text : value))
    return result?.ok === false
  }
  return [data.result, data.structuredContent].some(failed)
    || Array.isArray(resultBlock?.content) && resultBlock.content.some(failed)
}

export function sessionToolCallId(data) {
  const message = record(data.message)
  const source = record(message?.source)
  const resultBlock = Array.isArray(message?.content)
    ? message.content.find(block => record(block)?.type === 'tool-result') : undefined
  return data.callId ?? (source?.kind === 'tool' ? source.callId : undefined)
    ?? resultBlock?.toolCallId ?? message?.toolCallId ?? data.id
}

export function publicNativeToolResult(data, includeBrowse = true) {
  const message = record(data?.message)
  const resultBlock = Array.isArray(message?.content)
    ? message.content.find(block => record(block)?.type === 'tool-result') : undefined
  const receipts = new Map()
  collectArtifactRefs(data, undefined, receipts)
  const artifacts = [...receipts.values()].sort((left, right) =>
    left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : left.version - right.version
      || (left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0))
  return { failed: Boolean(data?.error || resultBlock?.isError || structuredToolFailure(data, resultBlock)),
    evidence: includeBrowse ? browseResultEvidence(data, resultBlock) : null,
    ...(artifacts.length ? {artifact_receipts: artifacts} : {}) }
}

/** Strict public vocabulary for authenticated result observations. */
export function parsePublicNativeToolResult(value) {
  const result = record(value)
  if (!result || Object.keys(result).sort().join(',') !== (result.artifact_receipts === undefined ? 'evidence,failed' : 'artifact_receipts,evidence,failed') || typeof result.failed !== 'boolean') {
    throw Error('native_activity_public_result_invalid')
  }
  if (result.artifact_receipts !== undefined) {
    if (!Array.isArray(result.artifact_receipts)) throw Error('native_activity_public_result_invalid')
    const seen = new Set()
    for (const receipt of result.artifact_receipts) {
      if (!record(receipt) || Object.keys(receipt).sort().join(',') !== 'artifact_id,sha256,version'
        || typeof receipt.artifact_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(receipt.artifact_id)
        || !Number.isSafeInteger(receipt.version) || receipt.version < 1
        || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw Error('native_activity_public_result_invalid')
      const key = JSON.stringify([receipt.artifact_id, receipt.version, receipt.sha256])
      if (seen.has(key)) throw Error('native_activity_public_result_invalid')
      seen.add(key)
    }
  }
  const evidence = result.evidence
  if (evidence === null) return result
  const keys = ['browse_outcome', 'action_trace_count', 'traced_action_types', 'verification_statuses', 'verified_action_types']
  if (!record(evidence) || Object.keys(evidence).some(key => !keys.includes(key))
    || !['success', 'pause', 'failure', 'unknown'].includes(evidence.browse_outcome)
    || !Number.isSafeInteger(evidence.action_trace_count) || evidence.action_trace_count < 0 || evidence.action_trace_count > 12) {
    throw Error('native_activity_public_result_invalid')
  }
  const list = (items, allowed) => Array.isArray(items) && items.length <= evidence.action_trace_count
    && new Set(items).size === items.length && items.every(item => typeof item === 'string' && allowed.has(item))
  if (!list(evidence.verified_action_types, BROWSE_ACTION_TYPES)
    || evidence.traced_action_types !== undefined && !list(evidence.traced_action_types, BROWSE_ACTION_TYPES)
    || evidence.verification_statuses !== undefined && !list(evidence.verification_statuses, new Set([...BROWSE_VERIFICATION_STATUSES, 'UNKNOWN']))) {
    throw Error('native_activity_public_result_invalid')
  }
  return result
}

/** Source digest is carried separately from this bounded public observation. */
export function nativeToolResultObservation(event) {
  if (event?.type !== 'tool/result' || !record(event.data)) throw Error('native_activity_event_invalid')
  return { event: { type: event.type, seq: event.seq, time: event.time, data: { callId: sessionToolCallId(event.data) } },
    public_result: publicNativeToolResult(event.data) }
}

export function nativeBatchWebCall(data){
 const name=data?.name??data?.tool;if(!['universe_read_page','universe_browse','universe_execute'].includes(name))return null;
 let args=data?.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{return {name};}
 if(!args||typeof args!=='object'||Array.isArray(args))return {name};
 if(name==='universe_read_page')return Object.hasOwn(args,'urls')?{name}:null;
 return args.inputs&&Object.hasOwn(args.inputs,'items')?{name}:null;
}

export function safeWebOperationUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || [...value].length > 8192) return null
  try {
    const parsed = new URL(value)
    const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1]
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !authority || authority.includes('@')
      || parsed.username !== '' || parsed.password !== '') return null
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    const labels = hostname.split('.')
    const suffix = labels.at(-1) ?? ''
    const ipHost = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
    if (isIP(ipHost) !== 0 || parsed.port !== '' || labels.length < 2 || nonPublicHostSuffixes.has(suffix)
      || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
    return parsed.origin
  } catch {
    return null
  }
}


/** Extract only the original public argument vocabulary for tool activities. */
export function publicNativeToolCall(data) {
  let args = null
  try { args = record(typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments) } catch {}
  const name = data.name ?? data.toolName ?? data.tool
  const queries = new Set()
  if (/(search|research|query)/.test(String(name ?? '').toLowerCase())) {
    const inputs = record(args?.inputs)
    const addQuery = value => {
      if (queries.size < 50 && typeof value === 'string' && value.trim()) queries.add(value.trim().slice(0, 2000))
    }
    addQuery(args?.query); addQuery(inputs?.query)
    for (const values of [args?.queries, inputs?.queries]) {
      if (!Array.isArray(values)) continue
      for (const value of values) { addQuery(value); if (queries.size === 50) break }
    }
  }
  const urls = new Set()
  const addUrl = value => { const url = safeWebOperationUrl(value); if (url) urls.add(url) }
  const visit = (value, depth) => {
    if (depth > 4) return
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    const object = record(value)
    if (!object) return
    addUrl(object.url)
    if (Array.isArray(object.urls)) for (const value of object.urls) addUrl(value)
    for (const key of ['input', 'inputs', 'params', 'arguments', 'actions', 'open', 'navigate']) visit(object[key], depth + 1)
  }
  visit(args, 0)
  const actions = new Set()
  for (const values of [args?.actions, record(args?.inputs)?.actions]) {
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const type = record(value)?.type
      if (typeof type === 'string' && BROWSE_ACTION_TYPES.has(type.toLowerCase())) actions.add(type.toLowerCase())
    }
  }
  const action = args?.action ?? args?.operation
  const batch = nativeBatchWebCall({name: data.name, tool: data.tool, arguments: args})
  return {
    query_count: queries.size, urls: [...urls], requested_action_types: [...actions],
    delegates: name === 'jot_workspace' && args?.operation === 'tasks.delegate',
    ...(typeof action === 'string' && SAFE_TOOL_ACTION_LABELS.has(action.toLowerCase()) ? {action: action.toLowerCase()} : {}),
    ...(batch ? {native_batch_web: batch.name} : {}),
  }
}

export function parsePublicNativeToolCall(value) {
  const call = record(value)
  const keys = ['query_count', 'urls', 'requested_action_types', 'delegates', 'action', 'native_batch_web']
  if (!call || Object.keys(call).some(key => !keys.includes(key))
    || !Number.isSafeInteger(call.query_count) || call.query_count < 0 || call.query_count > 50
    || typeof call.delegates !== 'boolean'
    || !Array.isArray(call.urls) || new Set(call.urls).size !== call.urls.length
    || call.urls.some(url => typeof url !== 'string' || safeWebOperationUrl(url) !== url)
    || !Array.isArray(call.requested_action_types) || call.requested_action_types.length > BROWSE_ACTION_TYPES.size
    || new Set(call.requested_action_types).size !== call.requested_action_types.length
    || call.requested_action_types.some(type => !BROWSE_ACTION_TYPES.has(type))
    || call.action !== undefined && !SAFE_TOOL_ACTION_LABELS.has(call.action)
    || call.native_batch_web !== undefined && !['universe_read_page', 'universe_browse', 'universe_execute'].includes(call.native_batch_web)) {
    throw Error('native_activity_public_call_invalid')
  }
  return call
}

/** Original event identity is hashed separately from the public observation. */
export function nativeToolCallObservation(event) {
  const data = record(event?.data)
  if (event?.type !== 'tool/call' || !data) throw Error('native_activity_event_invalid')
  const name = data.name ?? data.toolName ?? data.tool
  // Keep compatibility with non-SDK legacy records using their original format.
  if (typeof name !== 'string') return null
  return {event: {type: event.type, seq: event.seq, time: event.time, data: {callId: sessionToolCallId(data), name}},
    public_call: publicNativeToolCall(data)}
}

export function collectArtifactRefs(value, output, receipts) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) return
    try { collectArtifactRefs(JSON.parse(text), output, receipts) } catch { /* Tool prose is not a structured artifact declaration. */ }
    return
  }
  if (Array.isArray(value)) { for (const item of value) collectArtifactRefs(item, output, receipts); return }
  const valueRow = record(value)
  if (!valueRow) return
  const completedJob = valueRow.status === 'completed'
    && Number.isInteger(Number(valueRow.output_version)) && Number(valueRow.output_version) > 0
  const immutableReceipt = Number.isInteger(Number(valueRow.version)) && Number(valueRow.version) > 0
    && typeof valueRow.sha256 === 'string' && typeof valueRow.media_type === 'string'
    && Number.isFinite(Number(valueRow.size_bytes)) && Number(valueRow.size_bytes) >= 0
  if ((completedJob || immutableReceipt) && typeof valueRow.artifact_ref === 'string'
    && /^artifact-[A-Za-z0-9-]+$/.test(valueRow.artifact_ref)) {
    output?.add(valueRow.artifact_ref)
  }
  if (receipts) {
    const artifactId = valueRow.artifact_ref ?? valueRow.artifact_id, version = Number(valueRow.version);
    const sha256 = valueRow.sha256;
    if (typeof artifactId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(artifactId)
      && (typeof valueRow.version === 'number' || typeof valueRow.version === 'string')
      && Number.isSafeInteger(version) && version > 0 && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)) {
      receipts.set(JSON.stringify([artifactId, version, sha256]), {artifact_id: artifactId, version, sha256});
    }
  }
  for (const child of Object.values(valueRow)) collectArtifactRefs(child, output, receipts)
}

