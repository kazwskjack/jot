# Voice input

The extended workbench composer supports on-demand microphone recording in both
ordinary and role conversations. The existing Gateway voice capability must be
enabled and ready; the control explains unavailable capability or browser/device
permission failures. Recording never starts when a conversation merely opens.

Choose **Start recording**, then stop to transcribe. The browser produces the
original backend's16kHz mono PCM16 WAV format and obeys its duration/byte limits.
The microphone and audio context are released before upload. The existing
same-origin voice endpoint creates and polls the original owned ASR job; no
browser SpeechRecognition service or separate ASR provider is introduced.

Transcription is appended to the current editable draft. Review it and use the
ordinary Send button. Recording/transcription does not send a message or start
another Agent run. Existing typed text is retained. Cancel discards the pending
result and cancels a known original ASR job. Closing the composer, changing the
conversation/role or changing the authenticated draft scope invalidates late
results and releases recording resources.

The existing transport has a bounded upload/poll window and preserves safe
backend failure codes. If upload was accepted but its job ID never reached the
browser, cancellation can prevent draft application but cannot address that
unknown server job by ID. Its original server lifecycle remains authoritative.
This is not a promise of refund, instant remote cancellation or provider delivery.

Local tests exercise actual WAV validation, recorder cleanup, permission/cancel
races, owner/context changes, transport failures and the React composer through
controlled browser audio/API fixtures. Physical microphones, actual ASR quality
and production readiness require their own checks. TTS is a separate capability.

Relevant source: `web/jot/VoiceInput.tsx`, `voice-recorder.mjs`,
`voice-draft-controller.mjs`, `RoleConversation.tsx` and the existing voice client
in `web/jot/client.ts`. Backend configuration remains in the existing Gateway
voice adapter; this UI does not alter its permissions, model selection or DSH
planning.
