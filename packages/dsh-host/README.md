# Official DSH host profile

This prepares a dedicated profile for the official DSH **0.2.1-rc.2** launcher.
The launcher supplies real Session, JSONL persistence, workspace, upload,
permissions, model and Web services through `dsh-base` + `dsh-web-app`.
The Jot adapter remains a plugin in that host. It is not a replacement Agent loop.
The `deepseek-flash` alias currently selects official V4.1-Flash-1017. Keep the
existing `high` reasoning effort when configuring the official model provider;
the SDK upgrade preserves native Session, Goal, permission and budget controls.

## Upgrade boundary

The lock pins the explicitly published `0.2.1-rc.2` release; the npm `latest`
tag can still name an older release. See the [official release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
and [official model catalog](https://api-docs.deepseek.com/quick_start/pricing/).
The alias is `deepseek-flash`, not a guessed dated model ID. Its SDK default
output allowance remains 256,000 tokens; the provider's advertised maximum is a
different setting, not an instruction to increase every request.

Prepare a separate profile and retain the previous installation and a stopped,
consistent copy of native histories before changing an existing runtime. The new
SDK has Session format migration; an inspection reporting migration required is
not proof of an empty inbox or an absent Goal. Do not reseal prior replay-profile
fingerprints or clear unknown usage while upgrading. Exact existing Sessions
resume through the original resolver instead of conversation creation, which may
mint a new identity for a nonblank Session in this SDK.

Optional memory extraction keeps its separately audited runtime and plugin pins.
Changing the main Host must not silently repoint its `modulesRoot`, skip its
integrity check or mark an untested plugin combination ready. Local SDK fixtures
with scripted model transport prove wiring; they do not prove production rollout
or remote-provider quality.

## Windows startup

Use a private installation directory outside the Agent workspace and Git checkout.
In PowerShell, replace the example absolute paths with your own paths:

```powershell
$env:DSH_HOME = 'D:/private/jot-host'
node packages/dsh-host/create-profile.mjs $env:DSH_HOME jot
Set-Location "$env:DSH_HOME/profiles/jot"
npm ci
```

The preparation command refuses an existing profile, installs nothing, reads no
credentials and starts no services. It copies the reviewed `runtime-package-lock.json`
as `package-lock.json`: the complete dependency graph is fixed, rather than
resolving transitive ranges again on each installation. All dependency entries
use the npm registry, carry SHA-512 integrity and contain no local file links.
Keep that lock unchanged for repeatable installs. Native installation scripts,
optional platform packages and the resulting binaries still depend on the target
OS and must be checked there; the lock is not a binary-release attestation.
Writes are exclusive but not a multi-file transaction. If preparation fails,
inspect the partial dedicated profile before manually removing/recreating it;
do not delete an existing operator profile blindly. The script does not set or
audit operating-system ACLs. Apply and verify private directory ownership on the
target host before using credentials or user data.
The generated configuration references this checkout's adapter and preset module
by absolute file URL. Keep that reviewed checkout at the same location, or prepare
a new profile for the new release. Do not move the checkout under a writable
Agent workspace or silently repoint a running profile.

Before launch, privately set `JOT_SESSION_ADAPTER_TOKEN` to a fresh random value
of at least 32 characters and configure your model credentials. The official
DeepSeek API-key provider reads `DEEPSEEK_API_KEY`; DSH also supports its own
credential store and additional providers. Never put credentials in a committed
profile, command argument, screenshot or issue. Put the same adapter token in the
gateway's private token file. See the [adapter contract](../session-adapter/README.md).

From the directory where Agents should work, run the installed **official** CLI:

```powershell
Set-Location 'D:/workspaces/jot'
& "$env:DSH_HOME/profiles/jot/node_modules/.bin/dsh.cmd" --profile jot --host 127.0.0.1 --port 18842 --no-open
```

On Linux/macOS the equivalent executable is
`$DSH_HOME/profiles/jot/node_modules/.bin/dsh`. Set/export `DSH_HOME` in that
process's environment as well. The working directory is deliberate; it is not
the profile directory. Session requests may specify their own absolute workspace.

- `18842`: official DSH Web UI, with its original operator authentication.
- `18841`: authenticated loopback Jot adapter; gateway API/worker connect here.
- `18831`: optional gateway callback origin; a separate internal token is required.

Do not expose either host listener directly to remote users. The Web UI prints
an operator login URL at startup; treat that URL and captured startup logs as
private. The official launcher owns signal handling and persistence shutdown.

## Preset and default policy

`jot-general` reuses the installed official `standard` declaration, including its
planning, compaction, delegation and platform-specific tool groups. It resolves
that declaration from the launcher's installation anchor, not a second SDK in the
Jot checkout. Registry audit must succeed before `jotHostReady` is provided and
the Jot adapter is allowed to activate. Session creation verifies that the
requested preset actually exists; an authenticated port alone is not acceptance.

The profile defaults to `workspace-write` + `ask`, keeps native application opening off,
and disables auxiliary model-generated titles, module HMR and DSH session-log /
session-telemetry contributors. It does not replace the official tool permissions
or create an unrestricted shell. Additional operator/home patches can change the
effective composition, so review `dsh --profile jot --dump-config` privately before
launch. Configuration dumps are trusted-code operations, not a sandbox.

These are defaults, not a prohibition on the authenticated operator changing
permissions. The original permission choices, including Full Access, remain
available. Only server module HMR is disabled; the official client rebuild
listener remains. Native application opening and the directory picker are
separate: the official picker may use a native dialog for a local Windows
operator. Neither setting grants an Agent permission to open applications.

Voice, native continuation, native roles, web budget and claimed-input recovery
are not enabled in the default profile. Configure their real backend contracts and run
their acceptance tests before opting in. This profile does not implement a new
browser/search server or automatically register private tool backends. Its
official `web` tool is distinct from an operator's external batch/browser service.

## Opt in to Workbench roles and persistent tasks

Prepare a **new**, dedicated profile with a private route file as the third
argument. The file accepts only `provider`, `model` and an optional HTTP loopback
`origin`; it must contain no credentials:

```json
{"provider":"deepseek-official","model":"deepseek-flash","origin":"http://127.0.0.1:18831"}
```

Treat this file, checkout and generated profile as trusted operator configuration:
only the service operator may write them. The configured loopback origin receives
the internal Bearer credential; loopback alone does not authenticate the listener.
Approve its port and process ownership before launch. Never accept this file or
its path from an Agent, web request or another untrusted user.

```powershell
node packages/dsh-host/create-profile.mjs $env:DSH_HOME jot-workbench 'D:/private/workbench-route.json'
```

Launch with `--profile jot-workbench` after installing its lock with `npm ci`.
This explicit option registers `jot-workbench-budgeted` alongside `jot-general`,
pins the trusted Workbench model route and enables the adapter's native Goal
continuation bridge. Both presets reuse the full official standard declaration.
It does **not** enable native Team/role-child dispatch, web budget, voice or
claimed-input recovery. A saved Gateway role is distinct from a native Team child.
The original DSH planner, permissions and tool lifecycle remain in charge.
The existing authenticated Workbench context bridge remains configured in the
default profile; default-off refers to the budgeted preset/model binding and
native continuation, not removal of that bridge.

The Gateway API, worker and host must share the same fresh, private
`GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN`, independent of the adapter token and model
credential. Configure the actual budget policy file on both API and worker, with
the same route as the host. Worker settings also include:

```powershell
$env:GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE = 'D:/private/budget-policy.json'
$env:GENERAL_AGENT_WORKBENCH_EXECUTION_READY = 'true'
$env:GENERAL_AGENT_WORKER_CONCURRENCY = '2'
$env:GENERAL_AGENT_WORKBENCH_DSH_AGENT_PRESET = 'jot-workbench-budgeted'
```

Use the existing [Gateway deployment guide](../gateway/README.md) for API and
worker startup and budget-policy schema. Readiness is an operator declaration
after configuring the backend, not something the preparation script proves.
Without it, the original worker admission gate leaves Workbench-bound runs queued.
Retain owner, capability epoch, lease and budget checks; do not remove those gates
to get a run started. An unlimited monetary cap is represented by
`limits.nano_usd: null`; actual and reserved usage must still be nonnegative
integer strings. Token and call limits remain independently enforced.

## Verification and remaining acceptance

```powershell
Set-Location packages/dsh-host
npm test
```

Preparation tests run without installing DSH. For the real launcher canary, set
`JOT_DSH_RUNTIME_MODULES` to the absolute installed `node_modules/@deepseek-ai`
directory and run the same tests. The Gateway/Worker case also requires the
Gateway dependencies (`npm ci --prefix packages/gateway` from the repository root).
The canary creates a temporary independent
home/workspace, launches the original CLI on isolated loopback ports, creates a
real `jot-general` Session, uploads synthetic text through the official upload
service and verifies unauthenticated requests fail. A test-only observer reads
the actual Agent mount, visible file tools, effective sandbox/approval preset
and Session model selection from the original services. It never sends a model prompt.
An unset SDK path skips that canary and must not be reported as full acceptance.
Set `TEMP`/`TMP` to an appropriate private scratch directory if needed. Failed
startup diagnostics, including the synthetic Web login URL, remain there;
successful runs remove their temporary data after terminating their own process.

The second integration case starts the real Gateway API and harness worker,
keeps the original DSH Messages provider and sends one ordinary conversation
through a loopback **synthetic model HTTP endpoint**. It checks one HTTP model
request, one committed reply, the original native completed event, actual Agent
permissions/route and idempotent message retry. The host plugin package carries
an explicit version because the official DeepSeek request inventory requires
both name and version for every named active package; missing metadata rejects
the request before HTTP dispatch. No inventory/permission checks are bypassed.

Additional cases use the explicit Workbench profile to run a saved role and a
persistent task through the same real services and synthetic model transport.
The role checks one settled budget attempt and an idempotent retry after success.
The task invokes the real workspace tool to request user input: the original
Goal becomes paused/disarmed, the worker records a durable checkpoint and pending
interaction, and Gateway reports `waiting_user`. Native `turn/end` reports the
expected `workbench_goal_stopped` guard error; it is not claimed as a completed
native turn or successful business delivery. Intermediate text stays provisional
in the public snapshot rather than being marked as a completed reply. Usage is
settled before a safe wait is accepted, and retry does not launch another run.

Further cases exercise input and review replies, the original native Goal driver,
and a complete file task. Input and review replies create one continuation per
confirmed answer, keep the same occurrence and Goal, preserve cumulative budget
and do not replay the original request. Duplicate answers return the same receipt.
The automatic case arms the original driver, crosses a completed native turn and
observes another native round without another Gateway run or competing prompt.

The file case actually writes `acceptance.md` through the workspace tool. The
scripted model consumes the returned execution receipt to complete its criterion
and requests business review with a logical workspace file declaration. Before owner acceptance there is no published
answer or business certificate; a foreign owner and an untrusted Origin cannot
approve it. After the owner accepts the frozen criterion, the original worker
completion pump records native Goal completion and publishes exactly one answer,
without another model call or task run. The final message contains one owned
Artifact attachment; downloading it returns the exact reviewed version and hash,
even after a later owner edit replaces the logical file. A foreign owner cannot
download it. These checks use real file/receipt,
checkpoint, review and completion services, not fabricated native proofs.

This proves the synthetic task's local lifecycle, not external provider quality,
arbitrary business correctness or native Team dispatch in this host profile.
The tests enable none of these options on a deployment. Gateway Origin/CSRF and
idempotency middleware are enabled, but the fixture uses a synthetic owner header
inside its private loopback boundary; production identity-proxy authentication
and a real browser session are not exercised.

Passing these cases proves the local official composition, upload, ordinary chat,
saved-role execution and the synthetic persistent tasks' wait, resume, automatic
round and reviewed workspace-file attachment delivery. Writing a workspace file
alone still does not publish it: the declaration, evidence, owner acceptance and
native completion gates all apply. These cases do not prove real model inference, external tools,
notification delivery, target-machine ACLs or power-loss durability. Full
claimed-input recovery additionally requires a reviewed immutable release
manifest, actual loaded source / permissions / model-route validation and
host-only provenance storage. The preparation script does not sign or approve a
release, and installing an exact package version is not that approval.

DSH and its standard declaration remain upstream MIT-licensed components;
Jot's profile integration does not claim authorship of them.

The isolated `test/cold-goal.test.mjs` additionally creates and pauses a native
Goal, restarts the actual Host, then reads its persisted state through the
adapter. It checks that the ID/revision/phase survive, activation is disarmed,
and no Agent or model call is created by the read. It uses no provider credentials.
This is restart/read acceptance, not a cold resume-control or power-loss test.

`test/cold-goal-controls.test.mjs` uses the same actual launcher with isolated
synthetic Sessions to pause a cold Goal, clear both active and paused Goals, and
verify durable results after another restart. Competing CAS operations admit only
one change; parked input is refused before activation, with zero model calls.
Cold control inspects official history and uses the ordinary resolver plus native
maintenance; the Host-only turn-boundary projection is not a wire contract.
This does not prove cold resume, crash-window control receipt recovery, actual
provider quality or production deployment acceptance.

Set `JOT_HOST_DIAGNOSTIC_DIR` to an untracked private directory to retain startup
failure diagnostics. The probes otherwise clean up their temporary profiles.

`chat-preset.mjs` is a separate read-only composition built from the installed
official persona and Web modules. It masks inherited Work capabilities and
denies non-Web execution; the Work preset keeps its complete original tree.
It is not automatically installed by the profile generator. Actual Host tests
verify the two Web schemas and a thinking-disabled Messages request through the
original Gateway/Worker path. Bounded context, durable turn allowances and native
post-answer compaction now have opt-in implementations and scripted-provider
SDK acceptance. Native mode readiness defaults off; explicit trusted
`ordinaryChatModeReadiness` requires the matching mounted Chat preset, original
model/input admission, bounded context and read-only Web composition. See
[actual UI/BFF/Gateway/SDK composition and remaining gates](../../docs/implementation/2026-10-19-chat-native-composition.md).
This configured capability is not external-provider authentication or production
acceptance. Standalone and extended interfaces have distinct tested protocols;
real-provider and the complete portability gates remain open;
[configuration and evidence](../../docs/implementation/2026-10-18-native-chat-preset.md)
distinguish these boundaries from a complete Chat feature.

Automatic post-answer maintenance additionally requires
`ordinaryChatCompactionAuto: true`, the existing original compaction/context
composition and `ordinaryChatCompactionRecovery: true`. The Worker independently
requires `GENERAL_AGENT_CHAT_COMPACTION_AUTO_ENABLED=true`, Chat, original input
recovery and steering. Defaults remain off. A trusted notification carries only
original owned history scope after canonical publication; it is not a public
tool, foreground lease or automatic startup scan. Notification acceptance is not
successful inference. See [automatic execution and limits](../../docs/implementation/2026-10-19-chat-automatic-post-answer.md).

### Work compaction visibility

The paired Gateway/UI can opt into explicit native Work compaction metadata with
`GENERAL_AGENT_WORK_COMPACTION_PROJECTION_ENABLED=true`; the default is false.
It requires an accepted Work execution policy and upgraded activity consumers.
It never displays native summary text or enables Chat background activities.
See [the native lifecycle and acceptance record](../../docs/implementation/2026-10-19-work-native-compaction-ui.md).
