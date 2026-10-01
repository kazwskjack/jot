import { timingSafeEqual } from 'node:crypto'

function authorized(actual, expected) {
  if (typeof actual !== 'string' || !actual.startsWith('Bearer ') || expected.length < 32) return false
  const candidate = Buffer.from(actual.slice(7))
  const wanted = Buffer.from(expected)
  return candidate.length === wanted.length && timingSafeEqual(candidate, wanted)
}

function safeCatalog(value) {
  if (!value || !Array.isArray(value.providers) || !value.selection
    || !Number.isSafeInteger(value.maxAudioBytes) || !Number.isFinite(value.maxDurationSeconds)) return null
  const providers = value.providers.map(provider => {
    if (!provider || typeof provider.id !== 'string' || typeof provider.name !== 'string'
      || !['host-local', 'cloud'].includes(provider.location) || !Array.isArray(provider.languages)
      || !provider.preparation || typeof provider.preparation.phase !== 'string') return null
    return {
      id: provider.id,
      name: provider.name,
      location: provider.location,
      languages: provider.languages.filter(language => typeof language === 'string'),
      preparation: { phase: provider.preparation.phase },
    }
  })
  if (providers.some(provider => provider === null)
    || typeof value.selection.providerId !== 'string' || typeof value.selection.language !== 'string') return null
  return {
    providers,
    selection: { providerId: value.selection.providerId, language: value.selection.language },
    maxAudioBytes: value.maxAudioBytes,
    maxDurationSeconds: value.maxDurationSeconds,
  }
}

export function createVoiceAdapterHandler({ speechController, token }) {
  return async ({ method, url, headers, body, signal = new AbortController().signal }) => {
    if (!authorized(headers.authorization, token)) return { status: 401, value: { error: 'unauthorized' } }
    if (method !== 'POST') return { status: 405, value: { error: 'method_not_allowed' } }
    if (url.pathname === '/v1/voice/catalog') {
      if (!speechController?.catalog) return { status: 503, value: { error: 'speech_unavailable' } }
      try {
        const value = safeCatalog(speechController.catalog())
        return value ? { status: 200, value } : { status: 503, value: { error: 'speech_unavailable' } }
      } catch {
        return { status: 503, value: { error: 'speech_unavailable' } }
      }
    }
    if (url.pathname === '/v1/voice/transcribe') {
      const audioBase64 = body?.audio_base64
      const providerId = body?.provider_id
      const language = body?.language
      if (typeof audioBase64 !== 'string' || audioBase64.length < 4 || audioBase64.length > 2_796_204
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64)
        || Buffer.from(audioBase64, 'base64').toString('base64') !== audioBase64
        || (providerId !== undefined && (typeof providerId !== 'string' || providerId.length > 128))
        || (language !== undefined && (typeof language !== 'string' || language.length > 64))) {
        return { status: 422, value: { error: 'transcription_input_invalid' } }
      }
      if (!speechController?.transcribe) return { status: 503, value: { error: 'speech_unavailable' } }
      try {
        const request = { audioBase64, ...(providerId ? { providerId } : {}), ...(language ? { language } : {}) }
        const transcript = await speechController.transcribe(request, signal)
        if (typeof transcript?.text !== 'string' || transcript.text.length > 100_000
          || !Number.isFinite(transcript.audioSeconds) || !Number.isFinite(transcript.inferenceSeconds)) {
          return { status: 502, value: { error: 'transcription_failed' } }
        }
        return { status: 200, value: { text: transcript.text, audio_seconds: transcript.audioSeconds,
          inference_seconds: transcript.inferenceSeconds } }
      } catch {
        return { status: signal.aborted ? 499 : 502, value: { error: signal.aborted ? 'transcription_cancelled' : 'transcription_failed' } }
      }
    }
    return { status: 404, value: { error: 'not_found' } }
  }
}
