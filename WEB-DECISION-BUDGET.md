# Web decision budget transport

This is a gateway foundation for metering a web-decision provider against an
existing owned run. It does **not** connect the external Python provider or the
official MCP client automatically. End-to-end web-decision budget coverage is
not yet established; do not enable it on the strength of these gateway tests.

The DSH Session remains the planner and final-answer authority. Browser
permissions remain separate. A budget grant cannot authorize a click, expand a
role's tool list, create another run, or bypass a task's execution approval.

## Host boundary

The trusted Session adapter can request a grant using the existing loopback
gateway service identity:

`POST /internal/v1/workbench/web-budget-grant`

Its body contains `run_id`, `session_ref`, `call_id`, `tool_name`, and the
SHA-256 `request_hash` of the original native tool call. The gateway resolves
the owner from the original run and Session binding and checks current role,
task and worker authority. The tool must already be permitted for that role.
These fields belong to trusted host plumbing, never model-generated arguments.

The response contains only `protocol: 1`, an opaque `grant`, and `expires_at`.
The ticket has a fixed five-minute lifetime, is tied to the original worker
lease generation and Session, and cannot extend its expiry through retry.
Replaying the same call returns the same ticket; a changed call hash or Session
is rejected. Tickets are credentials: do not log them, persist them in model
messages, include them in tool results, or publish them.

## Provider boundary

`POST /internal/v1/workbench/web-model-budget` uses the opaque ticket as its
Bearer credential. It does not accept the gateway management credential, owner,
run, or Session claims. Each command has a strict field allowlist:

| Action | Additional fields | Effect |
| --- | --- | --- |
| `reserve` | `request_id`, `provider`, `model`, `request_hash` | Admit a new attempt against live authority, or look up an exact existing attempt without spending |
| `dispatch` | `attempt_id` | Recheck live authority and mark the original attempt sent |
| `settle` | `attempt_id`, optional `usage` | Settle original provider usage, including after authority is revoked |
| `unknown` | `attempt_id`, `reason` | Retain unresolved token accounting; never claim zero usage |
| `release` | `attempt_id` | Release only an attempt not yet dispatched |
| `response_record` | `attempt_id`, `response_json`, `response_hash` | Store the original dispatched response as an immutable private fact |
| `response_read` | `attempt_id` | Retrieve that original response without a provider call |

Providers are restricted to `openjev` and `laya`, with a matching configured
model route. A new fallback invocation requires its own original-root attempt.
A repeat with the exact original provider, model, request ID and payload hash
returns `fresh: false` and the original receipt even after the ticket closes or
expires. The original ledger row must already exist. This is an accounting
lookup: a new or changed request remains denied, minting cannot renew the
closed ticket, and `dispatch` still requires live authority. A sent attempt
with no verified response stays unresolved rather than being reissued.
The boundary's `transport_unknown` and `provider_failed` reasons map to the
ledger's `stream_incomplete`; `settlement_pending` maps to
`settlement_unavailable`. These preserve the original held or settled cost.

For token-metered routes, use real supplier usage; incomplete usage stays
unknown and held. For an explicitly configured `dispatched_call` route, dispatch
charges that configured quota immediately and token usage remains `null`.
This is a configured per-call policy, not measured supplier pricing or a claim
that a supplier used zero tokens. Fake token usage is rejected on this route.

`unknown` reasons are `usage_incomplete`, `provider_failed`,
`transport_unknown`, or `settlement_pending`. Neither unknown results nor
cancellation refund dispatched costs. Settlement can affect only an attempt
originally mapped to the ticket; it cannot create another invocation.

## Closing and recovery

The trusted host closes a quiesced call using
`POST /internal/v1/workbench/web-budget-grant/close`, with the original
`run_id`, `session_ref`, and `call_id`. Closure is idempotent, revokes future
spending, and releases only unsent reservations. Sent and unknown attempts
retain their accounting. Grant identity and attempt mappings are immutable.

Changing the management secret invalidates old ticket authentication. This does
not erase already incurred accounting; management recovery must reconcile those
original attempts. A timed-out host request or a lost provider response must
not be treated as proof that nothing ran.

The gateway's original-response table is private runtime data, retained with
the original accounting attempt and database backup. It accepts exact UTF-8
JSON bytes and their SHA-256, at most 256 KiB. The frame is either
`{protocol: 1, encoding: "json", value: ...}` or an HTTP frame containing only
`protocol`, `encoding: "http"`, `status_code`, canonical `body_base64`, and
`retry_after` (null or bounded printable text). HTTP body bytes are limited to
128 KiB. Arbitrary HTTP headers, cookies or authorization fields are not accepted
in the frame. Its raw provider body may contain private content; never publish
the database or export it into public fixtures.

Recording before dispatch is denied. The original attempt accepts one exact
response; identical confirmation is idempotent, changed bytes/hash conflict,
and updates/deletes/replacements are denied. Reading or completing the original
record after ticket closure cannot authorize another invocation, alter charged
costs, or access a different ticket's attempt. An absent record is unresolved,
not proof that the provider did not run. Existing secret-rotation behavior still
applies. This is a trusted-host observation, not independent proof of model
quality or task success.

The gateway has been tested after closing every database connection and reopening
from its disk database. Python's actual-submission helper now encodes HTTP/JSON
responses, records them and checks the original record after an acknowledgement
is lost. A duplicate already-dispatched attempt reads that record and never
invokes the provider again. A missing/corrupt record stays unresolved; unknown
actual usage stays held. Local HTTP tests include a dropped committed response
acknowledgement and an original HTTP body over 64 KiB, with synthetic providers.
Complete native/cross-machine/real-provider recovery still needs acceptance.

## Remaining integration and acceptance

The existing extended runtime uses a native tool HTTP bridge, which then
forwards MCP requests. Its development source now supports an explicit trusted
ticket header and forwarding into MCP `_meta`. The Session adapter now has an
explicit `webBudgetEnabled` flag, defaulting to `false`. For an existing
budgeted role's permitted native tools it mints the original call's ticket,
binds it to the registry-owned token and exact Session/name/arguments in an
isolated async scope, rechecks authority before delegation, and closes after
delegation settles. Descendant work cannot use the ticket after scope closure.
The native transport must include the matching context module. Do not enable
the flag with an older transport or without Python receiver and accounting
callback acceptance. This does not justify patching an unrelated official client.
Do not mutate parsed tool arguments or tool identity to carry authority.
The Python intake and existing FastMCP dispatch wrapper now scope metadata to
the request; the native work executor explicitly copies that scope. The extended
development source now meters actual HTTP/model submission points and captures
a separate context for shadow jobs and local Laya threads; their tests still
use synthetic providers. Cross-machine callback and real-provider acceptance
are outstanding;
global mutable run identity is unsafe. Missing required authority must deny a
provider invocation, including fallback, rather than run unmetered.

An optional standard-library [Python boundary](packages/web-decision/README.md)
implements request-scoped opaque-ticket commands, frozen provider input and
conservative no-replay behavior. It has been exercised against actual local
gateway HTTP with synthetic providers. Its presence does not wire the existing
production providers or establish real-model acceptance. Its original-response
journal integration is locally verified, rather than a complete production claim.

A separate local wire experiment now runs the adapter's budget helper, native
HTTP transport, leaf WebSocket bridge, official Python MCP SDK stdio transport,
request-scoped thread and original Gateway HTTP ledger together. Two synthetic
owners each incur one synthetic provider call and one configured charge. A lost
committed response acknowledgement is recovered; a new Python process restores
the original result without invoking the provider again. Both grants close and
an unscoped later native call is rejected. The registry execution, Controller
identity, WebSocket relay and provider remain test fixtures. This experiment
does not establish production deployment, actual Controller hooks, cross-machine
callbacks, real-model billing or the full cancellation/expiry lifecycle.

The experiment also runs against an installed DSH `0.2.0-rc.2` ToolRuntime
and Cordis `4.0.4`: the actual registry assigns the private execution token,
freezes arguments and dispatches the `tools/execute` waterfall before the
budget helper and native transport run. Agent/Controller identities and the
model remain fixtures. This establishes that specific tool-runtime seam,
not full Session Controller compatibility or production readiness; the adapter's
declared peer dependency is not broadened on that evidence alone.

The isolated experiment can also use the actual AgentRegistry, AgentLoop,
SessionStore, GoalService and WorkbenchBridge. Scripted main-model responses
cause the AgentLoop to request the native tool and log its rendered result.
The original WorkbenchBridge runs its permission and Goal checks and meters
both scripted main calls and the auxiliary web call against one original root
per owner. This is stronger integration evidence than a fabricated tool token;
the model adapter, relay and host Controller/worker admission remain fixtures,
and the initial mode keeps Session state in memory. That initial mode does not
establish disk checkpoint recovery, real supplier usage or deployment readiness.

That AgentLoop/Goal/Workbench seam has been exercised with the installed
declared DSH `0.1.7-alpha.2` packages as well as the `0.2.0-rc.2` candidate.
Each owner uses two scripted main calls (30 synthetic reported tokens) plus
one synthetic web call, charged to one root. These numbers verify the test
fixture's accounting, not real supplier token counts or prices. Full Controller,
worker, persistence integration and real-model acceptance remains required for both versions.

An extended persistence mode uses the official checksummed Zstandard JSONL
backend. After flushing and disposing the real writer, a separate Node process
restores both original Sessions with no model adapter. The original checkpoint
prefix and Goal identity verify, changed hashes and foreign Session receipts
are rejected, and no new model call occurs. This has been exercised on both
versions. It proves that isolated Session storage/restore boundary; Controller
and worker recovery, interrupted writes, remote-host restore and production
acceptance remain outstanding. Private Session artifacts are never published.

A subsequent isolated run mounts the actual SessionController and its official
storage, workspace, attachment, file-upload and query services on both versions.
The authenticated adapter handler creates and adopts the original Sessions,
rejects conflicting workspace paths, and preserves each accepted request ID in
one user message. It then exercises the same budgeted tools and checkpoint
recovery above. Browser authentication is a deny-all test collaborator; HTTP
hosting, original worker admission and actual model providers are not covered.
This does not establish full Controller/worker recovery or production acceptance.

An additional local mode starts the original adapter HTTP plugin with its
declared service injections and a random loopback port. The original gateway
client sends prompts and consumes the NDJSON follow stream: a Session snapshot,
one user message, one tool result and an ordered turn-end boundary per owner.
Both installed versions pass this transport seam with scripted model providers.
The original worker/runner dispatch and real production providers are still
required; transport success is not business acceptance or a production result.

A separate, network-free check exercises the installed preset registry and
Controller with an explicitly empty local declaration. Both versions preserve
the preset identity in Agent composition and durable Session projection, adopt
the same Session without a new user message, and reject an unknown preset.
This checks the preset binding contract only; it does not certify the deployed
tool composition or the original worker/runner integration.

A further local mode uses the original coordinator, worker, Session binding
repository and runner, rather than inserting worker leases or running statuses
by hand. Two queued owner-isolated tasks run through the real adapter HTTP,
installed SessionController, AgentLoop and MCP budget path. The runner records
worker-fenced compressed Session checkpoints. Candidates remain pending business
review, no task answer is published, and both leases are released. This passes
with the private host modules and the public release modules on both installed
versions. The public run uses the documented `jot-general` preset identity.
Its declaration is still an explicitly empty fixture, and providers/relay are
scripted: production tool composition, actual provider usage, interrupted-writer
recovery and business acceptance are unproven.

A bounded native-continuation mode also mounts the official Goal round driver.
An accepted `tasks.propose` continuation produces one automatic round in the
same original Session, with no second client prompt. An accepted `wait_user`
proposal pauses/disarms that Goal, releases the original worker lease and saves
one pending interaction and a fenced checkpoint. Four scripted main calls plus
one scripted web call remain charged to that owner's original root; no task
answer is published. Private and public modules pass this local path on both
versions, including normal compressed storage/restart checks.

The local scripted user-response continuation also passes on both SDK versions
with the public modules. The original interaction API rejects a foreign owner
and replays an answer idempotently. The Worker restores the same Session and
Goal, preserves one occurrence and the complete original budget scope set, then
pauses for approval without publishing an answer. Five scripted main calls and
one scripted web call per owner remain cumulatively charged; fresh-process
checkpoint restoration makes no model call. Models and the empty preset remain
fixtures.

Separate local SDK scenarios on both versions and with the public modules now
exercise cancellation during an in-flight native round, budget exhaustion and
actual clock expiry. Cancellation passes through the original owner API,
command dispatcher, authenticated adapter and Controller; it releases the
Worker lease and pauses/disarms the Goal. The dispatched incomplete call keeps
an unknown-usage hold, while earlier settled costs remain charged. The command
does not replay and no subsequent tool or answer is published.

For exhaustion and expiry, the official driver admits one native round, then
the original root budget rejects the next admission. The Goal round limit is
two, so that limit is not what stops execution. The Worker retains a confirmed
checkpoint and a waiting state without inventing a user-input card. These two
tests deliberately control Runner observation timing to let the driver reach
its admission check first; they do not prove every production scheduling race.
Expiry occurs during an already-admitted scripted call, which finishes usage
settlement; subsequent admission is rejected. Providers, relay and the empty
preset remain fixtures. Interrupted storage recovery and real-model/production
autonomous operation still require their own acceptance.

Browser CSRF protection stays enabled. Only the three exact internal web budget
routes use their existing bearer/grant authorization instead of browser CSRF;
missing authorization is rejected. This separation does not exempt arbitrary
internal paths or browser mutations.

Local member execution checks also use the original Coordinator, Worker,
Runner and authenticated adapter HTTP. Two isolated owners each authorize one
member, which receives a distinct Session, writes a shared project file and
memory proposal, and returns one result through the durable mailbox. Both roles
share the original task-total budget. The lead retains an unpublished candidate
and the subtask still needs review. The test holds the scripted lead response
while the member runs; this controlled timing does not prove autonomous model
planning or upstream native Team/Handoff support.

Terminal publication releases the exact worker lease in the publication
transaction. A failed publication rolls back and preserves that retry lease;
late callbacks from a completed worker are fenced out. A running publication
retains its lease.

Acceptance must exercise the actual Session adapter, native HTTP/MCP bridge,
Python provider, and original gateway ledger together. It must cover parallel
run/owner isolation, provider-response loss, original-result recovery, tool
quiescence, cancellation, expiry, lease replacement, fallback and exhausted
root budgets. Local injected gateway tests prove the gateway boundary only.
They use synthetic worker leases and model routes, make no real model request,
and do not establish Controller, Python, resource attribution or production
acceptance.


## Fixed cross-host callback transport

`ticket_client` accepts only loopback HTTP and ignores environment proxies. When browser decisions run on a separate host, preserve that contract with a fixed SSH local-forwarding tunnel. The optional examples are `config-examples/web-budget-tunnel.service`, its `.env.example`, and `web-budget-sshd-match.conf`. They are templates, not installed or enabled services.

On the Gateway host, create a dedicated unprivileged relay account and authorize a dedicated application public key. It must have no password login, interactive shell session, agent forwarding or arbitrary destinations. Apply the Match policy only to that account: local forwarding is limited to `127.0.0.1:18831`. Review existing Match order, validate with `sshd -t`, and inspect effective settings with `sshd -T -C user=jot-budget-relay,host=example.invalid,addr=203.0.113.7` before reloading. A directory of drop-ins has no effect unless the main configuration includes it. Preserve a tested administrative connection and the exact original configuration for rollback.

On the decision host, generate a dedicated key under the service account and pin the Gateway host key through an already trusted channel. Keep the private key there with restricted permissions; do not copy a management key into this service. Configure the example with your private target, key and known-hosts file, and run the service as an unprivileged account. The service listens only on `127.0.0.1:18833` and forwards only to the Gateway loopback port. Use that fixed local origin in trusted host configuration. Neither a model argument nor ticket metadata may supply the destination. No public budget port is needed, and strict host checking must remain enabled.

Verify the complete route with an isolated owned run and short-lived grant. Check reserve, dispatch, response journaling, settlement, exact replay, changed-payload rejection, wrong-ticket rejection, and denial after lease replacement. Run the real MCP metadata boundary too; it must not add ticket fields to tool schemas. Check the original root ledger rather than creating another balance. Use synthetic provider results for transport tests and report them separately from real supplier usage or pricing. Tunnel reachability alone is insufficient for production readiness. A temporary relay through an operator workstation is suitable for a bounded test and cannot satisfy unattended server availability.

The regression `packages/gateway/test/vertical/web-budget-python-http.test.mjs` starts a real loopback Gateway HTTP server and invokes the optional Python client, including replay and replacement-lease denial. It uses synthetic usage and never calls an external model. Run with Python 3.11+ and Node 24+; `JOT_PYTHON` can select your interpreter.


Startup failures close the opened database and Fastify instance before rethrowing the original error. The startup-cleanup regression uses a real SQLite file; it does not simulate closure with a no-op database.

Conversation supplements are accepted for queued, starting and running runs with the current run version. They remain durable pending commands until the existing Session can receive them. Repeating the same command key returns the original command, and an accepted supplement does not create another run. Cancellation and terminal-state checks remain in force. The command-dispatcher regression verifies that the startup window holds the supplement and delivers it once when ready.


### Tunnel acceptance and rollback

Treat application identities and long-running forwarding services as explicit deployment changes. Keep the original SSH configuration and its hash, the installed configuration hash, and the created-file/account inventory in a private deployment record. Generate the application private key on the decision host and transfer only its public key. Obtain the Gateway host public key through an already authenticated management connection. Do not use an unverified network key scan as trust establishment.

After deployment, verify each boundary independently:

1. Open a fresh administrative connection and compare its effective SSH policy with the saved original. A successful existing connection is insufficient.
2. Confirm the forwarding listener binds only loopback, then check the intended Gateway health route through it. This proves connectivity, not budget accounting.
3. With the same application identity, try a different forwarding destination and require an explicit administrative-policy denial. Authentication failure does not prove destination confinement.
4. Try a harmless interactive command and verify that it cannot execute. A `nologin` shell may emit its standard unavailable-account message; do not require empty stdout or count that message as successful command execution.
5. Terminate only the dedicated tunnel's main process. Check that the service restarts with a new PID and the original fixed target becomes reachable again.
6. Stop only the dedicated tunnel and run a bound budget-client probe with a synthetic provider callback. Require a budget failure and zero callback invocations. Restore the service in `finally`, and verify it is enabled and healthy. Do not release an already dispatched model hold merely because the network is unavailable.
7. Separately verify an owned run with a real budget grant and the original root ledger. Include exact replay, changed-payload denial, replacement-lease denial and provider usage settlement. The preceding tunnel checks do not substitute for this test.

For rollback, first disable the dedicated tunnel and remove its application key authorization. Restore the saved SSH configuration only when the current hash still matches the recorded installed version; if it has drifted, preserve both versions and reconcile the change instead of overwriting someone else's configuration. Validate syntax and scoped effective policy before reloading, then verify a fresh administrative connection. Remove only the specifically recorded new account and files. Never reuse a management private key or recursively delete an inferred home directory as part of cleanup.


## Dynamic model aliases

A budget route cannot safely stand for an alias that chooses a different supplier on each request. Use a separate immutable provider/model route for budgeted tasks. The optional Python [route-pin guard](packages/web-decision/README.md#optional-model-route-pins) supplies manifest fingerprints and bounded wire model names for host integrations. The actual proxy integration must require the pin for its reserved wire namespace, verify it before reading supplier credentials, and convert the validated wire model into the manifest's real model. Ordinary dynamic aliases may remain available for unbudgeted chat. This helper does not automatically modify a proxy, SDK profile, preset or Gateway rate policy, and its unit tests do not establish production billing coverage.
