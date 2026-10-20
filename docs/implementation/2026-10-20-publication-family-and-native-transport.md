# Original publication family and native transport

## Problem and retained authority

An original project can contain multiple historical isolated work Sessions.
The previous publication check associated the producer with its original work
snapshot, but treated every other non-absent Session as belonging to the target
repository. This rejected legitimate older work, including failed work, and
could not be solved by dropping members from the reserved family.

The implementation keeps DSH planning, native Session/Goal custody, original
task admission, owner approval and Worker fencing. It does not copy upstream
PilotDeck source, install another scheduler or convert failed work into eligible
publication output. See the [source reuse comparison](2026-10-20-pilotdeck-reuse-strengthening-review.md)
for the pinned upstream reference and license boundary.

## Code, function and design reason

| Code | Behavior | Why this boundary exists |
| --- | --- | --- |
| `always-on/work-snapshot-history.ts` | Reads the original admission, grant, immutable workspace intent and snapshot record after a cycle closes. | Historical facts must remain readable without renewing live work authority. |
| `persistent-tasks/publication-native-placements.ts` | Derives every sealed native member's original placement from run/runtime/checkpoint/Goal/Session bindings and original delegation/activation lineage. | Conversation membership alone does not establish a physical cwd. Chat mode does not inherit a work snapshot by sharing a conversation. |
| `git/index-effects.ts` | Retains the complete original family and each actual native observation; pins physical storage, snapshot and target identities. | A valid historical record cannot authorize a substituted physical directory. Host-proven absent history remains recorded without recreating its old directory. |
| `persistent-tasks/work-publication-executions.ts` | Rechecks original evidence while retaining native custody; forwards held checkpoint verification and retains the original journal and lease. | A historical lookup is not permission to perform file effects. Revocation, physical replacement and original native checkpoint mismatch must still stop execution. |
| `session-adapter/native-git-transport.js` | Adds a distinct `work_publication` selector and exact optional owner disposition command to the existing authenticated local pipe/socket protocol. | Publication cannot masquerade as index staging. Existing three-ID index requests remain supported; callers cannot supply roots, bytes, modules or permissions. |
| `session-adapter/native-git-host.js` | Dispatches to the original publication service on the same physical database and configured repository; forwards held checkpoint verification. | The Host retains original native custody and opens no replacement Agent. Mounting or requesting publication cannot install or upgrade schema. |
| `gateway/src/server.ts` | Supplies the original publication service to the existing internal source route. | A fixture-only source route is insufficient: the actual Gateway must expose the same original admitted family to the authenticated Host. This is not public Apply. |

Paths without a package prefix above are relative to `packages/gateway/src/`.
The transport and Host paths are relative to `packages/`.

## Cache and performance boundary

A four-way regression exposed the existing completed-checkpoint test exceeding
its original ten-second verification deadline. An isolated CPU profile located
roughly one second in repeated full historical-placement derivation. The
deadline was retained.

Only the immutable placement derivation is cached, for one retained operation.
The cache stamp includes SQLite `data_version`, `schema_version` and
`total_changes()`. Own writes, writes rolled back through a savepoint, schema
changes and actual commits from a second connection invalidate it. A no-op
external UPDATE is not a valid invalidation test because SQLite need not change
the database version for it; the test performs an actual unrelated title change.

Original database identity, current owner/review/reservation checks, actual
native admission and physical directory identity checks are not cached away.
Unchanged historical derivation cannot extend a lease or revive an old grant.

## Executable evidence and limits

- `test/always-on/work-snapshot-history.test.mjs`: distinct original admissions,
  closed and failed history, read-only reopening and immutable proof corruption.
- `test/git/work-publication-family-placements.test.mjs`: full family association,
  original delegation/activation records, missing admission refusal, absent old
  directories and physical replacement. Delegation fixtures use original APIs;
  their closure proof does not establish a real SDK delegated-child lifecycle.
- `test/git/work-publication-native-custody.test.mjs`: actual installed SDK
  resident and cold historical Sessions, older failed snapshot replacement,
  held original checkpoint verification and cache invalidation. No model call
  is permitted by the synthetic provider.
- `session-adapter/test/native-git-transport.test.mjs` and
  `native-git-host-config.test.mjs`: ten tests passed after the transport/Host
  change, covering exact selectors, authentication, injected-root refusal,
  cancellation and shutdown. This is local transport evidence, not deployment.
- `test/git/native-publication-local-process.test.mjs`: a second process opens
  the original SDK persistence, publishes exact reviewed bytes, observes review
  revocation, exits after a real file effect and recovers through an explicit
  owner command without rewriting the file or adding duplicate journal entries.
  The actual-Gateway composition passed after replacing its fixture-only HTTP
  server. A three-case process/server run also retained legacy index operation
  and rejected publication on an index-only deployment without schema changes.
- `test/git/publication-source-server.test.mjs`: actual Gateway initially
  returned `GIT_WORKSPACE_SOURCE_UNCONFIRMED` for the accepted publication.
  Supplying the original publication service fixes it. The test passes and
  verifies service authentication, exact operation kind, foreign-owner refusal,
  absence of private-root projection, no journal/Worker effect and no schema
  or data changes on that serving connection.

The first root-suite run exposed an unrelated-service regression: eagerly
constructing the physical-publication service made a no-repository, in-memory
Gateway require a physical WAL database. The composition now constructs that
service only when operator repository bindings exist. A focused two-case server
test passes both no-repository in-memory startup with publication unavailable
and the original admitted publication on a configured physical database. The
physical database witness itself was not relaxed.

The synthetic crash test confirms the process exited before expiring only its
exact original lease. This is fault injection, not permission for a deployed
client to expire a live Worker. Recovery retains fresh native custody and the
original owner, command digest and Worker generation checks.

The restricted Windows shell rejects fixture runtime junction creation with
`EPERM` before native business execution. SDK regressions therefore run in the
authorized Windows user context. That environment result is recorded separately
from an application assertion failure; no alternative runtime replaces the SDK.

The combined 29-case historical/native/family/process regression passed with
zero failures, cancellations or skips in the authorized user context. The
original ten-second checkpoint verification bound was retained and passed.
The subsequent three-case actual-Gateway process/server run passed against the
updated server composition. Gateway typecheck and build also passed. These
focused results do not substitute for the later full current-tree gate.

### Optional memory verification environment

The ordinary adapter suite passed 820 tests with 29 conditional SDK cases
skipped. A separate run enabled the current `0.2.1-rc.2` SDK across the whole
adapter suite: 840 passed and nine optional memory tests failed because that
runtime lacked the separately pinned plugin and did not match its loader's SDK
requirements. Those failures were retained, not relabeled as skips or success.

The memory composition was then verified in a separate private runtime using
the loader's exact `dsh-llm 0.2.0-rc.2`, `cordis 4.0.4` and hash-verified
`dsh-memory 0.5.0` files. All 12 original memory runtime/loader tests passed,
including cancellation, source revocation, routing, output ceilings and package
integrity. This verifies the existing isolated compatibility composition; it
does not establish memory compatibility with the newer SDK, change the main
runtime or enable production extraction.

## Remaining completion gates

The final current-tree Gateway suite completed with 2,212 tests: 2,205 passed,
seven conditional skips, zero failures and zero cancellations. The installed
current SDK was enabled. All 1,100 frozen product files remained unchanged
through the gate, including the original checkpoint deadline and actual
Gateway/Host process cases. Root tests passed 67/67; UI tests passed 253/253.
Gateway typecheck/build, frontend build and six public-verifier tests passed.
The adapter and isolated-memory compatibility results above retain their own
scope; the full Gateway result does not certify newer-SDK memory compatibility.

One private gate wrapper initially included 211 concurrently generated
`.source-test-tmp` fixture files in its source manifest and consequently
reported a source-scope mismatch after the otherwise successful base-adapter
tests. Revalidation excluded only explicit runtime/build directory components
and confirmed all 1,100 product files matched every captured gate start. No
product-source change was ignored, and the original wrapper result was retained.

This increment does not certify all 26 PilotDeck capabilities. Owner-facing
Apply/status/recovery API, BFF and mobile controls still need original approval,
idempotency and lost-response acceptance. Broader binary/delete/rename/mode,
platform/provider and deployment cases remain explicit requirements. The full
current-tree regression, local builds and disclosure scans must pass before
publication; the prior `f0f5eb7` full-suite result cannot prove this later tree.
