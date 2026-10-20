# Original owner publication review API

This increment connects the existing publication-intent service to the actual
Gateway router. It preserves the original DSH Session/Goal, completed-work
proof, configured repository, project ownership and immutable review. It does
not introduce another planner, approval store, queue or filesystem executor.

## Public review boundary

- `POST /v1/projects/{projectId}/work-publications` prepares an original review
  from `request_id`, `source_run_id`, `source_sha256` and selected relative paths.
- `GET /v1/projects/{projectId}/work-publications/{intentId}` reads its current
  state. It never dispatches work or recovers an unknown file effect.
- `POST /v1/projects/{projectId}/work-publications/{intentId}/control` approves
  or cancels that exact review version and digest. Approval still creates no
  execution admission, file effects, Worker lease or Git index modification.

The public projection keeps the original source/task/run IDs, immutable file
versions and receipt IDs, complete inspected base/result inventories, original
diff and selected before/after text. Target metadata includes only snapshot,
repository, HEAD, index and target digests. Internal ancestor/stat witnesses,
root resolution, database identity and native session references stay internal.
The display projection is detached and frozen; it retains the original
`review_sha256`, rather than generating a new approval identity from the display.
It must never be accepted as the original service's `executionSource`.

Source text remains owner-scoped user content. The JSON boundary does not make
that content instructions, public repository material or permission to execute.
The eventual UI must render it as escaped text and keep actual output provenance.

## Existing authentication and receipt protocol

The routes use the original actor, project ownership, Origin/CSRF and request
idempotency checks. Prepared source/target IO happens before the synchronous
commit closure; no SQL transaction spans awaited filesystem work. The original
business transition and validated public HTTP receipt commit in the same
`atomicCommand` transaction, with `work-publication-review-atomic-v1` as the
reserved receipt protocol.

Failure while storing an acknowledgement rolls back the business mutation.
Retry after database reopen resumes only that original protocol and request.
An old pending record without protocol proof refuses; a different request body
under the same HTTP key conflicts. A historical successful approval receipt
remains historical after cancellation; GET independently returns current state.
Project ownership and CSRF are checked before returning cached success.

Repository configuration remains operator-supplied. An unavailable original
publication schema refuses with a bounded public error. Constructors and HTTP
requests do not install or upgrade publication tables. A Gateway without
configured repositories keeps its existing in-memory compatibility.

JSON, JSON-flow YAML, event definitions, operation manifest and TypeScript
contracts include this boundary. The existing browser client gains an encoded,
abortable, no-store owner review read through the existing BFF route family.
This is not a claim that a review/apply component is already available in the UI.

## Acceptance and remaining work

Actual Gateway regressions exercise preparation, exact target/source display,
approval, cancellation, reopen/replay, revoked ownership, Origin/CSRF rejection,
unknown query fields, injected authority, changed target bytes, lost preparation
and approval acknowledgements, legacy pending receipts and absent publication
schema. They compare actual target file/index bytes and original database rows;
the tests do not call real model or external provider services.

The implementation was test-first: the new route initially returned 404; the
file-version projection and client read separately failed before being added.
An initial synthetic fixture cleanup failure was corrected by closing the second
Gateway connection before the fixture's original database cleanup. No product
permissions or database semantics were relaxed for that correction.

The frozen Gateway gate completed with 2,220 tests: 2,213 passed, seven
conditional skips, no failures and no cancellations, with the current installed
SDK enabled. The captured product-source manifest was unchanged throughout.
Root tests passed 67/67; UI tests passed 254/254. Gateway typecheck/build,
frontend build and six disclosure-verifier tests passed.

After that gate, only a synthetic test's default HTTP idempotency-key label was
normalized to an explicit `test-` placeholder. The public scanner had flagged
the original nonsecret retry label as a possible credential. No scanner rule was
weakened, and no product code was changed by that correction. The exact final
eight-case owner review file is rechecked separately before publication.

Local loopback tests require the authorized Windows user context when the
restricted shell denies `127.0.0.1`; the original restricted-shell failures are
retained separately rather than reported as passing tests.

Subsequent increments implement the [original source/acceptance/current reads](2026-10-20-publication-source-and-execution-api.md)
and [explicit original native IO and recovery receipts](2026-10-20-publication-native-dispatch-api.md).
Still required in the same plan: BFF/mobile review and Apply/recovery controls,
real browser lost-response/current-state acceptance and final changed-tree gates. Approval
must not be silently dispatched by a GET, task delivery or response replay.
Binary/delete/rename/mode producers, full PilotDeck capability parity, portable
Chat/Work and provider/platform/deployment acceptance remain open.
