# Standalone Chat/Work implementation sequence

This implements the standalone item of the approved
[portable plan](2026-10-18-portable-chat-work.md), through `src/` and `/api`.
It does not proxy to Gateway or substitute another extended Session planner.

1. **Prerequisite implemented:** persist conversation mode/version and immutable accepted run mode/version.
   Existing rows and legacy creation remain Work. Mode changes require a current
   version and no queued, running or approval-waiting run. Match original accepted
   input retries before current mode checks. Public Chat readiness stays false
   until its actual executor exists; fail rather than dispatch Chat through Work.
   Verify migration, disk reopen, transactional CAS, idempotent original input,
   all active states, CSRF/origin checks and unchanged existing API behavior.
   See [executed evidence and remaining scope](../../implementation/2026-10-19-standalone-mode-admission.md).
2. **Executor implemented:** add a trusted standalone Chat route to `src/provider.mjs` and the Agent,
   freezing its nonsecret policy and bounded ordered text seed at acceptance.
   Explicitly declare actual thinking-disabled support. Use separate configured
   read-only search/page-read tools; these are standalone tools, not the native
   SDK's Search/Fetch. Persist one search/fetch group allowance before effects,
   keep duplicate/unknown outcomes from repeating and preserve cancellation.
   Keep uploaded text readable under its original conversation authority; do
   not claim image interpretation. Prove an actual streamed local model request
   and resulting committed answer before readiness can become true. See
   [executor evidence and remaining integration](../../implementation/2026-10-19-standalone-chat-execution.md).
3. Connect the standalone React interface to its own mode contract: one mode
   label, readiness-aware new conversations, versioned changes, unchanged drafts,
   original-request retries, active-run exclusion and unavailable status. Test
   real browser/API/provider transitions and reload, not a static mock label.
4. Document configuration and deployment limits; run root/UI tests, local build,
   source/staged/history audits, then publish explicit reviewed files. Provider
   cache/latency and the complete extended React/API/SDK acceptance remain separate
   gates in the parent plan. No periodic model probes or invented usage metrics.

Each step requires its own observed failing case and final verification. A
partial prerequisite is not a completed Chat feature or full capability parity.
