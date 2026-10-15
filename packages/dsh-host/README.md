# Official DSH host profile

This prepares a dedicated profile for the official DSH **0.2.0-rc.2** launcher.
The launcher supplies real Session, JSONL persistence, workspace, upload,
permissions, model and Web services through `dsh-base` + `dsh-web-app`.
The Jot adapter remains a plugin in that host. It is not a replacement Agent loop.

## Windows startup

Use a private installation directory outside the Agent workspace and Git checkout.
In PowerShell, replace the example absolute paths with your own paths:

```powershell
$env:DSH_HOME = 'D:/private/jot-host'
node packages/dsh-host/create-profile.mjs $env:DSH_HOME jot
Set-Location "$env:DSH_HOME/profiles/jot"
npm install
```

The preparation command refuses an existing profile, installs nothing, reads no
credentials and starts no services. Keep the generated `package-lock.json` for
your reviewed installation; use `npm ci` on subsequent deployments of that lock.
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
are not automatically enabled. Configure their real backend contracts and run
their acceptance tests before opting in. This profile does not implement a new
browser/search server or automatically register private tool backends. Its
official `web` tool is distinct from an operator's external batch/browser service.

## Verification and remaining acceptance

```powershell
Set-Location packages/dsh-host
npm test
```

Preparation tests run without installing DSH. For the real launcher canary, set
`JOT_DSH_RUNTIME_MODULES` to the absolute installed `node_modules/@deepseek-ai`
directory and run the same tests. The canary creates a temporary independent
home/workspace, launches the original CLI on isolated loopback ports, creates a
real `jot-general` Session, uploads synthetic text through the official upload
service and verifies unauthenticated requests fail. A test-only observer reads
the actual Agent mount, visible file tools, effective sandbox/approval preset
and Session model selection from the original services. It never sends a model prompt.
An unset SDK path skips that canary and must not be reported as full acceptance.
Set `TEMP`/`TMP` to an appropriate private scratch directory if needed. Failed
startup diagnostics, including the synthetic Web login URL, remain there;
successful runs remove their temporary data after terminating their own process.

Passing that canary proves this local official composition and upload path. It
does not prove real model inference, external tools, Gateway task execution,
notification delivery, target-machine ACLs or power-loss durability. Full
claimed-input recovery additionally requires a reviewed immutable release
manifest, actual loaded source / permissions / model-route validation and
host-only provenance storage. The preparation script does not sign or approve a
release, and installing an exact package version is not that approval.

DSH and its standard declaration remain upstream MIT-licensed components;
Jot's profile integration does not claim authorship of them.
