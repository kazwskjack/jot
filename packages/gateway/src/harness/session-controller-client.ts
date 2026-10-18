import {normalizeExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts'
import {ordinaryRunCompletionSource,validateOrdinaryRunCompletion,type OrdinaryRunHistoryScope} from './ordinary-run-completion.ts'
import {normalizeOrdinaryHistoryScope,validateOrdinarySteeringObservation,validateBoundOrdinarySteeringObservation,type OrdinaryHistoryScope} from './ordinary-steering-observation.ts'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import {nativeIdleSessionId,validateNativeIdleObservation} from './native-idle-observation.ts'

export type AdapterFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type OriginalInputExecution=Readonly<{run_id:string;execution_lease:ExecutionLease}>;
export function normalizeOriginalInputExecution(value:unknown):OriginalInputExecution{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('ordinary_input_binding_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='execution_lease,run_id'||typeof row.run_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row.run_id))throw Error('ordinary_input_binding_invalid');
 return Object.freeze({run_id:row.run_id,execution_lease:normalizeExecutionLease(row.execution_lease)});
}
export type OrdinarySteeringExecution=Readonly<{run_id:string;command_id:string;execution_lease:ExecutionLease}>;
export function normalizeOrdinarySteeringExecution(value:unknown):OrdinarySteeringExecution{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('ordinary_steering_binding_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='command_id,execution_lease,run_id'||typeof row.run_id!=='string'||typeof row.command_id!=='string'||![row.run_id,row.command_id].every(id=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id))||row.run_id===row.command_id)throw Error('ordinary_steering_binding_invalid');
 return Object.freeze({run_id:row.run_id,command_id:row.command_id,execution_lease:normalizeExecutionLease(row.execution_lease)});
}
export type ConversationGoalExecution=Readonly<{control_id:string;run_id:string;execution_lease:ExecutionLease}>;
export function normalizeGoalExecution(value:unknown):ConversationGoalExecution{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('goal_control_input_invalid');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!=='control_id,execution_lease,run_id'||!['control_id','run_id'].every(key=>typeof row[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row[key] as string)))throw Error('goal_control_input_invalid');
  return Object.freeze({control_id:row.control_id as string,run_id:row.run_id as string,execution_lease:normalizeExecutionLease(row.execution_lease)});
}

export type SessionPromptPart = { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string; name?: string }
  | { type: 'file'; receipt_id: string }

const SAFE_ADAPTER_REASON_CODES = new Set([
  'DSH_IMAGE_MODEL_UNSUPPORTED', 'DSH_IMAGE_INVALID', 'DSH_IMAGE_TOO_MANY_PIXELS',
  'DSH_IMAGE_DIMENSION_TOO_LARGE', 'DSH_IMAGE_STORAGE_FAILED', 'DSH_IMAGE_REFERENCE_INVALID',
  'DSH_IMAGE_TYPE_MISMATCH', 'DSH_IMAGE_TOO_LARGE', 'DSH_IMAGE_INTEGRITY_FAILED',
  'DSH_IMAGE_NOT_FOUND', 'DSH_IMAGE_READ_FAILED', 'DSH_TOO_MANY_IMAGES',
  'DSH_IMAGES_TOO_LARGE', 'DSH_IMAGE_TYPE_UNSUPPORTED', 'DSH_IMAGE_PROJECTION_UNSUPPORTED',
  'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED',
  'DSH_MODEL_UNAVAILABLE', 'DSH_SESSION_NOT_FOUND', 'DSH_PROMPT_REJECTED',
])

export class SessionAdapterError extends Error {
  readonly reasonCode: string
  readonly status:number
  readonly protocolCode:string|undefined
  constructor(status: number, reasonCode: string,protocolCode?:string) {
    super(`session_adapter_http_${status}`)
    this.name = 'SessionAdapterError'
    this.reasonCode = reasonCode
    this.status=status
    this.protocolCode=protocolCode
  }
}

function endpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('adapter_endpoint_not_loopback')
  }
  return url.toString().replace(/\/$/, '')
}

function nativeEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('native_endpoint_not_loopback')
  }
  return `${url.toString().replace(/\/$/, '')}/v2/native/tool`
}

export class SessionControllerClient {
  private readonly baseUrl: string
  private readonly nativeUrl: string
  private readonly token: string
  private readonly fetchImpl: AdapterFetch
  constructor(baseUrl: string, token: string, fetchImpl: AdapterFetch = globalThis.fetch,
    nativeBaseUrl = 'http://127.0.0.1:18792') {
    this.baseUrl = endpoint(baseUrl)
    this.nativeUrl = nativeEndpoint(nativeBaseUrl)
    this.token = token
    this.fetchImpl = fetchImpl
    if (token.length < 32) throw new Error('adapter_token_invalid')
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const reasonCode = typeof value.reason_code === 'string' && SAFE_ADAPTER_REASON_CODES.has(value.reason_code)
        ? value.reason_code : 'DSH_NO_RUNTIME_OUTCOME'
      throw new SessionAdapterError(response.status, reasonCode,typeof value.error==='string'&&['goal_revision_changed','goal_cold_input_pending'].includes(value.error)?value.error:undefined)
    }
    return value
  }

  async create(sessionId: string, cwd: string, agentPreset: string, signal?: AbortSignal, workbenchRunId?: string, workbenchExecutionLease?: ExecutionLease,workWorkspace?:Readonly<{protocol:1}>) {
    return await this.post('/v1/sessions', {
      session_id: sessionId, cwd, agent_preset: agentPreset,
      ...(workbenchRunId ? { workbench_context: { run_id: workbenchRunId, ...(workbenchExecutionLease?{execution_lease:normalizeExecutionLease(workbenchExecutionLease)}:{}),...(workWorkspace?{work_workspace:workWorkspace}:{}) } } : {}),
    }, signal)
  }

  async modelCatalog(signal:AbortSignal){return this.post('/v1/models',{},signal);}

  async prompt(sessionId: string, requestId: string, content: string | SessionPromptPart[],
    mode: 'queue' | 'steer' = 'queue', signal?: AbortSignal, original?:OriginalInputExecution) {
    const admission=original===undefined?undefined:normalizeOriginalInputExecution(original);if(admission&&admission.run_id!==requestId)throw Error('ordinary_input_binding_invalid');
    return await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      request_id: requestId, ...(typeof content === 'string' ? { text: content } : { content }), mode,...(admission?{ordinary_input:admission}:{}),
    }, signal)
  }

  async inputCompletion(sessionId:string,execution:OriginalInputExecution,commandIds:readonly string[],signal?:AbortSignal){
    const scope=normalizeOriginalInputExecution(execution);if(!Array.isArray(commandIds)||commandIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id)||id===scope.run_id)||new Set(commandIds).size!==commandIds.length)throw Error('ordinary_completion_input_invalid');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/input-completion`,{ordinary_input:scope,command_ids:[...commandIds]},signal);
  }

  /** Private read-only history; acceptance facts never authorize another prompt. */
  async observeSteeringHistory(sessionId:string,input:OrdinaryHistoryScope,signal?:AbortSignal){
    const scope=normalizeOrdinaryHistoryScope(sessionId,input);
    return validateOrdinarySteeringObservation(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/steering-history`,{history:scope},signal),sessionId,scope);
  }
  async observeBoundSteeringHistory(sessionId:string,input:OrdinaryHistoryScope,sourceHash:string,signal?:AbortSignal){
    const scope=normalizeOrdinaryHistoryScope(sessionId,input);if(typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(sourceHash))throw Error('ordinary_history_contract_invalid');
    return validateBoundOrdinarySteeringObservation(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/steering-history-v2`,{history:scope,source_sha256:sourceHash},signal),sessionId,scope,sourceHash);
  }
  async observeRunCompletion(sessionId:string,input:OrdinaryRunHistoryScope,source:unknown,signal?:AbortSignal){
    const expected=ordinaryRunCompletionSource(sessionId,input,source);
    return validateOrdinaryRunCompletion(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/run-history-completion`,{history:expected.scope,source_sha256:expected.source_sha256},signal),sessionId,expected.scope,source);
  }
  async ordinaryRunHistoryReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(15000),value=await this.post('/v1/ordinary-run-history/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,protocol,ready'||typeof value.ready!=='boolean'||value.protocol!==1||value.execution_authorized!==false)throw Error('ordinary_run_history_readiness_invalid');
    return{ready:value.ready,protocol:1 as const,execution_authorized:false as const};
  }

  async steerOriginal(sessionId:string,requestId:string,text:string,execution:OrdinarySteeringExecution,signal?:AbortSignal){
    const proof=normalizeOrdinarySteeringExecution(execution);if(proof.command_id!==requestId)throw Error('ordinary_steering_binding_invalid');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,{request_id:requestId,text,mode:'steer',ordinary_steer:proof},signal);
  }

  /**
   * Call the loopback DSH leaf bridge's native Universe route for internal
   * durable batch-event polling and timing metadata. The model never receives
   * this method as a tool; the bridge still performs its normal typed dispatch.
   */
  async nativeTool(tool: string, args: Record<string, unknown>, execution: Record<string, string>, signal?: AbortSignal) {
    const response = await this.fetchImpl(this.nativeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ tool, arguments: args, execution }),
      ...(signal ? { signal } : {}),
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(`native_tool_http_${response.status}`)
    return value
  }

  async stageFile(sessionId: string, path: string, displayName: string, signal?: AbortSignal) {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/octet-stream',
        'x-file-name-b64': Buffer.from(displayName, 'utf8').toString('base64url') },
      body: Readable.toWeb(createReadStream(path)) as BodyInit,
      ...(signal ? { signal } : {}),
      ...({ duplex: 'half' } as Record<string, unknown>),
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) throw new SessionAdapterError(response.status, 'DSH_NO_RUNTIME_OUTCOME')
    return value as { receipt_id: string; file?: Record<string, unknown> }
  }

  async memoryExtractionReadiness(signal:AbortSignal){
    return this.post('/v1/memory-extraction/readiness',{},signal);
  }
  async nativeIdleObservationReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(5000),value=await this.post('/v1/native-idle-observation/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,protocol,ready'||value.protocol!==1||typeof value.ready!=='boolean'||value.execution_authorized!==false)throw Error('native_idle_readiness_invalid');
    return Object.freeze({protocol:1 as const,ready:value.ready,execution_authorized:false as const});
  }
  async observeNativeIdle(sessionId:string,signal?:AbortSignal){
    nativeIdleSessionId(sessionId);const deadline=AbortSignal.timeout(20_000);
    return validateNativeIdleObservation(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/idle-observation`,{protocol:1},signal?AbortSignal.any([signal,deadline]):deadline),sessionId);
  }
  async conversationGoal(sessionId:string,body:Record<string,unknown>={},signal?:AbortSignal){
    const deadline=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/conversation-goal`,body,signal?AbortSignal.any([signal,deadline]):deadline);
  }
  async recoverInput(sessionId:string,execution:OriginalInputExecution,signal?:AbortSignal){
    const deadline=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/input-resume`,{ordinary_input:normalizeOriginalInputExecution(execution)},signal?AbortSignal.any([signal,deadline]):deadline);
  }
  async resumeGoal(sessionId:string,control:ConversationGoalExecution,signal?:AbortSignal){
    const deadline=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-resume`,{goal_control:normalizeGoalExecution(control)},signal?AbortSignal.any([signal,deadline]):deadline);
  }
  async conversationGoalResumeReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(5000);
    return this.post('/v1/conversation-goal-resume/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
  }

  async extractMemory(sessionId:string,runId:string,signal:AbortSignal){
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/memory-extraction`,{run_id:runId},signal);
  }

  async cancel(sessionId: string) {
    return await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {}, AbortSignal.timeout(20_000))
  }

  async checkpoint(sessionId:string,afterSeq:number,signal?:AbortSignal){
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint`,{after_seq:afterSeq},signal);
  }
  /** Private host observation only; not a model tool or public conversation API. */
  async goalStatus(sessionId:string,signal?:AbortSignal){
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-status`,{},signal);
  }
  async goalStop(sessionId:string,ref:{goal_id:string;goal_revision:number},signal?:AbortSignal){
    const timeout=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-stop`,ref,signal?AbortSignal.any([signal,timeout]):timeout);
  }
  async goalComplete(sessionId:string,intentId:string,signal?:AbortSignal){
    const timeout=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-complete`,{intent_id:intentId},signal?AbortSignal.any([signal,timeout]):timeout);
  }
  async goalRestore(sessionId:string,runId:string,intentId?:string,signal?:AbortSignal){
    const timeout=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-restore`,{run_id:runId,...(intentId===undefined?{}:{intent_id:intentId})},signal?AbortSignal.any([signal,timeout]):timeout);
  }

  async *follow(sessionId: string, signal?: AbortSignal,goalControl?:ConversationGoalExecution,ordinaryInput?:OriginalInputExecution): AsyncGenerator<Record<string, unknown>> {
    if(goalControl&&ordinaryInput)throw Error('ordinary_input_binding_invalid');
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/follow`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ max_messages: 100, assistant_stream: true,...(goalControl?{goal_control:normalizeGoalExecution(goalControl)}:{}),...(ordinaryInput?{ordinary_input:normalizeOriginalInputExecution(ordinaryInput)}:{}) }),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok || !response.body) throw new Error(`session_adapter_follow_http_${response.status}`)
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) yield JSON.parse(line) as Record<string, unknown>
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    if (pending.trim()) yield JSON.parse(pending) as Record<string, unknown>
  }
}
