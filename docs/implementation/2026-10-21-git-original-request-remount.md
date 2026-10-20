# Original Git request recovery across page reload

This continues the original selected-index Apply plan. DSH remains the planner;
original Gateway owner/review/version/CSRF checks, immutable server receipts,
physical database, native custody and Worker reservations remain authoritative.
No new server planner, registry, scheduler or receipt store is introduced.

## Gap and behavior

Committed admissions already appeared in server history. Previously an atomic
request whose response was lost before server commit was retained only by its
current page. Reloading could therefore lose the original request identity.
The browser now retains an untrusted recovery hint through the existing
TaskSaveReceipt mechanism. Each original transport key has its own record under
the authenticated owner scope and project. Loading or refreshing these records
never sends a POST, dispatches native effects or restores an approval.

Only exact review preparation, review approval/cancellation, index admission and
index-control commands are eligible. Store the frozen command body and original
Idempotency-Key; do not store file contents, credentials, cookies, native dispatch
or resolve requests. Known rejections clear the hint; response loss,408,5xx and
an in-progress idempotency response retain it. Different keys cannot overwrite
one another. Two views may confirm the same original receipt after one has
already removed the local hint. Storage failure prevents a new untracked request.

The Git panel exposes recovery independently of the current repository snapshot.
An explicit retry uses exactly the original body/key, even if caller state has
changed. After confirmation, authenticated current review or original admission
reads restore the appropriate existing UI. Index controls obtain the actual
original UI admission through the execution request ID. No synthetic acceptance
or automatic native execution is created. Unrelated new review/project mutations remain locked
while unconfirmed hints exist. Original history reads remain available: a
pending local hint cannot block another page from observing the committed
original admission or explicitly revoking its review through the original API. Owner changes remount the panel in their own
namespace; malformed records cannot supply arbitrary routes, roots or commands.

## Local acceptance

Actual mobile React/BFF/Gateway cases cover requests interrupted before forwarding,
an old request committing after page reload, original review preparation and
approval, original control recovery, a confirmed request followed by failed
current-record reads, damaged storage, foreign owner scope and quota failure.
Assertions preserve exact original JSON and key, zero automatic POST on reload,
zero native dispatch, no producer/Worker claim and unchanged index/HEAD.
These fixtures use synthetic data and an explicitly refusing native adapter;
they prove request recovery, not a new native-execution or provider acceptance.
The separately recorded selected-index SDK/process-loss tests retain their scope.

The failed-current-read case first reproduced a presentation defect: refreshing
the local hint list cleared its independent server-read failure. The regression
fails with the original code and passes after separating those error states.
The first complete UI gate finished289 cases with288 passes and one failure:
the stored pending hint disabled original history reads in another page. The
original native Apply case exposed the resulting admission/revocation wait.
A focused regression reproduces that disabled read button; keeping read-only
history independent from the unrelated-new-mutation lock fixes it. A further
assertion verifies navigation is released after original confirmation.
The original environment-startup failure and a damaged-record locator mismatch
remain separate from behavioral red/green evidence; neither is a product fix.

The final frozen full frontend gate passes289/289 with zero skips, failures or
cancellations, including the original actual-native Apply test. Root67/67,
Gateway typecheck/build, frontend build and public-verifier6/6 also pass. Source
hashes remain unchanged throughout those gates. The first full289 run's one
history-lock failure is retained separately; source and assertions were corrected
before this final full run, without relaxed functional assertions or timeouts.

No Gateway, BFF or adapter code changes in this increment.944 enumerated
backend/source/test/dependency inputs from the preceding full Gateway release
remain byte-identical, including the frontend projection imported by Gateway
tests. Its2315-case result (2308 passes/seven conditional skips) is historical
evidence, not a newly rerun whole Gateway result. New actual BFF/Gateway browser
cases are exercised by the current full frontend gate. Exact integrated source,
private-data and complete-history checks still precede the scoped upload.

## Remaining original scope

Browser storage is a recovery hint, not a backup: clearing site data removes it.
Committed original server receipts remain the authority. This increment does not
complete the broader Git branch/commit/destructive/revert/remote workflows,
producer/platform/deployment matrix or any remaining all26 capability chain.
No production switch or deployment is part of this local publication.

## Integrated release gate

The integrated tree matches all1150 frozen source/root/test input hashes.
Integrated root67/67, Gateway typecheck/build, frontend build and verifier6/6
pass. With browser test files serialized, the exact integrated original Git
suite passes17/17 with zero skips/failures/cancellations: seven receipt tests,
nine actual mobile remount cases and the existing actual-SDK native Apply case.
All functional assertions and their original timeouts are unchanged.

The first integrated focused run overlapped local builds and finished15/17:
two initial approval-button waits exceeded five seconds. That failure remains
recorded. The same sources and assertions pass with no concurrent build and
browser files serialized. Resource contention is an inference from that contrast,
not a separately proven root cause or a production performance claim. The full
289-case frontend pass with file concurrency2 remains separate evidence.
