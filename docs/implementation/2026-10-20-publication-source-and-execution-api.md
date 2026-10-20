# Original completed source, acceptance and current publication status

This continues the [owner review API](2026-10-20-publication-owner-review-api.md)
through the original services and database. DSH remains the Session/Goal planner
and native execution authority; this increment adds no new scheduler or lock.

## Completed source before preparation

`GET /v1/projects/{projectId}/work-publication-sources/{runId}` reads original
`FinalizedWorkSources.summary` and confirms the returned project equals the
route project. The historical reader still requires original owner, completed
task, accepted certificate, immutable candidate, native completion proof and
verified file versions. Unknown, foreign, unfinalized or corrupt material cannot
become a mutable latest-version fallback.

`publicationSourceView` is shared by this read and prepared reviews. It exposes
the exact finalized `source_sha256`, original task/run/occurrence and proof IDs,
file versions/receipts and complete inspected inventories/diff. It does not expose
native session references, host roots or recovery records. The finalized-source
digest is distinct from the work-inspection source digest. A browser uses the
former unchanged to prepare review, rather than guessing from an attachment.
Reading the source changes neither SQL rows/schema nor filesystem contents.

## Separate immutable acceptance and current state

- `POST /v1/projects/{projectId}/work-publications/{intentId}/admissions` calls
  original `WorkPublicationExecutions.admit` inside `atomicCommand`. Input is
  only request ID, approved review version and exact review digest. The original
  admission and HTTP acknowledgement commit together, under
  `work-publication-admission-atomic-v1`.
- `GET /v1/projects/{projectId}/work-publication-admissions/{requestId}` reads
  the original immutable receipt. `accepted` does not mean a file was applied.
- `GET /v1/projects/{projectId}/work-publication-executions/{executionId}` reads
  `publicationStatus`, including exact journal digest, published file facts and
  any unresolved relative path. It keeps `not_started`, `running`, `interrupted`,
  `unknown`, preparation failures, `applied_pending_settlement`,
  `abandon_pending_settlement`, `applied` and `abandoned_unknown` distinct.

Admission creates no native dispatch, workspace reservation, Worker, new run,
model call, file write or Git index change. It requires the explicit original
publication schema upgrade; constructors and requests do not migrate it. A
failed acknowledgement rolls back both original admission records. Reopen and
same-key replay recover one receipt; a legacy pending record without the original
atomic protocol refuses. Revoked ownership is checked before cached success.

History and current reads never dispatch, settle or replay a write. Cancelling a
review does not rewrite its historical accepted receipt. The current journal
remains independently readable; cancellation cannot grant another file effect.
Origin/CSRF, original owner/project checks, bounded exact contracts and no-store
responses are preserved. Unexpected query fields and caller root/executor/owner
authority refuse. The existing BFF client gains encoded abortable source,
acceptance and current-state reads; it sends no transport credentials.

## Executed local acceptance

- Source owner route: actual Gateway reads the source, uses its exact digest for
  preparation, matches the resulting source projection, rejects wrong project,
  foreign owner, absent run, extra selectors and later owner transfer, with no
  read-side row or schema change.
- Three execution-owner route cases verify acceptance/current separation,
  database reopen and cancellation, original file/index bytes unchanged, no
  workspace/Worker/journal allocation, acknowledgement rollback/recovery,
  wrong review versions, caller authority and legacy pending receipts.
- Source/review/contracts batch: 16 tests passed; execution/contracts batch:
  10 passed. These batches share contract tests and must not be summed as unique
  tests. The browser client suite passed 14; typecheck and both local builds
  passed. The synthetic retry label uses an explicit test placeholder; no
  disclosure rule was weakened.
- An actual separate original native Host case passed with the installed DSH
  runtime: original file publication, review revocation, process exit after the
  physical effect and explicit owner journal settlement. Added public GET checks
  match the original immutable admission, genuinely applied result,
  `applied_pending_settlement` and final settled result. Status reads add no
  journal records. Native model calls remain zero. This validates the public
  reads around real native effects; transport is invoked explicitly by that
  test, not through a public HTTP dispatch endpoint.

These results first ran in an isolated source/execution candidate, which was then
integrated after comparing its exact changed-file hashes and checking the
original files had not diverged. Private candidate metadata, runtime data and
dependency links were excluded from integration. This is not a production
deployment. The preceding 2,220-case frozen Gateway result belongs to the earlier
review API tree and cannot certify this later changed tree. Verification on the
integrated tree remains required before publishing this increment.

## Still required

Explicit dispatch and journal-CAS owner settlement are implemented in the
[following native IO increment](2026-10-20-publication-native-dispatch-api.md),
separately from admission and historical reads. BFF/mobile review, Apply,
current-result and explicit recovery now have actual lost-response acceptance in
[the mobile increment](2026-10-21-publication-mobile-apply.md). Final changed-tree
regression and disclosure gates remain separate. Broader binary/delete/rename/mode producers, Git remote
operations, all26 PilotDeck capabilities, portable Chat/Work and provider/platform
and production acceptance remain open.
