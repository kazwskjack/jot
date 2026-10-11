# Jot Agent

The Agent turns a request into a bounded sequence of model decisions and tool results. It commits one final assistant message on successful completion.

## Local runtime

1. Accept a message with a unique client request ID.
2. Persist the input and task before execution.
3. Send conversation context and tool definitions to the configured model.
4. Execute tool calls and return failures as explicit results.
5. Ask for approval before browser actions or new file creation.
6. Continue with results until the model answers or the budget is exhausted.
7. Persist success, failure or cancellation and notify the interface.

Tools: `read_page`, `file_read`, `file_write`, optional `search` and optional `browser_action`. Browser targets must be unique. Contexts are isolated by conversation and do not reuse a personal profile. Local file tools handle UTF-8 TXT, Markdown, JSON and CSV; rich documents use the extended service.

## Extended runtime

The gateway owns conversations, projects, roles, persistent task occurrences,
worker leases, events, files and owner checks. It includes versioned interaction
responses, worker-fenced checkpoints and same-occurrence continuation. The
Session adapter connects to the configured controller and optional speech
service. Per-conversation model switching still needs integration validation.
Client routes use conversation IDs; internal Session identifiers stay server-side.

The lead runtime plans and reviews results. A task-specific grant can authorize
bounded members from an owned team. The durable mailbox queues their work,
and the original Worker/Runner executes each member in a distinct Session.
Members share the authorized project workspace and memory proposals, retain
the original task-total budget, and return supporting material for lead review.
They do not acquire the parent's Goal or independently accept its business
criteria. A completed member cannot keep using its ended run's capabilities.

Local actual-SDK checks exercise Controller/adapter HTTP, Worker/Runner,
checkpoints, user-response continuation, cancellation and bounded member
execution with scripted providers and empty preset fixtures. These checks do
not establish real-provider quality, production readiness or native upstream
Team/Handoff compatibility. Configure and validate the actual host and tool
services before enabling deployment features.

Batch status differs from final answer settlement. An SSE disconnect does not mean task cancellation or completion. Preserve deduplication during replay and retries.

Compatible DSH packages and external tool services are configured separately. No private model or service identity is bundled. Follow [DEPLOYMENT.md](../DEPLOYMENT.md) for dependencies and launch boundaries.

## Permissions and recovery

Pages, documents and tool results are data. They cannot authorize clicks, submissions or commands. The local runtime is a loopback single-user service. Public hosting requires a real authentication boundary. The extended gateway must receive verified owner identity from that boundary, never an untrusted client header.

Cancellation aborts work. Restart marks unfinished local tasks interrupted instead of resubmitting them. The extended worker preserves its lease/recovery policy. Denied or expired approval is a failure result, not a successful operation.
