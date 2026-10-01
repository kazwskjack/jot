import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createVoiceAdapterHandler } from './voice.js'

export const name = 'jot-session-adapter'
export const inject = ['sessionController', 'fileUploads', 'agents']

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const ALLOWED_AGENT_PRESETS = new Set([
  'jot-general',
  'jot-general-batch50',
  'jot-general-batch',
])
const IMAGE_FAILURE_CODES = Object.freeze({
  MODEL_DOES_NOT_SUPPORT_IMAGES: 'DSH_IMAGE_MODEL_UNSUPPORTED',
  INVALID_IMAGE: 'DSH_IMAGE_INVALID',
  IMAGE_TOO_MANY_PIXELS: 'DSH_IMAGE_TOO_MANY_PIXELS',
  IMAGE_DIMENSION_TOO_LARGE: 'DSH_IMAGE_DIMENSION_TOO_LARGE',
  ATTACHMENT_WRITE_FAILED: 'DSH_IMAGE_STORAGE_FAILED',
  INVALID_ATTACHMENT_REF: 'DSH_IMAGE_REFERENCE_INVALID',
  IMAGE_TYPE_MISMATCH: 'DSH_IMAGE_TYPE_MISMATCH',
  IMAGE_TOO_LARGE: 'DSH_IMAGE_TOO_LARGE',
  ATTACHMENT_CORRUPT: 'DSH_IMAGE_INTEGRITY_FAILED',
  ATTACHMENT_NOT_FOUND: 'DSH_IMAGE_NOT_FOUND',
  ATTACHMENT_READ_FAILED: 'DSH_IMAGE_READ_FAILED',
  TOO_MANY_IMAGES: 'DSH_TOO_MANY_IMAGES',
  IMAGES_TOO_LARGE: 'DSH_IMAGES_TOO_LARGE',
  UNSUPPORTED_IMAGE_TYPE: 'DSH_IMAGE_TYPE_UNSUPPORTED',
  ATTACHMENT_PROJECTION_UNSUPPORTED: 'DSH_IMAGE_PROJECTION_UNSUPPORTED',
})

function promptFailureReasonCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const reason = typeof error?.details?.reason === 'string' ? error.details.reason : ''
  if (Object.hasOwn(IMAGE_FAILURE_CODES, reason)) return IMAGE_FAILURE_CODES[reason]
  if (code === 'session/model-unavailable') return 'DSH_MODEL_UNAVAILABLE'
  if (code === 'session/not-found') return 'DSH_SESSION_NOT_FOUND'
  return 'DSH_PROMPT_REJECTED'
}

function hasKnownSharpNativeImportFailure(error) {
  const pending = [error]
  const seen = new Set()
  while (pending.length && seen.size < 12) {
    const value = pending.shift()
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue
    seen.add(value)
    if (value.name === 'TypeError'
      && /Cannot read properties of undefined \(reading ['"]output['"]\)/i.test(String(value.message ?? ''))) return true
    if (value.cause) pending.push(value.cause)
    if (Array.isArray(value.errors)) pending.push(...value.errors)
  }
  return false
}

function authorized(actual, expected) {
  const prefix = 'Bearer '
  if (typeof actual !== 'string' || !actual.startsWith(prefix) || expected.length < 32) return false
  const candidate = Buffer.from(actual.slice(prefix.length))
  const wanted = Buffer.from(expected)
  return candidate.length === wanted.length && timingSafeEqual(candidate, wanted)
}

function json(status, value) { return { status, value } }

export function adapterErrorSummary(error) {
  const messages = []
  const seen = new Set()
  const visit = value => {
    if (!value || seen.has(value) || messages.length >= 12) return
    seen.add(value)
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error'
    const message = typeof value.message === 'string' && value.message ? value.message : String(value)
    messages.push(`${name}: ${message}`)
    visit(value.cause)
    if (Array.isArray(value.errors)) for (const nested of value.errors) visit(nested)
  }
  visit(error)
  return { messages }
}

function promptContent(body) {
  if (!Array.isArray(body?.content)) {
    const text = String(body?.text ?? '').trim()
    return text ? [{ type: 'text', text }] : null
  }
  if (body.content.length < 1 || body.content.length > 11) return null
  const values = []
  let attachments = 0
  for (const raw of body.content) {
    if (!raw || typeof raw !== 'object') return null
    if (raw.type === 'text') {
      const text = String(raw.text ?? '').trim(); if (!text) return null
      values.push({ type: 'text', text }); continue
    }
    attachments += 1
    if (attachments > 10) return null
    if (raw.type === 'image') {
      const mediaType = String(raw.media_type ?? '')
      const data = String(raw.data ?? '')
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 28 * 1024 * 1024) return null
      const value = { type: 'image', mediaType, data }
      if (typeof raw.name === 'string' && raw.name) value.name = raw.name.slice(0, 255)
      values.push(value); continue
    }
    if (raw.type === 'file') {
      const receiptId = String(raw.receipt_id ?? '')
      if (!ID.test(receiptId)) return null
      values.push({ type: 'file', receiptId }); continue
    }
    return null
  }
  return values.length ? values : null
}

function decodeFilename(headers) {
  const encoded = typeof headers['x-file-name-b64'] === 'string' ? headers['x-file-name-b64'] : ''
  if (!encoded || !/^[A-Za-z0-9_-]{1,1024}$/.test(encoded)) return null
  const value = Buffer.from(encoded, 'base64url').toString('utf8')
  return value && Buffer.byteLength(value, 'utf8') <= 255 && !/[\u0000\/\\]/.test(value) ? value : null
}

export function createAdapterHandler({ controller, fileUploads, agents, speechController, voiceEnabled = false, token }) {
  const voiceHandler = voiceEnabled ? createVoiceAdapterHandler({ speechController, token }) : null
  return async ({ method, url, headers, body, signal = new AbortController().signal }) => {
    if (!authorized(headers.authorization, token)) return json(401, { error: 'unauthorized' })
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
    if (url.pathname.startsWith('/v1/voice/')) {
      if (!voiceHandler) return json(404, { error: 'not_found' })
      return voiceHandler({ method, url, headers, body, signal })
    }
    if (url.pathname === '/v1/sessions') {
      const sessionId = String(body?.session_id ?? '')
      const cwd = String(body?.cwd ?? '')
      if (!ID.test(sessionId) || !cwd.startsWith('/')) return json(422, { error: 'session_input_invalid' })
      const requestedPreset = body?.agent_preset
      if (requestedPreset !== undefined && !ALLOWED_AGENT_PRESETS.has(requestedPreset)) {
        return json(422, { error: 'agent_preset_not_allowed' })
      }
      const request = { sessionId, cwd }
      if (requestedPreset !== undefined) request.agentPreset = requestedPreset
      const value = await controller.create(request)
      return json(201, value)
    }
    const cancel = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/)
    if (cancel) {
      const sessionId = decodeURIComponent(cancel[1])
      if (!ID.test(sessionId)) return json(422, { error: 'session_id_invalid' })
      if (!agents?.get) return json(503, { error: 'agent_registry_unavailable' })
      const agent = agents.get(sessionId)
      // No attached driver exists after a Host restart; there is no live turn to stop.
      if (!agent) return json(202, { accepted: true, settled: true, attached: false })
      const value = await controller.cancel({ sessionId })
      await agent.whenIdle()
      return json(202, { ...value, settled: true, attached: true })
    }
    const prompt = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/prompts$/)
    if (prompt) {
      const sessionId = decodeURIComponent(prompt[1])
      const requestId = String(body?.request_id ?? '')
      const content = promptContent(body)
      const mode = body?.mode === 'steer' ? 'steer' : 'queue'
      if (!ID.test(sessionId) || !ID.test(requestId) || !content) return json(422, { error: 'prompt_input_invalid' })
      let value
      try {
        value = await controller.prompt({ requestId, sessionId, mode, content }, signal)
      } catch (error) {
        // Keep protocol-visible diagnostics stable and allow-listed. Remote error
        // messages/details may contain model, filesystem, or user-provided data.
        const hasImage = content.some(part => part.type === 'image')
        const reasonCode = hasImage && hasKnownSharpNativeImportFailure(error)
          ? 'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED' : promptFailureReasonCode(error)
        return json(422, { error: 'prompt_rejected', reason_code: reasonCode })
      }
      return json(202, value)
    }
    const file = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/files$/)
    if (file) {
      const sessionId = decodeURIComponent(file[1]); const name = decodeFilename(headers)
      if (!ID.test(sessionId) || !name || !body?.[Symbol.asyncIterator]) return json(422, { error: 'file_input_invalid' })
      if (!fileUploads?.uploadStream) return json(503, { error: 'file_uploads_unavailable' })
      const value = await fileUploads.uploadStream({ sessionId, data: body, signal, name })
      return json(201, { receipt_id: value.receiptId, file: value.file })
    }
    const follow = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/follow$/)
    if (follow) {
      const sessionId = decodeURIComponent(follow[1])
      if (!ID.test(sessionId)) return json(422, { error: 'session_id_invalid' })
      const maxMessages = Math.min(200, Math.max(1, Number(body?.max_messages ?? 50)))
      const request = { address: { kind: 'session', sessionId }, maxMessages }
      if (body?.assistant_stream === true) request.assistantStream = true
      return { status: 200, stream: controller.follow(request, signal) }
    }
    return json(404, { error: 'not_found' })
  }
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

export function apply(ctx, config = {}) {
  const host = config.host || '127.0.0.1'
  const port = Number(config.port || 18841)
  const token = String(process.env[config.tokenEnv || 'JOT_SESSION_ADAPTER_TOKEN'] || '')
  const voiceEnabled = config.voiceEnabled === true
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || token.length < 32) {
    throw new Error('jot_session_adapter_config_invalid')
  }
  const speechController = voiceEnabled ? ctx.speechController : undefined
  if (voiceEnabled && !speechController) throw new Error('jot_voice_speech_service_unavailable')
  const handler = createAdapterHandler({ controller: ctx.sessionController, fileUploads: ctx.fileUploads, agents: ctx.agents,
    speechController, voiceEnabled, token })
  const server = createServer(async (req, res) => {
    const abort = new AbortController()
    req.once('aborted', () => abort.abort())
    res.once('close', () => { if (!res.writableEnded) abort.abort() })
    try {
      const url = new URL(req.url, `http://${host}:${port}`)
      const isFileUpload = /^\/v1\/sessions\/[^/]+\/files$/.test(url.pathname)
      const bodyLimit = url.pathname.startsWith('/v1/voice/') ? 4 * 1024 * 1024 : 32 * 1024 * 1024
      const result = await handler({ method: req.method, url, headers: req.headers,
        body: isFileUpload ? req : await readJson(req, bodyLimit), signal: abort.signal })
      if (result.stream) {
        res.writeHead(result.status, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
        for await (const frame of result.stream) res.write(`${JSON.stringify(frame)}\n`)
        return res.end()
      }
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result.value))
    } catch (error) {
      console.error('[jot-session-adapter] request failed', JSON.stringify(adapterErrorSummary(error)))
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'adapter_internal_error' }))
    }
  })
  server.listen(port, host)
  ctx.effect(() => () => server.close())
}
