# Original index control admission and recovery inventory

This remains a private continuation candidate for the original index Apply and
recovery plan. The latest local continuation also connects original settlement;
see [settlement evidence and remaining gates](2026-10-21-index-native-recovery-settlement.md).
It does not enable public index writes or certify full cross-process recovery.
Keep DSH as the only planner and preserve the
original owner, review, workspace, physical database and Worker authority.

## Implemented

- Separate synchronous original owner control admission from asynchronous
  cleanup using the existing `wb_git_index_controls` table. The caller must own
  the original transaction and UI-admitted execution. No filesystem operation,
  native call, producer, lease or workspace release occurs at admission.
- Bind exact original request, state digest and unknown acknowledgement. Exact
  replay survives response loss, restart and subsequent producer finish facts;
  a replacement request cannot take over the original control. Read-only
  acceptance is distinct from its eventual cleanup receipt.
- A committed control fences original dispatch and asynchronous preparation.
  A real applied index with lost native acknowledgement can be confirmed without
  replaying the effect or treating its original reservation as settled.
- Recovery inventory needs an already admitted original control, unchanged
  current ownership, binding, held original reservation and exact sealed member
  identities. It reads after approval cancellation without restoring approval,
  resealing membership, selecting a new root, or acquiring native custody.
- Extend the existing service-authenticated no-store inventory and native adapter
  with strict `git_index` plus `control_request_id` scope. Preserve existing
  three-ID and typed publication requests. Reject caller roots, members, grants,
  foreign controls, malformed responses and switched control IDs across awaits.
- Actual installed DSH native custody has been exercised after revocation:
  original factory admission, original members, awaited callback and final
  source check/drain. The context expires afterwards. This is inventory/custody
  evidence only, with no index write, producer, settlement or model call.
- Fresh `resolveReserved` requires the exact previously admitted original
  confirmation. It retains the same physical family/root witnesses and exact
  Worker lease throughout original evidence observation, cleanup, control
  receipt creation, final native source checks and handle drain. Its callback
  reuses a private custody token; requests cannot supply roots or a host.
- Both legacy disposition and this native continuation share the original
  physical cleanup routine. The continuation never calls index preparation or
  application. It can observe an actual applied index after an outcome write
  failure and persist the original applied result without rewriting index bytes,
  replacing the index inode or changing the original producer finish.
- Original control state CAS applies at admission. A genuine producer finish
  appended afterwards does not force the owner to replace the command. Every
  awaited recovery boundary still rechecks original control, current owner,
  held family, root/placement identity, native startup admission and Worker lease.
- Native acknowledgement loss after physical cleanup retains its immutable
  original control receipt and the original workspace reservation. Repeating
  that exact command reacquires fresh custody/drain without replaying effects.
  The later settlement continuation now releases only after successful native
  drain and exact database receipt validation; failed acknowledgements still
  retain the original hold. Its new evidence supersedes this earlier cleanup-only stage.
- A Host response cannot manufacture completion. The actual original callback
  must finish while this invocation owns its Worker lease; after native drain,
  the returned value must exactly match the validated original database control
  receipt. Return that database receipt, not the peer's object. Missing callback
  or changed response leaves the original reservation held.

## Evidence

Admission tests first failed on the missing admission methods; the original
related regression passed 81 tests with the SDK enabled and no skips. Four
recovery-inventory cases first failed on the missing method after correcting
fixture expectations, then passed. The two HTTP/adapter cases first failed on
the missing request shape, then passed through actual loopback HTTP in the
authorized local user context. Restricted-context HTTP failure is retained in
the private log and is not counted as an application fix. Adapter regression
now passes 17 tests, including control replacement before/after callback.

The expanded installed-SDK Gateway regression completed with 39 passes, zero
failures/cancellations/skips. This includes the actual revoked-review native hold
and final drain and the existing stage/unstage, lost acknowledgement, lease and
admission revocation tests. Candidate typecheck and local Gateway build passed.
Full integration, root/UI tests and disclosure gates have not run for this candidate.
No private paths, fixture databases or test logs belong in public source.

Fresh cleanup tests first reproduced the missing reserved-recovery method in
three installed-SDK scenarios. After the shared original cleanup and private
custody path were connected, 54 related tests passed with no failures/skips,
including original lock-acquisition process exits, legacy dispositions, approval
and Worker revocation, admission rollback and all three native recovery cases.
The local Gateway build passed. Two additional replacement/cancellation cases
passed after correcting only the test's original error-code expectation and
normalizing SQLite row prototypes for exact all-field comparison. The raw failed
expectations remain in private logs. Two new receipt-integrity tests reproduced
accepting a Host result without a callback or with changed fields; the completion
path now requires original callback completion and the exact database receipt.
All seven native cleanup cases completed against that final change: seven
passes, zero failures/cancellations/skips. The final local Gateway build also
passed. These remain private candidate results, not public activation, completed
settlement or cross-process production acceptance.

## Required continuation

1. Finish the additional replacement/cancellation cases and separate-process
   recovery evidence for the original cleanup continuation. Do not count a
   same-process hold as full cross-process or production recovery acceptance.
2. Carry the validated cleanup completion into settlement only after native
   postchecks/drain. Current timer expiry alone is not native quiescence.
3. Retain the now-shared original execution/control/result validation in further
   integrations. Preserve old applied receipts; never manufacture the interrupted
   producer's finish from a replacement lease. Unknown cleanup is not rollback.
4. Prove lost callback, process exit, replaced Worker/root, cancellation and
   another device before connecting original atomic HTTP, IPC and mobile UI.
5. Run the original full release gates before integrating/publishing this
   candidate. Continue the wider all26 plan and separate Git workflows.

### Settlement boundaries now implemented locally

- Reuse the extracted original read-only execution, preparation, dispatch, result,
  disposition and control-receipt validation for reuse by both the execution
  service and coordinator. Do not construct a service that migrates storage
  while performing a read, and do not add a weaker duplicate JSON projection.
- Reuse the original producer-record validation. A replacement recovery lease
  must never append or reinterpret the interrupted producer's finish.
- Keep the existing applied settlement record readable. Explicit-control
  settlement needs a separately discriminated original receipt retaining exact
  control/result hashes, uncertainty and cleanup classification, including a
  genuinely absent original finish. Store it only in the original settlement
  table, with the original reservation release in the same transaction.
- Only the owning service after successful awaited native drain may settle.
  Recheck current owner, original sealed family/placements, physical DB/root and
  exact recovery Worker; release that lease and settle atomically. An expired
  lease, stored applied outcome or completed physical control is insufficient.
- Replay after a proven settlement reads the original command and settlement;
  it must not reserve the project again or execute cleanup/index effects.
  A lost callback or failed settlement write keeps the original hold, so a new
  explicit invocation must reestablish native custody before attempting release.
