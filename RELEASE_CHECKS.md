# Code preview verification

## Failure before native Session creation

The creation-abort change passed the complete Gateway suite: 1,015 passing,
zero failures and one POSIX-only restore skip (1,016 total), including Python
file-engine execution. Gateway build/typecheck passed. The final seven-case
creation subset also passed after adding real simultaneous HTTP bind/abort
requests; both submission orders commit exactly one outcome. This checks one
Gateway with SQLite transactions, not distributed-host capacity or throughput.

Adapter tests passed 312 cases without skips using the pinned runtime; the
final host unit subset passed 23 cases. Seven actual installed-SDK scenarios
passed with the real native manager, Team, SessionController and Gateway HTTP:
normal delegation, a prepare rejection before bind, a lost reservation reply,
a lost committed-bind reply, owner cancellation during prepare, parallel
members and cancellation of an executing member. The original CLI host suite
passed 14 cases. Models remain local scripted/HTTP fixtures, and no production
service or real external model was used.

The prepare-cancellation case uses the actual owner cancel HTTP command and
original command dispatcher through the Session Adapter. It verifies cleanup
before final cancellation, zero child runs, no persisted child Session and no
child inference. Fault-test connections are closed during isolated teardown;
fixture timings are not a production latency benchmark.

An earlier CLI host run observed a snapshot body without `messages`; its HTTP
status/body was not retained, so the cause remains unproven. The same case and
a subsequent full suite passed. An explicit snapshot HTTP/status assertion now
preserves better evidence if it recurs; this is not a claimed runtime fix.

An already bound run or cross-process/changed-lease creation outcome is still
pending. This change supplies neither general provisioning replay nor an
automatic retry queue, cryptographic process attestation, end-user recovery UI
or production native-role approval.

## Native completion and cost accounting

Gateway tests passed 1,009 cases with zero failures and one POSIX-only restore
skip (1,010 total), including Python file-engine execution. Gateway build passed.
The final six native completion cases separately verify unclosed reservation,
unclosed activation, settled child/activation costs, isolated injected pending
cost faults after genuine closure, same-database sibling isolation, distinct
ledger membership and refused post-review admission. The independent fault
injection inserts a new test receipt; it does not weaken immutable settled
records or claim that the normal closure API admits unresolved costs.

The original CLI host suite passed 14 cases. Two installed-SDK scenarios passed
with real SessionController/Team/Subagent/AgentLoop and Gateway HTTP: one member
delegation and two overlapping members (measured peak two). Models are local
scripted adapters; upload/archive leaves are inert, and production was not
accessed. The earlier intermittent delegation observation remains unproven in
cause despite these passes; this result does not close that historical issue.

Unbound reservation abort/recovery, precise native child-file delivery and the
complete official CLI multi-role composition remain open. Passing accounting
tests does not enable native roles or satisfy those separate release gates.

## Frozen acceptance-file review

On Windows, 1,003 Gateway tests passed with zero failures and one POSIX-only
restore skip (1,004 total); Python file-engine cases ran. The final preview
safety subset passed eight cases after the response-deadline change, and Gateway
typecheck/build passed. Portable root tests passed 32 cases and workbench/Jot UI
tests passed 109 cases.

The installed original DSH host suite passed 14 cases. Its actual file-task case
was rerun after the final read changes: the real Gateway, separate Worker and
official launcher returned the original frozen version before acceptance, denied
foreign access and the old review route after acceptance, then published exactly
one matching final attachment. Only model Messages HTTP/SSE and the loopback
owner fixture were synthetic; this is not external model-quality or production
authentication acceptance.

An isolated Edge/Playwright check of the actual React component with synthetic
review HTTP verified literal HTML, hash-checked downloads, image preview/object
URL cleanup, interaction switching, disabled state and expired-state cleanup.
This does not replace a production browser/provider test. Review reads remain a
conservative single response per Gateway with a 100 MiB generated aggregate cap;
large-group performance and fair multi-user queues remain outside this result.

## Pre-publication recovery of claimed human input

This follow-up passed 286 public adapter tests, 319 internal adapter tests,
23 installed-SDK scenarios, 31 portable tests, the local Windows web build
and six public-review tests. Source review covered 543 files without findings.
The final crash probe was additionally rerun after strengthening it with a
second hard kill following durable restoration; both scenarios passed.
Gateway source and production configuration were unchanged.

The new baseline kills a reported test worker after official claim deletion,
flush and exact durable readback. Ordinary and Goal input remain absent under
unmodified resume, with zero model calls and the restored Goal disarmed.
The opt-in setup recovers human input before publication using the official
SessionQuery log and Inbox projection on real detached SDK Sessions. A second
process exit after restoration leaves exactly one pending copy on the next
resume. An explicit subsequent user continuation commits the original human
ID once; the helper creates no wake message and does not replay a Goal prompt.
All models and authorization in this probe are fixtures, not real Gateway
owner/lease acceptance.

Regression checks reject approval/question/schedule/internal sources, cancelled
input, later work, started steps, invalid publication identity, conflicting
pending IDs and changed logs. They also cover an event prefix between the two
claim deletions, partially restored positions, immutable validator input and
same-length source rewrites. Review led to removing new deprecated live-log
reads and structural Session stand-ins. A failed intermediate query test
revealed that SessionQuery includes the logical end-seed marker; final checks
use that documented factory boundary and pass the real SDK scenarios.

The setup is exported and packaged, but is not installed in the default HTTP
Controller or production preset. Audited host composition, real authorization,
worker-lease succession, unknown provider effects, cross-process writer
exclusion and torn-write recovery remain outstanding. These tests establish
input repair in the specified pre-step window, not complete crash recovery.

## Claimed Inbox ordering and final-return composition

This follow-up passed 275 public adapter tests, 308 internal candidate tests,
21 actual installed-SDK scenarios and 31 portable tests, with zero final
failures or skips in those suites. The Windows web build and six public-review
tests passed; the source scanner reviewed 539 files without findings. Gateway
source was unchanged in this follow-up, so earlier full Gateway suite counts
are not presented as a fresh run.

The added SDK evidence covers official claim-before-pre-step behavior, original
input preservation on cancellation/failure, a paused Goal remaining paused,
explicit Goal resume followed by original-scope control reconciliation, and
normal release without a synthetic user wake. A real local Gateway/Controller/
Team scenario starts the formal composition from an npm-packed adapter. Lead
model requests after member execution occur only after the committed returned
state. A separate uncertain-response scenario retains one return request and
the exact two original HTTP user prompts.

Review regressions reproduced cancellation before the next log fence hiding
unchecked events, and binding revocation preventing local hold cleanup. The
fixes audit from the original cut and allow exact-scope local abort without
granting permission or writing old input to a replacement Session. An initial
internal rerun passed 307 of 308 tests; its remaining fixture used the public
token environment name instead of the internal default. Correcting that test
configuration produced the final 308/308 run. A restricted-account loopback
failure observed during composition work is not counted as a passing run.

The gate is process-local. Hard-kill recovery between claim and message
commitment, replaced worker leases, automatic successor-role selection, live
providers and production/browser/UI acceptance remain unverified. Production
switches remain disabled; this is a code preview with explicit opt-in.

## Recovery of an already closed member

The closed-member recovery follow-up passed 252 public adapter tests, 285 internal adapter tests, 11 actual installed-SDK scripted-provider scenarios and 31 portable tests. The normal Windows Gateway run passed 980 tests with zero failures and six platform skips (986 total). Both public builds and both Gateway typechecks passed; the internal handoff transport suite passed 22 tests. An initial restricted-account Gateway run had 17 permission/loopback-related failures; it is retained as a failed run, and the successful full rerun used the authorized Windows context with temporary files under the workspace.

New formal HTTP/SessionController evidence closes a real native member, disposes the original SDK host, resumes only the original lead in a fresh host and automatically restores control from durable facts. The member is never resumed, no additional model call occurs, and repeated root attachment preserves one original return receipt. A separate actual-SDK check exercises the official session invariant companion without an Agent, including its synthetic `TOOL_NOT_STARTED` exception and invalid step/result rejection. Unit and HTTP checks cover changed logs, draining Sessions, missing projections/validation, alternate execution identities, paused Goals, stopped handoffs, changed authority and an already committed return whose response was lost.

This is a fresh-host recovery under the original valid worker lease, not a hard-kill test or replacement-lease adoption. It requires a previously committed child closure, explicit trusted final-return configuration and a quiescent original lead. It does not recover an unaccounted crashed child, discover unknown external effects, guarantee Team-notice/model ordering or enable production multi-role routing. Model providers remain local scripts; archive/upload leaves are inert fixtures.

## Member-scoped closure publication wait

The closure-isolation follow-up passed 235 public adapter tests, 268 internal adapter tests and nine actual installed-SDK scripted-provider scenarios, with zero failures or skips. New regressions first reproduced unrelated blocked spawns preventing a disposed member's durable closure, both under another parent and under the same parent. The observer now waits only for that exact member's publication. Paired cases verify that a member which finishes before its own spawn returns, or during recovery of its original reserved publication, still waits for that publication. Recovery reuses the original child without another spawn. Host shutdown continues to await every pending spawn before removing the admission hooks. These are local host/runtime checks, not production concurrency acceptance; Gateway and web source were unchanged.

## Optional automatic final-return follow-up

The final-return change passed 231 public adapter tests, 264 internal adapter tests, nine actual installed-SDK scripted-provider scenarios and 31 portable tests with zero failures/skips; the local web build passed. New tests verify callback execution only after durable closure, callback retry without another closure or spawn, original parent-binding retention after rebinding, exact source/current execution checks, malformed-route refusal before transfer, cancellation while waiting for the lead and stable retry after a committed return. The helper is included in an actual independent packed-module import. Internal source was synchronized without overwriting its additional tests or private defaults.

The new formal HTTP/SessionController scenario has no explicit child drain or return-transfer call in the probe: official natural settlement releases the member, the host persists its original closure and invokes the configured final-return hook. It verifies the real member file receipt, one intent/reservation/publication, zero legacy dispatches and restored original lead permission. Its model calls are scripted; upload/archive services are inert. It does not prove a durable return outbox, first post-notice lead-model ordering, full automatic multi-role routing or production external effects. Gateway source was unchanged in this follow-up. Earlier explicit-return probes remain historical checks of their own narrower paths.

## Original intent restoration follow-up

The restoration change passed 222 public adapter tests, 255 internal adapter tests, eight actual installed-SDK scripted-provider scenarios and 31 portable tests, with zero failures or skips; the local web build passed. New checks cover new-host pending restoration, exact reserved-publication observation without another spawn, failed-page atomic staging, paused Goals and formal Session attachment with safe blocked-recovery reporting. Internal composition retains its private defaults; a previously absent model-admission test file was added rather than overwriting unrelated internal tests.

The new formal HTTP/SessionController probe begins with an original plan already stored in isolated SQLite before the adapter starts. Reattachment restores that exact request; child admission happens without another lead planning call, the member produces its verified original file receipt, and the probe explicitly drains and returns control. It checks one original intent/reservation/publication and zero legacy dispatches. This is new-host adoption evidence, not a hard-kill recovery test or production-provider acceptance. Gateway source was unchanged in this follow-up.

## Deferred formal-host handoff follow-up

The deferred scheduler passed 217 public adapter tests, 248 internal adapter tests, seven actual installed-SDK scripted-provider scenarios and 31 portable tests, all with zero failures/skips. The local web build passed. Unit checks cover busy-lead pending receipts, exact request replay/conflicts, journal pagination, changed plans/bindings, prior reservations, cancellation, revoked authority and active-shutdown draining; actual packed-module imports include the scheduler.

The new formal HTTP/SessionController scenario invokes `tasks.delegate` from a genuinely running native lead. Its tool result is pending, the lead completes its original turn, and the native idle event triggers journal lookup and handoff before the member's first model. The member writes a file with a verified original occurrence receipt; one original intent/reservation/publication and zero legacy dispatches are recorded. Child closure is drained and control is explicitly returned through the existing authenticated management API. A diagnostic initially tried to serialize the official Agent proxy; reporting only receipt state fixed that probe error without changing assertions. Gateway source was unchanged in this follow-up. At this deferred-scheduler milestone, original-intent restoration had not yet been added; production acceptance remained pending.

## Durable task-intent enumeration follow-up

The authenticated enumeration change passed the full gateway suite with 971 passes, zero failures and six platform-related skips (977 total). Three new scenarios cover reopening the original immutable journal, deterministic pagination, reserved-state observation without another run or mailbox dispatch, stale step/policy and foreign-scope refusal, and the actual HTTP endpoint's authentication, Session and worker-lease checks. The same 14-test focused suite and typecheck passed in the internal candidate. Both local builds and 31 portable tests passed.

The HTTP test first exposed a missing internal-route registration; registering this exact route resolved it without bypassing its own channel authentication. These tests use isolated fixtures and establish a host scheduling prerequisite, not automatic deferred execution, hard-exit recovery or production acceptance.

## Native maintenance handoff follow-up

The maintenance ownership follow-up passed 209 adapter tests, 31 portable tests and six actual installed-SDK scenarios, with zero failures or skips; the local web build passed. The added SDK scenario holds actual native maintenance, queues an official user message, verifies no model request starts during the hold, refuses the changed source and then verifies the original Agent consumes that same message. It also verifies native cancellation reaches the transition without a caller-provided cancellation signal. Unit checks cover unavailable/already-owned maintenance, cleanup and management-request signal propagation.

The SDK providers are local scripts and use isolated state. These results do not establish production behavior, automatic deferred-intent scheduling, unknown-commit recovery or external-effect coverage. Gateway source was unchanged in this follow-up, so its preceding suite is not counted as a new run.

These checks apply to the first standalone code preview. Historical engineering results are described separately and are not reused as this release's test counts.

| Check | Result | What it establishes |
| --- | --- | --- |
| Portable test suite | 21 passed, 0 failed | Model streaming, lifecycle, approvals, worker bounds, idempotency, artifacts and local API/SSE boundaries |
| Portable Vite build | Passed | Web source compiles into static assets |
| Gateway selected contract/store/security suite | 38 passed, 0 failed | Included routes, contracts, owner isolation, transactions, event cursors and retention inventory |
| Gateway typecheck and build | Passed | Included TypeScript and generated neutral template build |
| Session voice protocol suite | 6 passed, 0 failed | Mocked authentication, capability, transcription and cancellation contract |
| Public source/document review | Completed | Private deployment material omitted; dependencies and unfinished integrations distinguished |
| Real UI click verification | Not executed | Browser tooling blocked opening the new localhost preview; build is not a substitute for UI acceptance |
| Real model/browser/office/speech/provider acceptance | Not run for this code preview | Requires operator-configured external services and separate validation |

The document build used Python 3.12.14. Node may report its built-in SQLite API as experimental. Neither that notice nor a successful health response establishes external runtime readiness.

See [Feature status](FEATURE_MATRIX.md) for incomplete host dispatch paths and [Deployment](DEPLOYMENT.md) for post-installation acceptance. Do not infer production parity, browser-pool capacity or performance superiority from these results.

## Follow-up verification: 2026-10-14

The operation-outcome handoff barrier passed 16 focused gateway tests, including older-schema migration, stale observations, unknown item outcomes and exact execution authority. The portable runtime passed 31 tests; workbench UI helpers passed 105 tests. The full extended gateway suite completed with 963 passed, 0 failed and 6 skipped tests (969 total). Both the web build and extended gateway build completed locally. Skipped checks are not counted as passes.

The public worktree review scanned 509 source and documentation files. Reachable-history review covered 42 existing commits and 703 objects with no text or private-identity findings; five binary objects matched previously reviewed neutral template hashes. The final index and commit receive a separate publication review. These checks do not establish live provider reconciliation or production handoff readiness.

The first portable test run under a restricted Windows account encountered denied loopback connections and test-directory access. Running the unchanged suite in the normal user context passed. The focused gateway checks also used isolated fixtures in that context. No production accounts, browser profiles or user conversations were used.

A follow-up regression reproduced a missing accepted count being treated as complete. The fix was verified against six incomplete-manifest cases and newer complete observations. The final gateway rerun again completed with 963 passed, 0 failed and 6 skipped; gateway build and the 509-file public source review passed. Internal candidate tests and typechecking were verified separately. Production handoff remains disabled.

The authenticated handoff management transport was tested through real gateway HTTP requests and isolated SQLite state. Two new scenarios cover exact root/Session/lease identity, atomic transfer rollback, immutable retries, same-role alternate Session denial, return to the lead and stopping without releasing in-flight spend. A separate regression reproduced an unresolved-usage error returning 500; it now returns the fixed conflict code `HANDOFF_USAGE_UNRESOLVED` with status 409. The final full gateway suite passed 965 tests with 0 failures and 6 skips (971 total). Both local builds, the 31-test portable suite, and the internal candidate's two HTTP scenarios and typecheck passed. These gateway checks did not establish native-host orchestration or live provider-effect reconciliation.

The subsequent member-admission change passed 182 adapter tests and three actual installed-SDK scenarios (handoff, existing formal delegation and task cancellation), with no skips. The portable 31-test suite and web build also passed. The handoff probe uses the actual native Team and AgentLoop, an authenticated isolated gateway and scripted providers; it is not production or external-effect acceptance. Gateway source was unchanged in this follow-up; the preceding full gateway result is recorded separately rather than counted as a new run.

The background-operation closure prerequisite passed 187 public adapter tests and 219 internal adapter tests, with no failures or skips. Regression tests first reproduced premature closure without an observer and an ignored malformed setup option. They now reject missing or mismatched proofs, running operations, incomplete/duplicate manifests and Session changes during observation. Three existing actual-SDK scenarios passed again using local scripted providers; the portable 31-test suite and local web build passed. Operation proofs in the new closure tests are fixtures, not live remote-service evidence. Gateway source was unchanged in this follow-up. Production Handoff and external-effect acceptance remain pending.

The configured leaf-transport follow-up passed 194 public adapter tests and 225 internal adapter tests (zero failures/skips). It includes a real loopback HTTP member-closure scenario and an actual packed-module import. The latter initially failed because the new runtime module was missing from the package manifest; adding the module resolved that failure in both packages. The actual-SDK three-scenario regression, portable 31 tests and local web build also passed. The new HTTP server uses synthetic operation snapshots; it does not prove live provider or production acceptance.

Durable external-operation facts and prefix recovery were verified with 196 public adapter tests and 227 internal adapter tests (zero failures/skips). The full gateway suite completed with 967 passes, zero failures and six platform-related skips (973 total). New persistence scenarios verify stored manifests, immutable retry conflicts and invalid/foreign evidence rejection without releasing a member. A regression first reproduced recovery accepting missing operation evidence, then passed with exact log-call matching. Three actual-SDK scripted-provider scenarios, the portable 31 tests, web build, gateway build and internal focused two scenarios/typecheck passed. New operation facts use fixtures; live provider operation acceptance is still pending.

The original-lead barrier follow-up passed 201 public adapter tests, 232 internal adapter tests and three actual installed-SDK scripted-provider scenarios, with zero failures/skips. Tests cover temporary gates, busy leads, pending inboxes, changed logs, management failures, acknowledged background batches and independent packed-module loading. The actual SDK initially rejected a fresh lead containing only official Goal metadata; inspecting its real event types identified initialization rather than unfinished execution. The shared reader now distinguishes that state while retaining completed-turn requirements for member closure. Portable 31 tests and the local web build passed. Gateway source was unchanged; its prior full-suite result is not counted as a fresh run. Formal automatic handoff scheduling remains pending.

The reusable initial handoff admission passed 204 public adapter tests and 235 internal adapter tests, including actual packed-module imports. Four actual installed-SDK scenarios passed with zero skips: the new formal HTTP handoff, the prior explicit-host handoff, normal model-callable delegation and owner cancellation. Formal handoff uses a real local adapter/gateway HTTP path, native SessionController/Team/AgentLoop and isolated SQLite, with a scripted LLM and inert upload/archive services. Its first attempt failed because the precreated Session lacked its native cwd metadata; adding the correct fixture metadata resolved the original Controller rejection without relaxing its checks. Portable 31 tests and the local web build passed. Gateway source was unchanged. Production, deferred handoff scheduling and multi-hop completion remain pending.

The subsequent-role transition passed 205 public adapter tests and 236 internal adapter tests. Five actual installed-SDK scripted-provider scenarios passed, including formal two-role handoff after the first task step was completed using its real file receipt. The second role actually read the first role's file and produced separate read/write receipts; both execution closures and final return were verified. A regression reproduced same-role alternate execution evidence being accepted; current controller reads now include exact run/Session binding and that substitution is refused. The full gateway suite passed 968 tests with zero failures and six platform-related skips (974 total); portable 31 tests, both local builds, internal source-purpose test and typecheck passed. Tests also preserve the old cold-source refusal for completed predecessor assignments. Production, automatic scheduling, automatic final acceptance and hard-exit recovery remain unverified.

## Voice feedback follow-up: 2026-10-18

Microphone-driven waveform and recording duration were added to the shared extended composer. Startup now times out after 20 seconds, covering permission and AudioContext resume, with late-stream cleanup. The voice controller/client/browser suite passed 25 tests, the subsequent recorder/controller/composer policy run passed 23, the portable runtime passed 50, and the web production build passed. The browser used fake microphone audio and synthetic ASR; physical mobile input and live provider quality remain unverified. These overlapping suites are not added together. See [bounded voice release](docs/implementation/2026-10-18-voice-feedback-release.md) for scope and open integration work.

## Model boundary follow-up: 2026-10-18

Queued execution now joins the existing model mutation guard, and metadata validation/write use one immediate transaction. The official budgeted host resolver receives the original cancellation signal. Gateway full regression passed 1,723 tests with seven skips and zero failures (1,730 total); the final eight-test focused run additionally covers confirmed receipt replay after queue admission. Adapter test-directory results were 557 passed/25 skipped/zero failed, with six separate voice protocol passes and one actual installed-SDK resolver cancellation pass. Root tests (50), Gateway build and frontend build passed. These overlapping checks are not a full capability completion claim. See [evidence and open integration](docs/implementation/2026-10-18-model-policy-boundaries.md).
