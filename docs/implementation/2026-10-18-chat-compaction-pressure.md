# Chat maintenance effective-pressure prerequisite

The Session adapter now exports `inspectChatCompactionPressure`. This is an
unwired, read-only prerequisite, not completed background compaction. No HTTP
route, readiness switch, inference, write, idle certification or execution
grant was added. General Chat readiness remains unavailable.

The caller supplies the actual official token meter and LLM metadata service,
the original Session, exact resolved model and resolved host pressure policy.
The observer uses `tokenMeter.measure(session)`, not stored transcript length.
It takes detached measurement/envelope snapshots before metadata resolution and
compares them afterward, including the Session sequence. Route mismatch,
unavailable/invalid capacity or changing facts quietly skips. Cancellation
propagates even if a metadata provider does not settle its pending promise.
Only detached numeric advice leaves this module; no prompt, history, image or
provider error text is returned.

The threshold follows the installed official `dsh-compaction-basic`
0.2.1-rc.2 calculation in `resolveCompactSpec`:

```
floor(min(contextWindow * thresholdRatio,
          contextWindow - reservedCompletionTokens - headroomTokens))
```

The effective request's `maxTokens` takes precedence over the adapter default;
when neither declares a cap the reservation is zero. The caller must resolve
exact-target overrides before inspection. This module does not silently invent
capacity, policy defaults or an alternate model. Equal pressure returns
`needed`, always with `execution_authorized: false`. Native completion, genuine
maintenance admission, a useful safe summary span and independently accounted
inference are still required. The official `compactNow` can force compaction
below pressure; this observer never invokes it.

## Validation

- Thirteen new focused tests pass: below/equal threshold, reservation precedence,
  raw-history exclusion, invalid capacity/numbers, exact route, changes during
  metadata resolution, private errors and immediate cancellation.
- Full Session adapter: 653 total, 628 passed, 25 conditional skips, zero failed.
- Root: 50 passed; local Windows build passed.
- Public-source scanner: six scanner tests passed; 964 files scanned.
- Initial restricted-context runs failed on existing hard-link/loopback tests
  (adapter eight failures, root proxy failures). The same complete suites passed
  in the Windows user context. No permissions, production settings or test
  assertions were weakened.

These tests exercise the observer against supplied meter/metadata fixtures.
They do not establish actual SDK/Host background execution, native idle,
provider usage, cancellation of inference or checkpoint consumption. Gateway
code was unchanged and its full suite was not rerun for this increment.

Continue with [the original Chat/Work plan](../superpowers/plans/2026-10-18-portable-chat-work.md):
owned native completion and idle checks, an independent background attempt,
official maintenance and usage capture, then a source-backed checkpoint consumed
by the next bounded request. Do not enable readiness before those gates pass.
