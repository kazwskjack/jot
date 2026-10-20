# Original native workspace admission across Host recreation

Status: original-chain integration in progress; no Git write endpoint or
production activation. DSH remains the planner. This is a negative admission
fence, not a second scheduler, native maintenance handle or execution grant.

## Durable original namespace

`GitIndexExecutions.reserveWorkspace` now seals its server-derived native family
in the original reservation transaction. The immutable membership journal binds
the original reservation, owner, project, configured repository identity and
member scopes. Source collection failure rolls back the reservation as well.
Current approval and ownership remain separate from producer drain: revocation
or transfer does not discard this original namespace evidence.

The service-only `/internal/v1/workbench/native-workspace-admission` uses the
existing internal bearer. It accepts only a Session reference, never owner,
project, root, member or permission selectors. Responses are private/no-store,
with fixed errors and no execution authorization. Held members remain denied
after database reopening and approval/owner changes. Known unrelated members
retain their original scope. Unbound or ambiguous identities are not assumed
unrelated while a hold exists. An older unresolved reservation without sealed
membership fails closed; observation never invents a migration seal.

## Check before opening original storage

Real installed-runtime acceptance exposed an earlier write boundary: original
resume can append a seed-ending marker before the existing setup hooks run.
The first test correctly failed when a denied resume changed the original log.
The requirement was retained rather than normalizing that extra event away.

The optional `dsh-storage-admission-patch.js` therefore adds an awaited original
factory observation before storage in fresh/configured creation, public creation
and resume. It is layered on the existing reviewed Jot setup compatibility
delta, optionally together with the existing pending-input wake delta. The
original persistence, Session preparation, driver, cancellation and planner are
retained. Caller-selected identity is captured and checked across the new await.

This is explicitly **Jot compatibility**, not an upstream DSH API. It advertises
the separate `jotStorageAdmissionHookProtocol: 1` marker while retaining setup
protocol 2. The preparation command supports `--native-admission` together with
`--pending-input-wake`. It verifies the complete pinned upstream package and
license before writing a new disposable output; it never patches a live Host.
Unknown, changed or partially patched artifacts are refused.

With `nativeWorkspaceAdmission: true`, the original adapter mounts the guard
before its server opens. It requires the actual pre-storage marker and existing
internal authentication. It also requires an empty original registry and no
eager configured agents, so pre-existing startup cannot be mistaken for guarded
admission. Existing producers must drain before an operator enables it. The
default is unchanged; no configuration flag is enabled by this source increment.

Each pre-storage, pre-setup and post-setup observation is fresh and cancellable.
Offline or malformed responses do not reuse a prior success. Disposal cancels
pending observations and waits for them to finish before removing the hooks.

## Verification and remaining chain

The initial missing Gateway cases failed, then original admission/reservation
checks passed 27 cases with one installed-runtime conditional skip. The first
real runtime continuation failed on the seed-ending marker described above.
After the pre-storage change, ten original Gateway cases passed with the actual
installed SDK and authenticated loopback HTTP. That run recreated the native
Host and persistence service, rejected resume without changing original history,
and allowed it only after the original explicit unstarted release. This is Host
instance recreation, not a claimed operating-system process-kill acceptance.

Pure compatibility checks cover both standalone and combined pending-input
transforms, idempotence and modified-artifact refusal. Native admission cases
cover offline/held/malformed responses, cancellation/drain and mounting before
eager startup or an existing resident. Full frozen-source gates and the final
combined-runtime rerun are recorded separately; these focused results are not
full-product acceptance.

The frozen-source Gateway regression completed with 2,089 tests: 2,081 passed,
eight conditional skips, zero failures and zero cancellations. The final adapter
regression completed with 829 tests: 800 passed, 29 conditional skips and zero
failures or cancellations. Skipped cases are not counted as acceptance.

The separate final installed-runtime Gateway run passed all ten cases, including
the combined pending-input and pre-storage compatibility path. An additional
installed-SDK package-integrity, compatibility, driver and writer-lock gate
passed all 25 cases without skips. These real installed-runtime runs are distinct
from default tests whose optional SDK cases may be skipped. Gateway typecheck
and local build passed; the standalone root passed 67 tests and its Vite build.
This evidence covers the source increment described here, not production
activation or the remaining physical-effect integration below.

This closes neither physical Git coordination nor producer settlement. The
actual owning Gateway must retain its synchronous original authority and exact
Worker lease at effects. Hold real native maintenance through dispatch; verify
the configured Git root, logical version store and native working directory
association, checkpoint restore, cancellation/drain, unknown outcomes and
settled release. No API observation, cached inventory or serializable identifier
can substitute for those original obligations.
