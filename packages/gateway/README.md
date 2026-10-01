# Jot gateway

The gateway is the extended session, project, event, attachment and interaction API. It stores product state in SQLite and delegates Agent execution to a separate DSH Session host through the session adapter. Running the API alone does not run a model or complete queued tasks.

For the standalone local Agent and browser demo, start from the repository root. Its `/api/*` endpoints and `JOT_*` settings are a separate entry point; the root demo is not a client for this gateway's `/v1/*` endpoints.

## Dependencies

| Component | Requirement | Purpose |
| --- | --- | --- |
| Node.js | 22+; use 24 for one version across this repository | Native SQLite, HTTP service and workers |
| Python | `python` on PATH during build; Python 3.12+ recommended and 3.12 tested | Generates an original DOCX template with the standard library |
| DSH host + session adapter | Required for the harness worker | Planning, model calls, tools, session execution and cancellation |
| Trusted identity proxy | Required for a deployment with remote users | Authenticates users and replaces the `x-user-id` header |
| Python file worker | Optional | DOCX/XLSX inspection; PDF needs `pypdf` or a compatible fallback |
| LibreOffice + matching Python UNO | Optional | Office editing and PDF export |
| Browser/tool bridge | Optional | Browser actions and native batch progress; not supplied by this gateway |
| DSH speech service | Optional | Voice transcription; disabled by default |

The session adapter's `cwd` validation currently requires a POSIX absolute path. Use Linux or WSL for the extended DSH chain. The root portable Agent can run natively on Windows.

## Build and start

From this directory:

```sh
npm ci
npm run build
npm run gate
```

The build runs `scripts/create-template.py`, compiles TypeScript and copies the schema, contracts, Python worker and generated template into `dist`. Activate a Python virtual environment first if your system only exposes `python3`; it must provide a `python` executable for the build command.

Copy `.env.example` to `.env`, supply new independent random secrets, create the database parent directory, and replace the example paths with your own installation paths. Set the template path to this build's `dist/file-engine/templates`. Set a workspace directory that actually exists and a preset already registered in the DSH host. The adapter's preset allow-list includes `jot-general`, `jot-general-batch50` and `jot-general-batch`; these names do not install presets or their tools automatically.

Start the DSH host with the [session adapter](../session-adapter/README.md) loaded first. Then run these as separate supervised processes using the same database and file root:

```sh
npm start
npm run start:worker
# Only if document processing dependencies are installed:
npm run start:file-worker
```

The API listens on loopback port `18831`; the adapter listens on loopback port `18841`. `GET /healthz` confirms API liveness only, not model or worker readiness. The complete run requires a live host, model, tools and matching adapter token.

## Identity and permissions

`x-user-id` is an identity assertion from a trusted upstream, not a login mechanism. The gateway checks its syntax and uses it for owner isolation. A reverse proxy must authenticate the user, remove any client-supplied `x-user-id`, and inject the authenticated owner. Keep the gateway on loopback or a private trusted network; a directly exposed gateway would let callers forge identities.

Non-read browser requests also require an allowed `Origin`, `x-csrf-token` and an `Idempotency-Key` of 8–128 printable ASCII characters. The internal channel/file/batch routes require a separate bearer token. Adapter tokens are at least 32 characters and must match the DSH host's environment value and the worker's private token file. None of these shared service tokens replace user authentication.

Frontend state uses `conversation_id`; internal session IDs and token files stay server-side. Configure task tool permissions and approval in the Agent host; this API does not grant blanket permission for arbitrary browser or shell actions.

The static capability response is not proof of end-to-end host readiness. Interaction responses, selected models and checkpoint references have storage/contracts, but complete approval dispatch, per-conversation model switching and checkpoint execution resume are not yet wired through every included worker path. Validate those integrations separately; do not expose them solely because a capability flag is true.

## Configuration defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| Worker concurrency | 1; clamped to 5 | Concurrent task runs in one worker process, not browser pages |
| Worker poll | 1,000 ms; minimum 250 ms | Check for queued work |
| Worker lease | 900,000 ms; minimum 60,000 ms | Recovery lease; not an execution timeout |
| Command dispatch | 500 ms | Cancel/steer dispatch loop; source constant |
| SSE heartbeat | 15,000 ms | Keep stream connections alive; source constant |
| Text delta flush | 250 ms / 256 characters | Flush on either threshold; runner options, not env settings |
| Web operation polling | 750 ms | Native progress polling; runner option |
| File engine timeout | 180,000 ms; minimum 10,000 ms | Python job timeout |
| File job lease | 300 seconds | File worker lease; source constant |
| Single attachment | 100 MiB | Artifact service limit; distinct from JSON/multipart limits |
| Prompt attachments | 10 files / 200 MiB total | Resolver limits; server-side checks remain required |
| Voice | Off; WAV PCM mono 16 kHz / 16-bit, 60 s, 2 MiB | Needs live speech service before enabling |

See [DEPLOYMENT.md](../../DEPLOYMENT.md) for resource estimates, startup checks and tuning order.

## Optional integration boundaries

`src/artifacts/main.ts` expects a separately supplied document exporter and runtime bridge; the fallback exporter path is not a bundled executable. `src/channels/main.ts` expects a separately supplied enterprise messaging provider module and runtime bridge. `src/artifacts/archive-main.ts` needs a configured external archive CLI and credentials. These extension points are source code, not ready-to-run bundled providers. Do not enable them merely because the gateway builds successfully.

Event retention reports are read-only inventories. A seven-day event cutoff and ninety-day cold-conversation cutoff do not authorize deletion: the included retention planner marks candidates protected while complete restore evidence is absent.
