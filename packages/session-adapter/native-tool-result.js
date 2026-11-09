const BROWSE_ACTION_TYPES = new Set(['click', 'expand', 'next_page', 'scroll', 'wait', 'fill'])
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
  return { failed: Boolean(data?.error || resultBlock?.isError || structuredToolFailure(data, resultBlock)),
    evidence: includeBrowse ? browseResultEvidence(data, resultBlock) : null }
}

/** Strict public vocabulary also bounds authenticated observation input. */
export function parsePublicNativeToolResult(value) {
  const result = record(value)
  if (!result || Object.keys(result).sort().join(',') !== 'evidence,failed' || typeof result.failed !== 'boolean') {
    throw Error('native_activity_public_result_invalid')
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
