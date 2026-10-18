# Voice feedback and bounded microphone startup

The extended workbench composer now shows a microphone-driven waveform and captured recording duration. The same component serves ordinary and role conversations. Recording still produces the existing mono 16 kHz PCM16 WAV upload; transcription only appends to the editable draft and never sends a message automatically.

Microphone startup has a fixed 20-second deadline covering both permission acquisition and AudioContext resume. Timeout and cancellation close owned audio resources, including a stream granted after the deadline. A later attempt can start normally. The deadline ends when capture starts and does not shorten the configured recording duration.

The waveform uses RMS energy from captured samples, with bounded bar heights and reduced-motion support. It is feedback about microphone capture, not evidence that a speech provider has recognized words. Duration measures captured audio rather than elapsed network time. Existing capability readiness, request cancellation, owner checks, conversation replacement and stale-result protection remain in force.

## Verification

- Recorder regressions: nine passed, including late microphone permission, a stalled AudioContext, resource release, bounded audio bytes, amplitude and duration.
- Voice controller/client/browser suite before the final additional AudioContext regression: 25 passed. The real local Edge test used a fake microphone with nonzero samples and explicitly synthetic ASR responses. It verified visible waveform/timer, valid WAV uploads, editable draft retention, explicit send, permission errors, cancellation and stale owner/conversation/role results.
- Final focused recorder/controller/composer policy run: 23 passed.
- Portable runtime: 50 passed; local Vite production build passed.
- The initial restricted-account run could not connect to loopback services or launch Edge. Those checks passed in the authorized normal user context; no runtime policy was weakened.

These checks do not establish physical iPhone microphone behavior, speech recognition accuracy or live provider readiness. This increment changes web audio capture and feedback only. It does not publish a separate Chat/Work mode, alter the Session adapter or change gateway protocols. The standalone root server still has a separate contract from the extended workbench.

## Remaining release work

Porting fast Chat/Work behavior requires explicit mode contracts through the extended gateway and native Session host, including model/tool policy, bounded context handoff and cancellation. Copying an older application-specific Session adapter over the current public adapter would discard recovery and admission fixes. That integration remains open, alongside the full capability ledger in the [implementation plan](../superpowers/plans/2026-10-17-pilotdeck-remaining-full-chain.md).
