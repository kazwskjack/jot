# Model policy boundary follow-up

## Fixed behavior

An accepted message could still be queued when the conversation model was changed. The model mutation guard covered starting/running/waiting/cancelling states but omitted queued execution. The new API regression first reproduced HTTP 200 for that queued change. All pending states now return the existing `ACTIVE_RUN_MODEL_CHANGE` conflict; the model and conversation version remain unchanged on rejection.

Conversation metadata validation and update now use the existing immediate transaction helper, keeping the version check, pending-run guard and write in one synchronous database transaction. The transaction performs no provider or filesystem I/O. Owned title changes still work, foreign-owner changes remain denied, and completed runs permit later model changes. An already confirmed idempotent model receipt still replays after another message is queued without applying settings twice. These changes do not implement native inference model switching.

The trusted budgeted host model selector checked cancellation around model resolution but failed to pass the signal into the official `resolveCallConfig` API. A provider capability lookup could therefore wait after the owner cancelled. It now forwards the original signal; exact route verification, authority rechecks and Session-local selection remain unchanged. The default model is not saved or modified. This relies on the provider resolver honoring its official cancellation contract; it does not introduce a new timeout or claim that every external provider behaves correctly.

## Verification

| Check | Result | Scope |
| --- | --- | --- |
| Gateway focused conversation and metadata suites | 8 passed | Every pending state, unchanged rejection, owner/version checks, terminal updates and confirmed receipt replay |
| Gateway full suite | 1,723 passed, 7 skipped, 0 failed; 1,730 total | Local Gateway fixtures; executed before the final additional receipt-replay assertion, which passed in the focused rerun |
| Gateway build | Passed | Neutral templates, TypeScript and copied assets |
| Adapter test directory | 557 passed, 25 skipped, 0 failed; 582 total | Local adapter contracts, not live provider acceptance |
| Adapter voice protocol | 6 passed | Existing separately located protocol suite |
| Installed official SDK resolver probe | 1 passed, no skips | Actual `0.2.1-rc.2` LlmRuntime, local scripted capability resolver, no inference or native Session |
| Root runtime and frontend | 50 tests passed; build passed | Separate standalone contracts |

An initial SDK probe intentionally rejected an older installed runtime before any resolution; the successful probe used the required version. The installed runtime is configured locally, not bundled with this repository. To run the probe, point `JOT_DSH_RUNTIME_MODULES` at a configured installation's `node_modules/@deepseek-ai` directory and run:

```sh
node --test packages/session-adapter/verification/model-resolution-cancel-runtime.mjs
```

Without that environment variable the probe is skipped, not passed. The full Gateway suite and focused suites overlap; their counts are not a single capability total. Skips and local scripted evidence do not establish live-model, physical-device or production readiness.

## Remaining integration

The public Gateway currently publishes an empty model catalog. Persisted ordinary conversation model metadata is not proof of native request selection. The [Chat/Work design](../superpowers/specs/2026-10-18-portable-chat-work-design.md) and [implementation plan](../superpowers/plans/2026-10-18-portable-chat-work.md) define exact model policy consumption, mode-specific Session identity, bounded context, official Search/Fetch, post-answer compaction and UI acceptance. Their unchecked items remain open. The newer original input/steering/replay adapter must be preserved throughout that work.
