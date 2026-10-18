# Native Chat preset and thinking policy

This increment connects the accepted Chat execution policy to the actual native
model request and provides a separate read-only preset. It preserves the full
Work declaration and original admission, ownership, lease and completion path.
It does not advertise complete Chat readiness or activate a production profile.

## Actual provider behavior

The pinned official DeepSeek adapter exposes `off` as a supported reasoning
effort. Its Messages serializer maps `off` to `thinking: {type: disabled}` and
omits `output_config.effort`. A low reasoning effort is not the same thing.
The Chat selector now requests `off` through the official model resolver and
Session-local selection service. It refuses an incompatible resolver instead of
using a provider default or falling back to Work. The resolved original route
and `off` value are persisted through the existing model-policy binding.

An optional Host `ordinaryExecutionPolicy` declaration requires original model
selection and original input admission. A new reader checks the bearer bridge's
original run, input, owner, conversation, native Session, live lease and both
policy digests. It verifies the exact mounted preset and approved Chat route,
context revision and preset revision. The policy is re-read after resolution
before selecting the native model. A changed policy or replaced/cancelled Agent
does not produce a speculative model call.

The new module is included in the adapter package manifest. A `jot-chat` Session
without this execution-policy path cannot use legacy Work selection. Existing
Work configuration without the opt-in retains its original model behavior.

## Separate official composition

`packages/dsh-host/chat-preset.mjs` derives only the official persona and Web tool
modules from the installed `0.2.1-rc.2` standard declaration. Its stable prompt
prioritizes direct solutions, the user's language and available evidence. It
does not inject time/model placeholders or promise generated downloads. The
official `web_search` and `web_fetch` schemas and implementations are retained;
their cooperative timeout is ten seconds, and complete fetch output is bounded
to 24,000 characters.

The original Work preset still mounts the complete official declaration,
including filesystem, planning, delegation, Goal and compaction groups. A shared
declaration reader checks the launcher identity and exact SDK version; it does
not replace Work with the smaller Chat list.

Actual Host verification exposed a globally inherited `working_directory` tool
that a plain Agent fixture did not have. The Chat policy now masks that inherited
Work tool through the official scoped restriction API and fixes native tool
presentation. A monotonic scoped execution guard denies every tool name except
`web_search` and `web_fetch`, including a tool added later or a direct PTC call.
The actual composition audit verifies exactly those two visible tools before
the original prompt may enter. No approval or permission setting is weakened.

## Activation boundary and remaining work

The profile generator does not mount this Chat preset automatically. The real
Host `/v1/conversation-modes/readiness` endpoint remains unimplemented/unavailable
until the remaining Chat contracts are connected. Tests explicitly supply
synthetic readiness; a mounted preset and an `off` request are not evidence
that bounded context, durable per-turn allowances or background compaction exist.

In particular, the one-search-group/one-fetch-group language in the prompt is
guidance, **not yet a durable execution limit**. Persisted allowance consumption,
no repeat of a failed URL after restart, the ordered context seed, post-answer
compaction/accounting, UI defaults and the separate standalone runtime remain
unchecked in the [implementation plan](../superpowers/plans/2026-10-18-portable-chat-work.md).
Do not enable general product readiness merely by adding the preset to a profile.

## Verification

- Adapter suite: 615 total, 590 passed, 25 conditionally skipped, zero failed.
- Actual installed SDK: eight passed, zero skipped, including explicit/default
  Work selection, steering/warm reuse, a changed conversation pointer, forced
  Host-exit recovery and Chat selecting `off` from its original accepted policy.
- Actual official Chat Host, Gateway and Worker: one mounted Chat preset,
  exactly two Web tools, one local scripted Messages request with
  `thinking: disabled`, and one committed original final reply. This verifies
  the wire payload rather than just a model label or hidden UI reasoning.
- Portable root: 50 passed and Windows Vite build passed.

The complete official Host compatibility run exited with 83 cases: 79 passed,
two conditional isolated-work cases skipped, and two old adversarial fixtures
failed while injecting their setup data. Both failures were the existing
`ordinary_steering_custody_immutable` SQL protection rejecting the fixture's
direct payload modification, before the intended native-corruption check.
The same fixture code was already present in the preceding uploaded branch.

Those two cases now first assert that SQL rejects the modification and preserves
the original payload. Only inside their isolated temporary database, they then
remove the exact trigger, inject simulated on-disk corruption, and restore the
original trigger SQL before starting the replacement Host/Worker. All existing
native denial, no-extra-inference and no-duplicate-answer assertions remain.
Both corrected cases passed in the focused real-Host rerun. Production triggers
were not changed. The first full-run counts and the corrected two-case run are
recorded separately; no fresh monolithic all-green Host run is claimed.

Public source review passed for 940 files. Staged source and full reachable Git
history introduced no identity or credential finding; only the same seven
previously reviewed generic example-path/neutral Office objects remain. The
scanner rules and manual-review distinction are unchanged.

All model providers in these tests are local scripted fixtures. No
external-provider quality, cache hit rate, universal latency or deployed product
activation is claimed.
