import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createVoiceAdapterHandler } from './voice.js'
import { apply, createAdapterHandler } from './index.js'

const token = 'v'.repeat(32)
const catalog = {
  providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto', 'zh'],
    preparation: { phase: 'ready' } }],
  selection: { providerId: 'sensevoice-local', language: 'auto' },
  maxAudioBytes: 2 * 1024 * 1024,
  maxDurationSeconds: 60,
}

function invoke(handler, path, body = {}, authorization = `Bearer ${token}`, signal) {
  return handler({ method: 'POST', url: new URL(`http://127.0.0.1${path}`),
    headers: { authorization }, body, signal })
}

test('voice catalog exposes only provider status and public recording limits', async () => {
  const speechController = { catalog: () => ({ ...catalog, secret: 'not for clients' }) }
  const handler = createVoiceAdapterHandler({ speechController, token })
  const result = await invoke(handler, '/v1/voice/catalog')
  assert.equal(result.status, 200)
  assert.deepEqual(result.value, catalog)
  assert.equal(JSON.stringify(result.value).includes('secret'), false)
})

test('session adapter keeps voice off by default and delegates to the official speech Remote only when opted in', async () => {
  let calls = 0
  const speechController = { catalog: () => (calls++, catalog), transcribe: async () => ({ text: '', audioSeconds: 0, inferenceSeconds: 0 }) }
  const defaults = createAdapterHandler({ token, speechController })
  assert.equal((await invoke(defaults, '/v1/voice/catalog')).status, 404)
  assert.equal(calls, 0)

  const candidate = createAdapterHandler({ token, speechController, voiceEnabled: true })
  const result = await invoke(candidate, '/v1/voice/catalog')
  assert.equal(result.status, 200)
  assert.equal(calls, 1)
})

test('base adapter starts without reading an uninjected speechController when voice is disabled', async () => {
  const previousToken = process.env.JOT_SESSION_ADAPTER_TOKEN
  process.env.JOT_SESSION_ADAPTER_TOKEN = token
  let speechControllerReads = 0
  let dispose
  const baseContext = {
    sessionController: {},
    fileUploads: {},
    agents: {},
    effect(register) { dispose = register() },
  }
  const context = new Proxy(baseContext, {
    get(target, key, receiver) {
      if (key === 'speechController') {
        speechControllerReads += 1
        throw new Error('cannot get property "speechController" without inject')
      }
      return Reflect.get(target, key, receiver)
    },
  })
  const port = 35000 + (process.pid % 20000)
  try {
    assert.doesNotThrow(() => apply(context, { port, voiceEnabled: false }))
    assert.equal(speechControllerReads, 0)
  } finally {
    if (dispose) {
      const server = dispose()
      await once(server, 'close')
    }
    if (previousToken === undefined) delete process.env.JOT_SESSION_ADAPTER_TOKEN
    else process.env.JOT_SESSION_ADAPTER_TOKEN = previousToken
  }
})

test('transcription calls the official speech Remote without submitting a Session message', async () => {
  const calls = []
  const speechController = {
    catalog: () => catalog,
    transcribe: async (request, signal) => (calls.push({ request, signal }),
      { text: '查找官方文档', audioSeconds: 2, inferenceSeconds: 0.4 }),
  }
  const handler = createVoiceAdapterHandler({ speechController, token })
  const controller = new AbortController()
  const result = await invoke(handler, '/v1/voice/transcribe', {
    audio_base64: 'UklGRg==', language: 'zh', provider_id: 'sensevoice-local',
  }, `Bearer ${token}`, controller.signal)
  assert.equal(result.status, 200)
  assert.deepEqual(result.value, { text: '查找官方文档', audio_seconds: 2, inference_seconds: 0.4 })
  assert.deepEqual(calls[0].request, { audioBase64: 'UklGRg==', language: 'zh', providerId: 'sensevoice-local' })
  assert.equal(calls[0].signal, controller.signal)
})

test('voice adapter rejects unauthenticated and malformed requests before calling speech service', async () => {
  let calls = 0
  const handler = createVoiceAdapterHandler({ token, speechController: {
    catalog: () => (calls++, catalog), transcribe: () => (calls++, Promise.resolve({ text: '' })),
  } })
  assert.equal((await invoke(handler, '/v1/voice/catalog', {}, '')).status, 401)
  assert.equal((await invoke(handler, '/v1/voice/transcribe', { audio_base64: 'not-base64!' })).status, 422)
  assert.equal(calls, 0)
})

test('voice cancellation is propagated and provider failures do not leak exception text', async () => {
  const signal = new AbortController().signal
  const handler = createVoiceAdapterHandler({ token, speechController: {
    catalog: () => catalog,
    transcribe: async (_request, receivedSignal) => {
      assert.equal(receivedSignal, signal)
      throw new Error('secret transcript or filesystem path')
    },
  } })
  const result = await invoke(handler, '/v1/voice/transcribe', { audio_base64: 'UklGRg==' }, `Bearer ${token}`, signal)
  assert.equal(result.status, 502)
  assert.deepEqual(result.value, { error: 'transcription_failed' })
  assert.equal(JSON.stringify(result.value).includes('secret'), false)
})
