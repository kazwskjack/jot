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

The session adapter requires an absolute path valid on the DSH host: for example, a Windows drive path on Windows or a POSIX absolute path on Linux. The isolated [host-to-worker acceptance](../dsh-host/test/gateway-worker.test.mjs) exercises the actual Gateway, Worker and official DSH launcher on Windows with a synthetic local Messages HTTP model endpoint. This does not validate every optional browser, shell, Office or inference backend on that platform; check their own dependencies separately.

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

### Reviewed workspace attachments

For a persistent task, `jot_workspace` supports a narrow completion declaration:

```json
{"operation":"tasks.propose","arguments_json":"{\"intent\":\"complete\",\"summary\":\"Review the report\",\"files\":[{\"path\":\"reports/result.md\",\"description\":\"Report\"}]}"}
```

Only `complete` may carry `files` (one to eight canonical relative Workbench paths,
up to 400 characters each). Entries accept only `path` and an optional description.
The task must actually write the file and reference its operation receipt in a
completed step. The server pins the highest file version referenced by those
completed steps, verifies its owner/project/occurrence and content, and shows its
version/hash in the acceptance card. Declaring a path never supplies authority,
replaces an execution receipt or grants acceptance.

Workspace declarations use `workspace_files` / `workspace_file_outputs` in the
frozen journal, separate from native DSH filesystem `presented_files`. Mixing
these two file sources in one candidate is rejected before a review card is
created, even when their paths differ. The original DSH `present` tool
still validates DSH filesystem files; no fake native presentation event is emitted.
After owner acceptance and confirmed native Goal completion, the existing output
publisher creates the Artifact attachment from the frozen bytes. Replays neither
follow later file replacements nor create a second publication. The local host
acceptance covers this path using a scripted model, not real model quality.

The acceptance card now lists and downloads exact frozen output versions before
acceptance through `GET /v1/interactions/{interaction_id}/outputs` and its
`/{output_index}` content route. These are authenticated, owner-only pending
review reads; no path/version query, final Artifact publication, lease renewal
or model call is accepted. State, authority, receipts and bytes are reverified
on each request. A later edit never substitutes the latest version. Expiry,
resolution, revocation and integrity failures close the read path.

Small text (including HTML/SVG as literal text) and PNG/JPEG/GIF/WebP can be
previewed; Office and other files are downloaded. The client verifies size/hash
before displaying or downloading supported outputs. Native Team child-file
lineage still needs its own official-host integration coverage.

Review requests use a deferred WAL snapshot, not a reserved writer lock.
Generated-group bytes are retained only within one request, up to 100 MiB in
aggregate. One review response per Gateway process may be in flight; another
receives `429 TASK_REVIEW_OUTPUT_BUSY`. Disconnect or a 30-second response
deadline releases the slot. This is a conservative memory bound, not a fair
multi-user download queue. Listing still verifies all frozen output bytes and
can incur disk/hash work; over-limit groups remain unavailable rather than
being partially reviewed. Large-group latency and multi-user capacity are not
production acceptance claims.

`src/artifacts/main.ts` expects a separately supplied document exporter and runtime bridge; the fallback exporter path is not a bundled executable. `src/channels/main.ts` expects a separately supplied enterprise messaging provider module and runtime bridge. `src/artifacts/archive-main.ts` needs a configured external archive CLI and credentials. These extension points are source code, not ready-to-run bundled providers. Do not enable them merely because the gateway builds successfully.

Event retention reports are read-only inventories. A seven-day event cutoff and ninety-day cold-conversation cutoff do not authorize deletion: the included retention planner marks candidates protected while complete restore evidence is absent.
