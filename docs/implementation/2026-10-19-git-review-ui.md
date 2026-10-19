# Git review workbench

The workbench connects selected diffs and the complete visible staged set to the
[owned review API](2026-10-19-git-review-api.md). It prepares reviews for stage,
unstage, commit, tracked-worktree discard and untracked-file deletion. Commit
reviews require a message and are unavailable when protected omitted paths or
staged conflicts prevent a complete review.

This is a review workflow, not a Git writer. The interface explicitly says that
preparing or approving a review does not modify the repository. Current state
distinguishes waiting, approved but not executed, and cancelled. Actual effects,
immutable outcome receipts, crash reconciliation and separately authorized
remote operations remain open in the full Git plan.

## Original requests and current state

The editor reuses the existing current-page mutation receipt helper. A lost
response retains the original body and request key. It locks editing, repository
selection, refresh and workbench navigation until the original reply is recovered;
the before-unload warning remains. It never creates a fresh approval because a
reply was lost. After a receipt, it reads current owned review state separately:
another device may already have cancelled a historically approved request.
A failed current-state read disables controls until refreshed. Changed source
bytes disable approval while retaining cancellation; version conflicts require
a fresh state read.

Browser command recovery is current-page only. Pending commands do not persist
through forced reloads, and there is no paginated review-history inventory yet.
Server original receipts survive reopening the database. Cross-device execution
coordination remains part of the future mutation phase, not completed parity.

## Verification

A real 390-by-844 React/BFF/Gateway test covers all five review types, required
commit messages, stale approval refusal, cancellation, a dropped approval reply,
byte-identical original request/key replay and another device cancelling before
replay. It checks current cancelled state, unchanged repository bytes and no
unexpected write routes. The existing read-only mobile case also passes,
including late-response isolation, stale patches, binary files and no page-level
horizontal overflow. The expanded fixture waits for the pending retry to become
enabled before simulating another device, and drains route handlers on cleanup;
an earlier fixture race was not counted as a production defect.

Full UI: 250 passed, no skips. Root: 67 passed, no skips. Windows frontend build
passed and the mobile layout was visually inspected using synthetic data. The
unchanged paired backend source completed Gateway regression with 1,952 passed,
seven existing conditional skips, zero failures (1,959 total). Backend and
frontend were verified separately. No external provider, production deployment,
actual Git mutation or full 26-capability completion is claimed.

Public source preflight scanned 1,086 files without findings. The original
history/index verifier covered 187 commits and 2,850 blobs with the same five
previously reviewed Office template binary findings and no new finding. The
private audit helper caches hash-verified Git plumbing bytes in bounded batches;
it leaves the original verifier body, thresholds and identity rules unchanged
and refuses a changed index/ref fingerprint. It does not cache findings or skip
objects. This heuristic scan remains separate from manual release review.
