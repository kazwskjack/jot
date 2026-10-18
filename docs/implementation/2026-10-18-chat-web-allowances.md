# Durable Chat Web groups

This increment enforces the Chat preset's existing one-search-group and
one-reading-group policy through original Gateway admission and the official
DSH Web tools. It does not replace DSH planning, the Web provider seam or tool
permissions. General Chat readiness and generated profiles remain off.

## What counts as one group

One original accepted Chat input/run owns one search group and one fetch
group. The first committed native assistant step that uses each kind fixes
that group's complete ordered call manifest. Multiple same-kind calls in that
step can run in the official parallel scheduler. `web_search` also retains
the official concurrent keyword-array behavior (up to four queries per call).

The manifest records native turn/step, assistant event/message identity and
exact call IDs/names/arguments. Later steps cannot replace it. Steering is a
supplement to the same original run, so it cannot replenish the allowance by
starting a new native step or turn. A separately accepted new question gets
its own run and allowance. This is not a model token or billing cap.

## Authority and persistence

The internal bearer-only `ordinary-chat-web` route verifies the original
running run, owner, native Session, live Worker lease and immutable Chat
policy. The trusted adapter derives manifests from the committed native log;
the page, model arguments and tool output cannot select an owner/run/step or
grant execution authority.

The Gateway freezes one manifest per original run and kind, and commits a
consumed-call row before any Web provider body runs. Group/call rows cannot be
updated. The unique run/call key prevents repeat effects; the unique run/URL
digest prevents duplicate fetches even with different call IDs. URL comparison
uses parsed HTTP(S) URLs without fragments, normalizing host case/default
ports. It does not claim every semantically equivalent query URL is identical.

A lost acknowledgement, cancellation after reservation, timeout or unknown
provider outcome leaves the call consumed. Replacement Worker leases and
database/Session reopen do not refund it. A retry receives a consumed result
instead of permission to issue another network request. Original native tool
results remain the evidence of actual success/failure; a reservation does not
prove that the provider ran or the page was read.

Malformed manifests, foreign Sessions, changed policy, missing native
provenance and expired authority refuse dispatch. The distinct fixed
`CHAT_WEB_ALLOWANCE_CONSUMED` denial is not reported as a login/permission
failure. Unknown authority failures retain the existing fail-closed behavior.

## Original adapter integration

`ordinaryChatWeb: true` requires the existing trusted execution policy,
original model/input admission and `ordinaryChatContext: true`. It is absent
by default. A newly created/restored Chat agent receives a denying Web hook
before binding; original admission supplies its exact owned run/lease before
entry. Work receives no Chat hook, context RPC or allowance.

At `tools/execute`, the adapter checks the official registry's same-process
token/Agent and root-call identity, the current frozen context marker, the
original native human input, the committed assistant group and the exact
tool/call arguments. It flushes native provenance before reservation, rechecks
authority after reservation, and only then enters the existing official tool
body. Cancellation, binding changes or a late management response cannot
dispatch a provider. Original DSH guards, schemas, output formatting and
provider selection remain in force.

Adapter/Agent disposal removes its installed hooks and invalidates captured
bindings. A late response after disposal cannot enter a provider. When the
adapter is reinstalled, both already-live and newly created Chat agents start
with the unbound denial until original admission re-confirms their scope;
reload is not permission to infer a binding from the current conversation.

## Evidence

The actual official Host test uses local scripted Messages and explicitly
selected synthetic Web providers. Two questions each perform one parallel
search group, one parallel fetch group and then attempted extra calls. It
observes three keyword requests and two distinct URL requests per question;
the duplicate URL and extra groups produce native error results. A simulated
fetch failure is not retried. The first question receives a real supplemental
message through the original command dispatcher after search; it does not
reset allowances. Each question publishes one canonical answer.

The actual installed-SDK reopen case persists a real official Session and
uses a real Gateway replacement lease after a synthetic unknown provider
outcome. Re-preparing the original run under a fresh adapter does not invoke
the provider a second time. This is a Session/authority integration test, not
a full cold Controller inference/driver recovery acceptance.

An early fixture run inherited the official base profile's explicit Web
provider settings, which take precedence over environment variables. It did
not exercise the intended synthetic provider. The fixture now explicitly
selects the local provider in the test profile and checks provider receipts;
that corrected run supplies the Web acceptance evidence. Do not treat an
environment variable alone as proof of the chosen production provider.

The final adapter suite passed 615 tests with 25 conditional skips and zero
failures. Ten actual installed-SDK cases passed, as did the root's 50 tests and
Windows build. The Gateway full run passed 1,771 tests with seven conditional
skips and zero failures before the final fixed denial-code refinement; that
small refinement passed the focused route/adapter checks and the final Gateway
Windows build. The five selected actual Host chains passed. After the final
admission-disposal fence, the actual Web Host case passed again. These
overlapping checks are not added together as independent totals.

The expanded original-input/Chat fixture run finished with 40 passes and two
failures out of 42, with no skips. Both failures timed out before their first
model request while fingerprinted adapter files were being edited between
Host lifetimes. The original replay profile verifies those exact artifact
hashes. In an isolated copy of the previous published revision, changing only
a comment between Host starts reproduced the same refusal/acceptance timeout
with zero model requests. The unchanged baseline case passed. After freezing
the current source, both failed cases passed individually and in a consecutive
two-case rerun without changing assertions or relaxing fingerprint checks.
This is a controlled source-drift diagnosis, not a claim that the original
42-case run passed. The final five selected Host cases and that two-case rerun
remain separate evidence.

Final focused Gateway coverage passed eleven context/migration/Web tests.
Public-source and reachable-history review are required before publication;
runtime logs, profiles, databases and controlled-copy diagnostics are excluded.

Background post-answer compaction, actual provider
cache/latency acceptance, real readiness and UI/standalone integration remain
open. This increment does not close the full 26-capability ledger.
