import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

export type AdapterFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

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
  constructor(status: number, reasonCode: string) {
    super(`session_adapter_http_${status}`)
    this.name = 'SessionAdapterError'
    this.reasonCode = reasonCode
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
      throw new SessionAdapterError(response.status, reasonCode)
    }
    return value
  }

  async create(sessionId: string, cwd: string, agentPreset: string, signal?: AbortSignal) {
    return await this.post('/v1/sessions', {
      session_id: sessionId, cwd, agent_preset: agentPreset,
    }, signal)
  }

  async prompt(sessionId: string, requestId: string, content: string | SessionPromptPart[],
    mode: 'queue' | 'steer' = 'queue', signal?: AbortSignal) {
    return await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      request_id: requestId, ...(typeof content === 'string' ? { text: content } : { content }), mode,
    }, signal)
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

  async cancel(sessionId: string) {
    return await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {}, AbortSignal.timeout(20_000))
  }

  async *follow(sessionId: string, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/follow`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ max_messages: 100, assistant_stream: true }),
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
