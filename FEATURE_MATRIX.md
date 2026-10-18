# Feature and integration status

This inventory distinguishes code availability from end-to-end readiness. The portable web app uses `/api/*`; the extended gateway uses a different API and requires its own authenticated client.

| Module | Included | External requirement or limitation |
| --- | --- | --- |
| Conversations | Portable create/list/snapshot/messages; extended metadata | Portable UI has no project/pin/archive management |
| Projects | Gateway owner-scoped projects and conversation assignment; optional bundled workbench | Configure the workbench's authenticated gateway proxy; portable root chat remains separate |
| Agent roles | Workbench creation/editing/copy/status/delete and owner-scoped role conversations | A verified execution host is required to run roles; management availability does not prove model readiness |
| Persistent tasks | Bounded schedules, dialogue triggers, calendar, task wizard and shared workspace/memory APIs | Host execution, external notification accounts and business acceptance require deployment validation |
| Memory | Owner-scoped provenance, expiry and revisions; reviewed consolidation/rollback; query/context evidence; opt-in public-source capture and candidate review | Optional pinned idle extraction is wired to original runs, leases and budget accounting with scripted SDK verification; reasoning retrieval, idle Dream, exhaustive crash recovery, real-provider quality and production acceptance remain incomplete |
| Native roles | Default-off saved-role admission, durable publication, closure and cold activation modules | Newer native host APIs and matching gateway; model-callable native dispatch is locally verified with scripted SDK providers; production acceptance remains pending; see [integration guide](NATIVE_ROLES.md) |
| Task workers | Bounded runs, one active task per conversation, up to five workers | Does not imply five Agents or a multi-page browser pool |
| Models | Portable streaming/function-tool adapter; DSH Session delegation; authenticated host catalog; original-run model/effort snapshots and opt-in native selection | Supply a model and enable the verified original-admission host configuration; local SDK tests cover steering, warm reuse, abrupt-exit recovery and final publication. Generated profiles keep selection off; live provider acceptance remains pending; see [evidence](docs/implementation/2026-10-18-native-model-policy.md) |
| Chat/Work modes | [Portable design and implementation plan](docs/superpowers/plans/2026-10-18-portable-chat-work.md) | Mode-specific native policy, context, tools and UI are not yet integrated; existing controls do not establish fast Chat support |
| Search | Optional JSON endpoint, bounded result list | Search engines, routing and provider quotas are not bundled |
| Browser | Optional isolated Playwright read/click/fill with approval | Chromium installation; one page per conversation; no shared batch executor |
| Batch progress | Gateway ownership, persisted progress and external operation binding | Actual parallel read/action executor must be supplied |
| Files | Portable UTF-8 upload/read/new-file creation/download; extended versions and jobs | Portable files have no version chain; office/PDF dependencies are optional |
| Speech | Extended composer recording, microphone waveform/timer, bounded startup, PCM WAV upload, owned transcription jobs and editable draft | Configure a real speech controller/provider; physical mobile capture and recognition quality require acceptance. The standalone root composer has no recording UI |
| Events | SQLite events, SSE, snapshots and cursors | Extended snapshot does not restore pending interaction records in every path |
| Approvals | Portable exact-operation approvals | Gateway interaction contracts need complete host dispatch |
| Identity | Local loopback boundary; gateway owner/CSRF/internal token checks | Trusted authenticated proxy for remote users; identity headers are not login |
| Recovery | Portable interrupted-on-restart; extended leases and worker-fenced Session checkpoints | Local installed-SDK checks include abrupt exit with a started tool: exact prefix survives, the SDK repairs the result as unknown, and checkpoints refuse it without replay. Byte-level torn writes, full worker crash accounting, remote/provider outcomes and production remain unproven; no portable action replay |
| Storage | SQLite/artifacts, notification archive/restore CLI, default-off archive maintenance and offline six-class host backup CLI | Private backup roots and remote destination must be configured; no automatic deletion of protected live data or bundled archive account |
| Decision advice | Optional OpenJev-first/Laya-fallback expression client | Active webpage decision service and learning pipeline are not bundled |
| Interface | React dark/light portable chat plus optional role/task workbench, uploads, previews, output downloads and extended voice composer | No complete PWA safe-area/mascot implementation; workbench uses the extended gateway rather than the root API |
| Agent adapters | DSH Session plugin; external leaf-runtime client contract | pi and other Agent SDK adapters are proposals, not tested implementations |
| Delivery services | Frozen notification/reply outbox, verified owner bindings, WeCom/email transport and archive/backup commands | Configure external providers and authorization; unknown sends are not blindly retried, SMTP receipt is not inbox delivery |
| Validation | Portable/store/protocol tests and local actual DSH Controller/HTTP/Worker/Runner/checkpoint checks | Local runs use scripted providers and an empty preset declaration; not complete live-model/browser/Office/batch/channel/production acceptance |

See [Deployment](DEPLOYMENT.md) for installation, [Integrations](INTEGRATIONS.md) for adapter designs and [Algorithms](ALGORITHMS.md) for exact mechanisms. Capability flags and healthy HTTP responses do not establish external service readiness.
