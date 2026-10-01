export const VOICE_MAX_BYTES = 2 * 1024 * 1024;
export const VOICE_MAX_DURATION_SECONDS = 60;

export function validateVoiceWave(audio: Buffer, maxDurationSeconds = VOICE_MAX_DURATION_SECONDS): number {
  if (audio.length < 46 || audio.length > VOICE_MAX_BYTES
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.toString('ascii', 12, 16) !== 'fmt ' || audio.readUInt32LE(16) !== 16
    || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1
    || audio.readUInt32LE(24) !== 16_000 || audio.readUInt32LE(28) !== 32_000
    || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(4) !== audio.length - 8
    || audio.readUInt32LE(40) !== audio.length - 44 || (audio.length - 44) % 2 !== 0) {
    throw new Error('voice_audio_invalid');
  }
  const seconds = (audio.length - 44) / 32_000;
  if (seconds <= 0) throw new Error('voice_audio_empty');
  if (seconds > Math.min(VOICE_MAX_DURATION_SECONDS, maxDurationSeconds)) throw new Error('voice_audio_too_long');
  return seconds;
}
