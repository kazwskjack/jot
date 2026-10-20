# Complete original isolated-work review

The existing pending task acceptance card can now show the complete frozen
isolated-work changes, original and resulting inventories, selected objective
and version hashes alongside its existing exact-version file downloads.

## Original ownership and evidence

The existing `GET /v1/interactions/{interaction_id}/outputs` returns optional
`work_review` only for an actual original isolated-work candidate. Ordinary
reviews keep their existing response. No new endpoint or permission is added.
Owner, pending status, expiry, exact checkpoint/run version, current original
candidate, original output proofs and byte integrity are rechecked within the
existing deferred SQLite read snapshot. Reading creates no artifact, task,
execution, model call, event or lease renewal.

`review-work-evidence.ts` projects the existing frozen inspection. It validates
the inspection hash, independently validates both inventories and recomputes the
diff. Source, plan, call-set and inspection identities remain available for
inspection; only explicitly selected fields are returned. Absolute host roots,
device/inode identities and internal recovery records never enter this response.
The original candidate reader still establishes authority and provenance: a
matching digest supplied by a caller is not an admission or a trusted source.

JSON/YAML and TypeScript product contracts describe this optional evidence.
They reject absolute/traversal paths, host-root fields and execution claims.
The complete YAML document was parsed and the six relevant schemas checked
under `components.schemas`, rather than relying on matching text lines alone.

## Existing card, complete inventory

The existing client reads this projection through the original same-origin
route. It rejects malformed source, inventory, diff and authority fields before
rendering. Downloads still verify the original exact version and content hash.
The card shows rename/other change kinds, complete original/result inventories,
file mode, size and expandable per-file hashes. Inventory and change pages show
50 entries at a time; all entries remain accessible, not truncated at 50.
The original selected objective is escaped text in an expandable section.

Read results are discarded after the interaction or version changes; failed or
revoked reads remove the old evidence. No HTML from objectives or filenames is
executed. The card explicitly distinguishes isolated results from publication
into the project. Accepting a task is not an apply, commit or checkpoint restore.

## Verification

- Relevant Gateway inspection/review/projection tests: **21 passed**, no skips.
  The actual isolated write, original inspection, proposal, candidate and pending
  review are used; the returned page also validates against the original API
  response contract. Foreign review reads fail and reads add no events.
- All contract tests plus projection: **48 passed**, including JSON/YAML schema
  placement, named TypeScript declarations, ordinary response compatibility and
  denied host paths/execution claims.
- Root tests: **67 passed**. Workbench/UI tests: **253 passed**, no skips.
- Dedicated real React/browser check: mobile/desktop, 55-entry pagination,
  escaped script-like objective, no eager reads/writes, stale-card removal and
  revoked response passed. The HTTP responses in this browser check are explicitly
  synthetic; original isolated provenance is covered separately above.
- Local root frontend build and Gateway typecheck/build passed. No remote build.

Initial restricted-shell attempts could not rename fixture files/connect to
loopback; authorized user-context reruns used a dedicated temporary directory.
An actual original-task fixture initially omitted the original artifact-delivery
configuration; it was corrected to use the same constructor/configuration as
the original service, without weakening the product check. An initial complete
Gateway run was deliberately stopped when the API contract omission was found.
A second complete run exposed the existing declaration-format check: each named
schema needs its own `export type Name =` declaration. It was deliberately
stopped after that confirmed failure. Named types were completed and the full
48-case contract gate passed without weakening its assertions. Neither stopped
run is recorded as passing. The final full Gateway gate completed with **2,090
passed, 20 skipped, zero failures and zero cancellations** (2,110 tests). All
Gateway source/contract/test hashes remained unchanged during that run. A later
frontend-only fix allows legal long relative paths to wrap on mobile; the actual
React browser check, all 253 UI tests and local frontend build passed again for
that final frontend revision.

## Remaining original chain

This closes the full-evidence review presentation increment, not publication.
The [continued original chain](../superpowers/plans/2026-10-20-work-review-publication-chain.md)
requires a distinct target review, original source/result version binding,
project/native custody and interrupted publication reconciliation. Only then
should Git execution and checkpoint/mobile apply controls be activated.
No production deployment, original Host flag or public Git write activation is
claimed by this increment. The complete 26-capability and portable Chat/Work
scope remains open.
