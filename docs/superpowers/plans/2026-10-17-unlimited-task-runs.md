# Explicit unlimited persistent-task run limits

Implements the prerequisite identified by the full Always-on discovery plan.
This does not enable project discovery or remove DSH/model/permission gates.

## Contract and migration

Public `budget.max_runs` is a configured integer 1–10000 or explicit null for
unlimited. Omission keeps the existing default 100 on create and current value
on update. Zero, negative, malformed and unknown budget forms are rejected.
Unlimited does not change once-trigger semantics, original occurrence identity,
pause/stop, deduplication, role/owner, model accounting or physical pool capacity.

Keep the existing table and add `run_limit_mode` default finite, preserving old
rows/counts/status/IDs. Internally only the exact `(unlimited,0)` pair represents
public null. Finite rows retain their existing positive max_runs. Atomic tuple
guards reject inconsistent writes; zero alone is never decoded as unlimited.
The legacy numeric zero causes the known earlier task scheduler's numeric
guard to refuse creating another occurrence it does not understand. It does
not revoke an occurrence already authorized by an updated scheduler or certify
every old Worker version. This is a conservative
rollback fence, not a claim that mixed consumer pools can process unlimited work.
Old consumers can leave error/exhaustion status requiring explicit owner resume
after upgrade. Do not silently reset progress or user pause during rollback.

## Implementation and verification sequence

1. Add failing real-service tests for explicit null creation, admission beyond
   the former bounds, count/restart persistence, exact-key retry, pause/resume,
   finite/unlimited edits, old-layout migration and inconsistent tuple rejection.
2. Centralize limit encoding/decoding/exhaustion in a persistent-task helper;
   migrate under the existing immediate transaction and update create/update,
   transition/admission, exhaustion SQL and workspace text projection.
3. Extend route and OpenAPI/type schemas. Advertise support through explicit
   capability fields; keep API zero invalid. Test authenticated routes and actual
   API/schema validation, including finite defaults and cross-owner refusal.
4. Offer an explicit unlimited checkbox only for supporting servers. Preserve
   old finite defaults and exact nullable payloads in drafts/unknown receipts.
   Edit/review/counters/resume must render unlimited clearly and never coerce null
   to numeric zero. A saved unknown command retries its original body and key.
5. Test service/routes/contracts/UI forms/draft recovery, built workbench behavior,
   complete Gateway and root tests/build. Document migration/rollback and actual
   evidence. Review public files and exact commit metadata before GitHub upload.

Mailbox thread quotas are separate and remain unchanged. Model limits, unknown
money and task occurrence permission checks remain unchanged. Keep the original
full capability scope and Always-on pipeline phases open after this prerequisite.

## Implemented and observed

`persistent-tasks/run-limit.ts` owns configuration validation, exact stored-tuple
interpretation and transactional migration/guards. The original task service
uses it for create/edit/read/resume/admission and updates exhaustion only for
finite mode. Public zero remains invalid. Original counts, task IDs, occurrences,
request keys and paused/exhausted states survive migration and mode changes.
Changing an exhausted task to unlimited does not resume it automatically.

Both OpenAPI formats, exported types, request schemas and strict response
capability schemas accept the new contract. Capability support is explicit;
the UI renders an optional checkbox, review text and run counter, preserves null
through edit/reload and refuses a new unlimited request against an unsupported
server. The original finite default and the existing mailbox/model quotas remain.

The initial service regressions failed with `invalid_budget` for explicit null.
New service/route/schema tests then passed 36 cases, including interval execution
past the old default, count above 10000, one-off no-repeat, original-key retry,
pause/resume, finite/unlimited edits, actual old-layout migration, independent
SQLite connection reopen and tuple/owner refusal. An initial migration assertion
compared a spread plain object to SQLite's null-prototype row; normalizing only
that prototype confirmed all actual fields were unchanged. The restricted-shell
junction fixture failed with EPERM and passed in the already-authorized Windows
test context; no permissions or link safety checks were relaxed.

The real built-browser probe (`node scripts/verify-unlimited-task-ui.mjs`) uses
an isolated actual root BFF, Gateway and SQLite database. It creates unlimited,
lets the server commit then loses the response, reloads and retries the exact
body/key, verifies only one task, edits back to five runs and confirms that
missing capability fields hide the unlimited control. It makes zero model runs
and records zero page errors. First it exposed an actual strict response-schema
omission for the new capability flags; that schema was completed rather than
turning validation off. A later locator used the select's actual accessible
label instead of assuming its text excluded option labels.

Three actual installed-SDK/Gateway/Worker tests pass (19.87 seconds), using a
scripted local Messages provider. The finite control retains waiting behavior;
unlimited user input/review continues the same occurrence and native Goal with
only one task run consumed; unlimited file completion still requires owner
criteria acceptance and publishes exactly one verified artifact/answer. Each
unlimited case uses three original model requests with original budget checks.
This is SDK integration evidence, not real-provider quality or production billing.
Root32/32, workbench/chat154/154 and Windows root build pass.

### Concurrent publication test diagnostics

The first full Gateway run had 1353 total, 1345 passes, seven skips and one
publication-race `database is locked` failure. Its older child fixture emitted
only the message, so its exact transaction site cannot be retroactively proven.
The existing 75 ms infrastructure timeout permits an acquisition refusal; both
competitors are not guaranteed first-attempt success. The fixture now records
whether BEGIN succeeded. Only a known SQLite busy refusal **before** BEGIN can
recover the winner's existing original receipt, with zero changes in the
recovering connection. Errors after BEGIN and unrelated errors still fail.

A second full run had 1354 total, 1346 passes, seven skips and one failed
controlled-contention assertion: a 120 ms sleep did not ensure the other process
was scheduled during the lock. This was a test synchronization error, not proof
of missing production locking. The final controlled case synchronizes actual
held-lock/refusal markers in its own scratch directory. The winner retains the
lock until the contender confirms acquisition refusal, then applies the extra
120 ms hold. Both owned children are awaited/cleaned up on every outcome. Normal
and controlled two-process cases pass; original failures remain private evidence.
No production timeout, execution retry, native call or publication logic changed
to make this fixture pass. This is not a claim that every original failure was
known pre-BEGIN or that production contention is impossible.

## Final verification

Final current-source Gateway run: 1354 total, 1347 passed, seven skips (six
existing and the separately opt-in output-load measurement), zero failures,
154.93 seconds. Windows Gateway build passes. All production and test code was
final before this run; the earlier two full-run failures remain recorded above.
Root32/32, workbench/chat154/154 and Windows root build pass. Actual installed-SDK
cases pass 3/3; the real built browser/BFF/Gateway probe passes creation, lost
response/reload/exact original-key retry, finite edit and missing-capability UI
behavior with one task, zero model runs and zero page errors. Public regressions
6/6, 760-file working-tree disclosure scan and BRAIN links pass. These are local
acceptance results, not production rollout or complete fleet compatibility.

The complete Always-on source collector, project policy/signal admission,
isolated work cycle, DSH discovery/work/report, reviewed apply, UI and deployed
acceptance remain unfinished. This prerequisite must not be presented as that
running feature or full 26-capability completion.
