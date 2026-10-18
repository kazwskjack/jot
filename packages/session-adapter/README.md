# Jot DSH Session adapter

`chat-compaction-pressure.js` provides a read-only effective-request pressure
inspection prerequisite for Chat maintenance. It uses the host's official token
meter, exact routed model metadata and explicitly resolved host policy. Low
pressure, unavailable capacity or changing state quietly skips. A `needed`
result is advisory with `execution_authorized: false`; it is neither native
completion/idle proof nor a model grant. It is not wired into execution or an
HTTP endpoint. Background inference, independent accounting, cancellation and
checkpoint handoff remain pending in the [Chat/Work plan](../../docs/superpowers/plans/2026-10-18-portable-chat-work.md).

A Cordis plugin that connects the extended Jot gateway to an existing DSH Session Controller. It is not a standalone model server and cannot be launched with `node index.js` to create a complete runtime.

## Host requirements

The package declares these peer dependencies:

- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/dsh-api-session-controller` `0.1.7-alpha.2`, `0.2.0-rc.2`, or `0.2.1-rc.2`

The host must provide `sessionController`, `fileUploads`, `agents`, `sessions` and `sessionPersistence`. When voice is enabled it must also provide `speechController` and a configured speech provider. These services, model credentials, Agent presets and actual tool backends are configured in the host; copying this directory does not create them.

Install the package in the host's dependency environment, import its `apply` function and register it through the host's Cordis plugin loader. A generic registration shape is:

```js
import * as jotSessionAdapter from '/absolute/path/to/jot/packages/session-adapter/index.js'

// hostContext already owns the required DSH services.
hostContext.plugin(jotSessionAdapter, {
  host: '127.0.0.1',
  port: 18841,
  tokenEnv: 'JOT_SESSION_ADAPTER_TOKEN',
  voiceEnabled: false,
})
```

This is the plugin registration boundary. For a dedicated host using the official DSH launcher and real services, follow the [host profile preparation and startup guide](../dsh-host/README.md). Set the private `JOT_SESSION_ADAPTER_TOKEN` environment value before the host starts. This is also the plugin's default token environment name. Use a fresh random token of at least 32 characters. Put the identical value in the worker's private token file and point `GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE` at it. Do not commit either value.

Only loopback binding is accepted. Port defaults to `18841`. Gateway and host should share the same private machine/network namespace, or use a deliberate loopback tunnel; the gateway client rejects public adapter URLs. The adapter only accepts authenticated POST requests and has no public health endpoint.

## Persistent-task bridge configuration

The registration example above enables the Session transport. Persistent task
tools and budget callbacks also require a separately configured internal gateway
token in the host environment. Configure `workbenchTokenEnv` explicitly, point
`workbenchOrigin` at your gateway's HTTP loopback origin, and give the gateway the
same private internal token. The token must contain at least 16 characters. This
is distinct from the adapter token used by the gateway to contact this plugin.

| Plugin setting | Default | Effect |
| --- | --- | --- |
| `workbenchOrigin` | `http://127.0.0.1:18831` | Internal gateway callback origin; only HTTP loopback origins are accepted |
| `workbenchTokenEnv` | `GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN` | Name of the host environment variable holding the internal gateway token |
| `nativeContinuation` | `false` | Enable the existing host-native Goal continuation bridge after host validation |
| `webBudgetEnabled` | `false` | Bind supported native tool calls to the gateway's original budget context |

An absent internal token leaves the workbench bridge uninstalled. Either boolean
set to `true` without the token rejects plugin startup; setting a flag alone does
not install tools, a model, a preset or a remote budget callback service. For
separate machines, provide and verify an authenticated loopback tunnel rather
than substituting a public callback URL. External tool backends must preserve the
original budget identity and settle their actual reported usage.

Validate an owned role task, its workspace tools, user-response continuation,
cancellation and checkpoint recovery before enabling native continuation in a
deployment. Local checks with installed DSH versions and scripted providers do
not establish compatibility of your configured model or production preset. The
declared peer version above remains the package installation contract.

## Protocol

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/sessions` | Create a session with a host-native absolute `cwd` and an allowed preset |
| `POST /v1/sessions/{id}/prompts` | Send text, image or file receipt content; queue or steer |
| `POST /v1/sessions/{id}/follow` | Follow host messages as NDJSON; default 50, capped at 200 |
| `POST /v1/sessions/{id}/cancel` | Ask the host to cancel, then wait for idle; a detached host reports no live turn |
| `POST /v1/sessions/{id}/files` | Stage a file and return the host's receipt |
| `POST /v1/voice/*` | Speech operations, only when enabled in the host |

Allowed presets are `jot-general`, `jot-general-batch50` and `jot-general-batch`. Register them and their tool permissions in the host. Being in this allow-list is not proof a preset exists or that a batch browser service is available.

On Windows, use an absolute drive path; on Linux, use an absolute Linux path.
The adapter preserves that path for the original Controller. Relative paths,
drive-relative paths, embedded NUL and non-string values are rejected. If a
previous checkout used a different default token environment name, set
`tokenEnv` explicitly or migrate to the documented `JOT_SESSION_ADAPTER_TOKEN`.

File/image receipts are session-scoped. Browser clients must use gateway conversation IDs rather than internal session IDs. The gateway performs owner checks; this trusted internal adapter receives host session IDs and must never be exposed directly to browsers.

## Voice

Keep `voiceEnabled: false` until the speech service is configured and inspected. Enabling the gateway's voice flag alone is insufficient. The gateway accepts at most 60 seconds / 2 MiB of WAV PCM mono 16 kHz 16-bit audio, obtains capability/provider readiness from the adapter and returns a transcription draft; it does not silently turn that draft into a sent chat message.

Run the included voice protocol tests with:

```sh
node --test voice.test.mjs
```

Mocked protocol tests do not establish that a real model, speech provider or browser action works in your host. Validate the complete chain after installing your providers.

## Runtime compatibility

The peer range includes the legacy `0.1.7-alpha.2` and `0.2.0-rc.2` controllers
alongside the current `0.2.1-rc.2` controller. This is not a promise of identical features: budgeted
role execution requires the newer Session-local model selection and native
goal/checkpoint capabilities. The adapter checks those capabilities and fails
closed when they are missing. Do not enable budgeted tasks solely because the
package manager accepts the peer version.

When a profile declares explicit dependency injection, include
`sessionController`, `fileUploads`, `agents`, `sessions`, `sessionPersistence`, `sessionProjections`
and `llm` for the complete budgeted adapter. Preserve the existing host, port,
authentication environment reference and ordinary provider configuration.
Compose the complete profile with the installed SDK before restarting it.

## Optional native roles and Goal controls

See [Native role integration](../../NATIVE_ROLES.md) for host requirements, default-off flags, durable publication and cold activation. The ordinary native Goal control endpoint is authenticated and revision checked. Native Team support requires the newer host APIs; the older transport peer version is not a Team compatibility claim.

For the tested final-return Inbox ordering, use the optional trusted
`nativeHandoff: { policyVersion, maxHops, validateLog }` composition. It creates
one shared gate for admission, return and recovery with the actual native
services. Do not mix it with manual handoff callbacks. This is a server-side
opt-in and does not activate a production profile or select successor roles.

The package also exports `createNativeClaimedInputRecoverySetup` for an audited
host's official pre-publication resume setup. It restores eligible original
Inbox input after a crash, using SessionQuery and the native projection;
mandatory host authorization and pre-step replay-safety checks remain external.
It does not wake execution or install itself in the default HTTP Controller.
See the recovery boundary and subprocess evidence in [Native roles](../../NATIVE_ROLES.md).

An audited host can opt into formal Controller composition using
`nativeClaimedInputRecovery: {Session, validateLog, profile, provenance}`.
It also requires native continuation, a configured budget model and authenticated
Workbench access. Include `agentLoop` and `sessionQuery` in explicit host injection.
This option requires the separately prepared rc.2 compatibility copy described
in [Native roles](../../NATIVE_ROLES.md#formal-controller-claimed-input-recovery).
It is absent by default; enabling it without hook protocol 2 fails at startup.
The profile callback receives `{agent, phase}` for both `prepared` and `bound`
checks. Validate the actual mounted Registry generation in the second phase;
pre-reading a source file alone is insufficient. Regenerate an isolated copy
from the pinned original package rather than updating an existing protocol 1
copy in place. Source receipt migration remains explicit and unimplemented.


The package includes an optional pending-input wake compatibility transform for
the exact locked rc.2 SDK. Preparation requires `--pending-input-wake` and writes
a new package; normal preparation remains unchanged. This is a Jot extension,
not an upstream API. It latches existing exact-RPC inputs behind native
maintenance without a new prompt or inbox mutation. The default HTTP Controller
does not invoke it. Original product ownership, execution/composition authority,
cancellation and usage recovery remain required; see
[Goal continuation](../../docs/GOAL-CONTINUATION.md#optional-native-pending-input-wake-compatibility).

## Explicit pending input binding compatibility

Newly prepared optional compatibility copies advertise
`pendingInputBindingsProtocol: 1` in their manifest and expose
`jotPendingInputBindingsProtocol: 1` plus `jotResumePendingInputs`. The original
single-RPC `jotResumePending` contract is unchanged. The new entry requires one
exact ordered `{messageId, requestId}` pair per existing human inbox message,
with no duplicates, missing/extra identities or unknown fields. Native
maintenance, current sequence, non-aborted state and absence of another wake
are still mandatory. It appends no input or history and retains the same fresh
local Symbol token and exact-token revocation semantics.

This is a Jot compatibility extension to the pinned installed MIT-licensed
runtime, not an upstream API or execution authorization. Preparation writes a
new isolated package and refuses overwrite; an earlier patched copy is not
silently upgraded. Hosts still need per-command product/admission proofs before
using this capability. The ordinary cold recovery path has not yet been wired
to it. No production package is modified by these local tests.

The opt-in ordinary steering configuration also requires this Adapter's
`POST /v1/sessions/:id/input-completion` inspection and the matching Runner's
completion capability. The endpoint accepts only original execution metadata
and command IDs; it returns IDs/hashes and busy/completed observations, no user
text or execution grant. It does not create/wake an Agent or change admissions.
Keep the switch off until the matching stack and rollout gates are accepted.

Private ordinary admission storage exposes `entryInspectionProtocol: 1` and
`inspectEntry({session,runId,messageId,signal})` for historical observation.
Reads require existing storage and never create a directory. The result contains
the exact admission digest and a validated reservation or observed absence,
always with `execution_authorized: false`. Absence does not grant replay; a
reservation does not prove provider dispatch, completion or cost. Original
admission/replay/reservation guards remain authoritative and unchanged. This
storage API alone does not repair historical product acknowledgement or delivery.

`ordinary-steering-observation.js` provides an isolated
`createOrdinarySteeringObservationReader` factory. It verifies terminal product
scope before opening the original raw persistence handle, joins exact immutable
original/command admissions and reservation observations, then re-reads raw and
product sources. It refuses attached execution in this Host. Its hash-only facts
distinguish historically admitted input from committed native input; an answer
observation requires a real persisted completed turn. Missing input is unproven,
never safe to resend. A reported historical profile fingerprint is not current
replay compatibility. This factory does not register an HTTP/MCP tool or perform
ACK repair, final publication, replay, Agent activation or billing settlement.

The Adapter can explicitly expose this reader through trusted Host configuration
`ordinaryInputHistory: {Session, validateLog}`. Use the installed official Session
class and the existing detached invariant validator; the original private
`ordinaryInputAdmission` store must support `entryInspectionProtocol: 1`. Omit
this option to keep history unavailable. It does not enable ordinary replay or
steering and does not require arming a Goal.

With the existing Adapter bearer token, `POST /v1/ordinary-input-history/readiness`
accepts `{}` and returns `{ready, protocol: 1, execution_authorized: false}`.
`POST /v1/sessions/:id/steering-history` accepts only
`{history:{owner_id,conversation_id,run_id,command_id,expected_run_version}}`.
Session identity comes from the path. No content, old lease or requested action
is accepted. Per-call product/native verification is mandatory even when ready.
Unavailable configuration returns 503; an unconfirmed scope/snapshot returns a
generic 409, without private diagnostic text. The Gateway's
`SessionControllerClient.observeSteeringHistory` validates this exact request and
the returned hashes, identity, nullable facts and sequence bounds. No public
browser/MCP route or automatic reconciliation consumer is enabled by this API.

Protocol 2 is separate: `POST /v1/sessions/:id/steering-history-v2` accepts only
`{history, source_sha256}`. The Gateway derives the digest from the complete
current product-source record using recursively sorted JSON keys. The Host
checks it before raw history access and again rechecks the source afterward.
The response has protocol 2 and the same digest, still with
`execution_authorized: false`. Legacy protocol 1 remains unchanged and cannot be
upgraded into bound evidence. Gateway `observeBoundSteeringHistory` validates
this version explicitly. These facts may support acceptance-only reconciliation
under a separate product transaction; they never authorize native replay,
driver activation, final-answer publication or monetary settlement.

### Full ordinary historical completion transport

An independent trusted `ordinaryRunHistory: {Session, validateLog}` kit enables
only the new reader. It also requires the existing immutable admission store,
the official `sessionProjections.snapshot` service and the internal product
bridge. It is absent by default and does not arm Goal/recovery or publish.
Bearer POST `/v1/ordinary-run-history/readiness` accepts `{}` and returns
`{ready,protocol:1,execution_authorized:false}`.
POST `/v1/sessions/:id/run-history-completion` accepts exactly
`{history:{owner_id,conversation_id,run_id,expected_run_version},source_sha256}`.
The digest binds the entire `ordinary_run_history` product record. Text,
commands, execution leases and actions in the request are rejected. Disabled
configuration is 503; unconfirmed source/native state is a generic 409.

The result is protocol 1 of `ordinary_run_completion`, not a per-command
steering observation. It contains the exact command/native-message coverage,
source/native provenance and scoped native answer/output events for Gateway's
shared output interpreter. These events are private internal data, not public
logs or execution authorization. Gateway `observeRunCompletion` accepts the
caller-held full product snapshot, derives its digest and validates identity,
version, complete command order, unique native IDs, answer text hash and output
sequence/type bounds. Rechecking output ownership/integrity and source inside a
publication transaction remains necessary. No canonical writer or automatic
consumer is enabled here; unknown usage and money remain unchanged.

Product runtime cursors use the Worker's existing deterministic
`runtime-session-<run hash>` identity, independently of the DSH controller
Session in `ga_harness_session_bindings`. A shared mapping now prevents the
history source from confusing those identities. A controller ID substituted
into the runtime binding is refused rather than treated as an alias.

Compatibility preparation accepts only the separately audited `0.2.0-rc.2` and `0.2.1-rc.2` AgentLoop artifacts, with one exact file manifest per version. Installed-SDK verification targets `0.2.1-rc.2`; the older artifact remains available for explicit compatibility and rollback checks. Memory extraction retains its separately pinned plugin/SDK runtime until that composition is independently verified.

### Optional original-run model policy

`ordinaryModelSelection: true` requires the existing `ordinaryInputAdmission`
store/profile and internal product bridge. It applies the original accepted
run's frozen model/effort through official resolution and Session-local
selection before prompt assembly. Exact original ownership and live lease
checks remain required. Steering and recovery reuse the original policy;
legacy runs without a snapshot are refused, never guessed from current
conversation metadata. Generated profiles keep the option off.

The same opt-in enables the detached bearer-authenticated `POST /v1/models`
catalog (`{}` only). Metadata is advisory and never grants execution; missing
readiness or failed resolution is not a reason to fall back silently to a
different model. See [activation, evidence and limitations](../../docs/implementation/2026-10-18-native-model-policy.md).

An optional `ordinaryExecutionPolicy` trusted Chat declaration additionally
checks the original execution-policy bridge, native preset and policy digests.
Chat selects the official `off` effort, yielding a real thinking-disabled
request; it cannot fall through to a Work/default route. The option requires
`ordinaryModelSelection` and original input admission. It does not expose
general Chat readiness or implement turn allowances/context compaction. See
[native Chat boundaries and actual Host evidence](../../docs/implementation/2026-10-18-native-chat-preset.md).

`ordinaryChatContext: true` optionally consumes the original run's immutable,
owned text window through the official Session surface API. It requires the
trusted execution policy and original model/admission configuration above.
The first batch preserves native system-prompt order; subsequent inputs replace
only the model-facing conversation body and retain stored transcript events.
It remains default-off and does not enable general Chat readiness. See
[bounds, retry/reopen behavior and actual SDK/Host evidence](../../docs/implementation/2026-10-18-chat-context-window.md).

`ordinaryChatWeb: true` additionally requires the trusted Chat declaration,
original input/model admission and `ordinaryChatContext: true`. It derives
search/fetch groups from committed native assistant steps and consumes each
call in the Gateway before the official provider executes. Steering, lost
acknowledgements and replacement leases do not reset the original run's
allowance. A fresh/restored Chat agent refuses Web effects until its original
binding is confirmed. Work and provider selection remain unchanged. See
[semantics, uncertainty and actual Host evidence](../../docs/implementation/2026-10-18-chat-web-allowances.md).
