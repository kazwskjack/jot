# Deployment and tuning

For private offline database, workspace, artifact, session and host configuration
recovery, see [host backup](HOST-BACKUP.md). It does not upload data or activate
restored services; keep all backup artifacts outside the public repository.

For owned, read-only auxiliary-call timing and process-resource evidence, see
[host resource observations](HOST-RESOURCES.md). These shared-process samples
are separate from token accounting and remote inference/GPU usage.

Jot has two runnable entry points. Choose the one whose execution and identity model fits your deployment; their databases, routes and environment variables are separate.

| Entry point | Runs what | Dependencies | Intended boundary |
| --- | --- | --- | --- |
| Repository root | Portable Agent loop, local web interface, conversations, tools, approvals and file delivery | Node.js 24+, a compatible streaming model endpoint; optional Playwright/search service | Local single-user application |
| `packages/gateway` | Extended product API and workers around a DSH Session host | Node.js, Python, DSH/Cordis host, registered presets/tools, session adapter and a trusted authentication proxy | Operator-managed session backend |

The root application can run without DSH. The gateway cannot execute queued tasks without its DSH host. The root chat uses the portable Agent API. The optional `/workbench.html` interface uses the gateway through an explicitly configured loopback proxy; see [Workbench setup](WORKBENCH.md). Installing all folders does not automatically combine the two runtimes or their conversations.

Gateway management can save roles and task rules before an execution host is ready. Its execution readiness flag must reflect a verified host; local fixture flags are not production evidence. The workbench role chat supports snapshot/SSE recovery, message queues, cancellation, interaction responses and output-file downloads. From a completed role message, task creation preserves server-validated source IDs independently of the trigger conversation. The five-step task wizard reviews role/goal, triggers, budgets, delivery and a final confirmation before saving. When `task_create_delivery` is advertised, selected verified owner bindings and the task save atomically; invalid or revoked bindings roll back the entire creation. Unselected external delivery stays application-local. With a configured gateway CSRF token, an opaque authenticated-owner namespace separates same-tab drafts and unknown save receipts; navigation or reload restores the confirmation view without sending a request. An explicit retry uses the original payload and request key. Browser storage must accept the receipt before a network save starts. Closing the tab or rotating the authentication secret changes this recovery boundary. The workbench can also open owned gateway conversations and convert a completed ordinary-chat message into a task after an explicit role selection. The gateway rechecks source ownership and workspace/project compatibility; the portable root chat remains a separate runtime. The picker currently exposes the most recent 100 active gateway conversations, without claiming full list pagination. Bounded autonomous reply and formal host acceptance remain integration work. SMTP acceptance proves transport receipt, not recipient inbox arrival. The portable runtime's operation-specific approval path is separate.

## Task run-limit upgrades

Before enabling explicitly unlimited persistent-task runs, back up the existing
private database and upgrade the task API/UI and every task consumer together.
The migration adds `run_limit_mode`, defaulting existing rows to finite, without
resetting task IDs, counts, pause state or occurrence keys. The exact internal
`(unlimited,0)` tuple maps to public `max_runs:null`; zero on its own is invalid.
Database guards reject inconsistent tuples. The known earlier numeric admission
check refuses this zero rather than executing an unsupported unlimited task.
This is a rollback refusal mechanism, not full historical-binary compatibility:
older consumers may leave error/exhausted state. After upgrade, inspect the
original records and explicitly resume where appropriate; never reset counts,
drop the mode column or convert uncertain work to a new task. Preserve original
user pause/cancel and unknown model/tool outcomes. New capability flags indicate
API support only, not that every deployed Worker has been upgraded.

## Resource planning

These figures are engineering starting estimates, not measured minimums or benchmarked capacity guarantees. They exclude remote model infrastructure, depend on document size and page complexity, and must be verified with your actual workloads. Disk space includes operating-system/dependency headroom rather than a promise of unlimited retained files.

| Workload | Suggested minimum to try | Recommended starting configuration |
| --- | --- | --- |
| Portable core with remote model, no browser | 1 vCPU, 2 GiB RAM, 20 GiB SSD | 2 vCPU, 4 GiB RAM, 40 GiB SSD |
| Extended gateway + DSH host with remote model, no browser pool | 2 vCPU, 4 GiB RAM, 40 GiB SSD | 4 vCPU, 8 GiB RAM, 80 GiB SSD |
| Separate browser service with a target of 20 live pages | 8 vCPU, 16 GiB RAM, 80 GiB SSD | 16 vCPU, 32 GiB RAM, 160 GiB SSD |
| Add a small local decision model below 1B parameters | Additional 4 vCPU, 8 GiB RAM | Additional 8 vCPU, 16 GiB RAM; accelerator if your chosen backend supports it |
| Local general-purpose language model | Size from the model's quantization, context length and concurrent requests | Plan weight memory + KV cache + runtime/browser headroom; follow the selected model server's requirements |

The browser row describes a capacity target for a separately deployed tool backend. The portable tool currently keeps one browser page per conversation and clamps Agent workers at five; it does not create a 20-page pool. The extended gateway also does not supply a browser pool. Raising task workers is not equivalent to increasing browser pages. Neither entry point downloads local model weights or launches a local inference server for you.

Start at one task worker. Increase through two, three and five only after measuring success rate, peak memory, provider throttling, time to first output and end-to-end latency. Keep browser and model capacity independently bounded.

## Portable Agent: Windows, Linux or macOS

Install Node.js 24 or later. From the repository root:

```sh
npm ci
npm run build
npm test
npm run demo
```

Open the loopback URL printed by the process, normally `http://127.0.0.1:3030`. Demo responses are scripted and explicitly labelled; this checks interface/lifecycle behavior without pretending to be model inference.

To run real tasks, copy the root `.env.example` to `.env`, set a model endpoint and model name, and run:

```sh
npm start
```

The model endpoint must implement streaming Chat Completions with function tool calls. The model URL is the API base URL, typically ending in `/v1`; the client appends `/chat/completions`. Verify tool-call capability rather than only testing a plain text completion. API keys stay in `.env`, outside Git. The interface's capability endpoint reports whether a model is configured; it cannot prove the provider is reachable until a real run is performed.

| Portable setting | Default | Purpose / tuning |
| --- | --- | --- |
| `JOT_PORT` | 3030 | Loopback application port |
| `JOT_MODEL_URL` | Unset | Streaming model API base URL |
| `JOT_MODEL` | Unset | Provider model name |
| `JOT_MODEL_KEY` | Unset | Private provider key; optional for an unauthenticated local model endpoint |
| `JOT_WORKERS` | 1; clamped to 5 | Simultaneous Agent runs across conversations |
| `JOT_MAX_STEPS` | 12; clamped to 1–50 | Maximum model/tool planning rounds, not browser pages |
| `JOT_APPROVAL_TIMEOUT_MS` | 300,000; clamped to 1,000–300,000 | Time to answer an operation approval |
| `JOT_WEB_ORIGINS` | Empty | Explicit HTTPS origins the read/browser tools may access |
| `JOT_SEARCH_URL` | Unset | Operator-configured JSON search endpoint; results become untrusted input |
| `JOT_BROWSER` | False | Enables optional Playwright tools in real Agent mode |

Browser use also requires the optional Playwright dependency and its Chromium installation. By default Jot does not reuse a personal browser profile. Include required HTTPS origins deliberately, including page assets the browser needs; avoid permitting unrelated hosts just to make a page load. Search-provider authentication must be configured by the operator, without committing credentials or embedding them in public example URLs.

The portable application binds to `127.0.0.1`, rejects unexpected Host/Origin values and uses a per-process request token. This is a local single-user boundary, not multi-user authentication. Do not publish this listener directly to the Internet or use a single database for unrelated remote users. A fresh process marks unfinished runs interrupted; it does not secretly replay a potentially submitted browser action after restart.

Local product data defaults to `.data/jot.db` and `.data/files` relative to the launch directory. Keep one process for this portable store, back up both database and files consistently, and do not commit `.data`. Existing conversations and uploaded/generated files are private deployment data.

## Extended gateway: staged startup

1. Prepare a dedicated official DSH host using the [host profile startup guide](packages/dsh-host/README.md), or register `packages/session-adapter` in an existing verified host; see its [README](packages/session-adapter/README.md). The prepared profile uses the original DSH launcher, real uploads/workspaces and the official standard preset under `jot-general`; model credentials and optional backend acceptance remain operator steps. Use a working directory that is absolute on the host operating system, such as a Windows drive path or a Linux path. Relative and drive-relative paths are rejected. This path support does not establish that every optional Office, browser or inference backend runs on Windows; validate those separately.
2. Install Node.js 24 and Python. In `packages/gateway`, run `npm ci` and `npm run build`. The build generates three neutral original templates (two DOCX files and one XLSX file); no private document is copied into the repository. A `python` executable must be on PATH during build.
3. Copy the gateway `.env.example` to `.env`. Replace paths with your own paths. Create a writable database parent and file root. Use the same database and file root for API and workers. Generate fresh CSRF, internal channel and adapter tokens; never reuse deployment credentials from another service.
4. Put the adapter token in a private file and in the DSH host's explicitly configured token environment. Set `GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE` to that file. Keep the adapter on loopback; the client rejects public adapter URLs.
5. Start the DSH host, gateway API (`npm start`) and harness worker (`npm run start:worker`) as separate supervised processes. Only start `npm run start:file-worker` after its processing dependencies are installed.
6. Place an authenticated reverse proxy before the gateway for remote users. Strip client-provided `x-user-id` and inject the authenticated owner. Give the browser a CSRF token through your authenticated UI, enforce the origin allow-list, and keep internal routes private. The root demo does not implement this gateway authentication layer.

Original-run model/effort selection is an explicit host opt-in, separate from
model metadata editing. Follow the [activation and migration notes](docs/implementation/2026-10-18-native-model-policy.md)
before enabling `ordinaryModelSelection`; it requires verified original-input
admission/recovery and refuses pre-upgrade runs without a frozen policy. The
API projects detached model metadata from its existing authenticated host
client; an unconfigured or unready host exposes an empty catalog. Generated
profiles retain their existing default-off behavior. This is not yet a
complete fast Chat/Work deployment.

For Node processes launched from another directory, explicitly load the same private env file, for example `node --env-file=/private/path/gateway.env /opt/jot/packages/gateway/dist/src/main.js`. This is an installation example, not an existing deployment path. Relative paths depend on the service working directory; absolute configured paths avoid accidental creation of a second database.

## Existing tuning preserved in the extended path

These defaults come from the included configuration and source code. They preserve the backend's behavior without publishing any website endpoints, accounts or production values.

| Layer | Preserved value | Why it exists / how to tune |
| --- | --- | --- |
| Task queue | 1 worker by default; hard cap 5 | Bound provider and tool load; configure `GENERAL_AGENT_WORKER_CONCURRENCY` |
| Queue polling | 1,000 ms; minimum 250 ms | Low idle overhead; configure `GENERAL_AGENT_WORKER_POLL_MS` |
| Worker lease | 900,000 ms; minimum 60,000 ms | Recover abandoned ownership; configure `GENERAL_AGENT_WORKER_LEASE_MS`; not a hard task timeout |
| Cancel/steer dispatch | 500 ms | Source constant; remains separate from run execution |
| SSE cross-process polling | 1,000 ms | Database cursor is authoritative; in-process events are only a latency hint |
| SSE heartbeat | 15,000 ms | Keep intermediaries alive |
| Assistant delta coalescing | 250 ms or 256 characters | Avoid a database write for every tiny token; constructor options, not env keys |
| Native operation polling | 750 ms | Balance progress freshness with polling load; constructor option |
| SQLite | WAL, foreign keys, 75 ms busy timeout | Durable local event store with short transactions; keep files on local storage |
| File worker | 180 s timeout, 300 s lease, 500 ms idle poll | Prevent an indefinitely stuck conversion; timeout env configurable |
| Upload / prompt attachments | 100 MiB per file; 10 files / 200 MiB per prompt | Bound disk and in-memory model staging; distinct from the 1 MiB JSON body limit |
| Voice | Off; 60 s, 2 MiB, fixed WAV format | Only enable after real speech capability is ready |

Do not add imaginary environment flags for source constants. Change the constructor wiring or implementation deliberately if altering them, then rerun the relevant event, worker and cancellation checks. HTTP proxy idle timeouts should exceed the 15-second heartbeat interval; a 65-second starting value leaves room for transient scheduling delays. Disable buffering/caching on SSE and preserve event IDs when reconnecting. Proxy upload limits must fit the specific upload route and server limit rather than raising every JSON limit globally.

The public `jot-general` preset is a neutral name, not a copy of a private host's installed preset. Register the matching capabilities in your own host and verify each tool before claiming it is enabled. Optional batch/native event monitoring expects an independently implemented tool bridge. A configured bridge URL is not evidence of its availability.

## Optional services

| Optional path | Additional requirements | Readiness boundary |
| --- | --- | --- |
| PDF read/edit | `pypdf` in the Python selected by `GENERAL_AGENT_FILE_ENGINE_PYTHON` | Inspect dependency probe / perform a real sample job |
| Office edit / PDF export | LibreOffice plus a Python interpreter able to import `uno` | Generic pip Python does not automatically include system UNO |
| Voice | DSH `speechController` and speech provider; host and gateway flags/tokens | Capability response + real audio transcription required |
| Display expression suggestions | OpenJev or Laya endpoint and private provider token | Optional display advice; does not grant action permissions |
| Report exporter worker | Supplied exporter script, runtime bridge and LibreOffice QA | Default exporter path is not bundled in this repository |
| Enterprise message delivery | Supplied provider module and runtime bridge | Provider accounts and connector implementation are not bundled |
| Archive / restore | Installed archive CLI with privately configured account | Verify remote copy and restore before allowing local cleanup |

Linux's system Python with `python3-uno` may be needed for LibreOffice integration; a Python virtual environment for template generation does not establish UNO readiness. The file child environment deliberately excludes most parent credentials. Keep secrets in the service environment or token files with restrictive permissions, not in downloaded files or model-visible context.

## Acceptance after deployment

- **Local demo:** build succeeds, UI loads, a new conversation receives an explicitly scripted response and persists across reload. This does not count as model validation.
- **Real Agent:** one live model reply, then one permitted page read and one approved generated text file. Capture provider failures as failures rather than substituting demo output.
- **Gateway execution:** authenticate as a test owner, create a project/conversation, send one message with a unique idempotency key, receive replayable SSE, and observe a terminal run from the DSH host. `/healthz` alone is insufficient.
- **Owner isolation:** a second authenticated owner cannot restore or download the first owner's conversation/artifact; spoofed client identity is stripped by the proxy.
- **Approval / cancellation:** deny one proposed action, cancel an active run, and confirm no unapproved side effect. Test cancellation again while waiting for approval and after reconnecting.
- **Idempotency / restart:** repeated message keys produce one task/answer; changed payload with a reused key is rejected. Restart recovery does not duplicate a submitted action.
- **Optional dependencies:** sample PDF/Office/voice/browser jobs must pass independently before advertising them as available.
- **Load:** measure one, two and five concurrent conversations before changing deployment limits; record memory, failure rate and latency. A browser pool needs its own validation.

Use synthetic fixtures and newly created test conversations. Never publish real users' prompts, screenshots, documents, browser profiles or model credentials as benchmark artifacts.

## Storage and operations

Supervise processes, collect redacted operational metrics and preserve the data directories across updates. Back up the SQLite database with a consistent SQLite backup method and include the corresponding artifact files; copying a live database file alone can omit WAL state. Avoid changing schema or cleaning events while active tasks are writing.

The gateway's retention inventory flags seven-day events and ninety-day inactive conversations but marks them protected until complete checkpoint/restore evidence exists. It is not an automatic deletion schedule. Archive cleanup requires a verified remote copy, absence of active leases and successful restore checks. Do not infer that an expired UI download permits deleting the only remaining artifact copy.

Artifact cleanup also checks the current registered file set against the verified
manifest, including sizes, SHA-256 content and the manifest's MD5. It validates
every part before removing any. Changed bytes, a newer current version, incorrect
paths or incomplete manifests preserve local files instead of marking them
deleted. Content hashing runs outside SQLite writer admission; a short removal
transaction rechecks the manifest, references, leases and file identities.
This does not supply a remote backup account, a deletion schedule or a guarantee
that an independently removed remote object is still available. Configure and
validate the actual private backup destination and restore procedure separately.

Release checks cover source/build/contracts and controlled fixtures. They do not replace provider reachability, authenticated host validation, model-backed actions or sustained deployment load testing.
# Optional email transport (integration in progress)

The gateway delivery worker supports an explicit `GENERAL_AGENT_DELIVERY_CHANNELS`
selection: `wecom` (default), `email`, or `wecom,email`. An email-only worker
does not load the WeCom module or require the runtime receipt client for text
notifications. Run the built worker with `node dist/src/channels/main.js` and
server-provided environment configuration.

SMTP requires an authenticated sender, port 465 with implicit TLS or port 587
with required STARTTLS, and certificate verification. Set the SMTP host, port,
user, sender, and password **file** using the gateway environment example.
Keep the password file outside the checkout and do not put credentials in
browser settings or task descriptions. Delivery fixes the sender and a single
recipient; it accepts plain text only and does not fetch URLs or local files.
An ambiguous SMTP outcome is recorded as unknown and is not automatically resent.

The task creation wizard supports combined delivery confirmation and atomic
task/binding selection when the gateway advertises `task_create_delivery`.
Live provider-to-inbox acceptance remains pending. The task detail's notification panel can apply
for mailbox verification, confirm a received code, select verified bindings,
save task notification settings and revoke a channel. Lost application or
confirmation responses require an explicit retry of the frozen original
request. Codes stay in component memory and are never persisted in browser
storage; reload recovers pending binding IDs from the authenticated API.
The backend mailbox-verification API is available behind
`GENERAL_AGENT_EMAIL_BINDINGS_ENABLED=true`, with the same server-only SMTP
configuration. `POST /v1/channel-bindings/email` takes only an address and mails
a ten-minute proof code. Its response omits the code and address. Repeat the
same request key to recover its challenge without sending a second message.
`POST /v1/channel-bindings/email/{binding_id}/confirm` accepts the received code
for the authenticated owner. Both mutations require the normal Origin, CSRF
and request-key checks. Wrong codes are limited to five attempts; revoked
bindings cannot be restored by replaying a consumed code. Only verified binding
IDs can be saved in task notification settings. Completion, event and monitor
notifications retain their existing frozen authorization and revocation checks.
SMTP acceptance does not prove mailbox arrival.
The local transport verification used a loopback TLS fixture and no external
recipient. Do not enable email through a public unverified recipient endpoint.

Transport reference: [Nodemailer SMTP documentation](https://nodemailer.com/smtp).
