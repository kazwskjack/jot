# Original-run native model selection

The extended Gateway can now expose an authenticated DSH model catalog and, when explicitly enabled in the host, apply the model and reasoning effort accepted with an ordinary conversation input. This is a prerequisite for portable Chat/Work modes, not their completion.

## Execution path

1. The existing message-acceptance transaction stores the owned conversation's model and version in `ga_runs.model_policy_json`. Automatic title changes happen afterward. An idempotent retry keeps the original policy. Existing queued/active model-edit guards remain in force.
2. The original admission host reads the policy through the internal bearer-authenticated bridge. The request must match the original run, owner-bound Session and current execution lease. The hash covers the canonical accepted policy; no browser-provided policy is trusted.
3. Official `LlmRuntime.resolveCallConfig` resolves the exact route and effort. If the accepted policy omitted effort, the first resolved default is stored once in `model_resolution_json`. Exact receipt retries are accepted; conflicting routes, efforts or hashes are rejected.
4. The host installs official Session-local model listeners before system-prompt assembly and selects through `SessionController.agents.selectForNextRequest`. This must happen before the actual request is assembled; merely logging a selection in a later pre-step hook does not change an already assembled request.
5. Steering, warm execution and original-input recovery reread that frozen policy. Changed conversation settings or provider defaults cannot silently change the accepted run. Cancelled or unsupported resolution retains the unentered original input without starting inference.

Database triggers prevent policy replacement and resolution replacement/erasure. Pre-upgrade runs remain without a snapshot. They are refused by the opt-in selection path rather than backfilled from mutable conversation metadata. Finish or explicitly resolve legacy pending work before enabling this option.

This does not replace the existing budgeted role selector. It does not change DSH planning, permissions, native Goal controls, original-input completion or ownership. Model selection is not execution authorization.

## Catalog and activation

The host's bearer-authenticated `POST /v1/models` accepts only `{}`. It reads official provider/model metadata, returns only provider/model identifiers and supported effort identifiers, and has a two-second bound. Provider exceptions, credentials, endpoint URLs and extra metadata never appear in the projection. The authenticated Gateway capabilities route uses the same configured loopback `SessionControllerClient`; an absent, unready, failed or invalid host returns an empty catalog.

Catalog membership is advisory. An operator-permitted unlisted model still requires exact native resolution; the catalog is not a new whitelist. Effort metadata alone does not establish reasoning-delta streaming, so the catalog conservatively reports `reasoning_output: 'none'`. This does not disable Work reasoning.

Activation requires all of the following:

- A verified original DSH host with the existing `ordinaryInputAdmission` store/profile and private internal bridge credentials.
- Host adapter option `ordinaryModelSelection: true`. Missing admission configuration fails startup. Ordinary prompts without original admission proof are refused when enabled.
- Gateway Worker `GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED=true`; use `GENERAL_AGENT_ORDINARY_STEERING_ENABLED=true` for original steering. Retain the existing audited recovery composition and worker Session resolver. The latter must use `SessionBindingRepository`, as in the supplied Worker startup.
- The API's existing adapter URL and private token-file configuration for catalog reads. Keep internal routes private and owner authentication at the Gateway.

The generated host profile remains default-off. Do not turn this on by editing an unverified composition or copying a separate application adapter into this package. The root portable runtime remains a distinct contract.

## Verification evidence

All inference in these checks used local scripted adapters, not a remote provider or private conversation.

| Check | Result and boundary |
| --- | --- |
| Gateway full suite | 1,741 total, 1,734 passed, seven skipped, zero failed; Gateway build passed |
| Adapter full suite | 603 total, 578 passed, 25 skipped, zero failed |
| Portable root | 50 passed; Vite build passed |
| Installed SDK `0.2.1-rc.2` ordinary policy | Four cases passed: explicit model/effort, resolved-default pinning, unsupported-model retention, and actual Worker/Runner final-answer publication |
| Installed SDK hard-exit recovery | One case passed: flushed unentered input, force-terminated isolated Host, replacement lease, fresh Host, same native input, exactly one actual scripted request with the original model/effort |
| Installed SDK resolver cancellation | One case passed without starting inference or installing a selection |

The ordinary cases also check authenticated catalog transport, duplicate requests, steering and the next accepted warm run. They exposed two test/integration ordering requirements: official model listeners must exist before assembly; the Worker must be given the same original Session resolver as its real startup. No identity guard was relaxed to pass these checks.

The cold fixture mounts the official preset projector but no preset plugins; its composition witness is synthetic. It verifies the real SDK loop, persistence and recovery mechanisms, not a deployed preset audit. Installed runtime artifacts remain outside the public tree. Tests skip explicitly without an operator-supplied `JOT_DSH_RUNTIME_MODULES` directory containing the pinned SDK; that skip is not acceptance.

Run from the repository root after installing Gateway dependencies:

```powershell
node --experimental-strip-types --test packages/session-adapter/verification/ordinary-model-policy-runtime.mjs packages/session-adapter/verification/ordinary-model-policy-cold-runtime.mjs
node --test packages/session-adapter/verification/model-resolution-cancel-runtime.mjs
```

## Remaining work

Mode-specific Session identity, the fast Chat preset, bounded context, Search/Fetch round limits, post-answer compaction and mode UI remain open in the [implementation plan](../superpowers/plans/2026-10-18-portable-chat-work.md). No live-provider latency, prefix-cache hit rate, physical-device behavior or production activation is claimed by this increment.
