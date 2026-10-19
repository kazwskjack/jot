# Owned Git review API (in progress)

The [exact review journal](2026-10-19-git-review-intents.md) now has authenticated
Gateway review routes. These manage original review records; they still do not
dispatch repository writes or enable commit, discard or remote operations in
the workbench. The [full Git plan](../superpowers/plans/2026-10-19-git-workbench.md)
keeps user controls, actual local effects and unknown-outcome recovery open.

## Routes and transactions

- POST `/v1/projects/{projectId}/git/intents`: prepare an exact review, returning
  201. The request supplies a stable request ID, operation, selected paths,
  original snapshot ID and a commit-only message.
- GET `/v1/projects/{projectId}/git/intents/{intentId}`: read current review state.
- POST `/v1/projects/{projectId}/git/intents/{intentId}/control`: approve or cancel
  against an exact version and review digest, returning 200.

The existing actor, origin/CSRF and original idempotency mechanisms apply.
Preparation/control performs asynchronous read validation first and then returns
a synchronous commit closure. The existing `atomicCommand` transaction commits
the original intent/event and HTTP acknowledgement together under the reserved
`git-review-atomic-v1` protocol. It does not cache an already-completed asynchronous
mutation after the fact.

A failed acknowledgement rolls back the original intent or approval event while
retaining the pending HTTP reservation. The same request can resume after a
restart. Legacy pending requests without this exact protocol cannot resume as
new commands. Changed request bodies conflict. Original acknowledgements and
current state remain separate: a historical approved acknowledgement does not
revive a cancelled review or authorize execution.

Project ownership is checked before serving even a cached successful
acknowledgement. Both original responses and cached replays use private/no-store
headers. Route errors expose fixed codes rather than filesystem details or raw
Git errors. Selector, root, executable and remote-operation overrides are not
accepted. All review projections retain `execution_authorized:false`.

## Verification performed

Six actual Gateway API tests pass, including database reopen, original replay,
injected acknowledgement-write failure for both preparation and approval,
revoked ownership, CSRF, changed bytes, old protocols and invalid selectors.
The original four cases first failed on missing routes. A subsequent cache-header
regression failed on the replay path before the no-store guard was added.

The combined Git and contract run passed 45 cases without skips; the additional
shared-schema regression then passed in the complete eleven-case contract run.
JSON/YAML, event definitions, operation manifest and TypeScript types are
synchronized. Adversarial schema tests reject omitted commit messages, unrelated
messages, duplicates, private overrides and execution/applied-state claims.
Windows Gateway build and source privacy preflight passed.

Complete API-source Gateway regression terminated with 1,952 passed, seven
existing conditional skips and zero failures (1,959 total). The subsequent
[review workbench](2026-10-19-git-review-ui.md) was verified independently with
the complete 250-case UI suite, root tests and frontend build. The backend source
remained unchanged during its full run. Staged/history publication review still
has its own gate. These local results do not establish production activation,
actual mutation recovery or full Git capability completion.
