# Jot DSH Session adapter

A Cordis plugin that connects the extended Jot gateway to an existing DSH Session Controller. It is not a standalone model server and cannot be launched with `node index.js` to create a complete runtime.

## Host requirements

The package declares these peer dependencies:

- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/dsh-api-session-controller` `0.1.7-alpha.2` or `0.2.0-rc.2`

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

This is the plugin registration boundary, not a complete DSH host bootstrap. Set the private `JOT_SESSION_ADAPTER_TOKEN` environment value before the host starts. This is also the plugin's default token environment name. Use a fresh random token of at least 32 characters. Put the identical value in the worker's private token file and point `GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE` at it. Do not commit either value.

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

The peer range includes the legacy `0.1.7-alpha.2` controller and the
`0.2.0-rc.2` controller. This is not a promise of identical features: budgeted
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
It is absent by default; enabling it on an unpatched runtime fails at startup.
