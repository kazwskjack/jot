# Feature and integration status

This inventory distinguishes code availability from end-to-end readiness. The portable web app uses `/api/*`; the extended gateway uses a different API and requires its own authenticated client.

| Module | Included | External requirement or limitation |
| --- | --- | --- |
| Conversations | Portable create/list/snapshot/messages; extended metadata | Portable UI has no project/pin/archive management |
| Projects | Gateway owner-scoped projects and conversation assignment | Separate gateway frontend required |
| Task workers | Bounded runs, one active task per conversation, up to five workers | Does not imply five Agents or a multi-page browser pool |
| Models | Portable streaming/function-tool adapter; DSH Session delegation | Supply a model; gateway per-conversation model execution switching remains scaffolding |
| Search | Optional JSON endpoint, bounded result list | Search engines, routing and provider quotas are not bundled |
| Browser | Optional isolated Playwright read/click/fill with approval | Chromium installation; one page per conversation; no shared batch executor |
| Batch progress | Gateway ownership, persisted progress and external operation binding | Actual parallel read/action executor must be supplied |
| Files | Portable UTF-8 upload/read/new-file creation/download; extended versions and jobs | Portable files have no version chain; office/PDF dependencies are optional |
| Speech | Gateway WAV validation and Session transcription interface | Real speech controller/provider; no portable recording UI |
| Events | SQLite events, SSE, snapshots and cursors | Extended snapshot does not restore pending interaction records in every path |
| Approvals | Portable exact-operation approvals | Gateway interaction contracts need complete host dispatch |
| Identity | Local loopback boundary; gateway owner/CSRF/internal token checks | Trusted authenticated proxy for remote users; identity headers are not login |
| Recovery | Portable interrupted-on-restart; extended leases/event recovery | No portable action replay; extended checkpoint execution resume is not complete |
| Storage | SQLite/artifact storage, archive and retention inventory source | No bundled automatic deletion schedule or external archive account |
| Decision advice | Optional OpenJev-first/Laya-fallback expression client | Active webpage decision service and learning pipeline are not bundled |
| Interface | React dark/light chat, progress, approvals, delivery and synthetic samples | No complete PWA safe-area, mascot or extended project/speech UI |
| Agent adapters | DSH Session plugin; external leaf-runtime client contract | pi and other Agent SDK adapters are proposals, not tested implementations |
| Delivery services | Extension source for reporting, channels and archival | Exporter, channel provider and archive CLI must be supplied |
| Validation | Portable deterministic tests, gateway contract/store tests, voice protocol tests | Not complete live-model/browser/Office/batch/channel acceptance |

See [Deployment](DEPLOYMENT.md) for installation, [Integrations](INTEGRATIONS.md) for adapter designs and [Algorithms](ALGORITHMS.md) for exact mechanisms. Capability flags and healthy HTTP responses do not establish external service readiness.
