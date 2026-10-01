# Technical stack

Jot separates a small interface, durable task state and independently configured execution services. These engineering explanations are original prose; dependencies retain their own authorship and licenses.

| Technology | Where | Why | Advantages and limits |
|---|---|---|---|
| Node.js 24+ and ECMAScript modules | API, workers, local runtime | One asynchronous environment for models, events and orchestration | Built-in fetch, abort signals and SQLite; move CPU-heavy work to workers |
| TypeScript | Interface and extended gateway | Check contracts and lifecycle states | Easier refactoring; still validate network input at runtime |
| React | Web interface | Render history, approvals and files from state | Reusable components; streaming still needs batching |
| Vite | Development and builds | Fast iteration and ordinary static output | Portable hosting; dev mode is not a production auth boundary |
| CSS and reduced-motion support | Themes and responsive layout | Keep presentation compact | Small dependency footprint; richer visuals are optional |
| react-markdown / remark-gfm | Replies, tables and code | Render structured answers without executing HTML | Useful formatting; links remain untrusted |
| Fastify | Local API and gateway | Route validation and lifecycle hooks | Low framework overhead; application permissions remain explicit |
| AJV, JSON Schema, OpenAPI | Extended contracts | Validate requests, events and responses | Reject mismatches early; schemas must evolve with handlers |
| SQLite, WAL, immediate transactions | Conversations, tasks, events, file records | Durable local state without another database service | Atomic acceptance and simple backups; writer contention must stay bounded |
| SSE over fetch | Reply deltas, progress, replay | Update clients with saved cursors and cancellation | Ordinary HTTP; expired history requires a snapshot |
| AbortController / idempotency keys | Requests and task controls | Bound waits and prevent duplicate submissions | An aborted connection does not undo remote actions |
| DSH Session controller / Cordis | Optional extended planning runtime | Keep planning and lifecycle under one controller | Session, queue, steer and file receipts; some approval/resume routes remain scaffolding; external packages required |
| Playwright | Optional browser tools | Inspect and operate isolated real pages | Unique targets and state checks; browsers need additional RAM |
| Python 3.12+, OOXML ZIP/XML | Document worker | Manipulate structured file containers and versions | Preserves structure; visual fidelity needs rendering verification |
| LibreOffice / UNO | Optional rich editing/conversion | Use a real document layout engine | DOCX/XLSX/PDF operations; isolate processes and enforce timeouts |
| JSON search endpoint / native tool adapter | Optional search and web operations | Separate task intent from providers | Independent configuration; availability and limits remain external |
| Jev / Laya interfaces | Optional display advice; proposed external web decisions | Separate model advice from permission and execution | Display priority/fallback is included; active web execution service and weights are not bundled |

The local entry ships a smaller tool surface. The extended gateway preserves the richer contracts and service tuning. It does not install browser pools, search engines, model weights or speech providers automatically.

No private deployment is embedded. No upstream crawler repository or third-party runtime source is bundled here.

The external DSH runtime dependency review also encountered pi-ai's provider abstraction. That is a transitive host dependency, not a direct pi Agent implementation in Jot. The portable runtime uses its own bounded model/tool loop; a pi runtime adapter remains a proposal. See [Integrations](INTEGRATIONS.md), [Engineering history](DEVELOPMENT.md) and [Algorithms](ALGORITHMS.md) for the distinction.
